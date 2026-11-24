//! `vis security keys-refresh --json [--clear]` — the native port of `src/commands/security/keys-refresh.ts` for
//! its JSON form: drop the cached npm signing keys, or fetch a fresh set and cache it.
//!
//! Node (`fetchRegistryKeys` in `src/security/marshalls/registry-keys.ts`) asks `VIS_NPM_KEYS_URL`, or
//! `https://registry.npmjs.org/-/npm/v1/keys`, with `fetch` and a 15 second limit, caches
//! `{createdAt, keys, ttlMs}` in `~/.vis/cache/registry-keys/npmjs.json`, and falls back to the old file when
//! the request fails. This module reproduces that, on the client of [`crate::http`], in a CI context off a
//! terminal at the root of a pnpm workspace (the context `shim status` answers in).
//!
//! Everything it cannot reproduce goes to Node before anything is printed or written:
//!
//! - the text form and every other argument;
//! - an environment where Node's `fetch` and this client would not reach the same server the same way: a proxy
//!   variable (Node ignores them unless `NODE_USE_ENV_PROXY` or `NODE_OPTIONS` ask for them), a CA file, or a
//!   TLS or Node option (see [`network_environment_is_plain`]);
//! - a redirect (`fetch` follows more hops than the client allows itself);
//! - a `VIS_NPM_KEYS_URL` that is not a plain `http(s)` URL on a port `fetch` always allows, and a `HOME` that
//!   is not a plain absolute path;
//! - a cache file that is not a JSON object with a `keys` array (Node removes a corrupt one), and an answer that
//!   is 2xx but not a JSON object, or has a byte-order mark, or holds a string `serde_json` rejects (a lone
//!   surrogate) or a number outside a double (`1e999`): the 2xx body is read the way `response.json()` does only
//!   for what this module reads identically.
//!
//! The cache file holds `JSON.stringify(keys)`, so the `keys` array is parsed and written again the way
//! JavaScript writes it (see [`Js`]): compact, strings escaped as JavaScript escapes them, numbers printed as
//! `Number.prototype.toString` prints them, and object keys in JavaScript's order (integer-like keys first,
//! ascending; a repeated key keeps its first place and its last value).
//!
//! The 15 second limit is Node's fixed one: `VIS_HTTP_TIMEOUT` and `VIS_HTTP_CONNECT_TIMEOUT`, which the other
//! commands of this binary honour, do not apply here.
//!
//! A refused or failed request is not a hand-off: Node's own reply to it (the old keys, or the
//! `fetch-failed` document and exit status 1) is reproduced.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;

use crate::advisories::{native_context, output_settings_are_default, write_stdout};
use crate::cache::vis_cache_dir;
use crate::http::{HttpClient, HttpConfig, HttpError};

const DEFAULT_KEYS_URL: &str = "https://registry.npmjs.org/-/npm/v1/keys";
/// `DEFAULT_FETCH_TIMEOUT_MS` of the Node module.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// `DEFAULT_TTL_MS`: a day.
const TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// `fetch` refuses a fixed list of ports, and the highest on it is 10080.
const LOWEST_UNBLOCKED_PORT: u32 = 10081;

/// Variables that change how Node's `fetch` reaches a server or whom it trusts, or that this client reads
/// differently: the proxy variables (and Node's switch for reading them), the CA files, and the Node options.
/// `NO_PROXY` alone changes nothing. The launcher keeps the same list in `networkEnvironmentIsPlain`
/// (`bin/route.mjs`); the shared cases of `native/cli/tests/fixtures/routing.json` fail when the two differ.
const NETWORK_VARIABLES: [&str; 12] = [
    "ALL_PROXY",
    "all_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_OPTIONS",
];

/// What a run prints and the status it ends with.
struct Outcome {
    stdout: String,
    status: i32,
}

#[derive(Clone, Copy)]
struct Flags {
    clear: bool,
}

/// The cached key set: how many keys the file holds.
struct Cached {
    count: usize,
}

/// A response body: only its `keys` member matters, kept as written.
#[derive(Deserialize)]
struct Body<'a> {
    #[serde(borrow)]
    keys: Option<&'a RawValue>,
}

