//! The evaluated form of a `vis.config.*` that cannot be read as plain data.
//!
//! A config that needs JavaScript to evaluate (computed values, imports, `extends` presets) is
//! evaluated once by the Node CLI (`vis __emit-config`), and the result is kept under the cache
//! directory. A later run reads it back without starting Node as long as everything the
//! evaluation depended on is unchanged: the config file, the modules it imported, the
//! directories it listed and the environment variables it read. The emitter lists those
//! dependencies, and this module hashes them, so revalidation needs no Node at all.
//!
//! A result is only stored as data when the emitter could track everything the config touched. A
//! config that started a process, used the network, wrote files, printed output or listed the whole
//! environment is stored as "Node's to run": it goes to Node on every run until something it did
//! track changes. `VIS_NO_CONFIG_CACHE=1` turns this module off, and the
//! config is then handed to Node like any other dynamic config. Deleting the cache directory
//! (`<cache dir>/config`) forgets every stored result.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Bump with the stored layout; an entry with another schema is ignored.
const SCHEMA: u32 = 1;

/// Environment values shorter than this are never taken for secrets.
const MIN_SECRET_LENGTH: usize = 8;

/// The emitter's own output version (`EMIT_VERSION` in `src/config/emit.ts`). Version 2 added the digest of each
/// tracked path as the evaluation first saw it. The stored layout ([`SCHEMA`]) did not change.
const EMIT_VERSION: u32 = 2;

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

/// How the emitter says it finished. Anything it adds later counts as a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Ok,
    NodeOnly,
    #[serde(other)]
    Failed,
}

#[derive(Debug, Deserialize)]
struct Emitted {
    version: u32,
    status: Status,
    config: Option<Value>,
    files: Vec<EmittedFile>,
    env: Vec<String>,
    uncacheable: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct EmittedFile {
    path: String,
    kind: Kind,
    /// SHA-256 of the path as the evaluation first saw it (see [`sha256_path`]); `None` when it was not there.
    digest: Option<String>,
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
    #[serde(flatten)]
    result: StoredResult,
    files: Vec<StoredFile>,
    env: Vec<StoredEnv>,
}

/// What a stored evaluation stands for. On disk it is the `node_only` and `config` fields of the entry, so the
/// layout ([`SCHEMA`]) does not change; a `node_only: false` entry without a config is not an entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "ResultFields", into = "ResultFields")]
enum StoredResult {
    NodeOnly,
    Data(Value),
}

#[derive(Serialize, Deserialize)]
struct ResultFields {
    node_only: bool,
    config: Option<Value>,
}

impl From<StoredResult> for ResultFields {
    fn from(result: StoredResult) -> Self {
        match result {
            StoredResult::NodeOnly => Self { node_only: true, config: None },
            StoredResult::Data(config) => Self { node_only: false, config: Some(config) },
        }
    }
}

impl TryFrom<ResultFields> for StoredResult {
    type Error = &'static str;

    fn try_from(fields: ResultFields) -> Result<Self, Self::Error> {
        match (fields.node_only, fields.config) {
            (true, _) => Ok(Self::NodeOnly),
            (false, Some(config)) => Ok(Self::Data(config)),
            (false, None) => Err("a stored configuration without data"),
        }
    }
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

    let version = crate::node_contract::version();
    let entry = entry_path(config_path, &version);

    if let Some(stored) = read_entry(&entry, config_path, &version) {
        return Some(stored);
    }

    let started = SystemTime::now();
    let emitted = emit(config_path)?;

    // The stored copy stands in for a later evaluation only when the evaluation was fully tracked and the
    // result is plain data. Anything else is remembered as "Node's to run" (the safe answer whatever changes),
    // so it is not evaluated again until one of the things it did track changes.
    let data = match (emitted.status, emitted.config.as_ref()) {
        (Status::Ok, Some(config))
            if emitted.uncacheable.is_empty() && !holds_environment_value(config, &emitted.env) =>
        {
            Some(config)
        }
        (Status::Ok | Status::NodeOnly, _) => None,
        (Status::Failed, _) => return None,
    };

    // A tracked file changed while the emitter ran, so what it read may already be out of date: the
    // config is left to Node this once rather than used natively.
    if store(&entry, config_path, &version, &emitted, data, started) == StoreOutcome::Raced {
        return None;
    }

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

