//! Where the cache lives: the directory a command reads (`@visulima/path` semantics for the plain POSIX paths this
//! module accepts), the branch and worktree scopes, the directories retention sees, and the per-user stores.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::entries::{has_backslash, sorted_entries};
use super::settings::Settings;

/// `DEFAULT_WORKSPACE_CACHE_DIRECTORY` in `src/util/vis-paths.ts`.
pub(crate) const DEFAULT_CACHE_DIRECTORY: &str = "node_modules/.cache/vis";

/// `BRANCH_SCOPE_DIRECTORY` in `src/commands/cache/entries.ts`.
pub(crate) const BRANCH_SCOPE_DIRECTORY: &str = "branches";

/// `--scope`.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Scope {
    Shared,
    Worktree,
    All,
}

impl Scope {
    /// The scope a `--scope` value names (`shared` when the flag is absent). `None` for a value Node must answer.
    pub(crate) fn from_flag(value: Option<&str>) -> Option<Self> {
        match value {
            None | Some("shared") => Some(Self::Shared),
            Some("worktree") => Some(Self::Worktree),
            Some("all") => Some(Self::All),
            Some(_) => None,
        }
    }
}

/// `CacheTarget` in `context.ts`.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Target {
    All,
    Task,
    Ai,
    Socket,
    DepsDev,
    Snyk,
}

impl Target {
    /// The store a `--type` value names (`all` when the flag is absent). `None` for a value Node must answer.
    pub(crate) fn from_flag(value: Option<&str>) -> Option<Self> {
        match value {
            None | Some("all") => Some(Self::All),
            Some("task") => Some(Self::Task),
            Some("ai") => Some(Self::Ai),
            Some("socket") => Some(Self::Socket),
            Some("deps-dev") => Some(Self::DepsDev),
            Some("snyk") => Some(Self::Snyk),
            Some(_) => None,
        }
    }

    pub(crate) fn includes(self, kind: Target) -> bool {
        self == Target::All || self == kind
    }
}

// ---------------------------------------------------------------------------------------------
// Paths: `@visulima/path` semantics for the plain POSIX paths this module accepts.
// ---------------------------------------------------------------------------------------------

/// Whether `@visulima/path` treats `path` like a plain POSIX path: no separators it rewrites, no drive
/// letter, no UNC form. Anything else is Node's.
pub(crate) fn is_plain_posix_path(path: &str) -> bool {
    let drive = path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && path.as_bytes().get(1) == Some(&b':');

    !path.contains(['\\', '\0']) && !path.starts_with("//") && !drive
}

/// `resolve(base, ...)` on POSIX for an absolute `base`: joins, then drops `.`, empty and resolved `..`.
pub(crate) fn resolve(base: &str, relative: &[&str]) -> String {
    let mut parts: Vec<&str> = Vec::new();

    for segment in std::iter::once(base).chain(relative.iter().copied()).flat_map(|text| text.split('/')) {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }

    format!("/{}", parts.join("/"))
}

/// `resolveCacheDirectory`: an absolute value is returned as written, a relative one is resolved.
fn normalize(root: &str, value: &str) -> Option<String> {
    if !is_plain_posix_path(value) {
        return None;
    }

    Some(if value.starts_with('/') { value.to_owned() } else { resolve(root, &[value]) })
}

/// `resolveSharedCacheDirectory`.
pub(crate) fn resolve_cache_directory(
    root: &Path,
    option: Option<&str>,
    config: Option<&str>,
    shared: bool,
) -> Option<String> {
    let root_text = root.to_str().filter(|text| is_plain_posix_path(text))?;
    let env_value = match env::var("VIS_CACHE_DIRECTORY") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => return None,
    };

    let explicit = option.or(config).or(env_value.as_deref());

    if explicit.is_some_and(|value| !value.is_empty()) {
        let chosen = [option, config, env_value.as_deref()].into_iter().flatten().find(|value| !value.is_empty())?;

        return normalize(root_text, chosen);
    }

    let anchor = if shared { shared_anchor(root)? } else { root.to_path_buf() };
    let anchor_text = anchor.to_str().filter(|text| is_plain_posix_path(text) && text.starts_with('/'))?;

    Some(resolve(anchor_text, &[DEFAULT_CACHE_DIRECTORY]))
}

/// The directory the shared task cache hangs off: the main worktree's root when `root` is a linked worktree, else
/// `root`. `None` when the lookup fails, which hands the run to Node.
fn shared_anchor(root: &Path) -> Option<PathBuf> {
    match task_runner_core::get_main_worktree_root(root.to_str()?) {
        Ok(Some(main)) => Some(PathBuf::from(main)),
        Ok(None) => Some(root.to_path_buf()),
        Err(_) => None,
    }
}

/// The task cache directory a run resolves without a config, a flag or `VIS_CACHE_DIRECTORY`:
/// `<main worktree root>/node_modules/.cache/vis`.
pub(crate) fn default_task_cache_directory(root: &Path) -> Option<PathBuf> {
    Some(shared_anchor(root)?.join(DEFAULT_CACHE_DIRECTORY))
}