/// Answers `vis security keys-refresh --json` natively or hands the whole invocation to Node. A hand-off names
/// its reason on stderr when `VIS_DEBUG_DECLINE` is set (see `delegate_because`).
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let outcome = match answer(args) {
        Ok(outcome) => outcome,
        Err(reason) => crate::delegate_because(&reason, raw_args),
    };

    write_stdout("security", "the output", &outcome.stdout);

    exit(outcome.status)
}

fn parse(args: &[String]) -> Option<Flags> {
    match args {
        [security, keys_refresh, json]
            if security == "security" && keys_refresh == "keys-refresh" && json == "--json" =>
        {
            Some(Flags { clear: false })
        }
        [security, keys_refresh, first, second]
            if security == "security"
                && keys_refresh == "keys-refresh"
                && matches!((first.as_str(), second.as_str()), ("--json", "--clear") | ("--clear", "--json")) =>
        {
            Some(Flags { clear: true })
        }
        _ => None,
    }
}

fn network_environment_is_plain() -> bool {
    NETWORK_VARIABLES.iter().all(|name| env::var_os(name).is_none())
}

/// The outcome of a run, or the reason it is Node's.
fn answer(args: &[String]) -> Result<Outcome, String> {
    let flags = parse(args).ok_or("not `security keys-refresh --json [--clear]`")?;

    for (declined, reason) in [
        (!cfg!(unix), "not a unix platform"),
        (!output_settings_are_default(), "an output setting (NODE_ENV, DEBUG, PAIL_LOG_LEVEL, CEREBRO_*) is set"),
        (io::stdout().is_terminal(), "stdout is a terminal"),
        (!native_context(), "not a CI run at the root of a pnpm workspace with a quiet stderr"),
        (!network_environment_is_plain(), "a proxy, CA or Node option is set in the environment"),
    ] {
        if declined {
            return Err(reason.to_owned());
        }
    }

    let file = PathBuf::from(vis_cache_dir().ok_or("no cache directory (HOME is not a plain absolute path)")?)
        .join("registry-keys")
        .join("npmjs.json");

    if flags.clear {
        return clear(&file);
    }

    let url = match env::var("VIS_NPM_KEYS_URL") {
        Ok(url) => url,
        Err(env::VarError::NotPresent) => DEFAULT_KEYS_URL.to_owned(),
        Err(env::VarError::NotUnicode(_)) => return Err("VIS_NPM_KEYS_URL is not Unicode".to_owned()),
    };

    if !url_is_plain(&url) {
        return Err(format!("VIS_NPM_KEYS_URL {url:?} is not a URL `fetch` and the client read alike"));
    }

    refresh(&file, &url)
}

/// `clearRegistryKeysCache`: remove the file when there is one.
fn clear(file: &Path) -> Result<Outcome, String> {
    let cleared = match fs::symlink_metadata(file) {
        Ok(metadata) if metadata.is_file() => {
            fs::remove_file(file).map_err(|error| format!("the cache file cannot be removed: {error}"))?;

            true
        }
        Ok(_) => return Err("the cache path is not a regular file".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("the cache file cannot be read: {error}")),
    };

    Ok(Outcome { stdout: document(&[("cleared", cleared.to_string()), ("refetched", "false".to_owned())]), status: 0 })
}