    Some(match stored.result {
        StoredResult::NodeOnly => Resolved::NodeOnly,
        StoredResult::Data(config) => Resolved::Data(config),
    })
}

/// Run the Node emitter and parse what it wrote. Whatever the config printed is dropped: a config that
/// prints is reported as untracked, and Node then runs it again and prints for real. A failed run is
/// silent too, and Node reports the error.
fn emit(config_path: &Path) -> Option<Emitted> {
    let entry = env::var_os("VIS_FALLBACK_ENTRY").filter(|value| !value.is_empty())?;
    let node = crate::process::node_program();
    let out = env::temp_dir().join(unique_temp_name("vis-config-", ".json"));

    // Claimed before Node writes to it, so a file or link another user left at that name is refused.
    create_private(&out).ok()?;

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

/// What `store` did with an evaluation.
#[derive(Debug, PartialEq)]
enum StoreOutcome {
    /// A tracked file changed while the emitter ran, so nothing was stored.
    Raced,
    /// The entry was written, or could not be (an unwritable cache directory is not an error).
    Done,
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
) -> StoreOutcome {
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

    // The digests above describe the files now. They stand for the evaluation only when the emitter saw the same
    // bytes when it read them, and a file's modification time cannot say that on a file system with coarse
    // timestamps, so the emitter's own digests are compared too.
    let changed_since_read =
        emitted.files.iter().any(|file| sha256_path(Path::new(&file.path), file.kind) != file.digest);

    if changed_since_read || files.iter().any(|file| modified_since(Path::new(&file.path), started)) {
        return StoreOutcome::Raced;
    }

    let stored = Stored {
        schema: SCHEMA,
        vis_version: version.to_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
        result: data.map_or(StoredResult::NodeOnly, |config| StoredResult::Data(config.clone())),
        files,
        env: emitted.env.iter().map(|name| StoredEnv { name: name.clone(), hash: hash_env(name) }).collect(),
    };

    let Some(directory) = entry.parent() else {
        return StoreOutcome::Done;
    };
    let Ok(bytes) = serde_json::to_vec(&stored) else {
        return StoreOutcome::Done;
    };
    // Created exclusively under a name no other process can predict, so a path planted in a shared cache
    // directory is refused instead of followed.
    let temporary = directory.join(unique_temp_name(".", ".tmp"));

    if fs::create_dir_all(directory).is_err()
        || write_private(&temporary, &bytes).is_err()
        || fs::rename(&temporary, entry).is_err()
    {
        let _ = fs::remove_file(&temporary);
    }

    StoreOutcome::Done
}

/// `prefix`, the process id and the clock to the nanosecond, then `suffix`: a name no other process can predict.
fn unique_temp_name(prefix: &str, suffix: &str) -> String {
    let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());

    format!("{prefix}{}-{nanos}{suffix}", std::process::id())
}

/// A new file that only its owner can read, created exclusively: an existing file or link is refused.
fn create_private(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();

    options.write(true).create_new(true);

    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);

    options.open(path)
}

/// The entry may hold values the config computed, so it is readable by its owner only.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::io::Write::write_all(&mut create_private(path)?, bytes)
}

fn modified_since(path: &Path, started: SystemTime) -> bool {
    fs::metadata(path).and_then(|metadata| metadata.modified()).is_ok_and(|modified| modified >= started)
}

/// What `kind` observes at `path`: `None` when the path does not exist, `Some(None)` for a path that merely has to
/// exist, and the bytes a file or a directory listing (its sorted names joined with NUL) is digested from.
fn observe(path: &Path, kind: Kind) -> Option<Option<Vec<u8>>> {
    match kind {
        Kind::Exists => fs::symlink_metadata(path).ok().map(|_| None),
        Kind::File => fs::read(path).ok().map(Some),
        Kind::Dir => {
            let mut names: Vec<String> = fs::read_dir(path)
                .ok()?
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();

            names.sort();

            Some(Some(names.join("\0").into_bytes()))
        }
    }
}

/// A digest of what `kind` observed at `path`, `None` when the path does not exist.
fn hash_path(path: &Path, kind: Kind) -> Option<String> {
    observe(path, kind).map(|bytes| bytes.map_or_else(String::new, |bytes| blake3::hash(&bytes).to_hex().to_string()))
}

