//! What the commands that only read a recorded run summary (`cache why`, `replay`) share: the
//! native context gate, strict value types for the summary fields they print, the run directory
//! listing and the output writer. `cache hash` (see [`crate::cache_hash`]) is the exemplar they
//! follow; the rules are the same: answer only what Node's output can be reproduced for byte for
//! byte, and hand every other input to Node.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::env;
use std::fmt;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use serde::de::{self, DeserializeOwned, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;

use crate::cache::entries::{mtime_ms, sorted_entries};
use crate::cache_hash::{Output, Probe, ProbeId, Summary};
use crate::error::WrapperError;
use crate::js::{is_index_like, MAX_SAFE_INTEGER};
use crate::node_context::{in_ci, monorepo_root, quiet_context};
use crate::pail::{pail_width, Layout};

/// The workspace root and pail layout of a run the native path may answer, or `None` when Node has
/// to: Windows (pail's clock is unix-only there and its paths come from `@visulima/path`), a
/// context that is not CI, a terminal, a `vis.config`, a Deno file, or a root whose path the Node
/// side would normalise differently. `json` runs print raw, so colour does not matter there.
pub(crate) fn context(args: &[String], json: bool) -> Option<(PathBuf, Layout)> {
    if !cfg!(unix) {
        return None;
    }

    let cwd = env::current_dir().ok()?;
    let root = monorepo_root(&cwd)?;

    if !in_ci() || !quiet_context(&cwd, &root) || io::stdout().is_terminal() {
        return None;
    }

    // `@visulima/path` turns a backslash into a separator when it joins the run directory.
    if root.to_str()?.contains('\\') {
        return None;
    }

    let layout = if json { Layout { width: pail_width()?, colour: false } } else { Layout::detect(args)? };

    Some((root, layout))
}

/// Writes what a run printed and exits with its code. A closed pipe is not worth reporting.
pub(crate) fn emit(command: &str, out: &Output) -> ! {
    let results = [
        (io::stdout().lock().write_all(out.stdout.as_bytes()).and_then(|()| io::stdout().flush())),
        (io::stderr().lock().write_all(out.stderr.as_bytes()).and_then(|()| io::stderr().flush())),
    ];

    for result in results {
        match result {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {}
            Err(error) => WrapperError::write(command, "the output", error).exit(),
        }
    }

    exit(out.exit_code)
}

/// An integer a JavaScript number holds exactly, so `String(n)` and `JSON.stringify(n)` print its
/// digits. A float, an exponent or a larger value is Node's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct JsInt(pub(crate) i64);

impl<'de> Deserialize<'de> for JsInt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = i64::deserialize(deserializer)?;

        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(de::Error::custom("integer outside the exact range of a JavaScript number"));
        }

        Ok(Self(value))
    }
}

impl Serialize for JsInt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(self.0)
    }
}

/// `deserialize_with` for a key that may be missing but, when present, must hold a `T`: a `null`
/// is not `undefined` in JavaScript, so it is not read as a missing value.
pub(crate) fn present<'de, T: Deserialize<'de>, D: Deserializer<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// An object whose keys keep their file order, which the JSON output prints. A duplicate key, an
/// integer-like key (JavaScript orders those first) and `__proto__` are Node's.
pub(crate) struct Ordered<V>(pub(crate) Vec<(String, V)>);

impl<V> Ordered<V> {
    pub(crate) fn get(&self, name: &str) -> Option<&V> {
        self.0.iter().find(|(key, _)| key == name).map(|(_, value)| value)
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for Ordered<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedVisitor<V>(std::marker::PhantomData<V>);

        impl<'de, V: Deserialize<'de>> Visitor<'de> for OrderedVisitor<V> {
            type Value = Ordered<V>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered<V>, A::Error> {
                let mut entries = Vec::new();
                let mut seen = HashSet::new();

                while let Some((key, value)) = map.next_entry::<String, V>()? {
                    if key.is_empty() || is_index_like(&key) || !seen.insert(key.clone()) {
                        return Err(de::Error::custom("key left to Node"));
                    }

                    entries.push((key, value));
                }

                Ok(Ordered(entries))
            }
        }

