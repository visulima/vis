//! `vis cache why <task> [--format json|table] [--run <id>]` — the native fast path.
//!
//! Like `cache hash` (see [`crate::cache_hash`]) the command hashes nothing: it reads the recorded
//! run summary and diffs the hash inputs of the task against the previous recorded run, as
//! `packages/tooling/vis/src/commands/cache/why.ts` does. The previous run is the newest file under
//! `.vis/runs/` other than the loaded run's own, which `run_files` finds the way `fs.readdir` plus
//! `stat` order them.
//!
//! The native path answers only what it can reproduce exactly, and hands everything else to Node:
//!
//! - the argument shapes and the quiet context of `cache hash`, with the same summary-file rules;
//! - a task or previous task that deserializes without a doubt, and a previous run file that
//!   parses (Node does not look at the next newest file when it does not);
//! - hash buckets without a key named like an `Object.prototype` member, because the Node diff
//!   tests membership with `in`, and without integer-like keys;
//! - table output for printable ASCII only, as pail's wrapping counts UTF-16 units.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use crate::cache_hash::{parse, Request};
use crate::js::PROTOTYPE_NAMES;
use crate::output::Output;
use crate::pail::{Layout, Level};
use crate::run_summary::{summary_path, Details, Probe, ProbeId, Summary, Task};
use crate::summary::{
    context, find_task, json_text, load_summary, missing_summary, present, read_run_file, run_files, task_not_in_run,
    utf16_order, Ordered,
};
use crate::text::{is_ascii_graphic, is_ascii_printable};

/// The message of the "first run" block holds an em dash, which pail's wrap measures differently from the
/// byte-counting wrap here (it fits one line at a width where this one would wrap), so it is only printed
/// where both agree: the whole message fits within the wrap limit even counted in bytes.
const FIRST_TIME: &str = "No previous run to diff against — first time this task was recorded.";

/// One entry of `cacheMissReasons`: string fields in file order, with at least `type` and `detail`.
struct Reason(Ordered<String>);

impl<'de> Deserialize<'de> for Reason {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let fields = Ordered::<String>::deserialize(deserializer)?;

        if fields.0.iter().any(|(key, _)| !matches!(key.as_str(), "currentHash" | "detail" | "previousHash" | "type"))
            || fields.get("type").is_none()
            || fields.get("detail").is_none()
        {
            return Err(de::Error::custom("reason left to Node"));
        }

        Ok(Self(fields))
    }
}

impl Serialize for Reason {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl Reason {
    /// `describeCacheMissReason`; an unknown type takes the default text.
    fn describe(&self) -> String {
        let detail = self.0.get("detail").map_or("", String::as_str);

        match self.0.get("type").map_or("", String::as_str) {
            "args-changed" => "Command arguments changed".to_owned(),
            "chain-changed" => "Previous segment changed: its trace key moved, so this segment re-runs".to_owned(),
            "declared-changed" => "Declared inputs changed (the run was keyed on its declared hash)".to_owned(),
            "directory-changed" => format!("Directory contents changed: {detail}"),
            "env-changed" => format!("Environment variable changed: {detail}"),
            "file-changed" => format!("File modified: {detail}"),
            "file-created" => format!("File created (was missing): {detail}"),
            "file-deleted" => format!("File deleted: {detail}"),
            "tracker-changed" => format!("Tracker changed ({detail}): the stored trace saw different file accesses"),
            _ => "No previous fingerprint found (first run)".to_owned(),
        }
    }

