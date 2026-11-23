//! `vis cache hash <task> [--format json|table] [--run <id>]` — the native fast path.
//!
//! The command does not hash anything. It reads a run summary the task runner recorded
//! (`<root>/.vis/last-summary.json`, or `<root>/.vis/runs/<id>.json` for `--run`) and prints the
//! hash and the per-input hashes stored there, like `packages/tooling/vis/src/commands/cache/hash.ts`.
//! So none of the hashing engine runs here and the output is the recorded strings, byte for byte;
//! the task-runner core crate is linked for its git-worktree lookup (see the trace-mode case below).
//!
//! The native path answers only what it can reproduce exactly, and hands everything else to Node:
//!
//! - the argument shapes of [`parse`], and the same quiet context as `list` (CI, no terminal, no
//!   `vis.config`, no Deno file), with the header lines of the table coloured as pail does;
//! - a summary file that is absent (Node's "no summary" and "not found" messages), or one that
//!   deserializes without a doubt. Anything else about the file goes to Node, since `JSON.parse`
//!   and serde disagree on lone surrogates, depth and so on;
//! - a task that carries `hashDetails`, has no hash at all, or is a trace-mode task (a hash and no
//!   `hashDetails`). The last reads its tracked inputs out of the cache entry. With no config and no
//!   `VIS_CACHE_DIRECTORY` the entry sits in the main worktree's `node_modules/.cache/vis`, which
//!   `task_runner_core::get_main_worktree_root` finds, the very function the Node addon wraps;
//! - table output only for printable ASCII, because pail's wrapping and `padEnd` count UTF-16
//!   units, and for a root-collation locale, because Node sorts the buckets with `localeCompare`.

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;

use crate::advisories::{in_ci, monorepo_root, quiet_context};
use crate::error::WrapperError;
use crate::pail::{pail_width, Layout, Level};

/// A recorded hash is cut to this many characters in the table, then `…` follows.
const HASH_DISPLAY_PREFIX: usize = 16;

/// `String.prototype.padEnd` width of the key column.
const KEY_COLUMN: usize = 40;

/// What the user asked for.
#[derive(Debug, PartialEq)]
pub(crate) struct Request {
    pub(crate) task_id: String,
    pub(crate) json: bool,
    pub(crate) run: Option<String>,
}

/// Parses the arguments of `cache hash` (`args[0]` is `cache`, `args[1]` is `hash`) the way cerebro
/// does for this command, or `None` for a shape that is Node's: one task id, and at most one each
/// of `--format <json|table>` and `--run <id>`, in either spelling.
pub(crate) fn parse(args: &[String]) -> Option<Request> {
    let mut task_id: Option<&str> = None;
    let mut format: Option<&str> = None;
    let mut run: Option<&str> = None;
    let mut tokens = args.iter().skip(2).map(String::as_str);

    while let Some(token) = tokens.next() {
        let (slot, value) = match token {
            "--format" => (&mut format, tokens.next()?),
            "--run" => (&mut run, tokens.next()?),
            _ if token.starts_with("--format=") => (&mut format, &token["--format=".len()..]),
            _ if token.starts_with("--run=") => (&mut run, &token["--run=".len()..]),
            _ if token.starts_with('-') => return None,
            _ => (&mut task_id, token),
        };

        // A value that looks like a flag is cerebro's to interpret.
        if slot.is_some() || value.starts_with('-') {
            return None;
        }

        *slot = Some(value);
    }

    let json = match format {
        None | Some("table") => false,
        Some("json") => true,
        Some(_) => return None,
    };

    // A run id names a file under `.vis/runs/`; anything that could leave the directory, or that
    // the path join of the Node side would treat specially, is Node's.
    if run.is_some_and(|id| {
        id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    }) {
        return None;
    }

    Some(Request { task_id: task_id.filter(|id| !id.is_empty())?.to_owned(), json, run: run.map(str::to_owned) })
}

/// Object keys that JavaScript would not keep in file order (integer-like keys come first) or
/// that name a prototype member.
fn reserved_key(key: &str) -> bool {
    key == "__proto__" || (!key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit()))
}

