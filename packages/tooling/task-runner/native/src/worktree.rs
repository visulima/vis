use napi::bindgen_prelude::*;
use napi_derive::napi;
use task_runner_core as core;

/// Detects whether the given workspace is a linked git worktree, and if so,
/// returns the path to the main worktree root.
///
/// Returns:
/// - `Ok(Some(main_root))` when `<workspace_root>/.git` is a *file* (gitlink) —
///   shells out to `git rev-parse --git-common-dir` and resolves to its parent.
/// - `Ok(None)` for primary checkouts, missing `.git`, shallow checkouts where
///   `git rev-parse` fails, or when the `git` binary is not available.
///
/// Results are memoized per canonicalized workspace_root for the lifetime of
/// the process. Symlinks in the input path are resolved before lookup so that
/// `/tmp/foo` and `/private/tmp/foo` share a cache entry.
#[napi(catch_unwind)]
pub fn get_main_worktree_root(workspace_root: String) -> Result<Option<String>> {
    core::get_main_worktree_root(&workspace_root).map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}

/// Returns true when `<workspace_root>/.git` exists and is a regular file
/// (the gitlink pointer used by `git worktree add`). False for primary
/// checkouts (where `.git` is a directory) and for non-git directories.
#[napi(catch_unwind)]
pub fn is_linked_worktree(workspace_root: String) -> Result<bool> {
    Ok(core::is_linked_worktree(&workspace_root))
}

/// Clears the memoization cache. Primarily useful for tests; production code
/// should never call this since worktree topology does not change at runtime.
#[napi(catch_unwind)]
pub fn reset_worktree_cache() {
    core::reset_worktree_cache()
}
