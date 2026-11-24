//! File hashing and the directory walk that feeds a task's inputs.
//!
//! # What the walk lists
//!
//! One walk ([`walk_files`]) backs [`collect_files`] and [`hash_files_in_directory`], so the two cannot disagree:
//!
//! - The walk root is always walked, whatever it is called. `IGNORED_DIRS` applies to directories below it only, so
//!   a fileset based at `{projectRoot}/dist` or a project that lives in `packages/coverage` is hashed like any other.
//! - A directory below the root named in `IGNORED_DIRS` is skipped. A regular file with such a name is a
//!   legitimate input and is kept.
//! - A symlink to a file is listed under the spelling of the link and hashed by the content of its target.
//! - A symlink to a directory is followed, and its files are listed under the spelling of the link
//!   (`src/shared/index.ts`, not the path of the target). A link whose name is in `IGNORED_DIRS` is skipped like the
//!   directory it points to.
//! - A directory that is one of its own ancestors (`up -> ..`) is not entered again, so a cycle ends. Only the
//!   ancestors of the current branch count, not every directory seen so far: two links to one directory are both
//!   listed, and which of them the walk meets first does not change the result.
//! - A dangling link is listed and hashes to a constant marker (see [`dangling_marker`]), so the key is the same
//!   on every machine, changes once the target exists and is hashed by content, and the run does not fail. A
//!   dangling link named in `IGNORED_DIRS` is skipped, because it is the ignored directory once its target exists.
//! - A symlink to anything that is not a regular file (a device, a socket) is skipped, as it always was.
//!
//! The JS walker (`collectFiles` in `src/utils.ts`) follows the same rules for links, cycles and the root. It
//! differs in three ways: it leaves a dangling link out (it has no per-file hash to give it a marker), it skips a
//! *file* named like an ignored directory, and each caller passes its own ignore set. No task key reads it: the
//! task hasher calls this module through the addon only, and the JS walker feeds the incremental hasher, the
//! external inputs of `affected` and the import-boundary check.

use rayon::prelude::*;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use xxhash_rust::xxh3::xxh3_128;

use crate::Error;

/// Ignored directory names during file collection.
const IGNORED_DIRS: &[&str] = &["node_modules", ".git", "dist", "coverage", ".cache"];

/// Computes the xxh3-128 hash of a single file.
/// Returns the hex-encoded hash string.
///
/// Uses xxHash xxh3 (same as Nx) for maximum hashing throughput.
/// xxh3 is ~5-10x faster than SHA-256 on modern CPUs with SIMD.
pub fn hash_file(file_path: &str) -> Result<String, Error> {
    let content = fs::read(file_path).map_err(|source| Error::ReadFile { path: file_path.to_owned(), source })?;

    Ok(hash_bytes(&content))
}

/// Collects all files in a directory recursively, ignoring common non-source directories.
/// Returns a list of absolute file paths.
pub fn collect_files(dir: &str) -> Vec<String> {
    let path = Path::new(dir);

    if !path.exists() {
        return Vec::new();
    }

    if path.is_file() {
        return vec![dir.to_owned()];
    }

    walk_files(path).into_iter().map(|file| file.to_string_lossy().to_string()).collect()
}

/// The files below `root`, by the rules in the module header: the root is never filtered, ignored directories
/// below it are skipped, symlinks are followed (a cycle ends, a dangling link is listed).
fn walk_files(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_entry(|entry| {
            // A filter on the root would drop a walk that starts in `dist`, `coverage`, ... entirely. A file with
            // an ignored name is a legitimate input, so only directories are matched; a followed link reports the
            // type of its target.
            entry.depth() == 0
                || !entry.file_type().is_dir()
                || !IGNORED_DIRS.contains(&entry.file_name().to_str().unwrap_or(""))
        })
        .filter_map(|entry| match entry {
            Ok(entry) => entry.file_type().is_file().then(|| entry.into_path()),
            // A cycle is reported against the link that closes it; that link has no content of its own.
            Err(error) if error.loop_ancestor().is_some() => None,
            // A dangling link named like an ignored directory is left out too: once its target exists it is that
            // ignored directory, so listing it now would change the key the moment the task's own build ran.
            Err(error) => error
                .path()
                .filter(|path| is_dangling_symlink(path) && !is_ignored_name(path.file_name()))
                .map(Path::to_path_buf),
        })
        .collect()
}