/// A string-to-string map, in file order. Duplicate and reserved keys are Node's.
struct Bucket(Vec<(String, String)>);

impl<'de> Deserialize<'de> for Bucket {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct BucketVisitor;

        impl<'de> Visitor<'de> for BucketVisitor {
            type Value = Bucket;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a map of strings")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Bucket, A::Error> {
                let mut entries = Vec::new();
                let mut seen = HashSet::new();

                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    if reserved_key(&key) || !seen.insert(key.clone()) {
                        return Err(de::Error::custom("key left to Node"));
                    }

                    entries.push((key, value));
                }

                Ok(Bucket(entries))
            }
        }

        deserializer.deserialize_map(BucketVisitor)
    }
}

impl Serialize for Bucket {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;

        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }

        map.end()
    }
}

/// A map of string lists, in file order. Duplicate and reserved keys are Node's.
struct Lists(Vec<(String, Vec<String>)>);

impl<'de> Deserialize<'de> for Lists {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ListsVisitor;

        impl<'de> Visitor<'de> for ListsVisitor {
            type Value = Lists;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a map of string lists")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Lists, A::Error> {
                let mut entries = Vec::new();
                let mut seen = HashSet::new();

                while let Some((key, value)) = map.next_entry::<String, Vec<String>>()? {
                    if reserved_key(&key) || !seen.insert(key.clone()) {
                        return Err(de::Error::custom("key left to Node"));
                    }

                    entries.push((key, value));
                }

                Ok(Lists(entries))
            }
        }

        deserializer.deserialize_map(ListsVisitor)
    }
}

enum Field {
    Text(String),
    Number(u32),
    Bucket(Bucket),
    Lists(Lists),
    Strings(Vec<String>),
}

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Number,
    Bucket,
    Lists,
    Strings,
}

/// The keys an object may hold, and the ones it must. A key outside the schema is Node's.
struct Schema {
    fields: &'static [(&'static str, Kind)],
    required: &'static [&'static str],
}

/// `TaskHashDetails`: what a declared-mode task recorded.
const DETAILS: Schema = Schema {
    fields: &[
        ("command", Kind::Text),
        ("implicitDeps", Kind::Bucket),
        ("layout", Kind::Number),
        ("nodes", Kind::Bucket),
        ("runtime", Kind::Bucket),
    ],
    // The table prints the command, and `undefined.slice` throws in Node.
    required: &["command"],
};

/// `TaskFingerprint`: what a trace-mode task tracked, stored in its cache entry.
const FINGERPRINT: Schema = Schema {
    fields: &[
        ("chainKey", Kind::Text),
        ("commandHash", Kind::Text),
        ("directoryListings", Kind::Lists),
        ("envHashes", Kind::Bucket),
        ("fileHashes", Kind::Bucket),
        ("missingFiles", Kind::Strings),
        ("modifiedInputs", Kind::Strings),
        ("tracker", Kind::Text),
    ],
    // `missingFiles` is mapped over, and the other buckets are printed; Node throws or prints
    // differently when one is absent.
    required: &["commandHash", "directoryListings", "envHashes", "fileHashes", "missingFiles"],
};

