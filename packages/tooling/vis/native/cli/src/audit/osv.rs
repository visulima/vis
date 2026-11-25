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
