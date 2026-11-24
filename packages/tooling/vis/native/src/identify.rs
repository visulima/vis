use std::path::PathBuf;

use napi_derive::napi;
use prek_identify::{tags as prek_tags, tags_from_path as prek_tags_from_path};

fn classify(path: &str) -> Vec<String> {
    let path = PathBuf::from(path);

    match prek_tags_from_path(&path) {
        Ok(set) => set.iter().map(|tag| tag.to_string()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Classifies each path using `prek-identify`. Returns one tag list per input
/// path in the same order, covering the extensions, interpreters and metadata
/// tags that pre-commit / prek would associate with the file. Errors for
/// individual paths collapse to empty vectors so partial classification
/// failures don't fail the whole batch (the same behavior pre-commit applies
/// when stat-ing a deleted staged file mid-run).
#[napi]
pub fn tags_from_paths(paths: Vec<String>) -> Vec<Vec<String>> {
    paths.iter().map(|p| classify(p)).collect()
}

/// Returns the full prek-identify tag universe. Used by the vis migrator
/// to validate `types:` / `types_or:` / `exclude_types:` filters in
/// migrated `.pre-commit-config.yaml` files — anything outside this set
/// (and outside the vis-specific overlay) is surfaced as a warning.
#[napi]
pub fn all_known_tags() -> Vec<String> {
    prek_tags::ALL_TAGS.iter().map(|t| t.to_string()).collect()
}
