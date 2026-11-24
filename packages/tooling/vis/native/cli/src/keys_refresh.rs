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
//!   is 2xx but not a JSON object, or has a byte-order mark: the 2xx body is read the way `response.json()`
//!   does only for what `serde_json` reads identically.
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
    // Redirects are Node's: `fetch` follows a different set of them than the client does (https to http, the
    // ports and credentials of the target), so a run that meets one is handed over whole.
    let client =
        HttpClient::new(HttpConfig { follow_redirects: false, ..HttpConfig::from_env(FETCH_TIMEOUT, FETCH_TIMEOUT) });

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

/// A fetched key set: how many keys, and the `keys` text to cache.
struct Fetched {
    count: usize,
    raw: String,
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

    Some(Fetched { count: serde_json::from_str::<Vec<&RawValue>>(raw).ok()?.len(), raw: raw.to_owned() })
}

/// `writeCachedKeys`: `JSON.stringify({createdAt, keys, ttlMs})`, the `keys` as the registry sent them.
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
    fn a_key_set_is_counted_and_kept_as_written() {
        let fetched = fetched_keys(r#" {"keys":[{"keyid":"a","key":"x"}, {"b":1}], "extra": true}"#).unwrap();

        assert_eq!((fetched.count, fetched.raw.as_str()), (2, r#"[{"keyid":"a","key":"x"}, {"b":1}]"#));

        for empty in [r#"{}"#, r#"{"keys":null}"#, r#"{"keys":{"a":1}}"#, r#"{"keys":"x"}"#, r#"{"keys":[]}"#] {
            let fetched = fetched_keys(empty).unwrap();

            assert_eq!((fetched.count, fetched.raw.as_str()), (0, "[]"), "{empty}");
        }
    }

    #[test]
    fn a_body_node_may_read_differently_is_handed_over() {
        for text in
            ["", "null", "[]", "5", "\"x\"", "\u{feff}{}", "{", "{\"keys\":[1,}", r#"{"keys":[],"keys":[1]}"#, "<html>"]
        {
            assert!(fetched_keys(text).is_none(), "{text:?}");
        }
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
