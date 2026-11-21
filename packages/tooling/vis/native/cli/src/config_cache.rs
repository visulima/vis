//! The evaluated form of a `vis.config.*` that cannot be read as plain data.
//!
//! A config that needs JavaScript to evaluate (computed values, imports, `extends` presets) is
//! evaluated once by the Node CLI (`vis __emit-config`), and the result is kept under the cache
//! directory. A later run reads it back without starting Node as long as everything the
//! evaluation depended on is unchanged: the config file, the modules it imported, the
//! directories it listed and the environment variables it read. The emitter lists those
//! dependencies, and this module hashes them, so revalidation needs no Node at all.
//!
//! A result is only stored when the emitter could track everything the config touched. A config
//! that started a process, used the network, printed output or listed the whole environment is
//! evaluated again on every run instead. `VIS_NO_CONFIG_CACHE=1` turns this module off, and the
//! config is then handed to Node like any other dynamic config. Deleting the cache directory
//! (`<cache dir>/config`) forgets every stored result.

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bump with the stored layout; an entry with another schema is ignored.
const SCHEMA: u32 = 1;

/// Environment values shorter than this are never taken for secrets.
const MIN_SECRET_LENGTH: usize = 8;

/// The emitter's own output version (`EMIT_VERSION` in `src/config/emit.ts`).
const EMIT_VERSION: u32 = 1;

/// Set in the emitter's environment, so a config that starts `vis` itself is not evaluated again by that child.
const EMITTING: &str = "VIS_EMITTING_CONFIG";

/// What evaluating a config produced.
#[derive(Debug, PartialEq)]
pub enum Resolved {
    /// The merged user config (no secure defaults applied).
    Data(Value),
    /// The config holds values that are not data (functions in `plugins`, …); Node must run the command.
    NodeOnly,
}

