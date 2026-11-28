//! The 60 second result cache of `src/util/catalog/outdated.ts` (`outdated-cache.json` in the vis cache directory of
//! the workspace): the same file, key, hash and shape, so a native run and a Node run read each other's answers.
//!
//! Node asks `findCacheDirSync("vis", { create: true, cwd: root })`, which is `<root>/node_modules/.cache/vis` for a
//! root that holds a `package.json`, created when it is missing. A `CACHE_DIR` in the environment moves it, and a
//! directory that exists without being writable switches the cache off in Node; both are the reason to hand the run
//! to Node here. A cache entry that matches this run's hash and is fresh but is not shaped like one of this port's
//! (a run with security data wrote it) is Node's for the same reason.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use super::catalogs::Catalog;
use super::outdated::Outdated;
use super::version::UpdateType;
use crate::json::{self, Json};

/// `OUTDATED_CACHE_TTL_MS`.
const TTL_MS: i64 = 60_000;

const FILE: &str = "outdated-cache.json";

/// What a run asks that the answer depends on, besides the dependencies themselves.
pub(super) struct Key<'a> {
    pub(super) exclude: &'a [String],
    pub(super) include: &'a [String],
    pub(super) include_prerelease: bool,
    pub(super) security: bool,
    pub(super) target: &'a str,
}

/// The part of a run's result the command prints.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Cached {
    pub(super) failed: Vec<String>,
    pub(super) outdated: Vec<Outdated>,
}

/// `computeCacheHash`: djb2 over the UTF-16 units of the text that names the run.
pub(super) fn hash(catalogs: &[Catalog], key: &Key<'_>) -> String {
    let mut parts: Vec<String> = Vec::new();

    for catalog in catalogs {
        for (package, range) in &catalog.dependencies {
            parts.push(format!("{}:{package}={range}", catalog.name));
        }
    }

    parts.push(format!("target={},pre={},chan=_,sec={}", key.target, key.include_prerelease, key.security));
    parts.push(format!("in={},ex={},ig=", key.include.join(","), key.exclude.join(",")));
    parts.push("locked=false".to_owned());
    parts.push("mra=0".to_owned());
    parts.push("socket=false".to_owned());

    let mut value: i32 = 5381;

    for unit in parts.join("|").encode_utf16() {
        value = value.wrapping_shl(5).wrapping_add(value).wrapping_add(i32::from(unit));
    }

    value.to_string()
}

#[cfg(unix)]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    let Ok(text) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };

    // SAFETY: `access` reads the NUL-terminated path it is given and nothing else.
    unsafe { libc::access(text.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn writable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| !metadata.permissions().readonly())
}

/// The cache file of the workspace at `root`, creating the directory as Node does, or the reason Node's cache is
/// not the one this port would use.
pub(super) fn file(root: &Path) -> Result<PathBuf, String> {
    // JavaScript reads an empty value as unset, and these four as "no directory named".
    if let Some(directory) = env::var_os("CACHE_DIR") {
        if !directory.is_empty() && !matches!(directory.to_str(), Some("0" | "1" | "false" | "true")) {
            return Err("CACHE_DIR moves the cache".to_owned());
        }
    }

    let directory = root.join("node_modules").join(".cache").join("vis");

    if directory.exists() {
        if !directory.is_dir() || !writable(&directory) {
            return Err("the cache directory is not a writable directory".to_owned());
        }
    } else {
        fs::create_dir_all(&directory).map_err(|error| format!("the cache directory cannot be created: {error}"))?;
    }

    Ok(directory.join(FILE))
}

fn text_list(value: &Json) -> Option<Vec<String>> {
    let Json::Array(items) = value else { return None };

    items.iter().map(|item| item.as_str().map(str::to_owned)).collect()
}