/// `sanitizeBranchSegment`.
fn branch_slug(branch: &str) -> String {
    let mut slug = String::new();
    let mut in_run = false;

    for character in branch.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
            slug.push(character);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }

    // Every character left is ASCII, so bytes and UTF-16 units agree.
    let mut slug = slug.trim_matches('-').to_owned();

    slug.truncate(64);

    slug
}

/// `detectGitBranch`: the same `git` call, with its failures as `None`.
fn detect_git_branch(cwd: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_owned();

    (!branch.is_empty() && branch != "HEAD").then_some(branch)
}

/// `applyBranchScope`.
fn apply_branch_scope(directory: String, root: &Path, enabled: bool) -> String {
    if !enabled {
        return directory;
    }

    let Some(branch) = detect_git_branch(root) else {
        return directory;
    };

    let slug = branch_slug(&branch);

    if slug.is_empty() {
        return directory;
    }

    resolve(&directory, &[BRANCH_SCOPE_DIRECTORY, &slug])
}

/// `hasUnscopedEntries`: a directory entry (a symlink does not count) outside the branch container.
fn has_unscoped_entries(base: &str) -> bool {
    if fs::metadata(base).is_err() {
        return false;
    }

    let Ok(entries) = fs::read_dir(base) else {
        return false;
    };

    // A failing entry makes Node's `readdirSync` throw, which its `catch` turns into `false`.
    let mut found = false;

    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };

        let name = entry.file_name();

        if entry.file_type().is_ok_and(|kind| kind.is_dir())
            && !name.as_encoded_bytes().starts_with(b".")
            && name != BRANCH_SCOPE_DIRECTORY
        {
            found = true;
        }
    }

    found
}

/// The path Node lists for the branch directory at `path`: `Ok(Some(path))` for a UTF-8 name, `Ok(None)` for one
/// that is not (Node reads the mangled path as an empty directory, which adds nothing to a count), and `Err(())`
/// for one that is not when the command prints a block for each directory (`cache prune` names the mangled path
/// in it, which is not reproduced).
#[cfg(unix)]
fn branch_directory(path: &Path, per_directory_output: bool) -> Result<Option<String>, ()> {
    match path.to_str() {
        Some(text) => Ok(Some(text.to_owned())),
        None if per_directory_output => Err(()),
        None => Ok(None),
    }
}

/// `evictionDirectories`: `base` and, when branch scoping applies, the subtree of every branch. `None` when a
/// branch directory has a name `@visulima/path` would rewrite, or (with `per_directory_output`, for a command that
/// prints a block for each directory) a name that is not UTF-8.
#[cfg(unix)]
pub(crate) fn eviction_directories(base: &str, branch_scoped: bool, per_directory_output: bool) -> Option<Vec<String>> {
    let mut directories = vec![base.to_owned()];

    if !branch_scoped {
        return Some(directories);
    }

    let branches = resolve(base, &[BRANCH_SCOPE_DIRECTORY]);

    if fs::metadata(&branches).is_err() {
        return Some(directories);
    }

    // A failing read makes Node's `readdirSync` throw, which its `catch` turns into the base alone.
    let Some(entries) = sorted_entries(Path::new(&branches)) else {
        return Some(directories);
    };

    for entry in entries.iter().filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir())) {
        if has_backslash(&entry.file_name()) {
            return None;
        }

        // A name that is not UTF-8 reaches Node mangled, and the directory it names reads as empty.
        if let Some(path) = branch_directory(&entry.path(), per_directory_output).ok()? {
            directories.push(path);
        }
    }

    Some(directories)
}

/// The `(base, branch-scoped)` directory of each scope `scope` selects, as `resolveCacheDirectoryFromContext` pairs them.
fn selected_directories(
    root: &Path,
    cache_dir: Option<&str>,
    scope: Scope,
    settings: &Settings,
) -> Option<Vec<(String, String)>> {
    let config = settings.cache_directory.as_deref();

    let worktree_base = resolve_cache_directory(root, cache_dir, config, false)?;
    let shared_base = resolve_cache_directory(root, cache_dir, config, settings.shared_worktree)?;
    let worktree_scoped = apply_branch_scope(worktree_base.clone(), root, settings.branch_scoped);
    let shared_scoped = apply_branch_scope(shared_base.clone(), root, settings.branch_scoped);

    Some(match scope {
        Scope::All if shared_scoped == worktree_scoped => vec![(shared_base, shared_scoped)],
        Scope::All => vec![(shared_base, shared_scoped), (worktree_base, worktree_scoped)],
        Scope::Worktree => vec![(worktree_base, worktree_scoped)],
        Scope::Shared => vec![(shared_base, shared_scoped)],
    })
}