#[derive(Debug, Deserialize)]
struct Emitted {
    version: u32,
    status: String,
    config: Option<Value>,
    files: Vec<EmittedFile>,
    env: Vec<String>,
    uncacheable: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct EmittedFile {
    path: String,
    kind: Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Dir,
    Exists,
    File,
}

#[derive(Debug, Serialize, Deserialize)]
struct Stored {
    schema: u32,
    vis_version: String,
    config_path: String,
    node_only: bool,
    config: Option<Value>,
    files: Vec<StoredFile>,
    env: Vec<StoredEnv>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredFile {
    path: String,
    kind: Kind,
    /// `None` when the path did not exist.
    hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredEnv {
    name: String,
    /// `None` when the variable was not set.
    hash: Option<String>,
}

/// The config at `config_path`, evaluated by Node on a miss and read back from the cache otherwise.
/// `None` means it could not be evaluated here (caching off, no Node entry, the config fails to
/// load, …), and the caller treats the config as dynamic.
pub fn resolve(config_path: &Path) -> Option<Resolved> {
    if env::var_os("VIS_NO_CONFIG_CACHE").is_some_and(|value| value == "1") || env::var_os(EMITTING).is_some() {
        return None;
    }

    let version = vis_version();
    let entry = entry_path(config_path, &version);

    if let Some(stored) = read_entry(&entry, config_path, &version) {
        return Some(stored);
    }

    let started = SystemTime::now();
    let emitted = emit(config_path)?;

    // The stored copy stands in for a later evaluation only when the evaluation was fully tracked and the
    // result is plain data. Anything else is remembered as "Node's to run" (the safe answer whatever changes),
    // so it is not evaluated again until one of the things it did track changes.
    let data = match (emitted.status.as_str(), emitted.config.as_ref()) {
        ("ok", Some(config)) if emitted.uncacheable.is_empty() && !holds_environment_value(config, &emitted.env) => {
            Some(config)
        }
        ("ok" | "node-only", _) => None,
        _ => return None,
    };

    store(&entry, config_path, &version, &emitted, data, started);

    Some(data.map_or(Resolved::NodeOnly, |config| Resolved::Data(config.clone())))
}

/// Whether the config carries a value it read from the environment (a token, a password), which must not
/// be written to the cache directory. Short values are ignored: they are flags and names, not secrets.
fn holds_environment_value(config: &Value, names: &[String]) -> bool {
    let secrets: Vec<String> =
        names.iter().filter_map(|name| env::var(name).ok()).filter(|value| value.len() >= MIN_SECRET_LENGTH).collect();

    !secrets.is_empty() && contains_any(config, &secrets)
}

fn contains_any(value: &Value, needles: &[String]) -> bool {
    match value {
        Value::String(text) => needles.iter().any(|needle| text.contains(needle.as_str())),
        Value::Array(items) => items.iter().any(|item| contains_any(item, needles)),
        Value::Object(map) => map.iter().any(|(key, item)| {
            needles.iter().any(|needle| key.contains(needle.as_str())) || contains_any(item, needles)
        }),
        _ => false,
    }
}

fn vis_version() -> String {
    env::var("VIS_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned())
}

/// `<cache dir>/config/<key>.json`, keyed by the config path and the vis version. The cache directory
/// is `VIS_CACHE_DIRECTORY` (resolved against the config's directory) or `node_modules/.cache/vis`
/// there. `taskRunner.cacheDirectory` cannot be used: it lives inside the config being cached.
fn entry_path(config_path: &Path, version: &str) -> PathBuf {
    let directory = config_path.parent().unwrap_or(Path::new("."));
    let base = match env::var_os("VIS_CACHE_DIRECTORY").filter(|value| !value.is_empty()) {
        Some(value) => directory.join(value),
        None => directory.join("node_modules").join(".cache").join("vis"),
    };
    let mut key = blake3::Hasher::new();

    key.update(config_path.to_string_lossy().as_bytes());
    key.update(&[0]);
    key.update(version.as_bytes());

    base.join("config").join(format!("{}.json", &key.finalize().to_hex()[..16]))
}

fn read_entry(entry: &Path, config_path: &Path, version: &str) -> Option<Resolved> {
    let stored: Stored = serde_json::from_slice(&fs::read(entry).ok()?).ok()?;

    if stored.schema != SCHEMA
        || stored.vis_version != version
        || Path::new(&stored.config_path) != config_path
        || !stored.files.iter().any(|file| Path::new(&file.path) == config_path)
        || !stored.files.iter().all(|file| hash_path(Path::new(&file.path), file.kind) == file.hash)
        || !stored.env.iter().all(|variable| hash_env(&variable.name) == variable.hash)
    {
        return None;
    }

    match (stored.node_only, stored.config) {
        (true, _) => Some(Resolved::NodeOnly),
        (false, Some(config)) => Some(Resolved::Data(config)),
        (false, None) => None,
    }
}

/// Run the Node emitter and parse what it wrote. Whatever the config printed is dropped: a config that
/// prints is reported as untracked, and Node then runs it again and prints for real. A failed run is
/// silent too, and Node reports the error.
fn emit(config_path: &Path) -> Option<Emitted> {
    let entry = env::var_os("VIS_FALLBACK_ENTRY").filter(|value| !value.is_empty())?;
    let node = env::var_os("VIS_NODE").filter(|value| !value.is_empty()).unwrap_or_else(|| OsStr::new("node").into());
    let out = env::temp_dir().join(format!(
        "vis-config-{}-{}.json",
        std::process::id(),
        SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|elapsed| elapsed.as_nanos()).unwrap_or(0)
    ));

    // Claimed before Node writes to it, so a file or link another user left at that name is refused.
    fs::OpenOptions::new().write(true).create_new(true).open(&out).ok()?;

    let output = Command::new(node)
        .arg(entry)
        .arg("__emit-config")
        .arg(config_path)
        .arg("--out")
        .arg(&out)
        .env(EMITTING, "1")
        .stdin(Stdio::null())
        .output()
        .ok()?;

    let bytes = fs::read(&out).ok();
    let _ = fs::remove_file(&out);

    if !output.status.success() {
        return None;
    }

    let emitted: Emitted = serde_json::from_slice(&bytes?).ok()?;

    if emitted.version != EMIT_VERSION {
        return None;
    }

    Some(emitted)
}

/// Write the entry, unless a tracked file changed while the emitter ran (the hashes would then
/// describe a different config than the one that was evaluated). The write is a rename, so a
/// concurrent run sees the old entry or the new one, never half of one.
fn store(
    entry: &Path,
    config_path: &Path,
    version: &str,
    emitted: &Emitted,
    data: Option<&Value>,
    started: SystemTime,
) {
    let mut files = vec![StoredFile {
        path: config_path.to_string_lossy().into_owned(),
        kind: Kind::File,
        hash: hash_path(config_path, Kind::File),
    }];

    for file in &emitted.files {
        if Path::new(&file.path) == config_path {
            continue;
        }

        files.push(StoredFile {
            path: file.path.clone(),
            kind: file.kind,
            hash: hash_path(Path::new(&file.path), file.kind),
        });
    }

    if files.iter().any(|file| modified_since(Path::new(&file.path), started)) {
        return;
    }

    let stored = Stored {
        schema: SCHEMA,
        vis_version: version.to_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
        node_only: data.is_none(),
        config: data.cloned(),
        files,
        env: emitted.env.iter().map(|name| StoredEnv { name: name.clone(), hash: hash_env(name) }).collect(),
    };

    let Some(directory) = entry.parent() else {
        return;
    };
    let Ok(bytes) = serde_json::to_vec(&stored) else {
        return;
    };
    let temporary = directory.join(format!(".{}.tmp", std::process::id()));

    if fs::create_dir_all(directory).is_err()
        || write_private(&temporary, &bytes).is_err()
        || fs::rename(&temporary, entry).is_err()
    {
        let _ = fs::remove_file(&temporary);
    }
}

/// The entry may hold values the config computed, so it is readable by its owner only.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();

    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);