        deserializer.deserialize_map(OrderedVisitor(std::marker::PhantomData))
    }
}

impl<V: Serialize> Serialize for Ordered<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;

        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }

        map.end()
    }
}

/// Whether the raw JSON value is an object. serde reads a sequence into a struct too, but
/// JavaScript does not, so an array in an object's place is Node's.
pub(crate) fn is_object(raw: &RawValue) -> bool {
    raw.get().trim_start().starts_with('{')
}

/// Reads a summary file as `T`: `Some(None)` when it does not exist, `None` for a file this module
/// will not interpret (not UTF-8, not an object, or serde and `JSON.parse` may disagree on it).
pub(crate) fn load_summary<T: DeserializeOwned>(path: &Path) -> Option<Option<T>> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim_start().starts_with('{') => serde_json::from_str(&text).ok().map(Some),
        Ok(_) => None,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}

/// `a.sort()` for strings: UTF-16 code unit order.
pub(crate) fn utf16_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// One `*.json` file of the run directory.
pub(crate) struct RunFile {
    pub(crate) name: String,
    pub(crate) mtime_ms: f64,
}

/// The run summaries under `<root>/.vis/runs`, newest first (`b.mtimeMs - a.mtimeMs`, stable, so
/// equal times keep the order `fs.readdir` returns: bytewise by name). `skip` leaves a name
/// out (Node skips the loaded run's own file). `Some(vec![])` when the directory cannot be read,
/// which Node treats as "no runs"; `None` for a name this port cannot treat like Node does.
pub(crate) fn run_files(root: &Path, skip: Option<&str>) -> Option<Vec<RunFile>> {
    let directory = root.join(".vis").join("runs");
    let Some(entries) = sorted_entries(&directory) else {
        return Some(Vec::new());
    };

    let mut files = Vec::new();

    for entry in entries {
        let name = entry.file_name();
        let bytes = name.as_encoded_bytes();

        if !bytes.ends_with(b".json") {
            continue;
        }

        // Node joins every name it reads, and a backslash turns into a separator there.
        let name = name.to_str()?;

        if name.contains('\\') {
            return None;
        }

        if skip == Some(name) {
            continue;
        }

        let Ok(metadata) = fs::metadata(entry.path()) else {
            continue;
        };

        if metadata.is_file() {
            files.push(RunFile { name: name.to_owned(), mtime_ms: mtime_ms(&metadata) });
        }
    }

    files.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(Ordering::Equal));

    Some(files)
}

/// The first task named `task_id` (`Array.prototype.find` over `taskId`), still raw. `Some(None)`
/// when there is none; `None` for an entry Node would read differently (not an object, or a
/// `taskId` of another type is simply not a match).
pub(crate) fn find_task<'a>(tasks: &'a [Box<RawValue>], task_id: &str) -> Option<Option<&'a RawValue>> {
    for raw in tasks {
        if !is_object(raw) {
            return None;
        }

        let probe: Probe = serde_json::from_str(raw.get()).ok()?;

        if matches!(probe.task_id, Some(ProbeId::Text(ref text)) if text == task_id) {
            return Some(Some(raw));
        }
    }

    Some(None)
}

/// The run summary a `--run` or the "previous run" lookup names, as the commands read it.
pub(crate) fn read_run_file(root: &Path, name: &str) -> Option<Summary> {
    let text = fs::read_to_string(root.join(".vis").join("runs").join(name)).ok()?;

    if !text.trim_start().starts_with('{') {
        return None;
    }

    serde_json::from_str(&text).ok()
}

