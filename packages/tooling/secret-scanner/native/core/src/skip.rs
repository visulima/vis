// Content the scan could not read, from the walker, the file reader and the archive walk.

use std::io;
use std::path::PathBuf;

/// Why content was not scanned. Surfaces as `SkippedFile.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    PermissionDenied,
    /// E.g. a broken symlink passed to `scanFiles`.
    NotFound,
    /// Over `maxFileSize`, an archive bomb, or an archive whose byte / entry budget ran out.
    TooLarge,
    SymlinkLoop,
    IoError,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PermissionDenied => "permission-denied",
            Self::NotFound => "not-found",
            Self::TooLarge => "too-large",
            Self::SymlinkLoop => "symlink-loop",
            Self::IoError => "io-error",
        }
    }
}

/// Reason for a file or directory the walker or the reader failed on.
impl From<&io::Error> for SkipReason {
    fn from(err: &io::Error) -> Self {
        match err.kind() {
            io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            io::ErrorKind::NotFound => Self::NotFound,
            _ => Self::IoError,
        }
    }
}

/// Content that could not be scanned: the file on disk, the archive-entry suffix
/// (`!dir/file.env`, empty for the file itself) and the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub path: PathBuf,
    pub entry: String,
    pub reason: SkipReason,
}

impl Skipped {
    /// The file itself, not an entry inside it.
    pub fn file(path: PathBuf, reason: SkipReason) -> Self {
        Self { path, entry: String::new(), reason }
    }
}
