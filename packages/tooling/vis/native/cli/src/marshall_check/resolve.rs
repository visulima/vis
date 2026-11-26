//! `resolveExplicitPackages` of `src/security/marshalls/resolve-explicit.ts`: each `<name>[@<spec>]` argument becomes a
//! concrete `{name, version}` before the marshalls run.
//!
//! A spec that `semver.coerce` reads (`^18.2.0`, `18`) gives its version with no request. Any other (a tag, a range with no
//! number, no spec) asks `https://registry.npmjs.org/<name>/latest`, the fixed address Node asks whatever `.npmrc` says; a
//! name that does not resolve is dropped, and the marshalls never see it.

use std::collections::HashMap;
use std::time::Duration;

use regex::bytes::Regex;

use crate::add::parse_package_argument;
use crate::http::node_fetch::{fetch_config, url_is_plain};
use crate::http::{HttpClient, HttpConfig, HttpError};

/// `DEFAULT_RESOLVE_TIMEOUT_MS`.
pub(super) const TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const LATEST_BASE: &str = "https://registry.npmjs.org";

/// `MAX_SAFE_INTEGER`: node-semver rejects a component above it.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// `semver.coerce(spec)?.version`: the first run of up to three numbers in the text, read as `major.minor.patch`.
///
/// The expression is node-semver's `COERCE` (digits of at most 16 characters, ASCII only), which finds the leftmost
/// match; a component with a leading zero or above `MAX_SAFE_INTEGER` makes the version invalid, and so `null`.
pub(super) fn coerce(spec: &str) -> Option<String> {
    let pattern = Regex::new(r"(?-u)(^|[^0-9])([0-9]{1,16})(?:\.([0-9]{1,16}))?(?:\.([0-9]{1,16}))?(?:$|[^0-9])")
        .expect("the coerce expression compiles");
    let found = pattern.captures(spec.as_bytes())?;
    let part = |index: usize| -> Option<&str> {
        found.get(index).map(|group| std::str::from_utf8(group.as_bytes()).expect("a run of digits is ASCII"))
    };
    let component = |text: Option<&str>| -> Option<u64> {
        let text = text.unwrap_or("0");

        (text == "0" || !text.starts_with('0'))
            .then(|| text.parse::<u64>().ok())
            .flatten()
            .filter(|n| *n <= MAX_SAFE_INTEGER)
    };

    Some(format!("{}.{}.{}", component(part(2))?, component(part(3))?, component(part(4))?))
}

/// What the registry's `/<name>/latest` answers for each name: the names that resolved, and their version. A request
/// that fails resolves nothing, as in Node; the reason for a hand-off for a redirect (`fetch` follows more of them than the
/// client does) and for a version that is not text.
pub(super) fn latest_versions(base: &str, names: &[String]) -> Result<HashMap<String, String>, String> {
    let client = HttpClient::new(fetch_config(HttpConfig::from_env(TIMEOUT, TIMEOUT), TIMEOUT));
    let mut versions = HashMap::new();

    for name in names {
        let url = format!("{base}/{name}/latest");

        if !url_is_plain(&url) {
            return Err(format!("the URL {url:?} is not one `fetch` and the client read alike"));
        }

        let response = match client.get(&url, &[("accept", "application/json")]) {
            Ok(response) => response,
            Err(error @ (HttpError::Redirect(_) | HttpError::TooLarge { .. })) => return Err(error.to_string()),
            Err(_) => continue,
        };
        let text = response.text().map_err(|error| format!("the answer is not UTF-8 text: {error}"))?;

        // `response.json()` throws on anything else, and the name is dropped like any failure.
        let Ok(body) = serde_json::from_str::<serde_json::Value>(text) else { continue };

        match body.get("version") {
            Some(serde_json::Value::String(version)) if !version.is_empty() => {
                versions.insert(name.clone(), version.clone());
            }
            None | Some(serde_json::Value::Null | serde_json::Value::Bool(false)) => {}
            Some(serde_json::Value::String(_)) => {}
            Some(_) => return Err("a `version` that is not text".to_owned()),
        }
    }

    Ok(versions)
}

/// What the registry's `/latest` resolved: name to version.
pub(super) type Latest = HashMap<String, String>;