/// A symlink whose target cannot be resolved.
fn is_dangling_symlink(path: &Path) -> bool {
    fs::read_link(path).is_ok() && fs::metadata(path).is_err()
}

fn is_ignored_name(name: Option<&OsStr>) -> bool {
    name.and_then(OsStr::to_str).is_some_and(|name| IGNORED_DIRS.contains(&name))
}

/// The hash a dangling link contributes. Constant on purpose: the link's own path is already part of the key, and
/// the text of the link can be an absolute path, which would differ between machines.
fn dangling_marker(path: &Path) -> Option<String> {
    is_dangling_symlink(path).then(|| hash_string("dangling-symlink"))
}

/// A single file hash result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileHash {
    pub path: String,
    pub hash: String,
}

/// Collects all files in a directory and computes xxh3-128 hashes for each,
/// using parallel processing via rayon for maximum throughput.
///
/// Returns a list of { path, hash } objects where path is relative to workspace_root.
pub fn hash_files_in_directory(dir: &str, workspace_root: &str) -> Result<Vec<FileHash>, Error> {
    let dir_path = Path::new(dir);

    if !dir_path.exists() {
        return Ok(Vec::new());
    }

    if dir_path.is_file() {
        let content = fs::read(dir_path).map_err(Error::ReadSingleFile)?;

        let hash = hash_bytes(&content);
        let rel = make_relative(dir, workspace_root);

        return Ok(vec![FileHash { path: rel, hash }]);
    }

    let files = walk_files(dir_path);

    let results: Vec<FileHash> = files
        .par_iter()
        .map(|file_path| {
            let abs = file_path.to_string_lossy().to_string();
            let rel = make_relative(&abs, workspace_root);
            let hash = read_and_hash(file_path);

            FileHash { path: rel, hash }
        })
        .collect();

    Ok(results)
}

/// Computes xxh3-128 hashes for multiple files in parallel.
/// Takes absolute file paths, returns relative_path + hash pairs.
pub fn hash_files_batch(file_paths: &[String], workspace_root: &str) -> Vec<FileHash> {
    file_paths
        .par_iter()
        .map(|file_path| {
            let rel = make_relative(file_path, workspace_root);
            let hash = read_and_hash(Path::new(file_path));

            FileHash { path: rel, hash }
        })
        .collect()
}

/// Makes a path relative to the workspace root. Always emits forward slashes
/// so JS-side consumers see consistent path keys across POSIX and Windows.
fn make_relative(path: &str, workspace_root: &str) -> String {
    let path_fwd = path.replace('\\', "/");
    let root_fwd = workspace_root.replace('\\', "/");
    let normalized_root = if root_fwd.ends_with('/') { root_fwd } else { format!("{}/", root_fwd) };

    if path_fwd.starts_with(&normalized_root) {
        path_fwd[normalized_root.len()..].to_string()
    } else {
        path_fwd
    }
}

/// Core hashing function using xxh3-128.
/// Produces a 32-character hex string (128-bit hash).
///
/// `pub` so the criterion bench (`native/core/benches/file_hasher.rs`) can measure
/// raw hashing throughput without going through the filesystem.
pub fn hash_bytes(data: &[u8]) -> String {
    let h = xxh3_128(data);
    hex::encode(h.to_be_bytes())
}

/// Read a file and hash its contents, returning a deterministic
/// sentinel hash if the read fails. Previously the read error was
/// swallowed via `.ok()?` in a `filter_map`, silently dropping the
/// file from the hash batch — which made cache keys non-deterministic
/// in the face of transient races (parallel write, broken symlink,
/// permission denied). The sentinel is keyed off the absolute path so
/// two unreadable files still produce distinct hashes; the constant
/// prefix lets a careful reader distinguish "could not read" from a
/// successful xxh3-128 hash, which is always 32 hex chars.
fn read_and_hash(file_path: &Path) -> String {
    match fs::read(file_path) {
        Ok(content) => hash_bytes(&content),
        Err(_) => dangling_marker(file_path).unwrap_or_else(|| {
            let path_bytes = file_path.to_string_lossy();
            let h = xxh3_128(path_bytes.as_bytes());
            format!("ERR:{}", hex::encode(h.to_be_bytes()))
        }),
    }
}

