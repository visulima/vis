use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;

#[napi(object, object_from_js = false)]
pub struct CleanResult {
    /// Directories that were removed
    pub removed: Vec<String>,
    /// Directories that failed to remove (with error messages)
    pub errors: Vec<String>,
    /// Lockfiles that were removed (when --lockfile flag used)
    pub lockfiles_removed: Vec<String>,
}

/// Safely removes all node_modules directories in a workspace.
///
/// Uses Rust's `fs::remove_dir_all` which correctly handles symlinks and
/// NTFS junctions on Windows without following them into targets.
///
/// When `remove_lockfile` is true, also removes lockfiles from the root.
#[napi(catch_unwind)]
pub fn clean_workspace(root: String, remove_lockfile: bool) -> napi::Result<CleanResult> {
    let root_path = PathBuf::from(&root);

    if !root_path.exists() {
        return Err(Error::new(Status::InvalidArg, format!("Directory does not exist: {root}")));
    }

    let outcome = vis_core::clean::clean_workspace(&root_path, remove_lockfile);

    Ok(CleanResult { removed: outcome.removed, errors: outcome.errors, lockfiles_removed: outcome.lockfiles_removed })
}
