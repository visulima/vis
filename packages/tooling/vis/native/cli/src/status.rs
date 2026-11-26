//! Native `vis status`: the workspace health overview, as text or `--json`, for a JS-only workspace.
//!
//! Mirrors `packages/tooling/vis/src/commands/status/handler.ts`. Its five numbers come from:
//!
//! - projects and unique targets: [`crate::graph`] and the script targets [`crate::list`] reads, so the same
//!   workspaces (no config, no inference detector, every project with scripts) are answered;
//! - runtime issues: [`crate::runtime_check`], which compares the root manifest and `.nvmrc` with the Node the run
//!   would be handed to. That is the launcher's own Node (`VIS_NODE_VERSION`) when it started the binary, and
//!   otherwise the answer of `node --version` for `VIS_NODE` or the `node` on `PATH`, asked once and only when a Node
//!   pin exists. No `node`, or an answer that is not a clean `vX.Y.Z`, is Node's;
//! - constraints: configured in `vis.config`, which the context gate already excludes, so there are none;
//! - flaky tasks and the cache hit rate: the run summaries under `.vis/runs` (`loadRunSummaries`,
//!   `analyzeFlakiness`). A summary file that is not strict JSON, or a field whose JavaScript behaviour depends on its
//!   type (`retryAttempts`, `stats.total`), is left to Node, because Node would skip, coerce or throw there.
//!
//! The text view is coloured by `@visulima/colorize`; the colour comes from the same detection as pail's
//! ([`crate::term::piped_colour_level`]), and a run that cannot tell is Node's.

use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::graph::project_graph_with_manifests;
use crate::json::{stringify, Json};
use crate::list::unique_target_count;
use crate::node_context::{monorepo_root, output_settings_are_default, quiet_context};
use crate::output::write_stdout;
use crate::runtime_check::count_findings;
use crate::term::{piped_colour_level, Style};
use crate::toolchain::{resolve_command, Versions};
use crate::vis_config;

/// Summaries the cache hit rate looks at, newest by file name.
const RATE_WINDOW: usize = 20;

#[derive(Debug, PartialEq)]
struct Overview {
    cache_hit_rate: Option<String>,
    flaky_tasks: usize,
    projects: usize,
    runtime_issues: usize,
    targets: usize,
}

/// `Some(json)` for `status [--json]`. `args[0]` is `status`; every other shape is `None`.
fn parse(args: &[String]) -> Option<bool> {
    match &args[1..] {
        [] => Some(false),
        [flag] if flag == "--json" => Some(true),
        _ => None,
    }
}

/// `X.Y.Z` of a `vX.Y.Z` version, which is `process.versions.node` for the Node that printed it. A pre-release
/// or any other text is `None`.
fn clean_node_version(text: &str) -> Option<String> {
    let version = text.strip_prefix('v')?;
    let mut parts = version.split('.');
    let numbers = [parts.next()?, parts.next()?, parts.next()?];

    (parts.next().is_none()
        && numbers.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
    .then(|| version.to_owned())
}

/// The version of the Node the run would be handed to: the launcher's, or what `node --version` prints.
fn node_version() -> Option<String> {
    if let Some(version) = env::var_os("VIS_NODE_VERSION") {
        return clean_node_version(version.to_str()?);
    }

    let command = resolve_command(&crate::process::node_program().to_string_lossy())?;
    let output = Versions::default().output(&command)?;

    clean_node_version(output.strip_suffix('\n')?)
}

/// The `.json` files of `.vis/runs`, parsed, with their names; `Some(empty)` when the directory does not exist.
/// `None` when Node might see something else: a name that is not UTF-8, an entry that cannot be read, or a file
/// that is not strict JSON (Node skips some of these, but its parser also reads more than serde does).
fn read_summaries(root: &Path) -> Option<HashMap<String, Value>> {
    let directory = root.join(".vis").join("runs");
    let mut summaries = HashMap::new();

    match fs::metadata(&directory) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Some(summaries),
        Ok(metadata) if metadata.is_dir() => {}
        _ => return None,
    }

    for entry in fs::read_dir(&directory).ok()? {
        let name = entry.ok()?.file_name().into_string().ok()?;

        if !name.ends_with(".json") {
            continue;
        }

        // The window takes the last names in `Array.prototype.sort` order, which is byte order for ASCII.
        if !name.is_ascii() {
            return None;
        }

        let value = serde_json::from_str(&fs::read_to_string(directory.join(&name)).ok()?).ok()?;

        summaries.insert(name, value);
    }

    Some(summaries)
}

