//! `.vis/last-summary.json`, as `generateRunSummary` builds it for a run of cache hits.

use std::time::{SystemTime, UNIX_EPOCH};

use vis_core::date::iso_from_millis;

use crate::js::random_uuid;
use crate::json::{stringify, Json};

use super::{Answer, Hit};

/// An ISO 8601 UTC time with milliseconds, `Date.prototype.toISOString`.
pub(super) fn iso(time: SystemTime) -> String {
    iso_from_millis(time.duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64))
}

fn text(value: &str) -> Json {
    Json::Str(value.to_owned())
}

fn number(value: u64) -> Json {
    Json::Int(value as i64)
}

fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(name, value)| (name.to_owned(), value)).collect())
}

/// The `[key, value]` pairs of a hash record, as the object they are in the summary.
fn record(pairs: &[Vec<String>]) -> Json {
    Json::Object(pairs.iter().map(|pair| (pair[0].clone(), text(&pair[1]))).collect())
}

impl Answer {
    /// The summary of the run, as the text Node writes. `None` when no run id can be made.
    pub(super) fn summary(&self) -> Option<String> {
        let count = self.hits.len() as u64;
        let id = format!("{}_{}", iso(self.started).replace([':', '.'], "-"), random_uuid()?);
        // `tasks` is listed by start time (the order of the lookups); `taskGraph` by project order.
        let graph_order = {
            let mut sorted: Vec<&Hit> = self.hits.iter().collect();

            sorted.sort_by_key(|hit| hit.graph_index);

            sorted.into_iter().map(|hit| hit.key.id.clone()).collect::<Vec<_>>()
        };

        let summary = object(vec![
            ("duration", number(self.milliseconds)),
            ("endTime", Json::Str(iso(self.ended))),
            (
                "environment",
                object(vec![
                    ("arch", text(self.arch)),
                    ("nodeVersion", Json::Str(self.node_version.clone())),
                    ("platform", text(self.platform)),
                ]),
            ),
            ("id", Json::Str(id)),
            ("startTime", Json::Str(iso(self.started))),
            (
                "stats",
                object(vec![
                    ("cached", number(count)),
                    ("failed", number(0)),
                    ("skipped", number(0)),
                    ("succeeded", number(0)),
                    ("total", number(count)),
                ]),
            ),
            (
                "taskGraph",
                object(vec![
                    (
                        "dependencies",
                        Json::Object(graph_order.iter().map(|id| (id.clone(), Json::Array(Vec::new()))).collect()),
                    ),
                    ("roots", Json::Array(graph_order.iter().map(|id| Json::Str(id.clone())).collect())),
                ]),
            ),
            ("tasks", Json::Array(self.hits.iter().map(|hit| self.task(hit)).collect())),
        ]);

        Some(stringify(&summary, "  "))
    }

    /// One entry of `tasks`.
    fn task(&self, hit: &Hit) -> Json {
        let details = &hit.key.details;
        let mut hash_details = vec![("command", text(&details.command))];

        if let Some(implicit) = &details.implicit_deps {
            hash_details.push(("implicitDeps", record(implicit)));
        }

        hash_details.push(("layout", number(2)));
        hash_details.push(("nodes", record(&details.nodes)));

        let (project, _) = hit.key.id.rsplit_once(':').unwrap_or((&hit.key.id, ""));

        object(vec![
            ("cacheable", Json::Bool(true)),
            ("cacheStatus", text("HIT")),
            ("dependencies", Json::Array(Vec::new())),
            ("duration", number(hit.milliseconds)),
            ("endTime", Json::Str(iso(hit.ended))),
            ("exitCode", number(0)),
            ("hash", text(&hit.key.hash)),
            ("hashDetails", object(hash_details)),
            ("outputs", Json::Array(Vec::new())),
            ("startTime", Json::Str(iso(hit.started))),
            ("target", object(vec![("project", text(project)), ("target", text(&self.target))])),
            ("taskId", Json::Str(hit.key.id.clone())),
        ])
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(UNIX_EPOCH + Duration::from_millis(1_795_473_196_232)), "2026-11-23T22:33:16.232Z");
        assert_eq!(iso(UNIX_EPOCH + Duration::from_millis(951_782_400_000)), "2000-02-29T00:00:00.000Z");
    }
}