/// An entry as this port writes it: the six fields, all text, in order.
fn entry(value: &Json) -> Option<Outdated> {
    let Json::Object(fields) = value else { return None };
    let names: Vec<&str> = fields.iter().map(|(name, _)| name.as_str()).collect();

    if names != ["catalogName", "currentRange", "newRange", "packageName", "targetVersion", "updateType"] {
        return None;
    }

    let text = |name: &str| value.get(name).and_then(Json::as_str).map(str::to_owned);

    Some(Outdated {
        catalog_name: text("catalogName")?,
        current_range: text("currentRange")?,
        new_range: text("newRange")?,
        package_name: text("packageName")?,
        target_version: text("targetVersion")?,
        update_type: match text("updateType")?.as_str() {
            "major" => UpdateType::Major,
            "minor" => UpdateType::Minor,
            "patch" => UpdateType::Patch,
            _ => return None,
        },
    })
}

/// `readOutdatedCache`: the fresh entry of this run, `Ok(None)` when there is none, or the reason the entry is Node's.
pub(super) fn read(file: &Path, hash: &str, now_ms: i64) -> Result<Option<Cached>, String> {
    let Ok(text) = fs::read_to_string(file) else { return Ok(None) };

    let Some(document) = json::parse(&text) else {
        // A file that is no JSON is a miss in Node too (it catches the parse error); one that is JSON this crate's reader
        // leaves alone may be a hit there.
        return if serde_json::from_str::<serde_json::Value>(&text).is_err() {
            Ok(None)
        } else {
            Err("the cache holds JSON this crate does not read the way JavaScript does".to_owned())
        };
    };

    if document.get("hash").and_then(Json::as_str) != Some(hash) {
        return Ok(None);
    }

    let Some(Json::Int(timestamp)) = document.get("timestamp") else {
        return Err("the cache entry has no integer timestamp".to_owned());
    };

    if now_ms - timestamp >= TTL_MS {
        return Ok(None);
    }

    let result = document.get("result").ok_or("the cache entry has no result")?;
    let failed = result.get("failed").and_then(text_list).ok_or("the cached `failed` is not a list of names")?;
    let Some(Json::Array(items)) = result.get("outdated") else {
        return Err("the cached `outdated` is not a list".to_owned());
    };
    let outdated = items
        .iter()
        .map(entry)
        .collect::<Option<Vec<_>>>()
        .ok_or("the cached `outdated` holds an entry this port does not write")?;

    Ok(Some(Cached { failed, outdated }))
}

fn entry_json(entry: &Outdated) -> Json {
    let field = |name: &str, value: &str| (name.to_owned(), Json::Str(value.to_owned()));

    Json::Object(vec![
        field("catalogName", &entry.catalog_name),
        field("currentRange", &entry.current_range),
        field("newRange", &entry.new_range),
        field("packageName", &entry.package_name),
        field("targetVersion", &entry.target_version),
        field("updateType", entry.update_type.label()),
    ])
}

/// What `writeOutdatedCache` writes: `JSON.stringify({ hash, result, timestamp }, null, "\t")` and a newline. The
/// counts are what `checkOutdated` returns; `ignored` is empty because the command has no `update.ignore`.
pub(super) fn document(
    hash: &str,
    checked: usize,
    failed: &[String],
    filtered: &[Outdated],
    outdated: &[Outdated],
    now_ms: i64,
) -> String {
    let list = |items: Vec<Json>| Json::Array(items);
    let result = Json::Object(vec![
        ("checkedCount".to_owned(), Json::Int(i64::try_from(checked).unwrap_or(i64::MAX))),
        ("failed".to_owned(), list(failed.iter().map(|name| Json::Str(name.clone())).collect())),
        ("filteredByTarget".to_owned(), list(filtered.iter().map(entry_json).collect())),
        ("ignored".to_owned(), list(Vec::new())),
        ("outdated".to_owned(), list(outdated.iter().map(entry_json).collect())),
    ]);
    let whole = Json::Object(vec![
        ("hash".to_owned(), Json::Str(hash.to_owned())),
        ("result".to_owned(), result),
        ("timestamp".to_owned(), Json::Int(now_ms)),
    ]);

    format!("{}\n", json::stringify(&whole, "\t"))
}