/// `(ms / 1000).toFixed(2)` for whole milliseconds. Rust rounds an exact tie to even where
/// JavaScript picks the larger candidate, and a tie needs a value that is exact in binary: the
/// multiples of an eighth, so only those are corrected.
fn seconds(ms: i64) -> String {
    if ms % 250 == 125 {
        let hundredths = ms / 10 + 1;

        return format!("{}.{:02}", hundredths / 100, hundredths % 100);
    }

    format!("{:.2}", ms as f64 / 1000.0)
}

/// `formatDuration` of `replay`.
pub(crate) fn format_duration(ms: Option<JsInt>) -> String {
    match ms {
        None => "-".to_owned(),
        Some(JsInt(ms)) if ms < 1000 => format!("{ms}ms"),
        Some(JsInt(ms)) => format!("{}s", seconds(ms)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordered_map_declines_the_keys_javascript_reorders_and_the_empty_key() {
        let parses = |json: &str| serde_json::from_str::<Ordered<String>>(json).is_ok();

        assert!(parses(r#"{"b":"1","a":"2","007":"3"}"#));

        for key in ["", "7", "0", "__proto__"] {
            assert!(!parses(&format!(r#"{{"{key}":"x"}}"#)), "{key:?}");
        }

        assert!(!parses(r#"{"a":"1","a":"2"}"#));
    }

    #[test]
    fn seconds_round_like_to_fixed() {
        // Ground truth from `(ms / 1000).toFixed(2)` on Node 26.
        for (ms, expected) in [
            (1000, "1.00"),
            (1005, "1.00"),
            (1015, "1.01"),
            (1125, "1.13"),
            (1375, "1.38"),
            (1625, "1.63"),
            (1875, "1.88"),
            (1999, "2.00"),
            (12_345, "12.35"),
            (3_600_125, "3600.13"),
        ] {
            assert_eq!(seconds(ms), expected, "{ms}");
        }
    }

    #[test]
    fn durations_print_like_the_handler() {
        assert_eq!(format_duration(None), "-");
        assert_eq!(format_duration(Some(JsInt(0))), "0ms");
        assert_eq!(format_duration(Some(JsInt(999))), "999ms");
        assert_eq!(format_duration(Some(JsInt(1000))), "1.00s");
        assert_eq!(format_duration(Some(JsInt(-5))), "-5ms");
    }

    #[test]
    fn utf16_order_puts_astral_characters_before_the_private_use_area() {
        let mut keys = vec!["\u{e000}", "\u{1f600}", "a", "B"];

        keys.sort_by(|a, b| utf16_order(a, b));

        assert_eq!(keys, ["B", "a", "\u{1f600}", "\u{e000}"]);
    }

    #[test]
    fn integers_outside_the_exact_range_are_left_to_node() {
        assert!(serde_json::from_str::<JsInt>("9007199254740991").is_ok());
        assert!(serde_json::from_str::<JsInt>("9007199254740992").is_err());
        assert!(serde_json::from_str::<JsInt>("-9223372036854775808").is_err());
        assert!(serde_json::from_str::<JsInt>("1.0").is_err());
        assert!(serde_json::from_str::<JsInt>("1e3").is_err());
        assert!(serde_json::from_str::<JsInt>("null").is_err());
    }

    #[test]
    fn ordered_objects_keep_the_file_order_and_refuse_odd_keys() {
        let map: Ordered<String> = serde_json::from_str(r#"{"b":"1","a":"2"}"#).unwrap();

        assert_eq!(serde_json::to_string(&map).unwrap(), r#"{"b":"1","a":"2"}"#);
        assert!(serde_json::from_str::<Ordered<String>>(r#"{"1":"x"}"#).is_err());
        assert!(serde_json::from_str::<Ordered<String>>(r#"{"__proto__":"x"}"#).is_err());
        assert!(serde_json::from_str::<Ordered<String>>(r#"{"a":"x","a":"y"}"#).is_err());
    }
}