/// A JSON object that keeps the order its keys have in the file, because the JSON output prints
/// them in that order.
pub(crate) struct Record(Vec<(&'static str, Field)>);

impl Record {
    pub(crate) fn text(&self, name: &str) -> &str {
        self.0
            .iter()
            .find_map(|(key, field)| match field {
                Field::Text(text) if *key == name => Some(text.as_str()),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub(crate) fn bucket(&self, name: &str) -> &[(String, String)] {
        self.0
            .iter()
            .find_map(|(key, field)| match field {
                Field::Bucket(bucket) if *key == name => Some(bucket.0.as_slice()),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub(crate) fn strings(&self, name: &str) -> &[String] {
        self.0
            .iter()
            .find_map(|(key, field)| match field {
                Field::Strings(list) if *key == name => Some(list.as_slice()),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub(crate) fn number(&self, name: &str) -> Option<u32> {
        self.0.iter().find_map(|(key, field)| match field {
            Field::Number(number) if *key == name => Some(*number),
            _ => None,
        })
    }

    fn read<'de, A: MapAccess<'de>>(schema: &Schema, mut map: A) -> Result<Record, A::Error> {
        let mut fields: Vec<(&'static str, Field)> = Vec::new();

        while let Some(key) = map.next_key::<String>()? {
            let Some(&(name, kind)) = schema.fields.iter().find(|(name, _)| *name == key) else {
                return Err(de::Error::custom("key left to Node"));
            };

            if fields.iter().any(|(seen, _)| *seen == name) {
                return Err(de::Error::custom("duplicate key"));
            }

            let field = match kind {
                Kind::Text => Field::Text(map.next_value()?),
                Kind::Number => Field::Number(map.next_value()?),
                Kind::Bucket => Field::Bucket(map.next_value()?),
                Kind::Lists => Field::Lists(map.next_value()?),
                Kind::Strings => Field::Strings(map.next_value()?),
            };

            fields.push((name, field));
        }

        if schema.required.iter().any(|name| !fields.iter().any(|(seen, _)| seen == name)) {
            return Err(de::Error::custom("required key missing"));
        }

        Ok(Record(fields))
    }
}

impl Serialize for Record {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;

        for (name, field) in &self.0 {
            match field {
                Field::Text(text) => map.serialize_entry(name, text)?,
                Field::Number(number) => map.serialize_entry(name, number)?,
                Field::Bucket(bucket) => map.serialize_entry(name, bucket)?,
                Field::Lists(lists) => map.serialize_entry(name, lists)?,
                Field::Strings(strings) => map.serialize_entry(name, strings)?,
            }
        }

        map.end()
    }
}

impl Serialize for Lists {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;

        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }

        map.end()
    }
}

/// A [`Record`] read against one of the schemas above.
macro_rules! record_type {
    ($name:ident, $schema:expr) => {
        pub(crate) struct $name(pub(crate) Record);

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                struct RecordVisitor;

                impl<'de> Visitor<'de> for RecordVisitor {
                    type Value = $name;

                    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                        formatter.write_str(stringify!($name))
                    }

                    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<$name, A::Error> {
                        Record::read(&$schema, map).map($name)
                    }
                }

                deserializer.deserialize_map(RecordVisitor)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                self.0.serialize(serializer)
            }
        }
    };
}

record_type!(Details, DETAILS);
record_type!(Fingerprint, FINGERPRINT);

/// The fields of a `TaskSummary` this command prints. A key of the wrong type, or a duplicate,
/// is Node's: serde and `JSON.parse` disagree there, and an `undefined` prints differently.
pub(crate) struct Task {
    pub(crate) task_id: String,
    pub(crate) cache_status: String,
    pub(crate) hash: Option<String>,
    pub(crate) details: Option<Details>,
    pub(crate) hash_source: Option<String>,
}

impl<'de> Deserialize<'de> for Task {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TaskVisitor;

        impl<'de> Visitor<'de> for TaskVisitor {
            type Value = Task;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a task summary")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Task, A::Error> {
                let (mut task_id, mut cache_status, mut hash, mut details, mut hash_source) =
                    (None, None, None, None, None);

                fn once<T, E: de::Error>(slot: &mut Option<T>, value: T) -> Result<(), E> {
                    if slot.replace(value).is_some() {
                        return Err(E::custom("duplicate task key"));
                    }

                    Ok(())
                }

                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "taskId" => once(&mut task_id, map.next_value::<String>()?)?,
                        "cacheStatus" => once(&mut cache_status, map.next_value::<String>()?)?,
                        "hash" => once(&mut hash, map.next_value::<String>()?)?,
                        "hashDetails" => once(&mut details, map.next_value::<Details>()?)?,
                        "hashSource" => once(&mut hash_source, map.next_value::<String>()?)?,
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }

                Ok(Task {
                    task_id: task_id.ok_or_else(|| de::Error::missing_field("taskId"))?,
                    cache_status: cache_status.ok_or_else(|| de::Error::missing_field("cacheStatus"))?,
                    hash,
                    details,
                    hash_source,
                })
            }
        }

        deserializer.deserialize_map(TaskVisitor)
    }
}

/// The run summary. The tasks stay raw: only the one asked for is read strictly, so another task's
/// unusual entry cannot send a lookup that does not involve it to Node.
#[derive(Deserialize)]
pub(crate) struct Summary {
    pub(crate) id: String,
    pub(crate) tasks: Vec<Box<RawValue>>,
}

/// The `taskId` of a task entry, when it is a string. Node compares with `===`, so a task without
/// one, or with another type, is simply not the task asked for.
#[derive(Deserialize)]
pub(crate) struct Probe {
    #[serde(default, rename = "taskId")]
    pub(crate) task_id: Option<ProbeId>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum ProbeId {
    Text(String),
    Other(IgnoredAny),
}

enum Lookup {
    Found(Task),
    Absent,
}

impl Summary {
    /// The first task named `task_id` (`Array.prototype.find`). `None` is an entry Node must read.
    fn find(&self, task_id: &str) -> Option<Lookup> {
        for raw in &self.tasks {
            let probe: Probe = serde_json::from_str(raw.get()).ok()?;

            if matches!(probe.task_id, Some(ProbeId::Text(ref text)) if text == task_id) {
                return serde_json::from_str(raw.get()).ok().map(Lookup::Found);
            }
        }

        Some(Lookup::Absent)
    }
}

/// The summary file the request names.
pub(crate) fn summary_path(root: &Path, run: Option<&str>) -> PathBuf {
    match run {
        None => root.join(".vis").join("last-summary.json"),
        Some(id) => root.join(".vis").join("runs").join(format!("{id}.json")),
    }
}

/// What reading the summary gave.
pub(crate) enum Loaded {
    Missing,
    Found(Summary),
}

/// `None` is a file this module will not interpret: Node decides.
fn load(path: &Path) -> Option<Loaded> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).ok().map(Loaded::Found),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Some(Loaded::Missing),
        Err(_) => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FoundJson<'a> {
    cache_status: &'a str,
    hash: Option<&'a str>,
    hash_details: Option<&'a Details>,
    hash_source: Option<&'a str>,
    run_id: &'a str,
    task_id: &'a str,
    tracked_fingerprint: Option<&'a Fingerprint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FailureJson<'a> {
    pub(crate) error: &'a str,
    pub(crate) run_id: Option<&'a str>,
    pub(crate) task_id: &'a str,
}

/// `JSON.stringify(value, undefined, 2)` plus the newline the handler writes.
pub(crate) fn json_text(value: &impl Serialize) -> Option<String> {
    serde_json::to_string_pretty(value).ok().map(|text| text + "\n")
}

/// What one run prints, split the way pail splits it: error blocks go to stderr.
#[derive(Default)]
pub(crate) struct Output {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit_code: i32,
}

/// A string pail and `padEnd` handle exactly: printable ASCII, no space.
pub(crate) fn plain(text: &str) -> bool {
    text.bytes().all(|byte| byte.is_ascii_graphic())
}

/// Whether Node's `localeCompare` orders ASCII like the root collation [`collate`] reproduces. A
/// tailored locale (`da`, `cs`, …) orders some letter pairs differently, and Node takes its default
/// locale from these variables.
fn root_collation() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LC_COLLATE", "LANG", "LANGUAGE"].iter().all(|key| match env::var(key) {
        Ok(value) => {
            let value = value.trim();
            let language = value.split(['_', '.', '@', '-', ':']).next().unwrap_or_default();

            value.is_empty() || matches!(language, "C" | "POSIX" | "en")
        }
        Err(env::VarError::NotPresent) => true,
        Err(env::VarError::NotUnicode(_)) => false,
    })
}

