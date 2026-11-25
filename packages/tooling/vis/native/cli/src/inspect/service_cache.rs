//! The cache files of the marshalls that ask a web service (`downloads`, `archivedRepo`): one JSON object per file with
//! a `createdAt` and a `ttlMs`, read through `readJsonSync` and deleted when it is past its time or unreadable.
//!
//! A file this module does not read the way Node does (not JSON, not an object, no numeric `createdAt` and `ttlMs`, not
//! a regular file) is the reason to hand the run to Node: Node would delete or ignore it, and this module must not
//! guess which.

use std::fs;
use std::io;
use std::path::Path;

use super::packument::Cached;
use crate::keys_refresh::Js;

/// The entry of `file` as `readCached…` finds it: `Fresh` for one inside its time, `Fetch` for none (nothing to delete)
/// or one past its time (Node deletes it first, so `stale_file` is true).
pub(super) fn read(file: &Path, now_ms: f64) -> Result<Cached, String> {
    match fs::metadata(file) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("a cache path is not a regular file".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Cached::Fetch { stale_file: false }),
        Err(error) => return Err(format!("a cache file cannot be read: {error}")),
    }

    let text = fs::read_to_string(file).map_err(|error| format!("a cache file cannot be read: {error}"))?;
    let entry: Js = serde_json::from_str(&text).map_err(|_| "a cache file is not JSON this module reads".to_owned())?;
    let number = |key: &str| match entry.member(key) {
        Some(Js::Number(number)) => Some(*number),
        _ => None,
    };

    if !entry.is_object() {
        return Err("a cache file is not an object".to_owned());
    }

    let (Some(created), Some(ttl)) = (number("createdAt"), number("ttlMs")) else {
        return Err("a cache file has no numeric createdAt and ttlMs".to_owned());
    };

    if now_ms - created > ttl {
        return Ok(Cached::Fetch { stale_file: true });
    }

    Ok(Cached::Fresh(entry))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_is_fresh_stale_missing_or_odd() {
        let directory = std::env::temp_dir().join(format!("vis-inspect-service-cache-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let file = directory.join("e.json");
        let at = |text: &str, now: f64| {
            fs::write(&file, text).unwrap();

            read(&file, now)
        };

        assert!(matches!(read(&directory.join("none.json"), 0.0), Ok(Cached::Fetch { stale_file: false })));
        assert!(matches!(at(r#"{"createdAt":1000,"ttlMs":500,"x":1}"#, 1500.0), Ok(Cached::Fresh(_))));
        assert!(matches!(at(r#"{"createdAt":1000,"ttlMs":500}"#, 1501.0), Ok(Cached::Fetch { stale_file: true })));

        for odd in [
            "",
            "not json",
            "[]",
            "null",
            "{}",
            r#"{"createdAt":"1","ttlMs":5}"#,
            r#"{"createdAt":1}"#,
            r#"{"ttlMs":1}"#,
        ] {
            assert!(at(odd, 0.0).is_err(), "{odd}");
        }

        assert!(read(&directory, 0.0).is_err());

        fs::remove_dir_all(&directory).unwrap();
    }
}
