use napi::bindgen_prelude::*;
use napi_derive::napi;
use task_runner_core as core;

fn to_napi_error(error: core::Error) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

/// A single file hash result.
#[napi(object, object_from_js = false)]
pub struct FileHash {
    pub path: String,
    pub hash: String,
}

impl From<core::FileHash> for FileHash {
    fn from(file: core::FileHash) -> Self {
        Self { path: file.path, hash: file.hash }
    }
}

/// Computes the xxh3-128 hash of a single file.
/// Returns the hex-encoded hash string.
///
/// Uses xxHash xxh3 (same as Nx) for maximum hashing throughput.
/// xxh3 is ~5-10x faster than SHA-256 on modern CPUs with SIMD.
#[napi(catch_unwind)]
pub fn hash_file(file_path: String) -> Result<String> {
    core::hash_file(&file_path).map_err(to_napi_error)
}

/// Collects all files in a directory recursively, ignoring common non-source directories.
/// Returns a list of absolute file paths.
#[napi(catch_unwind)]
pub fn collect_files(dir: String) -> Result<Vec<String>> {
    Ok(core::collect_files(&dir))
}

/// Collects all files in a directory and computes xxh3-128 hashes for each,
/// using parallel processing via rayon for maximum throughput.
///
/// Returns a list of { path, hash } objects where path is relative to workspace_root.
#[napi(catch_unwind)]
pub fn hash_files_in_directory(dir: String, workspace_root: String) -> Result<Vec<FileHash>> {
    core::hash_files_in_directory(&dir, &workspace_root)
        .map(|files| files.into_iter().map(Into::into).collect())
        .map_err(to_napi_error)
}

/// Computes xxh3-128 hashes for multiple files in parallel.
/// Takes absolute file paths, returns relative_path + hash pairs.
#[napi(catch_unwind)]
pub fn hash_files_batch(file_paths: Vec<String>, workspace_root: String) -> Result<Vec<FileHash>> {
    Ok(core::hash_files_batch(&file_paths, &workspace_root).into_iter().map(Into::into).collect())
}

/// Computes an xxh3-128 hash from a string.
/// Useful for hashing command strings, JSON, etc.
#[napi(catch_unwind)]
pub fn hash_string(input: String) -> String {
    core::hash_string(&input)
}

/// Computes a combined xxh3-128 hash from multiple strings.
/// Strings are concatenated and hashed, producing a single deterministic hash.
#[napi(catch_unwind)]
pub fn hash_strings(inputs: Vec<String>) -> String {
    core::hash_strings(&inputs)
}