/// Printable ASCII in the root collation's primary order (punctuation, digits, then letters, case
/// folded). Checked against `String.prototype.localeCompare` (see the unit test and `__tests__/native/cache-hash-parity.test.ts`).
const COLLATION_ORDER: &[u8] = b" _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

const fn primary_weights() -> [u8; 128] {
    let mut weights = [0u8; 128];
    let mut index = 0;

    while index < COLLATION_ORDER.len() {
        weights[COLLATION_ORDER[index] as usize] = index as u8 + 1;
        index += 1;
    }

    weights
}

static PRIMARY: [u8; 128] = primary_weights();

/// `a.localeCompare(b)` for printable ASCII under the root collation: the primary weights of the
/// whole strings first, then at the first case difference lowercase before uppercase.
fn collate(a: &str, b: &str) -> std::cmp::Ordering {
    let primary = |byte: u8| PRIMARY[usize::from(byte.to_ascii_lowercase())];

    a.bytes().map(primary).cmp(b.bytes().map(primary)).then_with(|| {
        a.bytes().map(|byte| byte.is_ascii_uppercase()).cmp(b.bytes().map(|byte| byte.is_ascii_uppercase()))
    })
}

/// `value.length > 16 ? value.slice(0, 16) + "…" : value`, for ASCII.
fn truncate_hash(value: &str) -> String {
    if value.len() > HASH_DISPLAY_PREFIX {
        format!("{}…", &value[..HASH_DISPLAY_PREFIX])
    } else {
        value.to_owned()
    }
}

