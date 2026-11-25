//! `vis replay [--format json|table] [--run <id>] [--task <id>] [--failed] [--list]` — the native fast path.
//!
//! The command re-executes nothing: it reads a run summary the task runner recorded
//! (`<root>/.vis/last-summary.json`, or `<root>/.vis/runs/<id>.json` for `--run`) and prints the
//! run, a task of it, or (`--list`) the recorded runs, like
//! `packages/tooling/vis/src/commands/replay/handler.ts`. It follows `cache hash` (see
//! [`crate::cache_hash`]): the native path answers only what it can reproduce exactly, and hands
//! everything else to Node:
//!
//! - the flags above, each at most once, and no positional argument; the quiet context of `cache hash`;
//! - a summary that deserializes into the exact shape below (the fields printed are strings and
//!   integers a JavaScript number holds exactly, `null` is never read as a missing value);
//! - table output for printable ASCII only, because the column widths count UTF-16 units;
//! - `--list` for names and times it can print as Node does (see [`crate::summary::run_files`]).

use std::ffi::OsString;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cache::format::iso;
use crate::cache_hash::{json_text, summary_path, Output, Probe, ProbeId};
use crate::pail::{Layout, Level};
use crate::summary::{context, emit, format_duration, is_object, load_summary, present, run_files, JsInt, Ordered};
use crate::text::{is_ascii_graphic, is_ascii_printable};

/// What the user asked for.
#[derive(Debug, Default, PartialEq)]
struct Request {
    failed: bool,
    json: bool,
    list: bool,
    run: Option<String>,
    task: Option<String>,
}

/// Parses the arguments of `replay` (`args[0]` is `replay`), or `None` for a shape that is Node's:
/// at most one each of `--format <json|table>`, `--run <id>`, `--task <id>`, `--failed` and
/// `--list`, in either spelling for the valued ones, and nothing else.
fn parse(args: &[String]) -> Option<Request> {
    let mut request = Request::default();
    let mut format: Option<&str> = None;
    let mut tokens = args.iter().skip(1).map(String::as_str);

    while let Some(token) = tokens.next() {
        if let Some(slot) = match token {
            "--failed" => Some(&mut request.failed),
            "--list" => Some(&mut request.list),
            _ => None,
        } {
            if std::mem::replace(slot, true) {
                return None;
            }

            continue;
        }

        let (name, value) = match token.split_once('=') {
            Some((name, value)) if token.starts_with("--") => (name, value),
            _ => (token, tokens.next()?),
        };

        // A value that looks like a flag, or is empty, is cerebro's to interpret.
        if value.is_empty() || value.starts_with('-') {
            return None;
        }

        let slot = match name {
            "--format" => &mut format,
            "--run" => {
                if request.run.replace(value.to_owned()).is_some() {
                    return None;
                }

                continue;
            }
            "--task" => {
                if request.task.replace(value.to_owned()).is_some() {
                    return None;
                }

                continue;
            }
            _ => return None,
        };

        if slot.replace(value).is_some() {
            return None;
        }
    }

    request.json = match format {
        None | Some("table") => false,
        Some("json") => true,
        Some(_) => return None,
    };

    // A run id names a file under `.vis/runs/`; anything that could leave the directory is Node's.
    if request
        .run
        .as_deref()
        .is_some_and(|id| !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')))
    {
        return None;
    }

    Some(request)
}

/// The tasks stay raw: only the ones the filters select are read strictly.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    #[serde(default, deserialize_with = "present")]
    duration: Option<JsInt>,
    end_time: String,
    environment: Ordered<String>,
    id: String,
    start_time: String,
    stats: Ordered<JsInt>,
    tasks: Vec<Box<serde_json::value::RawValue>>,
}

/// The fields of a `TaskSummary` that `replay` prints, declared in the order the JSON output has
/// them. A key of the wrong type, or a duplicate, is Node's.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    cache_status: String,
    dependencies: Vec<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    duration: Option<JsInt>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    end_time: Option<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    exit_code: Option<JsInt>,
    #[serde(default, deserialize_with = "present")]
    hash: Option<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    start_time: Option<String>,
    task_id: String,
}

impl Task {
    fn failed(&self) -> bool {
        self.exit_code.is_some_and(|code| code.0 != 0)
    }

    /// `formatStatus`.
    fn status(&self) -> String {
        match self.exit_code {
            None => self.cache_status.clone(),
            Some(JsInt(0)) if self.cache_status == "MISS" => "OK".to_owned(),
            Some(JsInt(0)) => self.cache_status.clone(),
            Some(JsInt(code)) => format!("FAIL({code})"),
        }
    }

