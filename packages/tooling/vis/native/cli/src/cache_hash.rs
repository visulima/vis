//! `vis cache hash <task> [--format json|table] [--run <id>]` — the native fast path.
//!
//! The command does not hash anything. It reads a run summary the task runner recorded
//! (`<root>/.vis/last-summary.json`, or `<root>/.vis/runs/<id>.json` for `--run`) and prints the
//! hash and the per-input hashes stored there, like `packages/tooling/vis/src/commands/cache/hash.ts`.
//! So none of the hashing engine runs here and the output is the recorded strings, byte for byte;
//! the task-runner core crate is linked for its git-worktree lookup (see the trace-mode case below).
//!
//! The native path answers only what it can reproduce exactly, and hands everything else to Node:
//!
//! - the argument shapes of [`parse`], and the same quiet context as `list` (CI, no terminal, no
//!   `vis.config`, no Deno file), with the header lines of the table coloured as pail does;
//! - a summary file that is absent (Node's "no summary" and "not found" messages), or one that
//!   deserializes without a doubt. Anything else about the file goes to Node, since `JSON.parse`
//!   and serde disagree on lone surrogates, depth and so on;
//! - a task that carries `hashDetails`, has no hash at all, or is a trace-mode task (a hash and no
//!   `hashDetails`). The last reads its tracked inputs out of the cache entry. With no config and no
//!   `VIS_CACHE_DIRECTORY` the entry sits in the main worktree's `node_modules/.cache/vis`, which
//!   `task_runner_core::get_main_worktree_root` finds, the very function the Node addon wraps;
//! - table output only for printable ASCII, because pail's wrapping and `padEnd` count UTF-16
//!   units, and for a root-collation locale, because Node sorts the buckets with `localeCompare`.

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;

use crate::cache::dirs::default_task_cache_directory;
use crate::collation::{collate, root_collation};
use crate::output::Output;
use crate::pail::{Layout, Level};
use crate::run_summary::{summary_path, Details, Fingerprint, Summary, Task};
use crate::summary::{context, find_task, json_text, load_summary, missing_summary, task_not_in_run, valid_run_id};
use crate::text::{is_ascii_graphic, is_ascii_printable};

/// A recorded hash is cut to this many characters in the table, then `…` follows.
const HASH_DISPLAY_PREFIX: usize = 16;

/// `String.prototype.padEnd` width of the key column.
const KEY_COLUMN: usize = 40;

/// What the user asked for.
#[derive(Debug, PartialEq)]
pub(crate) struct Request {
    pub(crate) task_id: String,
    pub(crate) json: bool,
    pub(crate) run: Option<String>,
}