/// `renderHashDetailsBucket`. `None` when an entry is not printable ASCII or the order is Node's.
fn render_bucket(out: &mut String, label: &str, entries: &[(String, String)]) -> Option<()> {
    if entries.is_empty() {
        return Some(());
    }

    if entries.iter().any(|(key, value)| !printable(key) || !printable(value))
        || (entries.len() > 1 && !root_collation())
    {
        return None;
    }

    let mut sorted: Vec<&(String, String)> = entries.iter().collect();

    sorted.sort_by(|(a, _), (b, _)| collate(a, b));

    out.push_str(&format!("  {label}:\n"));

    for (key, value) in sorted {
        out.push_str(&format!("    {key:<KEY_COLUMN$}  {}\n", truncate_hash(value)));
    }

    Some(())
}

/// Printable ASCII, spaces included: the bytes `padEnd` and the slice treat as one unit each.
pub(crate) fn printable(text: &str) -> bool {
    text.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// The table for a task found in the summary. `None` when Node has to answer.
fn table(
    request: &Request,
    summary: &Summary,
    task: &Task,
    tracked: Option<&Fingerprint>,
    layout: Layout,
) -> Option<Output> {
    let mut out = Output::default();

    if !(plain(&request.task_id)
        && plain(&summary.id)
        && printable(&task.cache_status)
        && task.hash.as_deref().is_none_or(printable))
    {
        return None;
    }

    out.stdout.push_str(&layout.block(Level::Info, &format!("Hash for {} (run {})", request.task_id, summary.id)));
    out.stdout.push('\n');
    out.stdout.push_str(&format!("  status:  {}\n", task.cache_status));
    out.stdout.push_str(&format!("  hash:    {}\n", task.hash.as_deref().unwrap_or("(none)")));

    if task.hash_source.as_deref() == Some("declared-fallback") {
        out.stdout.push_str(
            "  key:     declared-fallback (no files were tracked; the entry is keyed on the declared inputs below)\n",
        );
    }

    out.stdout.push('\n');

    match &task.details {
        Some(Details(details)) => {
            if !printable(details.text("command")) {
                return None;
            }

            out.stdout.push_str(&format!("  command: {}\n", truncate_hash(details.text("command"))));

            for name in ["nodes", "runtime", "implicitDeps"] {
                render_bucket(&mut out.stdout, name, details.bucket(name))?;
            }
        }
        None => match tracked {
            Some(Fingerprint(fingerprint)) => {
                // `Object.fromEntries(missingFiles.map((path) => [path, "absent"]))`: a repeated path is one entry.
                let mut seen = HashSet::new();
                let missing: Vec<(String, String)> = fingerprint
                    .strings("missingFiles")
                    .iter()
                    .filter(|path| seen.insert(path.as_str()))
                    .map(|path| (path.clone(), "absent".to_owned()))
                    .collect();

                render_bucket(&mut out.stdout, "tracked files", fingerprint.bucket("fileHashes"))?;
                render_bucket(&mut out.stdout, "tracked env", fingerprint.bucket("envHashes"))?;
                render_bucket(&mut out.stdout, "missing files", &missing)?;
            }
            None => out.stdout.push_str(&layout.block(Level::Info, "No hash details recorded for this task.")),
        },
    }

    Some(out)
}

/// `Number.parseInt(text.trim(), 10)` is a number: an optional sign, then a digit.
fn parses_as_integer(text: &str) -> bool {
    let trimmed = text.trim();

    trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed).bytes().next().is_some_and(|byte| byte.is_ascii_digit())
}