/// `loadRunSummaries`: the parsed summaries of `.vis/runs`, or the one `.vis/last-summary.json` when there are none.
fn run_history(root: &Path, summaries: &HashMap<String, Value>) -> Option<Vec<Value>> {
    if !summaries.is_empty() {
        return Some(summaries.values().cloned().collect());
    }

    let path: PathBuf = root.join(".vis").join("last-summary.json");

    match fs::read_to_string(&path) {
        Ok(text) => Some(vec![serde_json::from_str(&text).ok()?]),
        Err(error) if error.kind() == ErrorKind::NotFound => Some(Vec::new()),
        Err(_) => None,
    }
}

/// How many tasks `analyzeFlakiness(root, { minRuns: 2 })` reports: tasks that ran at least twice and failed or
/// needed a retry at least once. Cached and skipped runs do not count. `None` for a summary shape whose JavaScript
/// behaviour this does not reproduce.
fn flaky_count(history: &[Value]) -> Option<usize> {
    #[derive(Default)]
    struct Stats {
        failures: u32,
        retried: u32,
        runs: u32,
    }

    let mut stats: HashMap<&str, Stats> = HashMap::new();

    for summary in history {
        // `summary.tasks` throws on a `null`; any other value that is not an object has no tasks.
        let summary = match summary {
            Value::Object(summary) => summary,
            Value::Null => return None,
            _ => continue,
        };

        let Some(Value::Array(tasks)) = summary.get("tasks") else {
            continue;
        };

        for task in tasks {
            let Value::Object(task) = task else {
                return None;
            };

            if matches!(task.get("cacheStatus").and_then(Value::as_str), Some("HIT" | "REMOTE_HIT" | "SKIPPED")) {
                continue;
            }

            // `task.target.project` throws when a task has no target, and the key of the map is the id.
            let (Some(Value::String(id)), Some(Value::Object(_))) = (task.get("taskId"), task.get("target")) else {
                return None;
            };

            let entry = stats.entry(id).or_default();

            entry.runs += 1;

            // `exitCode !== undefined && exitCode !== 0`: a present key that is not the number zero, `null` included.
            let failed = task.get("exitCode").is_some_and(|code| code.as_f64() != Some(0.0));
            // `retryAttempts && retryAttempts > 0`: only a number or `null` is a plain case.
            let retried = match task.get("retryAttempts") {
                None | Some(Value::Null) => false,
                Some(Value::Number(count)) => count.as_f64().is_some_and(|count| count > 0.0),
                Some(_) => return None,
            };

            if failed {
                entry.failures += 1;
            } else if retried {
                entry.retried += 1;
            }
        }
    }

    Some(stats.values().filter(|entry| entry.runs >= 2 && (entry.failures > 0 || entry.retried > 0)).count())
}

/// `Number.prototype.toFixed(0)` of a non-negative double below 1e21: the integer nearest the exact value, the larger
/// one on a tie.
fn to_fixed_0(value: f64) -> Option<String> {
    if !(0.0..1e21).contains(&value) {
        return None;
    }

    let floor = value.floor();
    let rounded = if value - floor >= 0.5 { floor + 1.0 } else { floor };

    Some(format!("{rounded}"))
}