/// Every argument as `{name, version}`, in order, those that resolve only. `latest` is asked for the names no spec gave a
/// version, once each.
pub(super) fn resolve_explicit(
    packages: &[String],
    latest: &dyn Fn(&[String]) -> Result<Latest, String>,
) -> Result<Vec<(String, String)>, String> {
    let parsed: Vec<(&str, Option<&str>)> = packages
        .iter()
        .map(|package| parse_package_argument(package).ok_or_else(|| format!("{package:?} is not a plain package")))
        .collect::<Result<_, _>>()?;
    let mut coerced: HashMap<&str, String> = HashMap::new();

    for (name, spec) in &parsed {
        if let Some(version) = spec.and_then(coerce) {
            coerced.insert(name, version);
        }
    }

    let mut needed: Vec<String> = Vec::new();

    for (name, _) in &parsed {
        if !coerced.contains_key(name) && !needed.iter().any(|known| known == name) {
            needed.push((*name).to_owned());
        }
    }

    let resolved = if needed.is_empty() { HashMap::new() } else { latest(&needed)? };

    Ok(parsed
        .iter()
        .filter_map(|(name, _)| {
            coerced.get(name).or_else(|| resolved.get(*name)).map(|version| ((*name).to_owned(), version.clone()))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coerce_reads_the_first_numbers_the_way_node_semver_does() {
        for (spec, version) in [
            ("18", "18.0.0"),
            ("^18.2.0", "18.2.0"),
            ("~1.2", "1.2.0"),
            (">=1.2.3 <2", "1.2.3"),
            ("1.2.3.4", "1.2.3"),
            ("v2.0", "2.0.0"),
            ("1.x", "1.0.0"),
            ("x.5", "5.0.0"),
            ("npm:foo@1", "1.0.0"),
            ("1.0.0-beta.2", "1.0.0"),
            ("0", "0.0.0"),
            ("latest2", "2.0.0"),
            ("9007199254740991", "9007199254740991.0.0"),
        ] {
            assert_eq!(coerce(spec).as_deref(), Some(version), "{spec}");
        }

        // No number, a number node-semver rejects, and a run of digits that is too long.
        for spec in ["latest", "next", "*", "workspace:*", "", "01.2.3", "9999999999999999", "12345678901234567890"] {
            assert_eq!(coerce(spec), None, "{spec}");
        }
    }

    fn resolve(packages: &[&str], latest: &[(&str, &str)]) -> (Vec<(String, String)>, Vec<Vec<String>>) {
        let asked = std::cell::RefCell::new(Vec::new());
        let packages: Vec<String> = packages.iter().map(|package| (*package).to_owned()).collect();
        let resolved = resolve_explicit(&packages, &|names| {
            asked.borrow_mut().push(names.to_vec());

            Ok(latest.iter().map(|(name, version)| ((*name).to_owned(), (*version).to_owned())).collect())
        })
        .unwrap();

        (resolved, asked.into_inner())
    }

    #[test]
    fn a_spec_that_coerces_needs_no_request_and_the_rest_asks_for_latest_once() {
        let pair = |name: &str, version: &str| (name.to_owned(), version.to_owned());

        let (resolved, asked) = resolve(&["react@^18.2.0", "lodash@4"], &[]);

        assert_eq!(resolved, [pair("react", "18.2.0"), pair("lodash", "4.0.0")]);
        assert!(asked.is_empty());

        let (resolved, asked) =
            resolve(&["react", "react@next", "@s/pkg@latest", "ghost"], &[("react", "19.0.0"), ("@s/pkg", "1.2.3")]);

        assert_eq!(asked, [["react", "@s/pkg", "ghost"]]);
        // The name that resolves nowhere is dropped, and a name keeps one version for every argument that names it.
        assert_eq!(resolved, [pair("react", "19.0.0"), pair("react", "19.0.0"), pair("@s/pkg", "1.2.3")]);

        // The version a spec gives wins over the registry's, for every argument of that name.
        let (resolved, _) = resolve(&["react", "react@17"], &[("react", "19.0.0")]);

        assert_eq!(resolved, [pair("react", "17.0.0"), pair("react", "17.0.0")]);
    }

    #[test]
    fn latest_versions_come_from_the_registry_and_the_names_that_fail_are_dropped() {
        use crate::inspect::tests::{ok, Registry};

        let registry = Registry::start(HashMap::from([
            ("/react/latest".to_owned(), ok(&serde_json::json!({ "version": "19.0.0" }))),
            ("/@s/pkg/latest".to_owned(), ok(&serde_json::json!({ "version": "1.2.3", "name": "@s/pkg" }))),
            ("/empty/latest".to_owned(), ok(&serde_json::json!({ "version": "" }))),
            ("/none/latest".to_owned(), ok(&serde_json::json!({}))),
            ("/html/latest".to_owned(), (200, "<html>".to_owned(), Vec::new())),
            ("/down/latest".to_owned(), (503, "{}".to_owned(), Vec::new())),
            ("/number/latest".to_owned(), ok(&serde_json::json!({ "version": 5 }))),
        ]));
        let names = |list: &[&str]| list.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
        let found =
            latest_versions(&registry.url(), &names(&["react", "@s/pkg", "empty", "none", "html", "down", "ghost"]))
                .unwrap();

        assert_eq!(found.len(), 2);
        assert_eq!(found["react"], "19.0.0");
        assert_eq!(found["@s/pkg"], "1.2.3");
        assert!(registry.paths.lock().unwrap().iter().any(|request| request.starts_with("GET /@s/pkg/latest ")));

        // A version that is no text is a value Node reads its own way.
        assert!(latest_versions(&registry.url(), &names(&["number"])).is_err());
        // A URL `fetch` and the client would read differently is Node's.
        assert!(latest_versions("https://user:pw@registry.test", &names(&["react"])).is_err());
    }
}