/// Reads a text file the way `readFile(path, "utf8")` inside a `try` does: `Ok(None)` for any
/// failure Node swallows, `None` for the one it would not see (bytes that are not UTF-8).
fn read_swallowed(path: &Path) -> Option<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Some(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::InvalidData => None,
        Err(_) => Some(None),
    }
}

/// The fingerprint a trace-mode task stored in its cache entry (`Cache.get(hash)?.fingerprint`), in
/// the default cache directory the Node command resolves without a config: the main git worktree's
/// `node_modules/.cache/vis`, which the task-runner core crate finds the same way the Node addon
/// does. `None` hands the call to Node, `Some(None)` is "no entry, or none with a fingerprint".
fn tracked_fingerprint(root: &Path, hash: &str) -> Option<Option<Fingerprint>> {
    // `VIS_CACHE_DIRECTORY` moves the directory; a hash with a separator in it would leave it.
    if env::var_os("VIS_CACHE_DIRECTORY").is_some_and(|value| !value.is_empty())
        || hash.is_empty()
        || !hash.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return None;
    }

    let anchor = match task_runner_core::get_main_worktree_root(root.to_str()?) {
        Ok(Some(main)) => PathBuf::from(main),
        Ok(None) => root.to_path_buf(),
        Err(_) => return None,
    };

    let entry = anchor.join("node_modules").join(".cache").join("vis").join(hash);

    // An entry counts once `.commit` is there and `code` holds a number.
    if fs::read(entry.join(".commit")).is_err() {
        return Some(None);
    }

    let Some(code) = read_swallowed(&entry.join("code"))? else {
        return Some(None);
    };

    if !parses_as_integer(&code) {
        return Some(None);
    }

    let Some(text) = read_swallowed(&entry.join("fingerprint.json"))? else {
        return Some(None);
    };

    serde_json::from_str(&text).ok().map(Some)
}

/// The output for the request, or `None` to delegate.
fn answer(request: &Request, summary: Loaded, root: &Path, layout: Layout) -> Option<Output> {
    let mut out = Output { exit_code: 1, ..Output::default() };

    let summary = match summary {
        Loaded::Found(summary) => summary,
        Loaded::Missing if request.json => {
            out.stdout = json_text(&FailureJson {
                error: "no-summary",
                run_id: request.run.as_deref(),
                task_id: &request.task_id,
            })?;

            return Some(out);
        }
        Loaded::Missing => {
            let data = root.join(".vis");

            let message = match &request.run {
                None => format!(
                    "No previous run summary found. Run a task first to populate `{}`.",
                    data.join("last-summary.json").to_str()?
                ),
                Some(id) => format!("Run summary \"{id}\" not found in {}/.", data.join("runs").to_str()?),
            };

            if !(plain(&request.task_id) && plain(data.to_str()?)) {
                return None;
            }

            out.stderr = layout.block(Level::Error, &message);

            return Some(out);
        }
    };

    let task = match summary.find(&request.task_id)? {
        Lookup::Found(task) => task,
        Lookup::Absent => {
            if request.json {
                out.stdout = json_text(&FailureJson {
                    error: "task-not-in-summary",
                    run_id: Some(&summary.id),
                    task_id: &request.task_id,
                })?;
            } else if plain(&request.task_id) && plain(&summary.id) {
                out.stderr = layout
                    .block(Level::Error, &format!("Task \"{}\" was not part of run {}.", request.task_id, summary.id));
            } else {
                return None;
            }

            return Some(out);
        }
    };

    // Trace mode: a task with no declared details has its tracked inputs in the cache entry the hash names.
    let tracked = match (&task.details, &task.hash) {
        (None, Some(hash)) => tracked_fingerprint(root, hash)?,
        _ => None,
    };

    if request.json {
        out.stdout = json_text(&FoundJson {
            cache_status: &task.cache_status,
            hash: task.hash.as_deref(),
            hash_details: task.details.as_ref(),
            hash_source: task.hash_source.as_deref(),
            run_id: &summary.id,
            task_id: &task.task_id,
            tracked_fingerprint: tracked.as_ref(),
        })?;
        out.exit_code = 0;

        return Some(out);
    }

    let mut printed = table(request, &summary, &task, tracked.as_ref(), layout)?;

    printed.exit_code = 0;

    Some(printed)
}