/// The percentage of cached tasks in the last [`RATE_WINDOW`] summaries by file name, `None` inside `Some` when no
/// task was counted. `None` for a `stats` block whose JavaScript behaviour this does not reproduce.
fn cache_hit_rate(summaries: &HashMap<String, Value>) -> Option<Option<String>> {
    let mut names: Vec<&String> = summaries.keys().collect();

    names.sort_unstable();

    let mut total = 0.0_f64;
    let mut cached = 0.0_f64;

    for name in names.iter().rev().take(RATE_WINDOW).rev() {
        // `data.stats` on a non-object has no value, or throws inside the loop's `try`: the file adds nothing.
        let Value::Object(data) = &summaries[*name] else {
            continue;
        };

        let stats = match data.get("stats") {
            None | Some(Value::Null) => continue,
            Some(Value::Object(stats)) => stats,
            Some(_) => return None,
        };
        let number = |key: &str| -> Option<f64> {
            match stats.get(key) {
                None | Some(Value::Null) => Some(0.0),
                Some(Value::Number(value)) => value.as_f64().filter(|value| *value >= 0.0),
                Some(_) => None,
            }
        };

        total += number("total")?;
        cached += number("cached")?;
    }

    if total > 0.0 {
        return Some(Some(format!("{}%", to_fixed_0(cached / total * 100.0)?)));
    }

    Some(None)
}

fn overview(root: &Path) -> Option<Overview> {
    let user_agent = env::var("npm_config_user_agent");
    let user_agent = match &user_agent {
        Ok(agent) => Some(agent.as_str()),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => return None,
    };

    let (graph, manifests) = project_graph_with_manifests(root)?;
    let targets = unique_target_count(root, &graph, &manifests)?;
    let summaries = read_summaries(root)?;
    let flaky_tasks = flaky_count(&run_history(root, &summaries)?)?;
    let cache_hit_rate = cache_hit_rate(&summaries)?;
    // Last, because it may start `node`: a workspace Node answers anyway does not pay for that.
    let runtime_issues = count_findings(root, user_agent, &mut node_version)?;

    Some(Overview { cache_hit_rate, flaky_tasks, projects: graph.projects.len(), runtime_issues, targets })
}

fn render_json(overview: &Overview) -> String {
    let count = |value: usize| Json::Int(i64::try_from(value).unwrap_or(i64::MAX));
    let document = Json::Object(vec![
        ("cacheHitRate".to_owned(), overview.cache_hit_rate.clone().map_or(Json::Null, Json::Str)),
        ("constraintViolations".to_owned(), Json::Int(0)),
        ("flakyTasks".to_owned(), count(overview.flaky_tasks)),
        ("projects".to_owned(), count(overview.projects)),
        ("runtimeIssues".to_owned(), count(overview.runtime_issues)),
        ("targets".to_owned(), count(overview.targets)),
    ]);

    format!("{}\n", stringify(&document, "  "))
}

fn render_text(overview: &Overview, style: Style) -> String {
    let icon = |ok: bool| if ok { style.green("✓") } else { style.red("✗") };
    let runtime = if overview.runtime_issues == 0 {
        style.green("OK")
    } else {
        style.yellow(&format!("{} issue(s)", overview.runtime_issues))
    };
    let flaky =
        if overview.flaky_tasks == 0 { style.green("none") } else { style.yellow(&overview.flaky_tasks.to_string()) };
    let mut lines = vec![
        String::new(),
        format!("  {}", style.dim("VIS STATUS")),
        String::new(),
        format!("  {} {} projects · {} unique targets", icon(true), overview.projects, overview.targets),
        format!("  {} Runtime: {runtime}", icon(overview.runtime_issues == 0)),
        format!("  {} Constraints: {}", icon(true), style.green("OK")),
        format!("  {} Flaky tasks: {flaky}", icon(overview.flaky_tasks == 0)),
    ];

    if let Some(rate) = &overview.cache_hit_rate {
        lines.push(format!("  {} Cache hit rate: {rate} (last {RATE_WINDOW} runs)", icon(true)));
    }

    lines.push(String::new());

    lines.into_iter().map(|line| format!("{line}\n")).collect()
}