fn refresh(file: &Path, url: &str) -> Result<Outcome, String> {
    let cached = read_cache(file)?;
    let client = HttpClient::new(fetch_config(HttpConfig::from_env(FETCH_TIMEOUT, FETCH_TIMEOUT)));

    // A failed request, a failed write and a refused status all end the way Node's `catch` and `!response.ok`
    // do: the old keys when there are some, the `fetch-failed` document otherwise.
    let fetched = match client.get(url, &[("accept", "application/json")]) {
        Ok(response) => {
            let text = response.text().map_err(|error| format!("the answer is not UTF-8 text: {error}"))?;
            let keys = fetched_keys(text).ok_or("a 2xx answer that is not a JSON object Node reads the same way")?;

            store(file, &keys).then_some(keys)
        }
        // `fetch` has no size limit, so a body over this client's is Node's to read.
        Err(error @ (HttpError::TooLarge { .. } | HttpError::Redirect(_))) => return Err(error.to_string()),
        Err(_) => None,
    };

    Ok(match (fetched, cached) {
        (Some(keys), _) => Outcome {
            stdout: document(&[
                ("cleared", "false".to_owned()),
                ("fromCache", "false".to_owned()),
                ("keyCount", keys.count.to_string()),
                ("refetched", "true".to_owned()),
                ("stale", "false".to_owned()),
            ]),
            status: 0,
        },
        (None, Some(old)) => Outcome {
            stdout: document(&[
                ("cleared", "false".to_owned()),
                ("fromCache", "true".to_owned()),
                ("keyCount", old.count.to_string()),
                ("refetched", "false".to_owned()),
                ("stale", "true".to_owned()),
            ]),
            status: 0,
        },
        (None, None) => Outcome {
            stdout: document(&[
                ("cleared", "false".to_owned()),
                ("error", "\"fetch-failed\"".to_owned()),
                ("refetched", "false".to_owned()),
            ]),
            status: 1,
        },
    })
}

/// `config` with the limits Node's `fetch` has (one fixed 15 seconds) whatever `VIS_HTTP_TIMEOUT` and
/// `VIS_HTTP_CONNECT_TIMEOUT` say, and with redirects left to Node: `fetch` follows a different set of them than
/// the client does (https to http, the ports and credentials of the target), so a run that meets one is handed
/// over whole.
fn fetch_config(config: HttpConfig) -> HttpConfig {
    HttpConfig { follow_redirects: false, global_timeout: FETCH_TIMEOUT, connect_timeout: FETCH_TIMEOUT, ..config }
}

/// The cache entry on disk: `Ok(None)` when there is none, `Ok(Some(_))` for an object with a `keys` array,
/// and the reason for a hand-off for anything else, which Node removes or fails on.
fn read_cache(file: &Path) -> Result<Option<Cached>, String> {
    let metadata = match fs::symlink_metadata(file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("the cache file cannot be read: {error}")),
    };

    if !metadata.is_file() {
        return Err("the cache path is not a regular file".to_owned());
    }

    let text = fs::read_to_string(file).map_err(|error| format!("the cache file cannot be read: {error}"))?;
    let Ok(Value::Object(entry)) = serde_json::from_str::<Value>(&text) else {
        return Err("the cache file is not a JSON object".to_owned());
    };

    entry
        .get("keys")
        .and_then(Value::as_array)
        .map(|keys| Some(Cached { count: keys.len() }))
        .ok_or_else(|| "the cache file has no `keys` array".to_owned())
}

/// A fetched key set: how many keys, and `JSON.stringify(keys)` to cache.
struct Fetched {
    count: usize,
    raw: String,
}

/// A parsed JSON value that keeps what JavaScript's `JSON.parse` and `JSON.stringify` keep: the order of an
/// object's keys (before JavaScript's own reordering) and every number as a double.
enum Js {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Js>),
    /// Entries in first-seen order; a repeated key already replaced the value of the first.
    Object(Vec<(String, Js)>),
}

struct JsVisitor;

