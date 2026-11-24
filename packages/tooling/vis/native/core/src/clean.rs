//! Workspace clean: find and remove `node_modules` directories (and optionally the root
//! lockfiles). Shared by the napi addon's `cleanWorkspace` (`src/pm_clean.rs`) and the `vis`
//! CLI's native `clean`, so both remove the same paths.
//!
//! Two walks exist on purpose, because the Node command orders its output differently for each.
//! The removal walk keeps `read_dir` order (`find_node_modules`); the `--dry-run` listing visits
//! entries in byte order, like the TypeScript walker (`findNodeModulesDirectories`), so its
//! output matches Node's. Neither follows a symlink or a junction: a link is never a workspace
//! directory, so a run lists, and removes, exactly the paths the dry run showed, and a link that
//! points outside the workspace (or back into it) cannot lead the removal elsewhere.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::lockfiles::LOCKFILES;

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

/// Removal walk: every `node_modules` below `root`, not descending into one. A symlink is
/// never followed or listed, and the entries come in `read_dir` order.
pub fn find_node_modules(root: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let mut dirs_to_visit = vec![root.to_path_buf()];

    while let Some(dir) = dirs_to_visit.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            // `DirEntry::file_type` does not follow a symlink, so a link is neither a directory here nor walked.
            if !entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
                continue;
            }

            let path = entry.path();

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

/// The lockfiles present directly in `root`, in `LOCKFILES` order, which is the order the Node handler checks them.
pub fn find_lockfiles(root: &Path) -> Vec<PathBuf> {
    LOCKFILES.iter().map(|(name, _)| root.join(name)).filter(|path| path.exists()).collect()
}

/// Removes every `node_modules` below `root` (the root's own last, because the running `vis`
/// resolves itself through it), then the root lockfiles when `remove_lockfile` is set.
pub fn clean_workspace(root: &Path, remove_lockfile: bool) -> CleanOutcome {
    let mut node_modules_dirs = find_node_modules(root);

    // `sort_by_key` is stable, so only the root entry (key `true`) moves to the end.
    let root_node_modules = root.join("node_modules");
    node_modules_dirs.sort_by_key(|dir| *dir == root_node_modules);

    let lockfiles = if remove_lockfile { find_lockfiles(root) } else { Vec::new() };

    remove_listed(&node_modules_dirs, &lockfiles)
}

/// Removes exactly the given directories, in order, then the given lockfiles. A caller that has
/// already walked the tree and checked its paths passes those same paths here, so nothing is
/// walked twice and nothing else is removed.
///
/// `remove_dir_all` does not follow a symlink, so a path that turned into a link between the walk
/// and the removal is unlinked itself.
pub fn remove_listed(directories: &[PathBuf], lockfiles: &[PathBuf]) -> CleanOutcome {
    let mut outcome = CleanOutcome::default();

    for dir in directories {
        let dir_str = dir.to_string_lossy().to_string();

        match fs::remove_dir_all(dir) {
            Ok(()) => outcome.removed.push(dir_str),
            Err(error) => outcome.errors.push(format!("{dir_str}: {error}")),
        }
    }

    for lockfile in lockfiles {
        let lockfile_str = lockfile.to_string_lossy().to_string();

        match fs::remove_file(lockfile) {
            Ok(()) => outcome.lockfiles_removed.push(lockfile_str),
            Err(error) => outcome.errors.push(format!("{lockfile_str}: {error}")),
        }
    }

    outcome
}

#[cfg(test)]
mod tests {
    use super::find_node_modules;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("vis-core-clean-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();

        directory
    }

    #[cfg(unix)]
    fn sorted(mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
        paths.sort();

        paths
    }

    /// A workspace with a real `node_modules` and a symlink to a directory outside it that holds one.
    #[cfg(unix)]
    fn workspace_with_outside_link(name: &str) -> (PathBuf, PathBuf) {
        let base = scratch(name);
        let workspace = base.join("workspace");
        let outside = base.join("other-repo");

        fs::create_dir_all(workspace.join("packages/app/node_modules")).unwrap();
        fs::create_dir_all(workspace.join("vendor")).unwrap();
        fs::create_dir_all(outside.join("node_modules")).unwrap();
        fs::write(outside.join("node_modules/keep.js"), "").unwrap();
        std::os::unix::fs::symlink(&outside, workspace.join("vendor/lib")).unwrap();

        (workspace, outside)
    }

    #[cfg(unix)]
    #[test]
    fn the_removal_walk_does_not_follow_a_symlink_out_of_the_workspace() {
        let (workspace, outside) = workspace_with_outside_link("outside-walk");

        assert_eq!(find_node_modules(&workspace), vec![workspace.join("packages/app/node_modules")]);

        let outcome = super::clean_workspace(&workspace, false);

        assert!(outcome.errors.is_empty());
        assert!(outside.join("node_modules/keep.js").exists(), "a directory outside the workspace was deleted");

        fs::remove_dir_all(workspace.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_removal_walk_and_the_dry_run_walk_list_the_same_paths() {
        let (workspace, _) = workspace_with_outside_link("same-paths");

        assert_eq!(sorted(find_node_modules(&workspace)), sorted(super::list_node_modules(&workspace)));

        fs::remove_dir_all(workspace.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cycle_ends_the_removal_walk() {
        let base = scratch("cycle");
        let workspace = base.join("workspace");

        fs::create_dir_all(workspace.join("packages/a/node_modules")).unwrap();
        std::os::unix::fs::symlink(&workspace, workspace.join("packages/a/loop")).unwrap();

        assert_eq!(find_node_modules(&workspace), vec![workspace.join("packages/a/node_modules")]);

        fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_node_modules_is_not_listed_by_either_walk() {
        let base = scratch("linked-node-modules");
        let workspace = base.join("workspace");

        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(base.join("store")).unwrap();
        std::os::unix::fs::symlink(base.join("store"), workspace.join("node_modules")).unwrap();

        assert!(find_node_modules(&workspace).is_empty());
        assert!(super::list_node_modules(&workspace).is_empty());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn real_nested_node_modules_are_found_but_not_descended_into() {
        let base = scratch("nested");
        let node_modules = Path::new("packages/app/node_modules");

        fs::create_dir_all(base.join(node_modules).join("dep/node_modules")).unwrap();

        assert_eq!(find_node_modules(&base), vec![base.join(node_modules)]);

        fs::remove_dir_all(&base).unwrap();
    }
}