/// The text of one invocation, or `None` when Node must answer it.
fn answer(args: &[String]) -> Option<String> {
    let json = parse(args)?;

    if !output_settings_are_default() {
        return None;
    }

    let cwd = env::current_dir().ok()?;
    let root = monorepo_root(&cwd)?;

    if !quiet_context(&cwd, &root) || vis_config::requires_node(&vis_config::read(&root)) {
        return None;
    }

    // The text view is painted by the colour library: its level, or Node's answer when this cannot tell. The JSON
    // carries no colour.
    let style = if json { Style { colour: false } } else { Style { colour: piped_colour_level(args)? > 0 } };
    let overview = overview(&root)?;

    Some(if json { render_json(&overview) } else { render_text(&overview, style) })
}

/// Answers `vis status` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Some(text) => {
            write_stdout("status", "the status", &text);

            std::process::exit(0);
        }
        None => crate::process::delegate(raw_args),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    fn history(text: &str) -> Vec<Value> {
        vec![serde_json::from_str(text).expect("json")]
    }

    #[test]
    fn parses_the_plain_and_the_json_shape() {
        assert_eq!(parse(&argv(&["status"])), Some(false));
        assert_eq!(parse(&argv(&["status", "--json"])), Some(true));
        assert_eq!(parse(&argv(&["status", "--json", "--json"])), None);
        assert_eq!(parse(&argv(&["status", "--json=true"])), None);
        assert_eq!(parse(&argv(&["status", "extra"])), None);
    }

    #[test]
    fn to_fixed_rounds_a_tie_up_as_javascript_does() {
        assert_eq!(to_fixed_0(12.5).as_deref(), Some("13"));
        assert_eq!(to_fixed_0(0.5).as_deref(), Some("1"));
        assert_eq!(to_fixed_0(2.5).as_deref(), Some("3"));
        assert_eq!(to_fixed_0(12.4999).as_deref(), Some("12"));
        assert_eq!(to_fixed_0(100.0).as_deref(), Some("100"));
        assert_eq!(to_fixed_0(f64::NAN), None);
        assert_eq!(to_fixed_0(-1.0), None);
        assert_eq!(to_fixed_0(1e21), None);
    }

    #[test]
    fn a_task_that_failed_or_retried_in_two_runs_is_flaky() {
        let runs = history(
            r#"{"tasks":[
                {"taskId":"a:build","cacheStatus":"MISS","target":{},"exitCode":0},
                {"taskId":"a:build","cacheStatus":"MISS","target":{},"exitCode":1},
                {"taskId":"b:test","cacheStatus":"MISS","target":{},"retryAttempts":2},
                {"taskId":"b:test","cacheStatus":"MISS","target":{}},
                {"taskId":"c:lint","cacheStatus":"MISS","target":{},"exitCode":1},
                {"taskId":"d:lint","cacheStatus":"HIT","target":{},"exitCode":1},
                {"taskId":"d:lint","cacheStatus":"REMOTE_HIT","target":{},"exitCode":1},
                {"taskId":"e:x","cacheStatus":"MISS","target":{}},
                {"taskId":"e:x","cacheStatus":"MISS","target":{}}
            ]}"#,
        );

        assert_eq!(flaky_count(&runs), Some(2));
    }

    #[test]
    fn a_null_exit_code_counts_as_a_failure() {
        let runs = history(
            r#"{"tasks":[
                {"taskId":"a","cacheStatus":"MISS","target":{},"exitCode":null},
                {"taskId":"a","cacheStatus":"MISS","target":{}}
            ]}"#,
        );

        assert_eq!(flaky_count(&runs), Some(1));
    }

    #[test]
    fn shapes_javascript_would_coerce_or_throw_on_are_left_to_node() {
        for text in [
            r#"null"#,
            r#"{"tasks":[null]}"#,
            r#"{"tasks":[{"taskId":"a","cacheStatus":"MISS"}]}"#,
            r#"{"tasks":[{"taskId":1,"cacheStatus":"MISS","target":{}}]}"#,
            r#"{"tasks":[{"taskId":"a","cacheStatus":"MISS","target":{},"retryAttempts":"2"}]}"#,
        ] {
            assert_eq!(flaky_count(&history(text)), None, "{text}");
        }

        // A summary without a task list has nothing to count.
        for text in [r#"{"tasks":"x"}"#, "[]", "5", r#""text""#, "true"] {
            assert_eq!(flaky_count(&history(text)), Some(0), "{text}");
        }
    }

    fn summaries(files: &[(&str, &str)]) -> HashMap<String, Value> {
        files.iter().map(|(name, text)| ((*name).to_owned(), serde_json::from_str(text).expect("json"))).collect()
    }

    #[test]
    fn the_rate_is_over_the_last_twenty_files_by_name() {
        let mut files: Vec<(String, String)> = (0..22)
            .map(|index| (format!("{index:02}.json"), r#"{"stats":{"cached":0,"total":4}}"#.to_owned()))
            .collect();

        files[21].1 = r#"{"stats":{"cached":4,"total":4}}"#.to_owned();

        let map: HashMap<String, Value> =
            files.iter().map(|(name, text)| (name.clone(), serde_json::from_str(text).unwrap())).collect();

        // 20 files of 4 tasks, one of them fully cached: 4 / 80.
        assert_eq!(cache_hit_rate(&map), Some(Some("5%".to_owned())));
    }

    #[test]
    fn a_rate_exactly_between_two_integers_rounds_up() {
        let map = summaries(&[("a.json", r#"{"stats":{"cached":1,"total":8}}"#)]);

        assert_eq!(cache_hit_rate(&map), Some(Some("13%".to_owned())));
    }

    #[test]
    fn no_counted_task_has_no_rate() {
        assert_eq!(
            cache_hit_rate(&summaries(&[("a.json", r#"{"stats":{"total":0}}"#), ("b.json", r#"{}"#)])),
            Some(None)
        );
        assert_eq!(cache_hit_rate(&summaries(&[("a.json", "null"), ("b.json", "[1]")])), Some(None));
    }

    #[test]
    fn a_stats_value_that_javascript_would_concatenate_is_left_to_node() {
        assert_eq!(cache_hit_rate(&summaries(&[("a.json", r#"{"stats":{"total":"4"}}"#)])), None);
        assert_eq!(cache_hit_rate(&summaries(&[("a.json", r#"{"stats":5}"#)])), None);
        assert_eq!(cache_hit_rate(&summaries(&[("a.json", r#"{"stats":{"total":-4}}"#)])), None);
    }

    #[test]
    fn only_a_clean_release_version_is_taken_from_node() {
        assert_eq!(clean_node_version("v24.0.1").as_deref(), Some("24.0.1"));

        for text in
            ["24.0.1", "v24.0", "v24.0.1.2", "v24.0.1-nightly2025", "v24.0.x", "v", "", "v24..1", "node v24.0.1"]
        {
            assert_eq!(clean_node_version(text), None, "{text}");
        }
    }

    #[test]
    fn the_json_view_keeps_the_key_order_and_null() {
        let overview = Overview { cache_hit_rate: None, flaky_tasks: 0, projects: 3, runtime_issues: 2, targets: 4 };

        assert_eq!(
            render_json(&overview),
            "{\n  \"cacheHitRate\": null,\n  \"constraintViolations\": 0,\n  \"flakyTasks\": 0,\n  \"projects\": 3,\n  \"runtimeIssues\": 2,\n  \"targets\": 4\n}\n"
        );
    }

    #[test]
    fn the_text_view_lists_the_rate_only_when_there_is_one() {
        let plain = Style { colour: false };
        let without = render_text(
            &Overview { cache_hit_rate: None, flaky_tasks: 2, projects: 1, runtime_issues: 1, targets: 1 },
            plain,
        );
        let with = render_text(
            &Overview {
                cache_hit_rate: Some("50%".to_owned()),
                flaky_tasks: 0,
                projects: 1,
                runtime_issues: 0,
                targets: 1,
            },
            plain,
        );

        assert!(without.contains("  ✗ Runtime: 1 issue(s)\n"), "{without}");
        assert!(without.contains("  ✗ Flaky tasks: 2\n"), "{without}");
        assert!(!without.contains("Cache hit rate"));
        assert!(with.contains("  ✓ Runtime: OK\n"), "{with}");
        assert!(with.contains("  ✓ Flaky tasks: none\n  ✓ Cache hit rate: 50% (last 20 runs)\n\n"), "{with}");
    }
}
