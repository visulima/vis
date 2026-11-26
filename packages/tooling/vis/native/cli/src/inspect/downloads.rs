//! The `downloads` marshall: `src/security/marshalls/downloads.ts` for one package.
//!
//! Node reads the cached count (`<cache>/downloads/<name>.json`, 24 hours), else asks the registry's download API for the
//! last month and caches the count. A count under 20 is an error, one under 10000 a warning, and an answer without a
//! count (a 404, any other status, a body that has no number in `downloads`) is a warning that says so and caches nothing.
//!
//! What it does not reproduce goes to Node before anything is printed or written: a request that fails before an answer
//! (DNS, connection, TLS, timeout: Node reports those as "no data" too, but whether they fail depends on the machine, so
//! the run is Node's to repeat), a redirect, a body that is not JSON this module reads, and a count that is not a whole
//! number JavaScript writes the way Rust does.

use std::path::{Path, PathBuf};

use super::marshalls::{Finding, Severity};
use super::packument::{encode, Cached};
use super::{service_cache, CacheAction};
use crate::http::{HttpClient, HttpError};
use crate::js::MAX_SAFE_INTEGER;
use crate::keys_refresh::Js;

/// `DEFAULT_TTL_MS`: 24 hours.
const TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// `DEFAULT_ERROR_THRESHOLD` and `DEFAULT_WARN_THRESHOLD`.
const ERROR_THRESHOLD: u64 = 20;
const WARN_THRESHOLD: u64 = 10_000;

/// `DOWNLOADS_API_BASE`.
pub(super) const API: &str = "https://api.npmjs.org/downloads/point/last-month";

pub(super) fn cache_file(cache_dir: &str, name: &str) -> PathBuf {
    Path::new(cache_dir).join("downloads").join(format!("{}.json", encode(name)))
}

/// The answer of the API: a count, or no count (`fetchDownloads`' `no-data` and `error`).
enum Answer {
    Count(u64),
    NoData,
}

/// A JSON number that is a whole number from 0 to 2^53 - 1, which `String(n)`, `JSON.stringify(n)` and Rust write alike.
fn whole(value: &Js) -> Option<u64> {
    match value {
        Js::Number(number) if number.fract() == 0.0 && *number >= 0.0 && *number <= MAX_SAFE_INTEGER as f64 => {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn fetch(client: &HttpClient, url: &str) -> Result<Answer, String> {
    let response = match client.get(url, &[]) {
        Ok(response) => response,
        // 404, 429, 5xx and every other status without a redirect: `no-data`, nothing cached.
        Err(HttpError::Status { .. }) => return Ok(Answer::NoData),
        Err(error) => return Err(format!("the downloads request failed: {error}")),
    };
    let text = response.text().map_err(|error| format!("the downloads answer is not UTF-8 text: {error}"))?;

    if text.starts_with('\u{feff}') {
        return Err("the downloads answer starts with a byte-order mark".to_owned());
    }

    let body: Js =
        serde_json::from_str(text).map_err(|_| "the downloads answer is not JSON this module reads".to_owned())?;

    match body.member("downloads") {
        Some(number @ Js::Number(_)) => whole(number)
            .map(Answer::Count)
            .ok_or_else(|| "the download count is not a whole number JavaScript writes the way Rust does".to_owned()),
        // A missing or other member, and a body that is not an object (`null` throws, which Node reads as `error`).
        _ => Ok(Answer::NoData),
    }
}

/// `observedAt` is `new Date().toISOString()`.
fn cache_entry(count: u64, now_ms: u64) -> String {
    format!(
        "{{\"createdAt\":{now_ms},\"downloads\":{count},\"observedAt\":\"{}\",\"ttlMs\":{TTL_MS}}}",
        vis_core::date::iso_from_millis(i64::try_from(now_ms).unwrap_or(0))
    )
}

/// The finding of `runDownloadsMarshall` for `name`, if any, and the cache change that goes with it.
pub(super) fn run(
    client: &HttpClient,
    base: &str,
    cache_dir: &str,
    name: &str,
    now_ms: u64,
) -> Result<(Vec<Finding>, Vec<CacheAction>), String> {
    let file = cache_file(cache_dir, name);
    let mut cache = Vec::new();
    let count = match service_cache::read(&file, now_ms as f64)? {
        Cached::Fresh(entry) => entry
            .member("downloads")
            .and_then(whole)
            .ok_or("a cached download count is missing or not a whole number")?,
        Cached::Fetch { stale_file } => {
            if stale_file {
                cache.push(CacheAction::Remove(file.clone()));
            }

            match fetch(client, &format!("{base}/{}", encode(name)))? {
                Answer::NoData => {
                    let message = "npm stats API returned no monthly download data.".to_owned();

                    return Ok((vec![finding(name, Severity::Warning, message)], cache));
                }
                Answer::Count(count) => {
                    cache.push(CacheAction::Write { file, text: cache_entry(count, now_ms) });

                    count
                }
            }
        }
    };
    let severity = if count < ERROR_THRESHOLD {
        Severity::Error
    } else if count < WARN_THRESHOLD {
        Severity::Warning
    } else {
        return Ok((Vec::new(), cache));
    };

    Ok((vec![finding(name, severity, format!("Only {count} downloads in the past month."))], cache))
}

fn finding(name: &str, severity: Severity, message: String) -> Finding {
    Finding { marshall: "downloads", message, package: name.to_owned(), severity }
}