/// The digest the emitter reports for a path (`digestOf` in `src/config/emit.ts`): the same observation as
/// [`hash_path`], in SHA-256, which Node has built in.
fn sha256_path(path: &Path, kind: Kind) -> Option<String> {
    observe(path, kind).map(|bytes| bytes.map_or_else(String::new, |bytes| format!("{:x}", Sha256::digest(bytes))))
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
            status: Status::Ok,
            config: Some(serde_json::json!({ "install": { "backend": "npm" } })),
            files: vec![EmittedFile {
                path: helper.to_string_lossy().into_owned(),
                kind: Kind::File,
                digest: sha256_path(&helper, Kind::File),
            }],
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
            status: Status::Ok,
            config: Some(serde_json::json!({})),
            files: vec![],
            env: vec![],
            uncacheable: vec![],
        };
        let entry = dir.join("cache").join("entry.json");

        let outcome = store(&entry, &config, "1.0.0", &emitted, emitted.config.as_ref(), SystemTime::UNIX_EPOCH);

        assert_eq!(outcome, StoreOutcome::Raced);
        assert!(!entry.exists());
    }

    #[test]
    fn a_file_that_differs_from_the_digest_the_emitter_took_is_not_stored_whatever_its_mtime_says() {
        let dir = scratch("digest");
        let config = dir.join("vis.config.ts");
        let helper = dir.join("helper.ts");

        fs::write(&config, "export default {};").unwrap();
        fs::write(&helper, "read by the emitter").unwrap();

        let digest = sha256_path(&helper, Kind::File);
        let emitted = |digest: Option<String>| Emitted {
            version: EMIT_VERSION,
            status: Status::Ok,
            config: Some(serde_json::json!({})),
            files: vec![
                EmittedFile {
                    path: config.to_string_lossy().into_owned(),
                    kind: Kind::File,
                    digest: sha256_path(&config, Kind::File),
                },
                EmittedFile { path: helper.to_string_lossy().into_owned(), kind: Kind::File, digest },
            ],
            env: vec![],
            uncacheable: vec![],
        };
        // Far in the future, so the modification-time check cannot be what refuses the store.
        let started = SystemTime::now() + std::time::Duration::from_secs(3600);
        let entry = dir.join("cache").join("entry.json");

        // Edited after the emitter read it, on a file system whose timestamps did not move.
        fs::write(&helper, "edited behind its back").unwrap();

        assert_eq!(
            store(&entry, &config, "1.0.0", &emitted(digest.clone()), Some(&serde_json::json!({})), started),
            StoreOutcome::Raced
        );
        assert!(!entry.exists());

        fs::write(&helper, "read by the emitter").unwrap();

        assert_eq!(
            store(&entry, &config, "1.0.0", &emitted(digest), Some(&serde_json::json!({})), started),
            StoreOutcome::Done
        );
        assert!(entry.exists());

        // A path the emitter saw missing that exists now, and one it saw present that is gone, are races too.
        let _ = fs::remove_file(&entry);

        assert_eq!(
            store(&entry, &config, "1.0.0", &emitted(None), Some(&serde_json::json!({})), started),
            StoreOutcome::Raced
        );

        fs::remove_file(&helper).unwrap();

        assert_eq!(
            store(
                &entry,
                &config,
                "1.0.0",
                &emitted(sha256_path(&config, Kind::File)),
                Some(&serde_json::json!({})),
                started
            ),
            StoreOutcome::Raced
        );
    }

    #[test]
    fn the_digest_of_a_directory_listing_is_the_one_node_takes() {
        let dir = scratch("listing");

        fs::write(dir.join("b"), "").unwrap();
        fs::write(dir.join("a"), "").unwrap();

        // `sha256("a\0b")`, which `digestOf` in `src/config/emit.ts` takes of the sorted names.
        assert_eq!(
            sha256_path(&dir, Kind::Dir).as_deref(),
            Some("59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138")
        );
        assert_eq!(sha256_path(&dir, Kind::Exists).as_deref(), Some(""));
        assert_eq!(sha256_path(&dir.join("missing"), Kind::File), None);
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
            status: Status::Ok,
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

    #[test]
    fn a_stored_result_keeps_the_layout_of_the_entry_on_disk() {
        let data = StoredResult::Data(serde_json::json!({"a": 1}));

        assert_eq!(
            serde_json::to_value(&data).expect("serialises"),
            serde_json::json!({"node_only": false, "config": {"a": 1}})
        );
        assert_eq!(
            serde_json::to_value(StoredResult::NodeOnly).expect("serialises"),
            serde_json::json!({"node_only": true, "config": null})
        );
        assert!(matches!(
            serde_json::from_value::<StoredResult>(serde_json::json!({"node_only": true, "config": {"x": 1}})),
            Ok(StoredResult::NodeOnly)
        ));
        assert!(
            serde_json::from_value::<StoredResult>(serde_json::json!({"node_only": false, "config": null})).is_err()
        );
    }

    #[test]
    fn an_emitter_status_it_does_not_know_is_a_failure() {
        assert_eq!(serde_json::from_str::<Status>("\"ok\"").expect("ok"), Status::Ok);
        assert_eq!(serde_json::from_str::<Status>("\"node-only\"").expect("node-only"), Status::NodeOnly);
        assert_eq!(serde_json::from_str::<Status>("\"error\"").expect("other"), Status::Failed);
    }
}