    fn printable(&self) -> bool {
        self.0 .0.iter().all(|(_, value)| is_ascii_printable(value))
    }
}

/// The one task key `cache why` reads beyond what `cache hash` does.
#[derive(Deserialize)]
struct Extras {
    #[serde(default, rename = "cacheMissReasons", deserialize_with = "present")]
    reasons: Option<Vec<Reason>>,
}

#[derive(Serialize)]
struct BucketDiff {
    added: Vec<String>,
    changed: Vec<String>,
    removed: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diff {
    command_changed: bool,
    implicit_deps: BucketDiff,
    nodes: BucketDiff,
    runtime: BucketDiff,
}

impl BucketDiff {
    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.changed.is_empty() && self.removed.is_empty()
    }
}

/// `diffHashBuckets`: keys in current but not previous are added, in both with another value
/// changed, in previous but not current removed; each list is sorted by UTF-16 code units.
fn diff_buckets(current: &[(String, String)], previous: &[(String, String)]) -> BucketDiff {
    let before: HashMap<&str, &str> = previous.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    let after: HashMap<&str, &str> = current.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    let mut diff = BucketDiff { added: Vec::new(), changed: Vec::new(), removed: Vec::new() };

    for (key, value) in current {
        match before.get(key.as_str()) {
            None => diff.added.push(key.clone()),
            Some(other) if other != value => diff.changed.push(key.clone()),
            Some(_) => {}
        }
    }

    for (key, _) in previous {
        if !after.contains_key(key.as_str()) {
            diff.removed.push(key.clone());
        }
    }

    for list in [&mut diff.added, &mut diff.removed, &mut diff.changed] {
        list.sort_by(|a, b| utf16_order(a, b));
    }

    diff
}

/// `diffHashDetails`. Command hashes of different layouts are not comparable.
fn diff_details(current: Option<&Details>, previous: Option<&Details>) -> Diff {
    let layout = |details: Option<&Details>| details.and_then(|details| details.0.number("layout")).unwrap_or(1);
    let command = |details: Option<&Details>| details.map_or("", |details| details.0.text("command")).to_owned();
    let bucket = |details: Option<&Details>, name: &str| -> Vec<(String, String)> {
        details.map_or(&[][..], |details| details.0.bucket(name)).to_vec()
    };

    let buckets = |name: &str| diff_buckets(&bucket(current, name), &bucket(previous, name));

    Diff {
        command_changed: layout(current) == layout(previous) && command(current) != command(previous),
        implicit_deps: buckets("implicitDeps"),
        nodes: buckets("nodes"),
        runtime: buckets("runtime"),
    }
}

/// Whether a bucket of the details holds a key the Node diff would treat as already present.
fn has_prototype_key(details: Option<&Details>) -> bool {
    details.is_some_and(|details| {
        ["nodes", "runtime", "implicitDeps"]
            .iter()
            .any(|name| details.0.bucket(name).iter().any(|(key, _)| PROTOTYPE_NAMES.contains(&key.as_str())))
    })
}

/// The previous run and its entry for the task, as Node reads them. `None` hands the call to Node.
struct Previous {
    summary: Option<(Summary, Option<Task>)>,
}

fn previous_run(root: &Path, current_id: &str, task_id: &str) -> Option<Previous> {
    let files = run_files(root, Some(&format!("{current_id}.json")))?;

    let Some(newest) = files.first() else {
        return Some(Previous { summary: None });
    };

    // Node reads only the newest file, and a file it cannot parse is "no previous run".
    let summary = read_run_file(root, &newest.name)?;

    let task = match find_task(&summary.tasks, task_id)? {
        Some(raw) => Some(serde_json::from_str::<Task>(raw.get()).ok()?),
        None => None,
    };

    Some(Previous { summary: Some((summary, task)) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviousTaskJson<'a> {
    cache_status: &'a str,
    hash: Option<&'a str>,
    hash_details: Option<&'a Details>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskJson<'a> {
    cache_miss_reasons: Option<&'a Vec<Reason>>,
    cache_status: &'a str,
    hash: Option<&'a str>,
    hash_details: Option<&'a Details>,
    hash_source: Option<&'a str>,
    task_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WhyJson<'a> {
    diff: &'a Diff,
    previous_run_id: Option<&'a str>,
    previous_task: Option<PreviousTaskJson<'a>>,
    run_id: &'a str,
    task: TaskJson<'a>,
}

/// A task found in the summary, with the miss reasons its entry recorded.
struct Found<'a> {
    reasons: Option<&'a [Reason]>,
    summary: &'a Summary,
    task: &'a Task,
}

/// The table of a found task. `None` when Node has to answer.
fn table(
    request: &Request,
    root: &Path,
    found: &Found,
    previous: &Previous,
    diff: &Diff,
    layout: Layout,
) -> Option<Output> {
    let Found { reasons, summary, task } = *found;
    let mut out = Output::default();
    let previous_task = previous.summary.as_ref().and_then(|(_, task)| task.as_ref());

    render_header(&mut out.stdout, request, found, previous, layout)?;

    if task.details.is_none() {
        render_trace_reasons(&mut out.stdout, reasons, request, summary, layout)?;

        return Some(out);
    }

    if previous_task.is_none() {
        if !layout.fits_one_line(FIRST_TIME) {
            return None;
        }

        out.stdout.push_str(&layout.block(Level::Info, FIRST_TIME));

        return Some(out);
    }

    if !diff.command_changed && diff.nodes.is_empty() && diff.runtime.is_empty() && diff.implicit_deps.is_empty() {
        out.stdout.push_str(&layout.block(Level::Success, "No hash inputs changed since the previous run."));

        return Some(out);
    }

    render_diff(&mut out.stdout, diff, root, layout)?;

    Some(out)
}

/// The title and the `status`, `hash`, `key` and `prev` lines, then a blank line.
fn render_header(
    out: &mut String,
    request: &Request,
    found: &Found,
    previous: &Previous,
    layout: Layout,
) -> Option<()> {
    let Found { summary, task, .. } = *found;
    let previous_task = previous.summary.as_ref().and_then(|(_, task)| task.as_ref());

    if !(is_ascii_graphic(&request.task_id)
        && is_ascii_graphic(&summary.id)
        && is_ascii_printable(&task.cache_status)
        && task.hash.as_deref().is_none_or(is_ascii_printable))
    {
        return None;
    }

    out.push_str(&layout.block(Level::Info, &format!("Why {}? (run {})", request.task_id, summary.id)));
    out.push('\n');
    out.push_str(&format!("  status:  {}\n", task.cache_status));
    out.push_str(&format!("  hash:    {}\n", task.hash.as_deref().unwrap_or("(none)")));

    if task.hash_source.as_deref() == Some("declared-fallback") {
        out.push_str("  key:     declared-fallback (tracker observed no workspace access; keyed on declared inputs)\n");
    }

    match previous_task {
        Some(previous_task) => {
            let run = previous.summary.as_ref().map_or("?", |(summary, _)| summary.id.as_str());

            if !(is_ascii_printable(run) && previous_task.hash.as_deref().is_none_or(is_ascii_printable)) {
                return None;
            }

            out.push_str(&format!("  prev:    {}  [run {run}]\n", previous_task.hash.as_deref().unwrap_or("(none)")));
        }
        None => out.push_str("  prev:    (no prior run found)\n"),
    }

    out.push('\n');

    Some(())
}

/// Trace-mode tasks keep no declared hash inputs: their explanation is the recorded miss reason.
fn render_trace_reasons(
    out: &mut String,
    reasons: Option<&[Reason]>,
    request: &Request,
    summary: &Summary,
    layout: Layout,
) -> Option<()> {
    match reasons.filter(|reasons| !reasons.is_empty()) {
        Some(reasons) => {
            if !reasons.iter().all(Reason::printable) {
                return None;
            }

            out.push_str("Cache miss reasons (trace-mode fingerprint):\n");

            for reason in reasons {
                out.push_str(&format!("  - {}\n", reason.describe()));
            }
        }
        None => out.push_str(&layout.block(
            Level::Info,
            "No hash inputs recorded for this run (trace-mode tasks record a miss reason only when the cache misses).",
        )),
    }

    out.push('\n');
    out.push_str(&layout.block(
        Level::Info,
        &format!("Tracked files and env of this run: vis cache hash {} --run {}", request.task_id, summary.id),
    ));

    Some(())
}

/// The inputs that changed since the previous run, then the path of the last summary file.
fn render_diff(out: &mut String, diff: &Diff, root: &Path, layout: Layout) -> Option<()> {
    out.push_str("Hash inputs that changed since the previous run:\n\n");

    if diff.command_changed {
        out.push_str("  command:  changed\n");
    }

    for (name, bucket) in [("nodes", &diff.nodes), ("runtime", &diff.runtime), ("implicitDeps", &diff.implicit_deps)] {
        if bucket.is_empty() {
            continue;
        }

        out.push_str(&format!("  {name}:\n"));

        for (sign, keys) in [("+", &bucket.added), ("~", &bucket.changed), ("-", &bucket.removed)] {
            for key in keys {
                if !is_ascii_printable(key) {
                    return None;
                }

                out.push_str(&format!("    {sign} {key}\n"));
            }
        }
    }

    out.push('\n');

    let last = summary_path(root, None);
    let last = last.to_str()?;

    if !is_ascii_graphic(last) {
        return None;
    }

    out.push_str(&layout.block(Level::Info, &format!("Last summary file: {last}")));

    Some(())
}

/// The output for the request, or `None` to delegate.
fn answer(request: &Request, summary: Option<Summary>, root: &Path, layout: Layout) -> Option<Output> {
    let Some(summary) = summary else {
        return missing_summary(root, request.run.as_deref(), Some(&request.task_id), request.json, layout);
    };

    let Some(raw) = find_task(&summary.tasks, &request.task_id)? else {
        let mut out = task_not_in_run(&request.task_id, &summary.id, request.json, layout)?;

        if request.json {
            return Some(out);
        }

        // `Tasks in this run: a, b` names every task, so each id has to be a plain string.
        let mut ids = Vec::new();

        for task in &summary.tasks {
            let probe: Probe = serde_json::from_str(task.get()).ok()?;

            match probe.task_id {
                Some(ProbeId::Text(id)) if is_ascii_graphic(&id) => ids.push(id),
                _ => return None,
            }
        }

        // `join(", ") || "(none)"`: an empty joined string falls back as well.
        let joined = ids.join(", ");
        let listed = if joined.is_empty() { "(none)" } else { joined.as_str() };

        out.say(layout, Level::Info, &format!("Tasks in this run: {listed}"));

        return Some(out);
    };

    let task: Task = serde_json::from_str(raw.get()).ok()?;
    let extras: Extras = serde_json::from_str(raw.get()).ok()?;
    let previous = previous_run(root, &summary.id, &request.task_id)?;
    let previous_task = previous.summary.as_ref().and_then(|(_, task)| task.as_ref());

    if has_prototype_key(task.details.as_ref())
        || has_prototype_key(previous_task.and_then(|task| task.details.as_ref()))
    {
        return None;
    }

    let diff = diff_details(task.details.as_ref(), previous_task.and_then(|task| task.details.as_ref()));

    if request.json {
        let stdout = json_text(&WhyJson {
            diff: &diff,
            previous_run_id: previous.summary.as_ref().map(|(summary, _)| summary.id.as_str()),
            previous_task: previous_task.map(|task| PreviousTaskJson {
                cache_status: &task.cache_status,
                hash: task.hash.as_deref(),
                hash_details: task.details.as_ref(),
            }),
            run_id: &summary.id,
            task: TaskJson {
                cache_miss_reasons: extras.reasons.as_ref(),
                cache_status: &task.cache_status,
                hash: task.hash.as_deref(),
                hash_details: task.details.as_ref(),
                hash_source: task.hash_source.as_deref(),
                task_id: &task.task_id,
            },
        })?;

        return Some(Output { stdout, ..Output::default() });
    }

    let mut printed = table(
        request,
        root,
        &Found { reasons: extras.reasons.as_deref(), summary: &summary, task: &task },
        &previous,
        &diff,
        layout,
    )?;

    printed.exit_code = 0;

    Some(printed)
}

/// Runs the native path, or `None` to delegate. Reads the context first and prints nothing.
fn native(args: &[String]) -> Option<Output> {
    let request = parse(args)?;
    let (root, layout) = context(args, request.json)?;
    let summary = load_summary::<Summary>(&summary_path(&root, request.run.as_deref()))?;

    answer(&request, summary, &root, layout)
}

/// Answers `vis cache why` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(out) = native(args) else {
        crate::process::delegate(raw_args);
    };

    out.emit("cache why")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
    }

