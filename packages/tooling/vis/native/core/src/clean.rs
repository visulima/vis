//! Workspace clean: find and remove `node_modules` directories (and optionally the root
//! lockfiles). Shared by the napi addon's `cleanWorkspace` (`src/pm_clean.rs`) and the `vis`
//! CLI's native `clean`, so both remove the same paths.
//!
//! Two walks exist on purpose, because the Node command uses two different ones. The removal
//! walk follows symlinked directories and keeps `read_dir` order (`find_node_modules`), like the
//! addon. The `--dry-run` listing does not follow symlinks and visits entries in byte order,
//! like the TypeScript walker (`findNodeModulesDirectories`), so its output matches Node's.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

/// Lockfiles removed by `--lockfile`, in the order the Node handler checks them.
pub const LOCKFILE_NAMES: [&str; 6] =
    ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"];

/// What a removal did, in the order it happened.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CleanOutcome {
    pub removed: Vec<String>,
    /// Failures, each formatted as `<path>: <io error>`.
    pub errors: Vec<String>,
    pub lockfiles_removed: Vec<String>,
}

fn skipped_by_walk(name: &str) -> bool {
    name == ".git" || name == ".hg"
}

/// Removal walk: every `node_modules` below `root`, not descending into one. Symlinked
/// directories are followed, and the entries come in `read_dir` order.
pub fn find_node_modules(root: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let mut dirs_to_visit = vec![root.to_path_buf()];

    while let Some(dir) = dirs_to_visit.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();

            if !path.is_dir() {
                continue;
            }

            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            if name_str == "node_modules" {
                results.push(path);
            } else if !skipped_by_walk(&name_str) {
                dirs_to_visit.push(path);
            }
        }
    }

    results
}

/// Dry-run walk: the same directories, without following symlinks and in the order the Node
/// TypeScript walker visits them (each directory's entries sorted by byte order).
pub fn list_node_modules(root: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Some(names) = sorted_entry_names(&dir) else {
            continue;
        };

        for name in names {
            let path = dir.join(&name);

            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };

            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }

            let name_str = name.to_string_lossy();

            if name_str == "node_modules" {
                results.push(path);
            } else if !skipped_by_walk(&name_str) {
                stack.push(path);
            }
        }
    }

    results
}

fn sorted_entry_names(dir: &Path) -> Option<Vec<OsString>> {
    let mut names = fs::read_dir(dir).ok()?.flatten().map(|entry| entry.file_name()).collect::<Vec<_>>();

    names.sort();

    Some(names)
}

/// The lockfiles present directly in `root`, in `LOCKFILE_NAMES` order.
pub fn find_lockfiles(root: &Path) -> Vec<PathBuf> {
    LOCKFILE_NAMES.iter().map(|name| root.join(name)).filter(|path| path.exists()).collect()
}

/// Removes every `node_modules` below `root` (the root's own last, because the running `vis`
/// resolves itself through it), then the root lockfiles when `remove_lockfile` is set.
///
/// `remove_dir_all` does not follow a symlink, so a linked `node_modules` is unlinked itself.
pub fn clean_workspace(root: &Path, remove_lockfile: bool) -> CleanOutcome {
    let mut node_modules_dirs = find_node_modules(root);

    // `sort_by_key` is stable, so only the root entry (key `true`) moves to the end.
    let root_node_modules = root.join("node_modules");
    node_modules_dirs.sort_by_key(|dir| *dir == root_node_modules);

    let mut outcome = CleanOutcome::default();

    for dir in &node_modules_dirs {
        let dir_str = dir.to_string_lossy().to_string();

        match fs::remove_dir_all(dir) {
            Ok(()) => outcome.removed.push(dir_str),
            Err(error) => outcome.errors.push(format!("{dir_str}: {error}")),
        }
    }

    if remove_lockfile {
        for lockfile in &find_lockfiles(root) {
            let lockfile_str = lockfile.to_string_lossy().to_string();

            match fs::remove_file(lockfile) {
                Ok(()) => outcome.lockfiles_removed.push(lockfile_str),
                Err(error) => outcome.errors.push(format!("{lockfile_str}: {error}")),
            }
        }
    }

    outcome
}
