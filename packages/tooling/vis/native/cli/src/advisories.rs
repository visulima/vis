//! `vis advisories bloom status --format json --cache-dir <dir>` — the native fast path.
//!
//! The Node command (`src/commands/advisories/bloom-status.ts`) only reads the osv-bloom
//! cache: `getOsvBloomStatus` (`src/security/osv-bloom.ts`) checks for `filter.bin`, then
//! reads `manifest.json` and `state.json` best-effort. This module reproduces that read and
//! the `JSON.stringify(status, undefined, 2)` output byte for byte.
//!
//! Only the shape above is native, and only in the context [`native_context`] accepts. The table
//! output, the `--cache-dir`-less form (which needs `@visulima/find-cache-dir`'s lookup and its
//! `mkdir`), any config or Deno file, a missing `VIS_MONOREPO_ROOT`, and any manifest or state
//! file this module cannot read with the same result as JavaScript all go to Node via
//! [`crate::delegate`]. `sync`, `prune` and `bloom sync` are never native: they touch the
//! network or delete files.

use std::env;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use serde_json::Value;

use crate::pm_family::has_vis_config;

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

/// Answer the invocation, or delegate to Node. Never returns.
pub fn run(args: &[String]) -> ! {
    let planned = parse(args).filter(|_| native_context());

    let Some(cache_dir) = planned else {
        crate::delegate(args);
    };

    match status_json(Path::new(&cache_dir)) {
        Some(text) => {
            let mut stdout = io::stdout().lock();

            match stdout.write_all(text.as_bytes()).and_then(|()| stdout.flush()) {
                Ok(()) => exit(0),
                // A closed pipe is not an error worth reporting.
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => exit(0),
                Err(error) => {
                    eprintln!("vis advisories: failed to write the status: {error}");
                    exit(1);
                }
            }
        }
        None => crate::delegate(args),
    }
}

/// Whether Node would reach the same answer without a workspace search or any config notice.
///
/// Node resolves the workspace root with `@visulima/package`'s search (lerna, turbo, pnpm, npm
/// markers), which this crate does not reproduce. `VIS_MONOREPO_ROOT` skips that search, and the
/// root is then known to be truthy. Node also warns about a missing `vis.config` and about Deno
/// files, but only outside CI, and it prints tips and notices on a terminal. So the native path
/// needs CI, a non-terminal stderr, and no config or Deno file at or above either directory.
fn native_context() -> bool {
    let Some(cwd) = env::current_dir().ok() else {
        return false;
    };

    let Some(root) = env::var_os("VIS_MONOREPO_ROOT").filter(|root| !root.is_empty()).map(PathBuf::from) else {
        return false;
    };

    if !in_ci() || io::stderr().is_terminal() {
        return false;
    }

    [cwd.as_path(), root.as_path()]
        .iter()
        .all(|directory| !has_vis_config(directory) && !any_ancestor_has(directory, &DENO_FILES))
}

/// `is-in-ci`: `CI` or `CONTINUOUS_INTEGRATION` set to anything but `0` or `false`.
fn in_ci() -> bool {
    ["CI", "CONTINUOUS_INTEGRATION"]
        .iter()
        .any(|key| env::var_os(key).is_some_and(|value| value != "0" && value != "false"))
}

const DENO_FILES: [&str; 3] = ["deno.json", "deno.jsonc", "deno.lock"];

/// Whether `directory` or one of its ancestors holds a file named in `names`.
fn any_ancestor_has(directory: &Path, names: &[&str]) -> bool {
    directory.ancestors().any(|ancestor| names.iter().any(|name| ancestor.join(name).exists()))
}

/// The JSON text `vis advisories bloom status --format json` prints, or `None` when the cache
/// holds something this module will not reason about (Node then decides).
fn status_json(cache_dir: &Path) -> Option<String> {
    let cache_dir_text = cache_dir.to_string_lossy();
    let mut pairs: Vec<(&str, String)> = vec![("cacheDir", json_string(&cache_dir_text)?)];

    if !cache_dir.join("filter.bin").exists() {
        pairs.push(("present", "false".to_owned()));

        return Some(finish(&pairs));
    }

    if let Some(manifest) = read_manifest(&cache_dir.join("manifest.json"))? {
        // A state file that cannot be read the same way delegates (see `read_state`).
        let state = read_state(&cache_dir.join("state.json"))?;

        if let Some(fetched) = state {
            pairs.push(("fetchedAtIso", json_string(&fetched)?));
        }

        pairs.push(("manifest", object(&manifest)));
    } else {
        // An unreadable manifest is absent (Node drops the key), but state still counts.
        if let Some(fetched) = read_state(&cache_dir.join("state.json"))? {
            pairs.push(("fetchedAtIso", json_string(&fetched)?));
        }
    }

    pairs.push(("present", "true".to_owned()));

    Some(finish(&pairs))
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
            Some(text) if !text.is_empty() => fields.push((key, json_string(text)?)),
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

/// The top-level object, pretty-printed as `JSON.stringify(status, undefined, 2)` does.
fn finish(pairs: &[(&str, String)]) -> String {
    let body: Vec<String> = pairs.iter().map(|(key, value)| format!("  \"{key}\": {value}")).collect();

    format!("{{\n{}\n}}\n", body.join(",\n"))
}

/// `JSON.stringify` of a string. serde_json escapes the same characters: quotes, backslashes and
/// control characters. Returns `None` only if serde_json rejects the input, which Node would not.
fn json_string(text: &str) -> Option<String> {
    serde_json::to_string(text).ok()
}

/// `JSON.stringify` of a finite JavaScript number: the shortest digits that round-trip, written
/// the way `Number.prototype.toString` writes them (exponent form outside [1e-6, 1e21)).
fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }

    let sign = if value < 0.0 { "-" } else { "" };

    // `{:e}` yields the shortest round-trip digits, the same digits JavaScript picks.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|character| *character != '.').collect();
    let count = digits.len() as i32;
    let point = exponent + 1;

    let body = if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let power = point - 1;
        let power_sign = if power < 0 { "-" } else { "+" };

        if count == 1 {
            format!("{digits}e{power_sign}{}", power.abs())
        } else {
            format!("{}.{}e{power_sign}{}", &digits[..1], &digits[1..], power.abs())
        }
    };

    format!("{sign}{body}")
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
    fn js_number_matches_javascript_number_to_string() {
        // Expected values are what `JSON.stringify` prints for the same doubles.
        let cases: [(f64, &str); 12] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (100.0, "100"),
            (1.5, "1.5"),
            (0.001, "0.001"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (-2.5, "-2.5"),
        ];

        for (value, expected) in cases {
            assert_eq!(js_number(value), expected, "value {value:?}");
        }
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
