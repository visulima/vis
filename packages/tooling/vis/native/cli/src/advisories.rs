//! `vis advisories bloom status --format json --cache-dir <dir>` — the native fast path.
//!
//! The Node command (`src/commands/advisories/bloom-status.ts`) only reads the osv-bloom
//! cache: `getOsvBloomStatus` (`src/security/osv-bloom.ts`) checks for `filter.bin`, then
//! reads `manifest.json` and `state.json` best-effort. This module reproduces that read and
//! the `JSON.stringify(status, undefined, 2)` output byte for byte.
//!
//! Only the shape above is native, and only in the context [`native_context`] accepts. The table
//! output, the `--cache-dir`-less form (which needs `@visulima/find-cache-dir`'s lookup and its
//! `mkdir`), any config or Deno file, a working directory that is not the workspace root (see
//! [`native_root_is_cwd`]), and any manifest or state file this module cannot read with the same
//! result as JavaScript all go to Node via [`crate::process::delegate`]. `sync`, `prune` and `bloom sync`
//! are never native: they touch the network or delete files.

use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::process::exit;

use serde_json::Value;

use crate::js::{js_number, json_string, pretty_document};
use crate::node_context::native_context;
use crate::output::write_stdout;

/// Keys of the manifest object, in the order `parseManifest` returns them, with the upstream
/// field each one is read from. Every one must be a JSON number except the two strings.
const MANIFEST_NUMBERS: [(&str, &str); 8] = [
    ("advisoryCount", "advisory_count"),
    ("bloomByteLen", "bloom_byte_len"),
    ("bloomKHashes", "bloom_k_hashes"),
    ("bloomMBits", "bloom_m_bits"),
    ("builtAtUnix", "built_at_unix"),
    ("entryCount", "entry_count"),
    ("targetFpr", "target_fpr"),
    ("formatVersion", "format_version"),
];

const MANIFEST_STRINGS: [(&str, &str); 4] = [
    ("builtAtRfc3339", "built_at_rfc3339"),
    ("filterSha256", "filter_sha256"),
    ("setDigestSha256", "set_digest_sha256"),
    ("sourceUrl", "source_url"),
];

/// The flags this path understands, or `None` when the invocation needs Node.
///
/// `args` is the full argv, so the first three words are `advisories bloom status`. Both
/// `--name value` and `--name=value` are accepted; each flag may appear once.
fn parse(args: &[String]) -> Option<String> {
    let mut json = false;
    let mut cache_dir: Option<String> = None;
    let mut index = 3;

    while index < args.len() {
        let token = args[index].as_str();
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_owned())),
            _ => (token, None),
        };

        let value = match (name, inline) {
            ("--format" | "--cache-dir", Some(value)) => value,
            ("--format" | "--cache-dir", None) => {
                index += 1;

                args.get(index)?.clone()
            }
            _ => return None,
        };

        match name {
            "--format" if value == "json" && !json => json = true,
            "--cache-dir" if cache_dir.is_none() && !value.is_empty() && !value.starts_with('-') => {
                cache_dir = Some(value)
            }
            _ => return None,
        }

        index += 1;
    }

    // A lossy argv conversion turns invalid UTF-8 into U+FFFD. Node would see the raw bytes.
    if !json || cache_dir.as_deref().is_none_or(|dir| dir.contains('\u{FFFD}')) {
        return None;
    }

    cache_dir
}

/// Answer the invocation, or delegate to Node, with the raw argv so no byte changes on the way. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let planned = parse(args).filter(|_| native_context());

    let Some(cache_dir) = planned else {
        crate::process::delegate(raw_args);
    };

    match status_json(Path::new(&cache_dir)) {
        Some(text) => {
            write_stdout("advisories", "the status", &text);
            exit(0)
        }
        None => crate::process::delegate(raw_args),
    }
}

/// The JSON text `vis advisories bloom status --format json` prints, or `None` when the cache
/// holds something this module will not reason about (Node then decides).
fn status_json(cache_dir: &Path) -> Option<String> {
    let cache_dir_text = cache_dir.to_string_lossy();
    let mut pairs: Vec<(&str, String)> = vec![("cacheDir", json_string(&cache_dir_text))];

    if !cache_dir.join("filter.bin").exists() {
        pairs.push(("present", "false".to_owned()));

        return Some(pretty_document(&pairs));
    }

    if let Some(manifest) = read_manifest(&cache_dir.join("manifest.json"))? {
        // A state file that cannot be read the same way delegates (see `read_state`).
        let state = read_state(&cache_dir.join("state.json"))?;

        if let Some(fetched) = state {
            pairs.push(("fetchedAtIso", json_string(&fetched)));
        }

        pairs.push(("manifest", object(&manifest)));
    } else {
        // An unreadable manifest is absent (Node drops the key), but state still counts.
        if let Some(fetched) = read_state(&cache_dir.join("state.json"))? {
            pairs.push(("fetchedAtIso", json_string(&fetched)));
        }
    }

    pairs.push(("present", "true".to_owned()));

    Some(pretty_document(&pairs))
}