    #[test]
    fn buckets_diff_into_sorted_added_changed_and_removed() {
        let diff = diff_buckets(
            &pairs(&[("b", "1"), ("a", "2"), ("same", "x"), ("c", "new")]),
            &pairs(&[("gone", "1"), ("same", "x"), ("c", "old"), ("Z", "1")]),
        );

        assert_eq!(diff.added, ["a", "b"]);
        assert_eq!(diff.changed, ["c"]);
        assert_eq!(diff.removed, ["Z", "gone"]);
    }

    #[test]
    fn command_hashes_of_different_layouts_do_not_compare() {
        let details = |text: &str| -> Details { serde_json::from_str(text).unwrap() };
        let old = details(r#"{"command":"a"}"#);
        let new = details(r#"{"command":"b","layout":2}"#);
        let other = details(r#"{"command":"b"}"#);

        assert!(!diff_details(Some(&new), Some(&old)).command_changed);
        assert!(diff_details(Some(&other), Some(&old)).command_changed);
        // No details count as layout 1 and an empty command.
        assert!(diff_details(None, Some(&old)).command_changed);
        assert!(!diff_details(None, None).command_changed);
    }

    #[test]
    fn a_reason_needs_a_type_and_a_detail_and_nothing_else() {
        assert!(
            serde_json::from_str::<Reason>(r#"{"type":"file-changed","detail":"a.txt","previousHash":"1"}"#).is_ok()
        );
        assert!(serde_json::from_str::<Reason>(r#"{"type":"file-changed"}"#).is_err());
        assert!(serde_json::from_str::<Reason>(r#"{"type":"file-changed","detail":"a","extra":"x"}"#).is_err());
        assert!(serde_json::from_str::<Reason>(r#"{"type":"file-changed","detail":1}"#).is_err());
    }

    #[test]
    fn an_unknown_reason_type_takes_the_first_run_text() {
        let reason: Reason = serde_json::from_str(r#"{"type":"no-fingerprint","detail":""}"#).unwrap();

        assert_eq!(reason.describe(), "No previous fingerprint found (first run)");

        let reason: Reason = serde_json::from_str(r#"{"type":"tracker-changed","detail":"a -> b"}"#).unwrap();

        assert_eq!(reason.describe(), "Tracker changed (a -> b): the stored trace saw different file accesses");
    }

    #[test]
    fn prototype_member_keys_are_left_to_node() {
        let details: Details = serde_json::from_str(r#"{"command":"c","nodes":{"toString":"1"}}"#).unwrap();

        assert!(has_prototype_key(Some(&details)));
        assert!(!has_prototype_key(None));
    }
}