/// `writeOutdatedCache`: failing to write is not an error, as in Node.
pub(super) fn write(file: &Path, text: &str) {
    fs::write(file, text).ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Vec<Catalog> {
        vec![
            Catalog {
                name: ".:dependencies".into(),
                dependencies: vec![
                    ("calm".into(), "^1.0.0".into()),
                    ("@scope/scoped".into(), "^1.0.0".into()),
                    ("exact".into(), "1.0.0".into()),
                ],
            },
            Catalog {
                name: ".:devDependencies".into(),
                dependencies: vec![("devtool".into(), "~2.0.0".into()), ("uptodate".into(), "^3.0.0".into())],
            },
            Catalog { name: "packages/app:dependencies".into(), dependencies: vec![("calm".into(), "^1.1.0".into())] },
        ]
    }

    #[test]
    fn the_hash_is_the_one_node_computes() {
        let key = Key { exclude: &[], include: &[], include_prerelease: false, security: false, target: "minor" };

        // Taken from the file a Node run of the same project wrote.
        assert_eq!(hash(&catalog(), &key), "-1001060191");
        assert_ne!(hash(&catalog(), &Key { security: true, ..key }), "-1001060191");
    }

    fn entry_of(name: &str) -> Outdated {
        Outdated {
            catalog_name: ".:dependencies".into(),
            current_range: "^1.0.0".into(),
            new_range: "^1.2.0".into(),
            package_name: name.into(),
            target_version: "1.2.0".into(),
            update_type: UpdateType::Minor,
        }
    }

    #[test]
    fn the_file_is_written_as_node_writes_it_and_read_back() {
        let text = document("123", 4, &["@scope/scoped".to_owned()], &[], &[entry_of("calm")], 1_795_851_041_967);

        assert!(text.starts_with("{\n\t\"hash\": \"123\",\n\t\"result\": {\n\t\t\"checkedCount\": 4,\n\t\t\"failed\": [\n\t\t\t\"@scope/scoped\"\n\t\t],\n\t\t\"filteredByTarget\": [],\n\t\t\"ignored\": [],\n"));
        assert!(text.ends_with("\t},\n\t\"timestamp\": 1795851041967\n}\n"));

        let directory = std::env::temp_dir().join(format!("vis-check-cache-{}", std::process::id()));

        fs::create_dir_all(&directory).expect("create a directory");

        let path = directory.join(FILE);

        write(&path, &text);

        let hit = read(&path, "123", 1_795_851_041_967 + 59_999).expect("reads").expect("a hit");

        assert_eq!(hit, Cached { failed: vec!["@scope/scoped".into()], outdated: vec![entry_of("calm")] });
        assert_eq!(read(&path, "123", 1_795_851_041_967 + 60_000).expect("reads"), None);
        assert_eq!(read(&path, "124", 1_795_851_041_967).expect("reads"), None);
        assert_eq!(read(&directory.join("missing.json"), "123", 0).expect("reads"), None);

        fs::write(&path, "{ not json").expect("write a file");

        assert_eq!(read(&path, "123", 0).expect("reads"), None);

        // An entry with security data, or a timestamp that is not an integer, is Node's to read.
        fs::write(&path, r#"{"hash":"123","result":{"failed":[],"outdated":[{"packageName":"a","vulnerabilities":[]}]},"timestamp":5}"#).expect("write a file");

        assert!(read(&path, "123", 6).is_err());

        fs::write(&path, r#"{"hash":"123","result":{"failed":[],"outdated":[]},"timestamp":5.5}"#)
            .expect("write a file");

        assert!(read(&path, "123", 6).is_err());

        fs::remove_dir_all(directory).ok();
    }
}
