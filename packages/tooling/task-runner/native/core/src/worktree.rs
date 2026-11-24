use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{OnceLock, RwLock};

use crate::Error;

/// Cache of (workspace_root → main worktree root) results, keyed by canonicalized path.
/// `None` means "this workspace is not a linked worktree" (use the workspace root as-is).
/// `Some(path)` is the main worktree root.
fn cache() -> &'static RwLock<HashMap<PathBuf, Option<PathBuf>>> {
    static CACHE: OnceLock<RwLock<HashMap<PathBuf, Option<PathBuf>>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Detects whether the given workspace is a linked git worktree, and if so,
/// returns the path to the main worktree root.
///
/// Returns:
/// - `Ok(Some(main_root))` when `<workspace_root>/.git` is a *file* (gitlink) and
///   the checkout is a linked worktree (its git dir differs from the common one):
///   the top level of the main worktree.
/// - `Ok(None)` for primary checkouts, submodules and `--separate-git-dir`
///   checkouts (each is its own main worktree), missing `.git`, shallow checkouts
///   where `git rev-parse` fails, or when the `git` binary is not available.
///
/// Results are memoized per canonicalized workspace_root for the lifetime of
/// the process. Symlinks in the input path are resolved before lookup so that
/// `/tmp/foo` and `/private/tmp/foo` share a cache entry.
pub fn get_main_worktree_root(workspace_root: &str) -> Result<Option<String>, Error> {
    let canonical = canonicalize(workspace_root);

    {
        let read = cache().read().map_err(|e| Error::WorktreeCachePoisoned(e.to_string()))?;

        if let Some(cached) = read.get(&canonical) {
            return Ok(cached.as_ref().map(|p| p.to_string_lossy().into_owned()));
        }
    }

    let resolved = detect_main_worktree(&canonical);

    {
        let mut write = cache().write().map_err(|e| Error::WorktreeCachePoisoned(e.to_string()))?;

        write.insert(canonical, resolved.clone());
    }

    Ok(resolved.map(|p| p.to_string_lossy().into_owned()))
}

/// Returns true when `<workspace_root>/.git` exists and is a regular file
/// (the gitlink pointer used by `git worktree add`). False for primary
/// checkouts (where `.git` is a directory) and for non-git directories.
pub fn is_linked_worktree(workspace_root: &str) -> bool {
    Path::new(workspace_root).join(".git").is_file()
}

/// Clears the memoization cache. Primarily useful for tests; production code
/// should never call this since worktree topology does not change at runtime.
pub fn reset_worktree_cache() {
    if let Ok(mut write) = cache().write() {
        write.clear();
    }
}

fn detect_main_worktree(workspace_root: &Path) -> Option<PathBuf> {
    let git_path = workspace_root.join(".git");

    // Follow symlinks so a symlinked `.git` (pointing at a real gitlink file
    // or a real `.git` directory) is classified the same way as the target.
    // This keeps `detect_main_worktree` consistent with `is_linked_worktree`,
    // which uses `Path::is_file` (also follows symlinks).
    let metadata = fs::metadata(&git_path).ok()?;

    // Primary checkout: `.git` is a directory. Treat workspace_root as the
    // canonical root — no shared cache lookup needed.
    if metadata.file_type().is_dir() {
        return None;
    }

    // `.git` is a file (gitlink): a linked worktree, a submodule, or a checkout made with
    // `--separate-git-dir`. Only a linked worktree has a main checkout to share a cache with.
    if !metadata.file_type().is_file() {
        return None;
    }

    let git_dir = rev_parse(workspace_root, "--git-dir")?;
    let common_dir = rev_parse(workspace_root, "--git-common-dir")?;

    // A submodule or a separate-git-dir checkout owns its git dir: it is its own main worktree.
    if git_dir == common_dir {
        return None;
    }

    let main_root = main_checkout(&common_dir)?;

    if main_root == workspace_root {
        return None;
    }

    Some(main_root)
}

/// `git rev-parse <flag>` run in `directory`, canonicalized (git prints it relative to `directory`
/// for a plain layout and absolute otherwise).
fn rev_parse(directory: &Path, flag: &str) -> Option<PathBuf> {
    let output = Command::new("git").args(["rev-parse", flag]).current_dir(directory).output().ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    let text = stdout.trim();

    if text.is_empty() {
        return None;
    }

    canonicalize_existing(&directory.join(text))
}

/// The top level of the main worktree of the repository whose shared git dir is `common_dir`, when git
/// records it:
///
/// - `core.worktree` in the shared config (or its `config.worktree`) names it when the git dir does not sit inside the checkout
///   (a submodule's `<super>/.git/modules/<name>`); it is relative to the git dir.
/// - A git dir named `.git` sits inside it: the main worktree is its parent.
/// - A bare repository has no main worktree; its parent is the anchor, so worktrees of `<layout>/repo.git`
///   share `<layout>`.
///
/// Otherwise `None`: a checkout made with `--separate-git-dir` has none of those, and nothing in the git
/// dir says where the checkout is. The worktree then keeps its own cache rather than one in a guessed place.
///
/// `git worktree list` is not used: for such layouts it reports the git dir itself as the main entry.
fn main_checkout(common_dir: &Path) -> Option<PathBuf> {
    let config = |args: &[&str]| -> Option<String> {
        // `--git-dir` (not `--file <dir>/config`) so `config.worktree` is read too: with
        // `extensions.worktreeConfig`, which `git sparse-checkout init` enables, git moves
        // `core.worktree` there.
        let output = Command::new("git").arg("--git-dir").arg(common_dir).arg("config").args(args).output().ok()?;

        let text = String::from_utf8(output.stdout).ok()?;

        (output.status.success() && !text.trim().is_empty()).then(|| text.trim().to_owned())
    };

    if let Some(worktree) = config(&["--get", "core.worktree"]) {
        return canonicalize_existing(&common_dir.join(worktree));
    }

    if common_dir.file_name().is_some_and(|name| name == ".git")
        || config(&["--bool", "--get", "core.bare"]).as_deref() == Some("true")
    {
        return canonicalize_existing(common_dir.parent()?);
    }

    None
}

fn canonicalize(path: &str) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn canonicalize_existing(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}