/// Computes an xxh3-128 hash from a string.
/// Useful for hashing command strings, JSON, etc.
pub fn hash_string(input: &str) -> String {
    hash_bytes(input.as_bytes())
}

/// Computes a combined xxh3-128 hash from multiple strings.
/// Strings are concatenated and hashed, producing a single deterministic hash.
pub fn hash_strings(inputs: &[String]) -> String {
    let mut combined = Vec::new();
    for input in inputs {
        combined.extend_from_slice(input.as_bytes());
    }
    hash_bytes(&combined)
}

pub(crate) mod hex {
    const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";

    pub(crate) fn encode(bytes: impl AsRef<[u8]>) -> String {
        let bytes = bytes.as_ref();
        let mut result = String::with_capacity(bytes.len() * 2);
        for &byte in bytes {
            result.push(HEX_CHARS[(byte >> 4) as usize] as char);
            result.push(HEX_CHARS[(byte & 0x0f) as usize] as char);
        }
        result
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::os::unix::fs::symlink;

    fn workspace(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("file-hasher-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        root.canonicalize().unwrap()
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);

        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// The walk's files as sorted paths relative to `root`.
    fn walked(root: &Path) -> Vec<String> {
        let prefix = format!("{}/", root.display());
        let mut files: Vec<String> = collect_files(root.to_str().unwrap())
            .into_iter()
            .map(|file| file.strip_prefix(&prefix).unwrap().to_owned())
            .collect();

        files.sort();
        files
    }

    fn hashes(root: &Path) -> BTreeMap<String, String> {
        hash_files_in_directory(root.to_str().unwrap(), root.to_str().unwrap())
            .unwrap()
            .into_iter()
            .map(|file| (file.path, file.hash))
            .collect()
    }

    #[test]
    fn a_walk_root_named_like_an_ignored_directory_is_still_walked() {
        for name in ["dist", "coverage", "node_modules", ".cache"] {
            let root = workspace(&format!("root-{}", name.trim_start_matches('.')));
            let base = root.join(name);

            write(&base, "a.txt", "a");
            write(&base, "sub/b.txt", "b");

            assert_eq!(walked(&base), ["a.txt", "sub/b.txt"], "{name}");
            assert_eq!(hashes(&base).len(), 2, "{name}");
        }
    }

    #[test]
    fn ignored_directories_below_the_root_are_still_skipped() {
        let root = workspace("ignored-below");

        write(&root, "src/a.txt", "a");
        write(&root, "src/dist/out.js", "out");
        write(&root, "node_modules/dep/index.js", "dep");
        write(&root, "coverage/lcov.info", "lcov");
        // A file with an ignored name is a legitimate input.
        write(&root, "src/.cache", "a file");

        assert_eq!(walked(&root), ["src/.cache", "src/a.txt"]);
    }

    #[test]
    fn a_symlinked_file_is_hashed_by_the_content_of_its_target() {
        let root = workspace("file-link");

        write(&root, "libs/shared.ts", "one");
        fs::create_dir_all(root.join("app")).unwrap();
        symlink("../libs/shared.ts", root.join("app/shared.ts")).unwrap();

        let app = root.join("app");
        let first = hashes(&app);

        assert_eq!(first["shared.ts"], hash_bytes(b"one"));

        write(&root, "libs/shared.ts", "two");

        assert_eq!(hashes(&app)["shared.ts"], hash_bytes(b"two"));
        assert_eq!(
            hash_files_batch(&[app.join("shared.ts").to_str().unwrap().to_owned()], root.to_str().unwrap())[0].hash,
            hash_bytes(b"two")
        );
    }

    #[test]
    fn a_symlinked_directory_is_followed_under_the_spelling_of_the_link() {
        let root = workspace("dir-link");

        write(&root, "libs/shared/src/index.ts", "index");
        write(&root, "libs/shared/src/deep/more.ts", "more");
        write(&root, "libs/shared/src/node_modules/dep/x.js", "ignored");
        write(&root, "app/own.ts", "own");
        fs::create_dir_all(root.join("app/src")).unwrap();
        symlink("../../libs/shared/src", root.join("app/src/shared")).unwrap();

        assert_eq!(walked(&root.join("app")), ["own.ts", "src/shared/deep/more.ts", "src/shared/index.ts"]);
    }

    #[test]
    fn a_symlink_to_an_ignored_directory_name_is_skipped_like_the_directory() {
        let root = workspace("ignored-link");

        write(&root, "libs/out/a.js", "a");
        write(&root, "app/own.ts", "own");
        symlink("../libs/out", root.join("app/dist")).unwrap();

        assert_eq!(walked(&root.join("app")), ["own.ts"]);
    }

    #[test]
    fn a_directory_cycle_ends_and_every_other_alias_is_listed() {
        let root = workspace("cycle");

        write(&root, "app/src/a.ts", "a");
        // Points at an ancestor: entering it again would never end.
        symlink("..", root.join("app/src/up")).unwrap();
        symlink(".", root.join("app/src/self")).unwrap();
        // Two aliases of one directory that is not an ancestor are both listed, whatever order they are met in.
        write(&root, "app/real/r.ts", "r");
        symlink("real", root.join("app/alias")).unwrap();

        assert_eq!(walked(&root.join("app")), ["alias/r.ts", "real/r.ts", "src/a.ts"]);
    }

    #[test]
    fn a_dangling_link_contributes_a_marker_that_depends_on_neither_the_workspace_nor_the_target_text() {
        let first = workspace("dangling-a");
        let second = workspace("dangling-b");

        write(&first, "app/own.ts", "own");
        write(&second, "app/own.ts", "own");
        symlink("../missing/target.ts", first.join("app/broken.ts")).unwrap();
        symlink("/an/absolute/target.ts", second.join("app/broken.ts")).unwrap();

        let marker = &hashes(&first.join("app"))["broken.ts"];

        assert!(!marker.starts_with("ERR:"), "{marker}");
        assert_eq!(marker.len(), 32);
        assert_eq!(marker, &hashes(&second.join("app"))["broken.ts"]);
        // Both walkers list it, so the batch used by the native run agrees.
        assert_eq!(walked(&first.join("app")), ["broken.ts", "own.ts"]);
    }

    #[test]
    fn a_dangling_link_named_like_an_ignored_directory_is_skipped_so_its_target_appearing_changes_nothing() {
        let root = workspace("dangling-ignored");

        write(&root, "app/own.ts", "own");
        symlink("../build/out", root.join("app/dist")).unwrap();

        let before = walked(&root.join("app"));

        write(&root, "build/out/a.js", "built");

        assert_eq!(before, ["own.ts"]);
        assert_eq!(walked(&root.join("app")), before);
    }

    #[test]
    fn a_dangling_link_gets_its_target_hashed_once_the_target_exists() {
        let root = workspace("dangling-appears");

        fs::create_dir_all(root.join("app")).unwrap();
        symlink("../libs/late.ts", root.join("app/late.ts")).unwrap();

        let marker = hashes(&root.join("app"))["late.ts"].clone();

        write(&root, "libs/late.ts", "now here");

        assert_ne!(hashes(&root.join("app"))["late.ts"], marker);
        assert_eq!(hashes(&root.join("app"))["late.ts"], hash_bytes(b"now here"));
    }

    #[test]
    fn a_symlink_to_something_that_is_not_a_regular_file_is_skipped() {
        let root = workspace("device");

        write(&root, "app/own.ts", "own");
        symlink("/dev/null", root.join("app/null")).unwrap();

        assert_eq!(walked(&root.join("app")), ["own.ts"]);
    }
}