/// Parses the arguments of `cache hash` (`args[0]` is `cache`, `args[1]` is `hash`) the way cerebro
/// does for this command, or `None` for a shape that is Node's: one task id, and at most one each
/// of `--format <json|table>` and `--run <id>`, in either spelling.
pub(crate) fn parse(args: &[String]) -> Option<Request> {
    let mut task_id: Option<&str> = None;
    let mut format: Option<&str> = None;
    let mut run: Option<&str> = None;
    let mut tokens = args.iter().skip(2).map(String::as_str);

    while let Some(token) = tokens.next() {
        let (slot, value) = match token {
            "--format" => (&mut format, tokens.next()?),
            "--run" => (&mut run, tokens.next()?),
            _ if token.starts_with("--format=") => (&mut format, &token["--format=".len()..]),
            _ if token.starts_with("--run=") => (&mut run, &token["--run=".len()..]),
            _ if token.starts_with('-') => return None,
            _ => (&mut task_id, token),
        };

        // A value that looks like a flag is cerebro's to interpret.
        if slot.is_some() || value.starts_with('-') {
            return None;
        }

        *slot = Some(value);
    }

    let json = match format {
        None | Some("table") => false,
        Some("json") => true,
        Some(_) => return None,
    };

    if run.is_some_and(|id| !valid_run_id(id)) {
        return None;
    }

    Some(Request { task_id: task_id.filter(|id| !id.is_empty())?.to_owned(), json, run: run.map(str::to_owned) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FoundJson<'a> {
    cache_status: &'a str,
    hash: Option<&'a str>,
    hash_details: Option<&'a Details>,
    hash_source: Option<&'a str>,
    run_id: &'a str,
    task_id: &'a str,
    tracked_fingerprint: Option<&'a Fingerprint>,
}

/// `value.length > 16 ? value.slice(0, 16) + "…" : value`, for ASCII.
fn truncate_hash(value: &str) -> String {
    if value.len() > HASH_DISPLAY_PREFIX {
        format!("{}…", &value[..HASH_DISPLAY_PREFIX])
    } else {
        value.to_owned()
    }
}

/// `renderHashDetailsBucket`. `None` when an entry is not printable ASCII or the order is Node's.
fn render_bucket(out: &mut String, label: &str, entries: &[(String, String)]) -> Option<()> {
    if entries.is_empty() {
        return Some(());
    }

    if entries.iter().any(|(key, value)| !is_ascii_printable(key) || !is_ascii_printable(value))
        || (entries.len() > 1 && !root_collation())
    {
        return None;
    }

    let mut sorted: Vec<&(String, String)> = entries.iter().collect();

    sorted.sort_by(|(a, _), (b, _)| collate(a, b));

    out.push_str(&format!("  {label}:\n"));

    for (key, value) in sorted {
        out.push_str(&format!("    {key:<KEY_COLUMN$}  {}\n", truncate_hash(value)));
    }

    Some(())
}

/// The table for a task found in the summary. `None` when Node has to answer.
fn table(
    request: &Request,
    summary: &Summary,
    task: &Task,
    tracked: Option<&Fingerprint>,
    layout: Layout,
) -> Option<Output> {
    let mut out = Output::default();

    if !(is_ascii_graphic(&request.task_id)
        && is_ascii_graphic(&summary.id)
        && is_ascii_printable(&task.cache_status)
        && task.hash.as_deref().is_none_or(is_ascii_printable))
    {
        return None;
    }

    out.stdout.push_str(&layout.block(Level::Info, &format!("Hash for {} (run {})", request.task_id, summary.id)));
    out.stdout.push('\n');
    out.stdout.push_str(&format!("  status:  {}\n", task.cache_status));
    out.stdout.push_str(&format!("  hash:    {}\n", task.hash.as_deref().unwrap_or("(none)")));

    if task.hash_source.as_deref() == Some("declared-fallback") {
        out.stdout.push_str(
            "  key:     declared-fallback (no files were tracked; the entry is keyed on the declared inputs below)\n",
        );
    }

    out.stdout.push('\n');

    match &task.details {
        Some(Details(details)) => {
            if !is_ascii_printable(details.text("command")) {
                return None;
            }

            out.stdout.push_str(&format!("  command: {}\n", truncate_hash(details.text("command"))));

            for name in ["nodes", "runtime", "implicitDeps"] {
                render_bucket(&mut out.stdout, name, details.bucket(name))?;
            }
        }
        None => match tracked {
            Some(Fingerprint(fingerprint)) => {
                // `Object.fromEntries(missingFiles.map((path) => [path, "absent"]))`: a repeated path is one entry.
                let mut seen = HashSet::new();
                let missing: Vec<(String, String)> = fingerprint
                    .strings("missingFiles")
                    .iter()
                    .filter(|path| seen.insert(path.as_str()))
                    .map(|path| (path.clone(), "absent".to_owned()))
                    .collect();

                render_bucket(&mut out.stdout, "tracked files", fingerprint.bucket("fileHashes"))?;
                render_bucket(&mut out.stdout, "tracked env", fingerprint.bucket("envHashes"))?;
                render_bucket(&mut out.stdout, "missing files", &missing)?;
            }
            None => out.stdout.push_str(&layout.block(Level::Info, "No hash details recorded for this task.")),
        },
    }

    Some(out)
}

/// `Number.parseInt(text.trim(), 10)` is a number: an optional sign, then a digit.
fn parses_as_integer(text: &str) -> bool {
    let trimmed = text.trim();

    trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed).bytes().next().is_some_and(|byte| byte.is_ascii_digit())
}

/// Reads a text file the way `readFile(path, "utf8")` inside a `try` does: `Ok(None)` for any
/// failure Node swallows, `None` for the one it would not see (bytes that are not UTF-8).
fn read_swallowed(path: &Path) -> Option<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Some(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::InvalidData => None,
        Err(_) => Some(None),
    }
}

