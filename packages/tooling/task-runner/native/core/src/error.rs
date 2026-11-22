use std::{fmt, io};

/// Failures of the core operations. `Display` carries the exact text the napi
/// wrapper has always raised, so JS callers see unchanged messages.
#[derive(Debug)]
pub enum Error {
    GraphCycle,
    ReadFile { path: String, source: io::Error },
    ReadSingleFile(io::Error),
    WorktreeCachePoisoned(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GraphCycle => f.write_str("Graph contains cycles - topological sort is not possible"),
            Self::ReadFile { path, source } => write!(f, "Failed to read file {path}: {source}"),
            Self::ReadSingleFile(source) => write!(f, "Failed to read file: {source}"),
            Self::WorktreeCachePoisoned(reason) => write!(f, "worktree cache poisoned: {reason}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::ReadFile { source, .. } | Self::ReadSingleFile(source) => Some(source),
            Self::GraphCycle | Self::WorktreeCachePoisoned(_) => None,
        }
    }
}