/// Runs the native path, or `None` to delegate. Reads the context first and prints nothing.
fn native(args: &[String]) -> Option<Output> {
    // Windows keeps the Node path: the clock behind pail's header is unix-only, and its path
    // separators come from `@visulima/path`.
    if !cfg!(unix) {
        return None;
    }

    let request = parse(args)?;
    let cwd = env::current_dir().ok()?;
    let root = monorepo_root(&cwd)?;

    if !in_ci() || !quiet_context(&cwd, &root) || io::stdout().is_terminal() {
        return None;
    }

    // The table is pail's, coloured as `Layout::detect` decides; the JSON is written raw, so colour
    // does not matter there.
    let layout = if request.json { Layout { width: pail_width()?, colour: false } } else { Layout::detect(args)? };
    let loaded = load(&summary_path(&root, request.run.as_deref()))?;

    answer(&request, loaded, &root, layout)
}

/// Answers `vis cache hash` natively or hands the whole invocation to Node. `raw_args` keeps the
/// argv as it arrived for the delegation; `args` is its lossy view, used for matching.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(out) = native(args) else {
        crate::delegate(raw_args);
    };

    let results = [
        (io::stdout().lock().write_all(out.stdout.as_bytes()).and_then(|()| io::stdout().flush())),
        (io::stderr().lock().write_all(out.stderr.as_bytes()).and_then(|()| io::stderr().flush())),
    ];

    for result in results {
        match result {
            Ok(()) => {}
            // A closed pipe is not an error worth reporting.
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {}
            Err(error) => WrapperError::write("cache hash", "the output", error).exit(),
        }
    }

    exit(out.exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    fn request(task_id: &str, json: bool, run: Option<&str>) -> Option<Request> {
        Some(Request { task_id: task_id.to_owned(), json, run: run.map(str::to_owned) })
    }

    #[test]
    fn parses_the_shapes_it_answers() {
        assert_eq!(parse(&argv(&["cache", "hash", "a:b"])), request("a:b", false, None));
        assert_eq!(parse(&argv(&["cache", "hash", "a:b", "--format", "json"])), request("a:b", true, None));
        assert_eq!(parse(&argv(&["cache", "hash", "--format=json", "a:b"])), request("a:b", true, None));
        assert_eq!(
            parse(&argv(&["cache", "hash", "--format", "table", "a:b", "--run", "r-1.2_x"])),
            request("a:b", false, Some("r-1.2_x"))
        );
        assert_eq!(
            parse(&argv(&["cache", "hash", "a:b", "--run=2026-11-22T07-37-56-589Z_x"])),
            request("a:b", false, Some("2026-11-22T07-37-56-589Z_x"))
        );
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["cache", "hash"][..],
            &["cache", "hash", "a:b", "c:d"],
            &["cache", "hash", "a:b", "--json"],
            &["cache", "hash", "a:b", "--format"],
            &["cache", "hash", "a:b", "--format", "yaml"],
            &["cache", "hash", "a:b", "--format=JSON"],
            &["cache", "hash", "a:b", "--format", "json", "--format", "json"],
            &["cache", "hash", "a:b", "--run", ""],
            &["cache", "hash", "a:b", "--run", "../x"],
            &["cache", "hash", "a:b", "--run", "a/b"],
            &["cache", "hash", "a:b", "--run", "-x"],
            &["cache", "hash", "a:b", "--cache-dir", "x"],
            &["cache", "hash", "-x"],
            &["cache", "hash", "a:b", "-v"],
            &["cache", "hash", "a:b", "--help"],
            &["cache", "hash", ""],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    #[test]
    fn collation_matches_the_root_order_for_ascii() {
        let mut keys = vec![
            "b",
            "B",
            "a",
            "A",
            "a-b",
            "a_b",
            "a.b",
            "a/b",
            "ab",
            "a1",
            "A1",
            "_x",
            "-x",
            "10",
            "9",
            "packages/app/a.txt",
            "packages/App/a.txt",
        ];

        keys.sort_by(|a, b| collate(a, b));

        // Ground truth from `Array.prototype.sort((a, b) => a.localeCompare(b))` on Node 22 with ICU.
        assert_eq!(
            keys,
            [
                "_x",
                "-x",
                "10",
                "9",
                "a",
                "A",
                "a_b",
                "a-b",
                "a.b",
                "a/b",
                "a1",
                "A1",
                "ab",
                "b",
                "B",
                "packages/app/a.txt",
                "packages/App/a.txt"
            ]
        );
    }

    #[test]
    fn truncates_after_sixteen_characters() {
        assert_eq!(truncate_hash("0123456789abcdef"), "0123456789abcdef");
        assert_eq!(truncate_hash("0123456789abcdef0"), "0123456789abcdef…");
    }

    #[test]
    fn details_keep_the_file_order_and_refuse_unknown_keys() {
        let details: Details = serde_json::from_str(r#"{"nodes":{"b":"1","a":"2"},"command":"c","layout":2}"#).unwrap();

        assert_eq!(
            json_text(&details).unwrap(),
            "{\n  \"nodes\": {\n    \"b\": \"1\",\n    \"a\": \"2\"\n  },\n  \"command\": \"c\",\n  \"layout\": 2\n}\n"
        );
        assert!(serde_json::from_str::<Details>(r#"{"command":"c","extra":{}}"#).is_err());
        assert!(serde_json::from_str::<Details>(r#"{"nodes":{}}"#).is_err());
        assert!(serde_json::from_str::<Details>(r#"{"command":"c","nodes":{"1":"x"}}"#).is_err());
        assert!(serde_json::from_str::<Details>(r#"{"command":"c","nodes":{"a":"x","a":"y"}}"#).is_err());
    }

    #[test]
    fn a_task_with_a_mistyped_field_is_left_to_node() {
        assert!(serde_json::from_str::<Task>(r#"{"taskId":"a:b","cacheStatus":"HIT","hash":null}"#).is_err());
        assert!(serde_json::from_str::<Task>(r#"{"taskId":"a:b","cacheStatus":1}"#).is_err());
        assert!(serde_json::from_str::<Task>(r#"{"taskId":"a:b"}"#).is_err());
        assert!(serde_json::from_str::<Task>(r#"{"taskId":"a:b","cacheStatus":"HIT","extra":[1,{"x":null}]}"#).is_ok());
    }

    #[test]
    fn an_odd_task_only_matters_when_it_is_the_one_asked_for() {
        let summary: Summary = serde_json::from_str(
            r#"{"id":"r","tasks":[{"taskId":"odd","cacheStatus":"HIT","hashDetails":{"command":"c","nodes":{"1":"x"}}},{"taskId":7},{},{"taskId":"ok","cacheStatus":"HIT"}]}"#,
        )
        .unwrap();

        assert!(matches!(summary.find("ok"), Some(Lookup::Found(_))));
        assert!(matches!(summary.find("none"), Some(Lookup::Absent)));
        assert!(summary.find("odd").is_none());
    }
}