/// The fingerprint a trace-mode task stored in its cache entry (`Cache.get(hash)?.fingerprint`), in
/// the default cache directory the Node command resolves without a config: the main git worktree's
/// `node_modules/.cache/vis`, which the task-runner core crate finds the same way the Node addon
/// does. `None` hands the call to Node, `Some(None)` is "no entry, or none with a fingerprint".
fn tracked_fingerprint(root: &Path, hash: &str) -> Option<Option<Fingerprint>> {
    // `VIS_CACHE_DIRECTORY` moves the directory; a hash with a separator in it would leave it.
    if env::var_os("VIS_CACHE_DIRECTORY").is_some_and(|value| !value.is_empty())
        || hash.is_empty()
        || !hash.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return None;
    }

    let entry = default_task_cache_directory(root)?.join(hash);

    // An entry counts once `.commit` is there and `code` holds a number.
    if fs::read(entry.join(".commit")).is_err() {
        return Some(None);
    }

    let Some(code) = read_swallowed(&entry.join("code"))? else {
        return Some(None);
    };

    if !parses_as_integer(&code) {
        return Some(None);
    }

    let Some(text) = read_swallowed(&entry.join("fingerprint.json"))? else {
        return Some(None);
    };

    serde_json::from_str(&text).ok().map(Some)
}

/// The output for the request, or `None` to delegate.
fn answer(request: &Request, summary: Option<Summary>, root: &Path, layout: Layout) -> Option<Output> {
    let Some(summary) = summary else {
        return missing_summary(root, request.run.as_deref(), Some(&request.task_id), request.json, layout);
    };

    let Some(raw) = find_task(&summary.tasks, &request.task_id)? else {
        return task_not_in_run(&request.task_id, &summary.id, request.json, layout);
    };

    let task: Task = serde_json::from_str(raw.get()).ok()?;

    // Trace mode: a task with no declared details has its tracked inputs in the cache entry the hash names.
    let tracked = match (&task.details, &task.hash) {
        (None, Some(hash)) => tracked_fingerprint(root, hash)?,
        _ => None,
    };

    if request.json {
        let stdout = json_text(&FoundJson {
            cache_status: &task.cache_status,
            hash: task.hash.as_deref(),
            hash_details: task.details.as_ref(),
            hash_source: task.hash_source.as_deref(),
            run_id: &summary.id,
            task_id: &task.task_id,
            tracked_fingerprint: tracked.as_ref(),
        })?;

        return Some(Output { stdout, ..Output::default() });
    }

    let mut printed = table(request, &summary, &task, tracked.as_ref(), layout)?;

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

/// Answers `vis cache hash` natively or hands the whole invocation to Node. `raw_args` keeps the
/// argv as it arrived for the delegation; `args` is its lossy view, used for matching.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(out) = native(args) else {
        crate::process::delegate(raw_args);
    };

    out.emit("cache hash")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    fn request(task_id: &str, json: bool, run: Option<&str>) -> Option<Request> {
        Some(Request { task_id: task_id.to_owned(), json, run: run.map(str::to_owned) })
    }

    #[test]
    fn parses_the_shapes_it_answers() {
        assert_eq!(parse(&argv(&["cache", "hash", "a:b"])), request("a:b", false, None));
        assert_eq!(parse(&argv(&["cache", "hash", "a:b", "--format", "json"])), request("a:b", true, None));
        assert_eq!(parse(&argv(&["cache", "hash", "--format=json", "a:b"])), request("a:b", true, None));
        assert_eq!(
            parse(&argv(&["cache", "hash", "--format", "table", "a:b", "--run", "r-1.2_x"])),
            request("a:b", false, Some("r-1.2_x"))
        );
        assert_eq!(
            parse(&argv(&["cache", "hash", "a:b", "--run=2026-11-22T07-37-56-589Z_x"])),
            request("a:b", false, Some("2026-11-22T07-37-56-589Z_x"))
        );
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["cache", "hash"][..],
            &["cache", "hash", "a:b", "c:d"],
            &["cache", "hash", "a:b", "--json"],
            &["cache", "hash", "a:b", "--format"],
            &["cache", "hash", "a:b", "--format", "yaml"],
            &["cache", "hash", "a:b", "--format=JSON"],
            &["cache", "hash", "a:b", "--format", "json", "--format", "json"],
            &["cache", "hash", "a:b", "--run", ""],
            &["cache", "hash", "a:b", "--run", "../x"],
            &["cache", "hash", "a:b", "--run", "a/b"],
            &["cache", "hash", "a:b", "--run", "-x"],
            &["cache", "hash", "a:b", "--cache-dir", "x"],
            &["cache", "hash", "-x"],
            &["cache", "hash", "a:b", "-v"],
            &["cache", "hash", "a:b", "--help"],
            &["cache", "hash", ""],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    #[test]
    fn truncates_after_sixteen_characters() {
        assert_eq!(truncate_hash("0123456789abcdef"), "0123456789abcdef");
        assert_eq!(truncate_hash("0123456789abcdef0"), "0123456789abcdef…");
    }
}