/// `directoriesFor("evict")`: retention sees every branch's entries, so each selected base is expanded to the
/// base and its branch subtrees.
#[cfg(unix)]
pub(crate) fn evict_directories(
    root: &Path,
    cache_dir: Option<&str>,
    scope: Scope,
    settings: &Settings,
) -> Option<Vec<String>> {
    let mut directories: Vec<String> = Vec::new();

    for (base, _) in selected_directories(root, cache_dir, scope, settings)? {
        for directory in eviction_directories(&base, settings.branch_scoped, true)? {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        }
    }

    Some(directories)
}

/// `directoriesFor("read")` of `resolveCacheDirectoryFromContext`.
pub(crate) fn read_directories(
    root: &Path,
    cache_dir: Option<&str>,
    scope: Scope,
    settings: &Settings,
) -> Option<Vec<String>> {
    let selected = selected_directories(root, cache_dir, scope, settings)?;

    let mut directories: Vec<String> = Vec::new();

    for (base, scoped) in selected {
        let mut add = |directory: String| {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        };

        if scoped != base && has_unscoped_entries(&base) {
            add(scoped);
            add(base);
        } else {
            add(scoped);
        }
    }

    Some(directories)
}

/// `~/.vis/cache`, from a plain absolute `HOME` (what `os.homedir()` returns on POSIX).
pub(crate) fn vis_cache_dir() -> Option<String> {
    let home = env::var("HOME").ok().filter(|home| home.starts_with('/') && is_plain_posix_path(home))?;

    Some(resolve(&home, &[".vis", "cache"]))
}

/// The directories of the auxiliary stores, as `vis-paths.ts` and the security caches lay them out.
pub(crate) fn store_directories(target: Target, home_cache: &str) -> Vec<PathBuf> {
    let join = |parts: &[&str]| PathBuf::from(resolve(home_cache, parts));

    match target {
        Target::Ai => vec![join(&["ai"])],
        Target::Socket => vec![join(&["socket-security"])],
        Target::DepsDev => {
            vec![join(&["deps-dev", "versions"]), join(&["deps-dev", "projects"]), join(&["deps-dev", "advisories"])]
        }
        Target::Snyk => vec![join(&["snyk", "issues"])],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flags_name_a_scope_and_a_store() {
        assert!(Scope::from_flag(None) == Some(Scope::Shared));
        assert!(Scope::from_flag(Some("worktree")) == Some(Scope::Worktree));
        assert!(Scope::from_flag(Some("all")) == Some(Scope::All));
        assert!(Scope::from_flag(Some("ALL")).is_none());
        assert!(Target::from_flag(None) == Some(Target::All));
        assert!(Target::from_flag(Some("deps-dev")) == Some(Target::DepsDev));
        assert!(Target::from_flag(Some("nope")).is_none());
    }

    #[test]
    fn the_default_directory_hangs_off_the_root_outside_a_linked_worktree() {
        let directory = std::env::temp_dir().join(format!("vis-cache-default-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();
        assert_eq!(default_task_cache_directory(&directory), Some(directory.join("node_modules/.cache/vis")));
        fs::remove_dir_all(&directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_branch_directory_is_left_to_node_by_a_command_that_prints_each_directory() {
        use std::os::unix::ffi::OsStrExt;

        let name = std::ffi::OsStr::from_bytes(b"/cache/branches/caf\xe9");
        let plain = Path::new("/cache/branches/main");

        // `cache prune` prints a block naming the (mangled) path, which is not reproduced.
        assert_eq!(branch_directory(Path::new(name), true), Err(()));
        // A count reads the mangled path as an empty directory, so the directory adds nothing.
        assert_eq!(branch_directory(Path::new(name), false), Ok(None));
        assert_eq!(branch_directory(plain, true), Ok(Some("/cache/branches/main".to_owned())));
        assert_eq!(branch_directory(plain, false), Ok(Some("/cache/branches/main".to_owned())));
    }

    #[test]
    fn paths_resolve_like_visulima_path() {
        assert_eq!(resolve("/a/b", &["../c//d/./e/"]), "/a/c/d/e");
        assert_eq!(resolve("/a", &["../../../../z"]), "/z");
        assert_eq!(resolve("/x/../y", &["branches", "s"]), "/y/branches/s");
        assert_eq!(normalize("/a", "/x/../y").as_deref(), Some("/x/../y"));
        assert_eq!(normalize("/a", "x/./y").as_deref(), Some("/a/x/y"));
        assert_eq!(normalize("/a", "C:/x"), None);
        assert_eq!(normalize("/a", "//srv/x"), None);
        assert_eq!(normalize("/a", "x\\y"), None);
    }

    #[test]
    fn branch_names_become_slugs() {
        assert_eq!(branch_slug("feat/native cache"), "feat-native-cache");
        assert_eq!(branch_slug("--x--"), "x");
        assert_eq!(branch_slug("v1.2_rc"), "v1.2_rc");
        assert_eq!(branch_slug(&"a".repeat(80)).len(), 64);
        assert_eq!(branch_slug("ü"), "");
    }
}