    std::io::Write::write_all(&mut options.open(path)?, bytes)
}

fn modified_since(path: &Path, started: SystemTime) -> bool {
    fs::metadata(path).and_then(|metadata| metadata.modified()).is_ok_and(|modified| modified >= started)
}

/// A digest of what `kind` observed at `path`, `None` when the path does not exist.
fn hash_path(path: &Path, kind: Kind) -> Option<String> {
    match kind {
        Kind::Exists => fs::symlink_metadata(path).ok().map(|_| String::new()),
        Kind::File => fs::read(path).ok().map(|bytes| blake3::hash(&bytes).to_hex().to_string()),
        Kind::Dir => {
            let mut names: Vec<String> = fs::read_dir(path)
                .ok()?
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();

            names.sort();

            Some(blake3::hash(names.join("\0").as_bytes()).to_hex().to_string())
        }
    }
}

/// A digest of an environment variable's value, so secrets are never written to disk.
fn hash_env(name: &str) -> Option<String> {
    env::var_os(name).map(|value| blake3::hash(value.to_string_lossy().as_bytes()).to_hex().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("vis-config-cache-{}-{name}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        dir
    }

    #[test]
    fn a_directory_digest_changes_when_an_entry_is_added() {
        let dir = scratch("dir");
        let before = hash_path(&dir, Kind::Dir);

        fs::write(dir.join("a"), "").unwrap();

        assert_ne!(before, hash_path(&dir, Kind::Dir));
        assert_eq!(hash_path(&dir.join("missing"), Kind::Dir), None);
    }

    #[test]
    fn a_file_digest_follows_the_contents() {
        let dir = scratch("file");
        let path = dir.join("helper.ts");

        fs::write(&path, "one").unwrap();
        let first = hash_path(&path, Kind::File);
        fs::write(&path, "two").unwrap();

        assert_ne!(first, hash_path(&path, Kind::File));
        assert_eq!(hash_path(&dir.join("gone"), Kind::File), None);
    }

    #[test]
    fn an_entry_is_stale_once_a_tracked_file_changes() {
        let dir = scratch("stale");
        let config = dir.join("vis.config.ts");
        let helper = dir.join("helper.ts");

        fs::write(&config, "export default {};").unwrap();
        fs::write(&helper, "a").unwrap();

        let emitted = Emitted {
            version: EMIT_VERSION,
            status: "ok".to_owned(),
            config: Some(serde_json::json!({ "install": { "backend": "npm" } })),
            files: vec![EmittedFile { path: helper.to_string_lossy().into_owned(), kind: Kind::File }],
            env: vec!["VIS_CONFIG_CACHE_TEST_VARIABLE".to_owned()],
            uncacheable: vec![],
        };
        let entry = dir.join("cache").join("entry.json");

        store(
            &entry,
            &config,
            "1.0.0",
            &emitted,
            emitted.config.as_ref(),
            SystemTime::now() + std::time::Duration::from_secs(3600),
        );

        assert!(matches!(read_entry(&entry, &config, "1.0.0"), Some(Resolved::Data(_))));
        assert!(read_entry(&entry, &config, "2.0.0").is_none(), "another vis version must not reuse the entry");

        fs::write(&helper, "b").unwrap();

        assert!(read_entry(&entry, &config, "1.0.0").is_none(), "an edited import must invalidate the entry");

        fs::write(&helper, "a").unwrap();

        assert!(read_entry(&entry, &config, "1.0.0").is_some());

        env::set_var("VIS_CONFIG_CACHE_TEST_VARIABLE", "x");

        assert!(
            read_entry(&entry, &config, "1.0.0").is_none(),
            "a changed environment variable must invalidate the entry"
        );

        env::remove_var("VIS_CONFIG_CACHE_TEST_VARIABLE");
    }

    #[test]
    fn a_file_changed_during_emission_is_not_stored() {
        let dir = scratch("race");
        let config = dir.join("vis.config.ts");

        fs::write(&config, "export default {};").unwrap();

        let emitted = Emitted {
            version: EMIT_VERSION,
            status: "ok".to_owned(),
            config: Some(serde_json::json!({})),
            files: vec![],
            env: vec![],
            uncacheable: vec![],
        };
        let entry = dir.join("cache").join("entry.json");

        store(&entry, &config, "1.0.0", &emitted, emitted.config.as_ref(), SystemTime::UNIX_EPOCH);

        assert!(!entry.exists());
    }

    #[test]
    fn a_config_holding_a_value_read_from_the_environment_is_not_stored() {
        let config = serde_json::json!({ "release": { "token": "prefix-ghp_0123456789-suffix" }, "install": { "backend": "npm" } });

        env::set_var("VIS_CONFIG_CACHE_TEST_TOKEN", "ghp_0123456789");
        env::set_var("VIS_CONFIG_CACHE_TEST_SHORT", "npm");

        assert!(holds_environment_value(&config, &["VIS_CONFIG_CACHE_TEST_TOKEN".to_owned()]));
        assert!(
            !holds_environment_value(&config, &["VIS_CONFIG_CACHE_TEST_SHORT".to_owned()]),
            "short values are not secrets"
        );
        assert!(!holds_environment_value(&config, &["VIS_CONFIG_CACHE_TEST_UNSET".to_owned()]));

        env::remove_var("VIS_CONFIG_CACHE_TEST_TOKEN");
        env::remove_var("VIS_CONFIG_CACHE_TEST_SHORT");
    }

    #[cfg(unix)]
    #[test]
    fn a_stored_entry_is_private_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch("private");
        let config = dir.join("vis.config.ts");

        fs::write(&config, "export default {};").unwrap();

        let emitted = Emitted {
            version: EMIT_VERSION,
            status: "ok".to_owned(),
            config: Some(serde_json::json!({})),
            files: vec![],
            env: vec![],
            uncacheable: vec![],
        };
        let entry = dir.join("cache").join("entry.json");

        store(
            &entry,
            &config,
            "1.0.0",
            &emitted,
            emitted.config.as_ref(),
            SystemTime::now() + std::time::Duration::from_secs(3600),
        );

        assert_eq!(fs::metadata(&entry).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