impl<'de> serde::de::Visitor<'de> for JsVisitor {
    type Value = Js;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<Js, E> {
        Ok(Js::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Js, E> {
        Ok(Js::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Js, E> {
        Ok(Js::Number(value as f64))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Js, E> {
        Ok(Js::Number(value as f64))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Js, E> {
        Ok(Js::Number(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Js, E> {
        Ok(Js::String(value.to_owned()))
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Js, A::Error> {
        let mut items = Vec::new();

        while let Some(item) = seq.next_element()? {
            items.push(item);
        }

        Ok(Js::Array(items))
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Js, A::Error> {
        let mut entries: Vec<(String, Js)> = Vec::new();
        let mut places: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

        while let Some((key, value)) = map.next_entry::<String, Js>()? {
            match places.get(&key) {
                Some(place) => entries[*place].1 = value,
                None => {
                    places.insert(key.clone(), entries.len());
                    entries.push((key, value));
                }
            }
        }

        Ok(Js::Object(entries))
    }
}

impl<'de> Deserialize<'de> for Js {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsVisitor)
    }
}

/// Whether JavaScript orders `key` among the integer indices of an object: a canonical decimal below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let canonical =
        key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit()));

    canonical.then(|| key.parse::<u32>().ok()).flatten().filter(|index| *index != u32::MAX)
}

/// `Number.prototype.toString` for a finite double: the shortest digits that read back as the same double, in
/// decimal up to 21 digits and from 1e-6 on, in exponent form beyond. A non-finite value is `null` in a document.
fn js_number(value: f64) -> Option<String> {
    if !value.is_finite() {
        return Some("null".to_owned());
    }

    if value == 0.0 {
        return Some("0".to_owned());
    }

    if value < 0.0 {
        return Some(format!("-{}", js_number(-value)?));
    }

    // Rust prints the shortest digits that round-trip too: `d.ddde<exponent>`.
    let scientific = format!("{value:e}");
    let (mantissa, exponent) = scientific.split_once('e')?;
    let digits: String = mantissa.chars().filter(|character| *character != '.').collect();
    let point = exponent.parse::<i32>().ok()? + 1;
    let length = i32::try_from(digits.len()).ok()?;

    Some(if length <= point && point <= 21 {
        format!("{digits}{}", "0".repeat(usize::try_from(point - length).ok()?))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(usize::try_from(point).ok()?);

        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat(usize::try_from(-point).ok()?))
    } else {
        let power = point - 1;
        let sign = if power < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let fraction = if rest.is_empty() { String::new() } else { format!(".{rest}") };

        format!("{first}{fraction}e{sign}{}", power.abs())
    })
}

impl Js {
    /// `JSON.stringify(value)` with no indentation.
    fn stringify(&self, out: &mut String) -> Option<()> {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Self::Number(value) => out.push_str(&js_number(*value)?),
            // `serde_json` escapes the quote, the backslash and the control characters, as JavaScript does, and
            // writes every other character as it is.
            Self::String(text) => out.push_str(&serde_json::to_string(text).ok()?),
            Self::Array(items) => {
                out.push('[');

                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }

                    item.stringify(out)?;
                }

                out.push(']');
            }
            Self::Object(entries) => {
                // Integer-like keys come first, ascending; the rest keep their order.
                let mut indexed: Vec<(u32, &(String, Js))> =
                    entries.iter().filter_map(|entry| Some((array_index(&entry.0)?, entry))).collect();

                indexed.sort_by_key(|(index, _)| *index);

                let others = entries.iter().filter(|entry| array_index(&entry.0).is_none());

                out.push('{');

                for (position, (key, value)) in indexed.into_iter().map(|(_, entry)| entry).chain(others).enumerate() {
                    if position > 0 {
                        out.push(',');
                    }

                    out.push_str(&serde_json::to_string(key).ok()?);
                    out.push(':');
                    value.stringify(out)?;
                }

                out.push('}');
            }
        }

        Some(())
    }
}

/// What Node does with a 2xx body that is a JSON object: a missing or non-array `keys` is the empty list. `None`
/// hands the run to Node: a body that is not an object, one `response.json()` would read differently (a
/// byte-order mark, a repeated `keys`), or one that does not parse, which Node answers as a failed request.
fn fetched_keys(text: &str) -> Option<Fetched> {
    if text.starts_with('\u{feff}') || !text.trim_start().starts_with('{') {
        return None;
    }

    let body: Body = serde_json::from_str(text).ok()?;

    let Some(raw) = body.keys.map(RawValue::get).filter(|raw| raw.starts_with('[')) else {
        return Some(Fetched { count: 0, raw: "[]".to_owned() });
    };

    let keys = serde_json::from_str::<Js>(raw).ok()?;
    let Js::Array(items) = &keys else {
        return None;
    };

    let mut compact = String::new();

    keys.stringify(&mut compact)?;

    Some(Fetched { count: items.len(), raw: compact })
}

/// `writeCachedKeys`: `JSON.stringify({createdAt, keys, ttlMs})`.
fn store(file: &Path, keys: &Fetched) -> bool {
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else { return false };
    let entry = format!("{{\"createdAt\":{},\"keys\":{},\"ttlMs\":{TTL_MS}}}", now.as_millis(), keys.raw);

    file.parent().is_some_and(|directory| fs::create_dir_all(directory).is_ok()) && fs::write(file, entry).is_ok()
}

/// `JSON.stringify(object, undefined, 2)` and a newline, for values already written as JSON.
fn document(fields: &[(&str, String)]) -> String {
    let lines: Vec<String> = fields.iter().map(|(name, value)| format!("  \"{name}\": {value}")).collect();

    format!("{{\n{}\n}}\n", lines.join(",\n"))
}

/// A URL `fetch` and this client read the same way: lower-case `http` or `https`, printable ASCII without
/// backslashes, a fragment or an IPv6 literal, no user name or password, and no port from the list `fetch` refuses.
fn url_is_plain(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) else {
        return false;
    };

    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    let port_is_allowed = authority
        .rsplit_once(':')
        .is_none_or(|(_, port)| port.parse::<u32>().is_ok_and(|port| port >= LOWEST_UNBLOCKED_PORT));

    !authority.is_empty()
        && !authority.contains(['@', '['])
        && port_is_allowed
        && url.bytes().all(|byte| byte.is_ascii_graphic() && byte != b'\\' && byte != b'#')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn only_the_json_forms_are_native() {
        assert!(parse(&args(&["security", "keys-refresh", "--json"])).is_some_and(|flags| !flags.clear));
        assert!(parse(&args(&["security", "keys-refresh", "--clear", "--json"])).is_some_and(|flags| flags.clear));
        assert!(parse(&args(&["security", "keys-refresh", "--json", "--clear"])).is_some_and(|flags| flags.clear));

        for other in [
            &["security", "keys-refresh"][..],
            &["security", "keys-refresh", "--clear"],
            &["security", "keys-refresh", "--json", "--json"],
            &["security", "keys-refresh", "--json", "--cwd", "."],
            &["security", "keys-refresh", "--json=true"],
            &["security", "list", "--json"],
        ] {
            assert!(parse(&args(other)).is_none(), "{other:?}");
        }
    }

    #[test]
    fn a_key_set_is_counted_and_written_compact() {
        let fetched = fetched_keys(r#" {"keys":[{"keyid":"a","key":"x"}, {"b":1}], "extra": true}"#).unwrap();

        assert_eq!((fetched.count, fetched.raw.as_str()), (2, r#"[{"keyid":"a","key":"x"},{"b":1}]"#));

        for empty in [r#"{}"#, r#"{"keys":null}"#, r#"{"keys":{"a":1}}"#, r#"{"keys":"x"}"#, r#"{"keys":[]}"#] {
            let fetched = fetched_keys(empty).unwrap();

            assert_eq!((fetched.count, fetched.raw.as_str()), (0, "[]"), "{empty}");
        }
    }

    #[test]
    fn a_key_set_is_written_the_way_json_stringify_writes_it() {
        let written = |text: &str| fetched_keys(text).unwrap().raw;

        // Whitespace goes, and a number prints the way JavaScript prints it.
        assert_eq!(
            written("{\"keys\": [ 1.0, 1e2, 2.50, -0, -0.0, 1E5, 0.000001, 1e-7, 1e21, 12345678901234567890 ]}"),
            "[1,100,2.5,0,0,100000,0.000001,1e-7,1e+21,12345678901234567000]"
        );
        assert_eq!(
            written("{\"keys\":[9007199254740993,5e-324,1.7976931348623157e308,-1.5e-10,123456789012345680000]}"),
            "[9007199254740992,5e-324,1.7976931348623157e+308,-1.5e-10,123456789012345680000]"
        );

        // Strings keep their characters and escape what JavaScript escapes.
        assert_eq!(
            written(r#"{"keys":["caf\u00e9 \/ \u0041 \n \u0001 \u007f \u2028 \ud83d\ude00 \"q\" \\"]}"#),
            "[\"caf\u{e9} / A \\n \\u0001 \u{7f} \u{2028} \u{1f600} \\\"q\\\" \\\\\"]"
        );

        // Integer-like keys come first and ascending, a repeated key keeps its first place and its last value.
        assert_eq!(
            written(r#"{"keys":[{"b":1,"2":2,"1":3,"a":4,"a":5,"01":6,"4294967295":7,"4294967294":8}]}"#),
            r#"[{"1":3,"2":2,"4294967294":8,"b":1,"a":5,"01":6,"4294967295":7}]"#
        );
    }

    #[test]
    fn a_body_node_may_read_differently_is_handed_over() {
        for text in [
            "",
            "null",
            "[]",
            "5",
            "\"x\"",
            "\u{feff}{}",
            "{",
            "{\"keys\":[1,}",
            r#"{"keys":[],"keys":[1]}"#,
            "<html>",
            r#"{"keys":["\ud800"]}"#,
            r#"{"keys":[1e999]}"#,
        ] {
            assert!(fetched_keys(text).is_none(), "{text:?}");
        }
    }

    #[test]
    fn the_request_keeps_node_s_fixed_limit_whatever_the_environment_says() {
        let from_environment = HttpConfig::from_lookup(
            &|name| match name {
                "VIS_HTTP_TIMEOUT" => Some("90".into()),
                "VIS_HTTP_CONNECT_TIMEOUT" => Some("3".into()),
                _ => None,
            },
            FETCH_TIMEOUT,
            FETCH_TIMEOUT,
        );

        assert_eq!(from_environment.global_timeout, Duration::from_secs(90));

        let config = fetch_config(from_environment);

        assert_eq!((config.global_timeout, config.connect_timeout), (FETCH_TIMEOUT, FETCH_TIMEOUT));
        assert!(!config.follow_redirects);
    }

    #[test]
    fn the_documents_are_json_stringify_with_two_spaces() {
        assert_eq!(
            document(&[("cleared", "true".to_owned()), ("refetched", "false".to_owned())]),
            "{\n  \"cleared\": true,\n  \"refetched\": false\n}\n"
        );
    }

    #[test]
    fn a_url_must_be_plain() {
        for plain in [
            "https://registry.npmjs.org/-/npm/v1/keys",
            "http://127.0.0.1:49152/keys",
            "http://localhost/keys?a=1",
            "https://example.test:443/x",
        ] {
            assert!(url_is_plain(plain) == !plain.ends_with(":443/x"), "{plain}");
        }

        for odd in [
            "",
            "HTTP://a.test/",
            "file:///etc/passwd",
            "ftp://a.test/",
            "https://user:pw@a.test/",
            "http://a.test:6667/",
            "http://a.test:80/",
            "http://a.test/ x",
            "http://a.test/#f",
            "http://a.test\\x",
            "http://[::1]:49152/",
            "http://",
            "/relative",
        ] {
            assert!(!url_is_plain(odd), "{odd}");
        }
    }

    #[test]
    fn a_cache_file_is_read_for_its_key_count_or_handed_over() {
        let directory = std::env::temp_dir().join(format!("vis-keys-refresh-test-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let file = directory.join("npmjs.json");

        assert!(matches!(read_cache(&file), Ok(None)));

        for (text, expected) in [
            (r#"{"createdAt":1,"keys":[1,2,3],"ttlMs":2}"#, Some(3)),
            (r#"{"keys":[]}"#, Some(0)),
            ("{}", None),
            (r#"{"keys":"x"}"#, None),
            ("[]", None),
            ("not json", None),
            ("", None),
        ] {
            fs::write(&file, text).unwrap();

            assert_eq!(
                read_cache(&file).ok().map(|cached| cached.map(|cached| cached.count)),
                expected.map(Some),
                "{text}"
            );
        }

        fs::remove_dir_all(&directory).unwrap();
    }
}
