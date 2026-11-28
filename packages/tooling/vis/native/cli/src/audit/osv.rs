//! The OSV query of `vis audit`: `fetchVulnerabilities` of `src/util/catalog/osv.ts`, for the answers this crate
//! reproduces.
//!
//! Node sends one `POST` with a query per package, waits at most 10 seconds and treats every failure as "no
//! findings": a status outside 2xx, a connection that fails, a body that is not JSON. This module reproduces the
//! status case and the answer that lists nothing. Everything else is the reason to hand the run to Node, which then
//! asks again and prints whatever it finds: a failed request is no evidence, and a finding needs the rest of
//! the report (severity, resolution paths, exit gates) that this module does not have.

use std::time::{Duration, Instant};

use serde_json::Value;

use super::report::Package;
use crate::http::{node_fetch, HttpClient, HttpConfig, HttpError};
use crate::js::json_string;

pub(super) const URL: &str = "https://api.osv.dev/v1/querybatch";

/// `timeoutMs` of `fetchVulnerabilities`, which aborts the whole request, body included.
const TIMEOUT: Duration = Duration::from_secs(10);

/// `JSON.stringify({ queries })`.
pub(super) fn query_body(packages: &[Package<'_>]) -> String {
    let queries: Vec<String> = packages
        .iter()
        .map(|package| {
            format!(
                "{{\"package\":{{\"ecosystem\":\"npm\",\"name\":{}}},\"version\":{}}}",
                json_string(package.name),
                json_string(package.version)
            )
        })
        .collect();

    format!("{{\"queries\":[{}]}}", queries.join(","))
}

/// Whether a 2xx body is the answer of a scan that found nothing: an object whose `results` array holds only objects
/// without `vulns` (or with a null or empty one). Anything else is for Node to read: it may hold findings, and
/// a body `response.json()` reads differently (a byte-order mark) or rejects must end the way Node ends it.
pub(super) fn lists_nothing(text: &str) -> bool {
    let Ok(Value::Object(answer)) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    let Some(Value::Array(results)) = answer.get("results") else {
        return false;
    };

    results.iter().all(|result| match result {
        Value::Object(result) => match result.get("vulns") {
            None | Some(Value::Null) => true,
            Some(Value::Array(vulns)) => vulns.is_empty(),
            Some(_) => false,
        },
        _ => false,
    })
}

// The audit asks `scan` below; this is for a caller that has no use for a finding.
#[allow(dead_code)]
/// Asks OSV about `packages` and returns how long it took when the answer lists nothing, or the reason to hand the
/// run to Node.
pub(super) fn scan_is_clean(url: &str, packages: &[Package<'_>]) -> Result<Duration, String> {
    let client = HttpClient::new(node_fetch::fetch_config(HttpConfig::from_env(TIMEOUT, TIMEOUT), TIMEOUT));
    let started = Instant::now();
    let answer = client.post_json(url, &[], &query_body(packages));
    let took = started.elapsed();

    match answer {
        // `!response.ok` is an empty result in Node.
        Err(HttpError::Status { .. }) => Ok(took),
        Err(error) => Err(format!("the request to OSV did not end in an answer Node reads the same way: {error}")),
        Ok(response) => {
            let text = response.text().map_err(|error| format!("the answer is not UTF-8 text: {error}"))?;

            if lists_nothing(text) {
                Ok(took)
            } else {
                Err("the answer lists findings, or is not the JSON object Node reads the same way".to_owned())
            }
        }
    }
}

/// The keys of an OSV record that `mapOsvVuln` reads to give a finding a severity, a fix or a summary. The batch
/// endpoint documents `id` and `modified` only (https://google.github.io/osv.dev/post-v1-querybatch/), so an answer in
/// that shape has none of these; one that carries any of them is for Node to map.
const DETAIL_KEYS: [&str; 5] = ["severity", "database_specific", "affected", "aliases", "summary"];

/// How many findings an answer lists for the first `scanned` packages when it is the documented shape of the batch
/// endpoint (`{"results":[{"vulns":[{"id":"…","modified":"…"}]}]}`), or `None` for any other body.
///
/// A record with only an `id` maps to the severity `UNKNOWN`, which no `--severity` level lets through, so Node drops it
/// from the results, the exit gates and the summary and counts it only in the progress row. A record with a field
/// `mapOsvVuln` reads (see [`DETAIL_KEYS`]) may reach the report, and one of an unexpected type makes Node's `catch`
/// print an error row instead: both are Node's.
pub(super) fn documented_findings(text: &str, scanned: usize) -> Option<usize> {
    let Ok(Value::Object(answer)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let Some(Value::Array(results)) = answer.get("results") else {
        return None;
    };
    let mut count = 0;

    for (index, result) in results.iter().enumerate() {
        let Value::Object(result) = result else {
            return None;
        };
        let vulns = match result.get("vulns") {
            None | Some(Value::Null) => continue,
            Some(Value::Array(vulns)) => vulns,
            Some(_) => return None,
        };

        for vuln in vulns {
            let Value::Object(vuln) = vuln else {
                return None;
            };

            if !matches!(vuln.get("id"), Some(Value::String(_)))
                || DETAIL_KEYS.iter().any(|key| !matches!(vuln.get(*key), None | Some(Value::Null)))
            {
                return None;
            }
        }

        // Node reads the answer for the packages it asked about and ignores a longer list.
        if index < scanned {
            count += vulns.len();
        }
    }

    Some(count)
}

/// Asks OSV about `packages` and returns how many findings it lists and how long it took, or the reason to hand the run
/// to Node. A clean answer lists none; see [`documented_findings`] for the only shape that lists some.
pub(super) fn scan(url: &str, packages: &[Package<'_>]) -> Result<(usize, Duration), String> {
    let client = HttpClient::new(node_fetch::fetch_config(HttpConfig::from_env(TIMEOUT, TIMEOUT), TIMEOUT));
    let started = Instant::now();
    let answer = client.post_json(url, &[], &query_body(packages));
    let took = started.elapsed();

    match answer {
        // `!response.ok` is an empty result in Node.
        Err(HttpError::Status { .. }) => Ok((0, took)),
        Err(error) => Err(format!("the request to OSV did not end in an answer Node reads the same way: {error}")),
        Ok(response) => {
            let text = response.text().map_err(|error| format!("the answer is not UTF-8 text: {error}"))?;

            if lists_nothing(text) {
                return Ok((0, took));
            }

            documented_findings(text, packages.len()).map(|count| (count, took)).ok_or_else(|| {
                "the answer lists findings with fields Node maps, or is not the JSON object Node reads the same way"
                    .to_owned()
            })
        }
    }
}
