//! The entries of a cache directory (`collectCacheEntries`), their sizes and ages, and the statistics of the
//! per-user stores. Every function answers `None` where Node's behaviour for a name or a size cannot be reproduced.

use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::js::MAX_SAFE_INTEGER;

use super::dirs::BRANCH_SCOPE_DIRECTORY;

pub(crate) struct Entry {
    pub(crate) hash: String,
    pub(crate) mtime_ms: f64,
    pub(crate) size: u64,
}

/// `DEFAULT_MAX_CACHE_AGE` of the task runner's cache: an entry older than this is swept by `removeOldEntries`.
pub(crate) const DEFAULT_MAX_CACHE_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// `V2_ROOT`: the content-addressed subtree, which `removeOldEntries` leaves alone.
const V2_ROOT: &str = "v2";

/// Whether `removeOldEntries` looks at the top-level entry `name`: dot files and the `v2` store are not its.
pub(crate) fn is_sweep_candidate(name: &OsStr) -> bool {
    !name.as_encoded_bytes().starts_with(b".") && name != V2_ROOT
}

/// `Stats.mtimeMs`: seconds and nanoseconds combined in floating point.
#[cfg(unix)]
pub(crate) fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;

    metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1e6
}

#[cfg(not(unix))]
pub(crate) fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

/// Directory entries in the order `fs.readdir` returns them (libuv sorts by name, bytewise).
pub(crate) fn sorted_entries(directory: &Path) -> Option<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(directory).ok()?.collect::<Result<Vec<_>, _>>().ok()?;

    entries.sort_by(|a, b| a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes()));

    Some(entries)
}

/// `a + b`, or `None` once the sum is one a JavaScript number would round: Node adds sizes as JavaScript numbers, which
/// are exact only up to `Number.MAX_SAFE_INTEGER`.
pub(crate) fn add_safe(a: u64, b: u64) -> Option<u64> {
    a.checked_add(b).filter(|sum| *sum <= MAX_SAFE_INTEGER)
}

/// The summed size of `entries`, or `None` when Node's number would round it.
pub(crate) fn total_size(entries: &[Entry]) -> Option<u64> {
    entries.iter().try_fold(0, |total, entry| add_safe(total, entry.size))
}

/// Whether `@visulima/path` would read a backslash in `name` as a separator: Node joins every name it
/// reads, so a path it builds from such a name is not the one on disk.
pub(crate) fn has_backslash(name: &OsStr) -> bool {
    name.as_encoded_bytes().contains(&b'\\')
}

/// `sumDirectorySize`: files counted by `stat`, symlinks skipped, and a failure ends that directory's
/// loop while keeping what it already added. `None` when Node would not print the same number: a name
/// with a backslash, or a size past what a JavaScript number holds exactly.
pub(crate) fn sum_directory_size(directory: &Path) -> Option<u64> {
    let Some(entries) = sorted_entries(directory) else {
        return Some(0);
    };

    let mut total = 0;

    for entry in entries {
        let Ok(kind) = entry.file_type() else {
            break;
        };

        let name = entry.file_name();

        if has_backslash(&name) {
            return None;
        }

        // Node reads the name as UTF-8 with replacement characters, so a path it builds from a name
        // that is not UTF-8 names nothing: the directory below it reads as empty and a file fails.
        let utf8 = name.to_str().is_some();

        if kind.is_dir() {
            if utf8 {
                total = add_safe(total, sum_directory_size(&entry.path())?)?;
            }
        } else if kind.is_file() {
            match fs::metadata(entry.path()) {
                Ok(metadata) if utf8 => total = add_safe(total, metadata.len())?,
                _ => break,
            }
        }
    }

    Some(total)
}

/// `collectCacheEntries`, newest first. `None` when a name or a size needs Node's own handling.
pub(crate) fn collect_entries(directory: &str) -> Option<Vec<Entry>> {
    let Some(names) = sorted_entries(Path::new(directory)) else {
        return Some(Vec::new());
    };

    let mut entries = Vec::new();

    for entry in names {
        let name = entry.file_name();

        if name.as_encoded_bytes().starts_with(b".") || name == BRANCH_SCOPE_DIRECTORY {
            continue;
        }

        if has_backslash(&name) {
            return None;
        }

        // A name that is not UTF-8 cannot be stat-ed by the path Node builds from it: the entry is dropped.
        let Some(hash) = name.to_str() else {
            continue;
        };

        if !hash.is_ascii() {
            return None;
        }

        let Ok(metadata) = fs::metadata(entry.path()) else {
            continue;
        };

        if !metadata.is_dir() {
            continue;
        }

        entries.push(Entry {
            hash: hash.to_owned(),
            mtime_ms: mtime_ms(&metadata),
            size: sum_directory_size(&entry.path())?,
        });
    }

    // `entries.sort((a, b) => b.mtimeMs - a.mtimeMs)`: stable, so equal times keep name order.
    entries.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(Ordering::Equal));

    Some(entries)
}