    /// The strings the table prints for this task.
    fn printable(&self) -> bool {
        is_ascii_printable(&self.cache_status)
            && is_ascii_printable(&self.task_id)
            && self.hash.as_deref().is_none_or(is_ascii_printable)
            && self.start_time.as_deref().is_none_or(is_ascii_printable)
            && self.end_time.as_deref().is_none_or(is_ascii_printable)
            && self.dependencies.iter().all(|dependency| is_ascii_printable(dependency))
    }
}

impl RunSummary {
    fn complete(&self) -> bool {
        ["total", "succeeded", "cached", "skipped", "failed"].iter().all(|name| self.stat(name).is_some())
            && ["arch", "nodeVersion", "platform"].iter().all(|name| self.env(name).is_some())
    }

    fn stat(&self, name: &str) -> Option<i64> {
        self.stats.get(name).map(|value| value.0)
    }

    fn env(&self, name: &str) -> Option<&str> {
        self.environment.get(name).map(String::as_str)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunJson<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<JsInt>,
    end_time: &'a str,
    environment: &'a Ordered<String>,
    run_id: &'a str,
    start_time: &'a str,
    stats: &'a Ordered<JsInt>,
    tasks: &'a [Task],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FailureJson<'a> {
    error: &'a str,
    run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<&'a str>,
}

fn pad(value: &str, width: usize) -> String {
    format!("{value:<width$}")
}

/// `renderRunHeader`. `None` when a printed value is not printable ASCII or the summary lacks one.
fn render_header(out: &mut String, summary: &RunSummary) -> Option<()> {
    let (arch, node, platform) = (summary.env("arch")?, summary.env("nodeVersion")?, summary.env("platform")?);

    if ![summary.id.as_str(), &summary.start_time, &summary.end_time, arch, node, platform]
        .into_iter()
        .all(is_ascii_printable)
    {
        return None;
    }

    out.push_str(&format!("Run {}\n", summary.id));
    out.push_str(&format!("  start:    {}\n", summary.start_time));
    out.push_str(&format!("  end:      {}\n", summary.end_time));
    out.push_str(&format!("  duration: {}\n", format_duration(summary.duration)));
    out.push_str(&format!(
        "  totals:   {} total · {} ok · {} cached · {} skipped · {} failed\n",
        summary.stat("total")?,
        summary.stat("succeeded")?,
        summary.stat("cached")?,
        summary.stat("skipped")?,
        summary.stat("failed")?
    ));
    out.push_str(&format!("  env:      node {node} · {platform}/{arch}\n\n"));

    Some(())
}

/// `renderTaskTable`.
fn render_table(out: &mut String, tasks: &[Task]) {
    if tasks.is_empty() {
        out.push_str("(no tasks match the current filter)\n");

        return;
    }

    let rows: Vec<[String; 4]> = tasks
        .iter()
        .map(|task| {
            [
                task.task_id.clone(),
                task.status(),
                format_duration(task.duration),
                task.hash
                    .as_deref()
                    .filter(|hash| !hash.is_empty())
                    .map_or_else(|| "-".to_owned(), |hash| hash.chars().take(12).collect()),
            ]
        })
        .collect();

    let heads = ["task", "status", "duration", "hash"];
    let widths: Vec<usize> = (0..4)
        .map(|column| rows.iter().map(|row| row[column].len()).chain([heads[column].len()]).max().unwrap_or(0))
        .collect();
    let line = |cells: [&str; 4]| {
        format!(
            "  {}  {}  {}  {}\n",
            pad(cells[0], widths[0]),
            pad(cells[1], widths[1]),
            pad(cells[2], widths[2]),
            pad(cells[3], widths[3])
        )
    };
    let dashes: Vec<String> = widths.iter().map(|width| "-".repeat(*width)).collect();

    out.push_str(&line([heads[0], heads[1], heads[2], heads[3]]));
    out.push_str(&line([&dashes[0], &dashes[1], &dashes[2], &dashes[3]]));

    for row in &rows {
        out.push_str(&line([&row[0], &row[1], &row[2], &row[3]]));
    }
}

/// `renderTaskDetail`, with the pail block that closes it.
fn render_detail(out: &mut String, summary: &RunSummary, task: &Task, layout: Layout) -> Option<()> {
    render_header(out, summary)?;

    out.push_str(&format!("Task {}\n", task.task_id));
    out.push_str(&format!("  status:    {}\n", task.status()));
    out.push_str(&format!("  cache:     {}\n", task.cache_status));
    out.push_str(&format!("  duration:  {}\n", format_duration(task.duration)));
    out.push_str(&format!(
        "  exit:      {}\n",
        task.exit_code.map_or_else(|| "-".to_owned(), |code| code.0.to_string())
    ));
    out.push_str(&format!("  hash:      {}\n", task.hash.as_deref().unwrap_or("(none)")));
    out.push_str(&format!("  start:     {}\n", task.start_time.as_deref().unwrap_or("-")));
    out.push_str(&format!("  end:       {}\n", task.end_time.as_deref().unwrap_or("-")));

    if !task.dependencies.is_empty() {
        out.push_str(&format!("  deps:      {}\n", task.dependencies.join(", ")));
    }

    out.push('\n');

    if !(is_ascii_graphic(&task.task_id) && is_ascii_graphic(&summary.id)) {
        return None;
    }

    out.push_str(&layout.block(
        Level::Info,
        &format!("Drill into hash inputs with: vis cache why {} --run {}", task.task_id, summary.id),
    ));

    Some(())
}

/// Whether the task entry names `task_id`: `t.taskId === taskFilter`.
fn names(raw: &serde_json::value::RawValue, task_id: &str) -> Option<bool> {
    let probe: Probe = serde_json::from_str(raw.get()).ok()?;

    Some(matches!(probe.task_id, Some(ProbeId::Text(ref text)) if text == task_id))
}

/// The tasks the filters keep (`filterTasks`), read strictly. `None` when an entry Node would read
/// differently is one of them.
fn filter_tasks(summary: &RunSummary, request: &Request) -> Option<Vec<Task>> {
    let mut tasks = Vec::new();

    for raw in &summary.tasks {
        if !is_object(raw) {
            return None;
        }

        if let Some(filter) = &request.task {
            if !names(raw, filter)? {
                continue;
            }
        }

        let task: Task = serde_json::from_str(raw.get()).ok()?;

        if request.failed && !task.failed() {
            continue;
        }

        tasks.push(task);
    }

    Some(tasks)
}

/// The output for a run, or `None` to delegate.
fn answer(request: &Request, summary: Option<RunSummary>, root: &Path, layout: Layout) -> Option<Output> {
    let mut out = Output { exit_code: 1, ..Output::default() };

    let Some(summary) = summary else {
        if request.json {
            out.stdout =
                json_text(&FailureJson { error: "no-summary", run_id: request.run.as_deref(), task_id: None })?;

            return Some(out);
        }

        let data = root.join(".vis");

        let message = match &request.run {
            None => format!(
                "No previous run summary found. Run a task first to populate `{}`.",
                data.join("last-summary.json").to_str()?
            ),
            Some(id) => format!("Run summary \"{id}\" not found in {}/.", data.join("runs").to_str()?),
        };

        if !is_ascii_graphic(data.to_str()?) {
            return None;
        }

        out.stderr = layout.block(Level::Error, &message);

        return Some(out);
    };

    let tasks = filter_tasks(&summary, request)?;

    if let Some(filter) = &request.task {
        if tasks.is_empty() {
            if request.json {
                out.stdout = json_text(&FailureJson {
                    error: "task-not-in-summary",
                    run_id: Some(&summary.id),
                    task_id: Some(filter),
                })?;
            } else if is_ascii_graphic(filter) && is_ascii_graphic(&summary.id) {
                out.stderr =
                    layout.block(Level::Error, &format!("Task \"{filter}\" was not part of run {}.", summary.id));
            } else {
                return None;
            }

            return Some(out);
        }
    }

    // The totals and the environment are read by name; Node prints `undefined` or throws for a missing one.
    if !summary.complete() {
        return None;
    }

    // The run's outcome is the exit code, so `replay --failed` can serve as a status check.
    out.exit_code = i32::from(summary.stat("failed")? > 0);

    if request.json {
        out.stdout = json_text(&RunJson {
            duration: summary.duration,
            end_time: &summary.end_time,
            environment: &summary.environment,
            run_id: &summary.id,
            start_time: &summary.start_time,
            stats: &summary.stats,
            tasks: &tasks,
        })?;

        return Some(out);
    }

    if !tasks.iter().all(Task::printable) {
        return None;
    }

    if request.task.is_some() {
        render_detail(&mut out.stdout, &summary, tasks.first()?, layout)?;
    } else {
        render_header(&mut out.stdout, &summary)?;
        render_table(&mut out.stdout, &tasks);
    }

    Some(out)
}

#[derive(Serialize)]
struct ListEntry<'a> {
    id: &'a str,
    mtime: String,
    path: &'a str,
}

/// `--list`: the recorded runs, newest first.
fn list(request: &Request, root: &Path, layout: Layout) -> Option<Output> {
    let files = run_files(root, None)?;
    let directory = root.join(".vis").join("runs");
    let mut out = Output::default();

    if request.json {
        let paths: Vec<String> =
            files.iter().map(|file| directory.join(&file.name).to_str().map(str::to_owned)).collect::<Option<_>>()?;
        let mut entries = Vec::new();

        for (file, path) in files.iter().zip(&paths) {
            entries.push(ListEntry { id: file.name.strip_suffix(".json")?, mtime: iso(file.mtime_ms)?, path });
        }

        out.stdout = json_text(&entries)?;

        return Some(out);
    }

    if files.is_empty() {
        let shown = directory.to_str()?;

        if !is_ascii_graphic(shown) {
            return None;
        }

        out.stdout = layout
            .block(Level::Info, &format!("No recorded runs found in {shown}/. Run with --summarize to record a run."));

        return Some(out);
    }

    let ids: Vec<&str> = files.iter().map(|file| file.name.strip_suffix(".json")).collect::<Option<_>>()?;

    if !ids.iter().all(|id| is_ascii_printable(id)) {
        return None;
    }

    let width = ids.iter().map(|id| id.len()).chain([2]).max()?;

    out.stdout.push_str(&format!("  {}  {}\n", pad("id", width), pad("mtime", 24)));
    out.stdout.push_str(&format!("  {}  {}\n", "-".repeat(width), "-".repeat(24)));

    for (id, file) in ids.iter().zip(&files) {
        out.stdout.push_str(&format!("  {}  {}\n", pad(id, width), iso(file.mtime_ms)?));
    }

    Some(out)
}

/// Runs the native path, or `None` to delegate. Reads the context first and prints nothing.
fn native(args: &[String]) -> Option<Output> {
    let request = parse(args)?;
    let (root, layout) = context(args, request.json)?;

    if request.list {
        return list(&request, &root, layout);
    }

    let summary = load_summary::<RunSummary>(&summary_path(&root, request.run.as_deref()))?;

    answer(&request, summary, &root, layout)
}

/// Answers `vis replay` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(out) = native(args) else {
        crate::process::delegate(raw_args);
    };

    emit("replay", &out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn parses_the_shapes_it_answers() {
        assert_eq!(parse(&argv(&["replay"])), Some(Request::default()));
        assert_eq!(parse(&argv(&["replay", "--format", "json"])), Some(Request { json: true, ..Request::default() }));
        assert_eq!(
            parse(&argv(&["replay", "--task=app:build", "--failed", "--run", "r-1.2_x", "--format=table"])),
            Some(Request {
                failed: true,
                run: Some("r-1.2_x".to_owned()),
                task: Some("app:build".to_owned()),
                ..Request::default()
            })
        );
        assert_eq!(parse(&argv(&["replay", "--list"])), Some(Request { list: true, ..Request::default() }));
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["replay", "app:build"][..],
            &["replay", "--format"],
            &["replay", "--format", "yaml"],
            &["replay", "--format=JSON"],
            &["replay", "--format", "json", "--format", "json"],
            &["replay", "--failed", "--failed"],
            &["replay", "--failed=true"],
            &["replay", "--no-failed"],
            &["replay", "--list", "--list"],
            &["replay", "--task"],
            &["replay", "--task", ""],
            &["replay", "--task="],
            &["replay", "--task", "-x"],
            &["replay", "--task", "a", "--task", "b"],
            &["replay", "--run", "../x"],
            &["replay", "--run", "a/b"],
            &["replay", "--run="],
            &["replay", "--json"],
            &["replay", "--verbose"],
            &["replay", "-x"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    fn task(text: &str) -> Task {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn statuses_follow_the_exit_code() {
        let base = |exit: &str, cache: &str| {
            task(&format!(r#"{{"taskId":"a","cacheStatus":"{cache}","dependencies":[]{exit}}}"#))
        };

        assert_eq!(base("", "MISS").status(), "MISS");
        assert_eq!(base(r#","exitCode":0"#, "MISS").status(), "OK");
        assert_eq!(base(r#","exitCode":0"#, "HIT").status(), "HIT");
        assert_eq!(base(r#","exitCode":2"#, "MISS").status(), "FAIL(2)");
    }

    #[test]
    fn a_task_with_a_null_or_mistyped_field_is_left_to_node() {
        for text in [
            r#"{"taskId":"a","cacheStatus":"HIT","dependencies":[],"exitCode":null}"#,
            r#"{"taskId":"a","cacheStatus":"HIT","dependencies":[],"duration":1.5}"#,
            r#"{"taskId":"a","cacheStatus":"HIT","dependencies":[],"hash":null}"#,
            r#"{"taskId":"a","cacheStatus":"HIT"}"#,
            r#"{"taskId":"a","cacheStatus":"HIT","dependencies":[],"taskId":"b"}"#,
        ] {
            assert!(serde_json::from_str::<Task>(text).is_err(), "{text}");
        }
    }

    #[test]
    fn json_omits_what_is_absent_and_keeps_a_missing_hash_as_null() {
        let text = serde_json::to_string(&task(
            r#"{"taskId":"a","cacheStatus":"HIT","dependencies":["b"],"startTime":"t","extra":[1]}"#,
        ))
        .unwrap();

        assert_eq!(text, r#"{"cacheStatus":"HIT","dependencies":["b"],"hash":null,"startTime":"t","taskId":"a"}"#);
    }
}