/// The manifest fields, rendered, or `None` when Node would drop the manifest. The outer
/// `None` means "delegate": the file exists but its text cannot be trusted to parse the same.
fn read_manifest(path: &Path) -> Option<Option<Vec<(&'static str, String)>>> {
    let Some(text) = read_text(path)? else {
        return Some(None);
    };

    let value: Value = serde_json::from_str(&text).ok()?;
    let Value::Object(map) = value else {
        return Some(None);
    };

    let mut fields: Vec<(&'static str, String)> = Vec::new();
    let mut complete = true;

    for (key, upstream) in MANIFEST_NUMBERS {
        match map.get(upstream).and_then(Value::as_f64) {
            Some(number) => fields.push((key, js_number(number))),
            None => complete = false,
        }
    }

    for (key, upstream) in MANIFEST_STRINGS {
        match map.get(upstream).and_then(Value::as_str) {
            Some(text) if !text.is_empty() => fields.push((key, json_string(text))),
            _ => complete = false,
        }
    }

    if !complete || map.get("format_version").and_then(Value::as_f64) != Some(1.0) {
        return Some(None);
    }

    // `parseManifest` returns its fields in a fixed order, which is also the output order.
    fields.sort_by_key(|(key, _)| MANIFEST_ORDER.iter().position(|candidate| candidate == key).unwrap_or(usize::MAX));

    Some(Some(fields))
}

/// `fetchedAtIso` of a valid `state.json`, or `None` when Node would ignore the file. The outer
/// `None` means "delegate".
fn read_state(path: &Path) -> Option<Option<String>> {
    let Some(text) = read_text(path)? else {
        return Some(None);
    };

    let value: Value = serde_json::from_str(&text).ok()?;

    let Value::Object(map) = value else {
        return Some(None);
    };

    match (map.get("setDigestSha256").and_then(Value::as_str), map.get("fetchedAtIso").and_then(Value::as_str)) {
        (Some(_), Some(fetched)) => Some(Some(fetched.to_owned())),
        _ => Some(None),
    }
}

/// Node's `readFile(path, "utf8")` error handling: any read error means the file is absent.
/// `Some(None)` covers that. Invalid UTF-8 would be replaced by Node, so it returns `None`.
fn read_text(path: &Path) -> Option<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).ok().map(Some),
        Err(_) => Some(None),
    }
}

const MANIFEST_ORDER: [&str; 12] = [
    "advisoryCount",
    "bloomByteLen",
    "bloomKHashes",
    "bloomMBits",
    "builtAtRfc3339",
    "builtAtUnix",
    "entryCount",
    "filterSha256",
    "formatVersion",
    "setDigestSha256",
    "sourceUrl",
    "targetFpr",
];

fn object(pairs: &[(&str, String)]) -> String {
    let body: Vec<String> = pairs.iter().map(|(key, value)| format!("    \"{key}\": {value}")).collect();

    format!("{{\n{}\n  }}", body.join(",\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_numbers_round_trip_like_javascript() {
        // JavaScript's JSON.parse and Rust's correctly rounded parser agree on this value; serde_json's
        // default float parsing does not, unless `float_roundtrip` is enabled.
        let value: Value = serde_json::from_str("{\"n\":1.5777777777770001}").unwrap();

        assert_eq!(value["n"].as_f64(), Some("1.5777777777770001".parse::<f64>().unwrap()));
    }

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn parse_accepts_the_native_shape_in_either_flag_form() {
        assert_eq!(
            parse(&argv(&["advisories", "bloom", "status", "--format", "json", "--cache-dir", "/c"])).as_deref(),
            Some("/c")
        );
        assert_eq!(
            parse(&argv(&["advisories", "bloom", "status", "--cache-dir=/c", "--format=json"])).as_deref(),
            Some("/c")
        );
    }

    #[test]
    fn parse_delegates_every_other_shape() {
        let cases: [&[&str]; 9] = [
            &["advisories", "bloom", "status"],
            &["advisories", "bloom", "status", "--cache-dir", "/c"],
            &["advisories", "bloom", "status", "--format", "json"],
            &["advisories", "bloom", "status", "--format", "table", "--cache-dir", "/c"],
            &["advisories", "bloom", "status", "--format", "json", "--cache-dir", "/c", "--cache-dir", "/d"],
            &["advisories", "bloom", "status", "--format", "json", "--cache-dir", "-x"],
            &["advisories", "bloom", "status", "--format", "json", "--cache-dir="],
            &["advisories", "bloom", "status", "--format", "json", "--cache-dir", "/c", "--cwd", "/x"],
            &["advisories", "bloom", "status", "--format", "json", "--cache-dir", "/c", "extra"],
        ];

        for words in cases {
            assert_eq!(parse(&argv(words)), None, "argv {words:?}");
        }
    }

    #[test]
    fn parse_delegates_when_the_path_is_not_valid_utf8() {
        assert_eq!(
            parse(&argv(&["advisories", "bloom", "status", "--format", "json", "--cache-dir", "/\u{FFFD}"])),
            None
        );
    }
}