/// `AuxStats` without the directory.
#[derive(Default)]
pub(crate) struct Stats {
    pub(crate) entries: u64,
    pub(crate) newest: Option<f64>,
    pub(crate) oldest: Option<f64>,
    pub(crate) total: u64,
}

impl Stats {
    /// The statistics of a task cache directory's entries, which `collect_entries` lists newest first.
    pub(crate) fn of_entries(entries: &[Entry]) -> Option<Self> {
        Some(Self {
            entries: entries.len() as u64,
            newest: entries.first().map(|entry| entry.mtime_ms),
            oldest: entries.last().map(|entry| entry.mtime_ms),
            total: total_size(entries)?,
        })
    }
}

/// The `getCacheStats` shared by the AI, Socket.dev, deps.dev and Snyk stores: the `.json` files of
/// each directory. `None` when Node would throw (an unreadable directory, a file that cannot be stat-ed).
pub(crate) fn store_stats(directories: &[PathBuf]) -> Option<Stats> {
    let mut stats = Stats::default();

    for directory in directories {
        if fs::metadata(directory).is_err() {
            continue;
        }

        for entry in fs::read_dir(directory).ok()? {
            let name = entry.ok()?.file_name();

            if !name.as_encoded_bytes().ends_with(b".json") {
                continue;
            }

            // A name that is not UTF-8 reaches `statSync` mangled and fails there.
            name.to_str()?;

            if has_backslash(&name) {
                return None;
            }

            let metadata = fs::metadata(directory.join(&name)).ok()?;
            let modified = mtime_ms(&metadata);

            stats.entries += 1;
            stats.total = add_safe(stats.total, metadata.len())?;
            stats.oldest = Some(stats.oldest.map_or(modified, |oldest| oldest.min(modified)));
            stats.newest = Some(stats.newest.map_or(modified, |newest| newest.max(modified)));
        }
    }

    Some(stats)
}

pub(crate) fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sweep_leaves_dot_files_and_the_v2_store_alone() {
        for name in [".commit", ".tmp", "v2"] {
            assert!(!is_sweep_candidate(OsStr::new(name)), "{name}");
        }

        for name in ["0123abcd", "v1", "v22", "branches"] {
            assert!(is_sweep_candidate(OsStr::new(name)), "{name}");
        }
    }

    #[test]
    fn sizes_past_a_javascript_number_are_left_to_node() {
        assert_eq!(add_safe(MAX_SAFE_INTEGER - 1, 1), Some(MAX_SAFE_INTEGER));
        assert_eq!(add_safe(MAX_SAFE_INTEGER, 1), None);
        assert_eq!(add_safe(u64::MAX, 1), None);
        assert_eq!(add_safe(0, MAX_SAFE_INTEGER + 1), None);

        let entry = |size| Entry { hash: String::new(), mtime_ms: 0.0, size };

        assert_eq!(total_size(&[entry(MAX_SAFE_INTEGER - 5), entry(5)]), Some(MAX_SAFE_INTEGER));
        assert_eq!(total_size(&[entry(MAX_SAFE_INTEGER - 5), entry(6)]), None);
    }

    #[test]
    fn backslash_names_are_left_to_node() {
        assert!(has_backslash(OsStr::new("a\\b")));
        assert!(!has_backslash(OsStr::new("a/b")));

        let directory = std::env::temp_dir().join(format!("vis-cache-backslash-{}", std::process::id()));

        fs::create_dir_all(directory.join("entry")).unwrap();
        fs::write(directory.join("entry").join("a\\b"), "x").unwrap();
        assert_eq!(sum_directory_size(&directory.join("entry")), None);
        assert!(collect_entries(directory.to_str().unwrap()).is_none());

        fs::remove_dir_all(&directory).unwrap();
    }
}
