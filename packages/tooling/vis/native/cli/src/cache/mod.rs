//! Native `vis cache list` and `vis cache size`: read-only inspection of the cache stores.
//!
//! Mirrors `src/commands/cache/{handler,context,entries,list,size}.ts`, the directory resolution of
//! `src/cache/cache-directory.ts` and the store paths of `src/util/vis-paths.ts`. The binary answers only
//! what it can reproduce byte for byte and hands everything else to Node:
//!
//! - flags: `--cache-dir`, `--scope`, `--format` (both commands) and `--type` (`size`), each once, with
//!   a value Node does not rewrite (`shared|worktree|all`, `table|json`, a known store). An unknown value
//!   makes Node warn through pail, so it is Node's;
//! - the workspace root is the pnpm root [`monorepo_root`] finds, with CI set and a quiet stderr. A
//!   `vis.config.*` is read only at that root, and only as a literal (see [`settings::read_settings`]);
//! - output that Node frames with pail (a missing or empty cache directory in table form, the `# <dir>`
//!   header of a multi-directory listing) is Node's, because pail prints a clock. The JSON forms have no
//!   pail output and stay native, except the multi-directory `list`, whose header goes to stdout.
//!
//! Every read and decision runs before the first byte is written, so a delegation never follows output.
//!
//! This module keeps the argument parsing, the two renderings and [`run`]; [`settings`] reads the config,
//! [`dirs`] resolves where the cache lives, [`entries`] reads what is in it and [`format`] prints sizes, dates and ages.

pub(crate) mod dirs;
pub(crate) mod entries;
pub(crate) mod flags;
pub(crate) mod format;
pub(crate) mod settings;

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use crate::js::{js_number, json_string};
use crate::node_context::{any_ancestor_has, in_ci, monorepo_root, DENO_FILES};

use dirs::{read_directories, store_directories, vis_cache_dir, Scope, Target};
use entries::{collect_entries, now_ms, store_stats, total_size, Entry, Stats};
use format::{format_age, format_bytes, iso};
use settings::read_settings;

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Table,
    Json,
}

#[derive(Clone, Copy, PartialEq)]
enum Subcommand {
    List,
    Size,
}

struct Options {
    command: Subcommand,
    cache_dir: Option<String>,
    format: Format,
    scope: Scope,
    target: Target,
}

/// Parses the arguments after `cache`. `None` for any shape Node must answer.
fn parse(args: &[String]) -> Option<Options> {
    let command = match args.get(1).map(String::as_str) {
        Some("list") => Subcommand::List,
        Some("size") => Subcommand::Size,
        _ => return None,
    };

    let (mut cache_dir, mut format, mut scope, mut target): (Option<&str>, Option<&str>, Option<&str>, Option<&str>) =
        (None, None, None, None);
    let mut tokens = args.iter().skip(2);

    while let Some(token) = tokens.next() {
        let (name, inline) = flags::split(token);

        let slot = match name {
            "--cache-dir" => &mut cache_dir,
            "--format" => &mut format,
            "--scope" => &mut scope,
            "--type" if command == Subcommand::Size => &mut target,
            _ => return None,
        };

        flags::take_value(slot, inline, &mut tokens)?;
    }

    Some(Options {
        command,
        cache_dir: cache_dir.map(str::to_owned),
        format: match format {
            None | Some("table") => Format::Table,
            Some("json") => Format::Json,
            Some(_) => return None,
        },
        scope: Scope::from_flag(scope)?,
        target: Target::from_flag(target)?,
    })
}

/// `runList`. `None` for the pail-framed outcomes, which are Node's.
fn list_output(directory: &str, format: Format) -> Option<String> {
    let exists = fs::metadata(directory).is_ok();
    let entries = if exists { collect_entries(directory)? } else { Vec::new() };
    let total = total_size(&entries)?;
    let quoted = json_string(directory);

    if format == Format::Json {
        if entries.is_empty() {
            return Some(format!(
                "{{\n  \"directory\": {quoted},\n  \"entries\": [],\n  \"totalBytes\": 0,\n  \"totalCount\": 0\n}}\n"
            ));
        }

        let now = now_ms();
        let mut rows = Vec::new();

        for entry in &entries {
            rows.push(format!(
                "    {{\n      \"ageMs\": {},\n      \"hash\": {},\n      \"mtimeIso\": \"{}\",\n      \"sizeBytes\": {}\n    }}",
                js_number(now - entry.mtime_ms),
                json_string(&entry.hash),
                iso(entry.mtime_ms)?,
                entry.size
            ));
        }

        return Some(format!(
            "{{\n  \"directory\": {quoted},\n  \"entries\": [\n{}\n  ],\n  \"totalBytes\": {total},\n  \"totalCount\": {}\n}}\n",
            rows.join(",\n"),
            entries.len()
        ));
    }

    // A missing or empty directory is a pail line.
    if entries.is_empty() {
        return None;
    }

    let now = now_ms();
    let rows: Vec<[String; 3]> = entries
        .iter()
        .map(|entry| {
            Some([entry.hash.chars().take(12).collect(), format_bytes(entry.size)?, format_age(entry.mtime_ms, now)])
        })
        .collect::<Option<_>>()?;
    let width = |index: usize, least: usize| rows.iter().map(|row| row[index].len()).fold(least, usize::max);
    let (hash_width, size_width, age_width) = (width(0, 4), width(1, 4), width(2, 3));

    let mut out = format!("Cache directory: {directory}\nEntries: {} ({})\n\n", entries.len(), format_bytes(total)?);

    out.push_str(&format!("  {:hash_width$}  {:size_width$}  {:age_width$}\n", "hash", "size", "age"));
    out.push_str(&format!("  {}  {}  {}\n", "-".repeat(hash_width), "-".repeat(size_width), "-".repeat(age_width)));

    for row in &rows {
        out.push_str(&format!("  {:hash_width$}  {:size_width$}  {:age_width$}\n", row[0], row[1], row[2]));
    }

    Some(out)
}

/// One `printStatsBlock`.
fn stats_block(label: &str, directory: Option<&str>, stats: &Stats) -> Option<String> {
    // `stats.oldestEntry ? ... : "N/A"`: a zero time is as absent as none.
    let time = |value: Option<f64>| -> Option<String> {
        match value {
            Some(ms) if ms != 0.0 => iso(ms),
            _ => Some("N/A".to_owned()),
        }
    };

    let mut out = format!("{label}:\n");

    if let Some(directory) = directory {
        out.push_str(&format!("  Directory:  {directory}\n"));
    }

    out.push_str(&format!("  Entries:    {}\n", stats.entries));
    out.push_str(&format!("  Total size: {}\n", format_bytes(stats.total)?));
    out.push_str(&format!("  Oldest:     {}\n", time(stats.oldest)?));
    out.push_str(&format!("  Newest:     {}\n", time(stats.newest)?));

    Some(out)
}

const STORES: [(Target, &str, &str); 4] = [
    (Target::Ai, "ai", "AI response cache"),
    (Target::Socket, "socket", "Socket.dev report cache"),
    (Target::DepsDev, "deps-dev", "deps.dev cache"),
    (Target::Snyk, "snyk", "Snyk issue cache"),
];

fn iso_or_null(value: Option<f64>) -> Option<String> {
    match value {
        Some(ms) => Some(format!("\"{}\"", iso(ms)?)),
        None => Some("null".to_owned()),
    }
}

/// `cacheSizeExecute`.
fn size_output(options: &Options, directories: &[String]) -> Option<String> {
    let home_cache = if options.target == Target::Task { None } else { Some(vis_cache_dir()?) };
    let mut task: Option<Vec<(String, Vec<Entry>, bool)>> = None;

    if options.target.includes(Target::Task) {
        let mut collected = Vec::new();

        for directory in directories {
            let exists = fs::metadata(directory).is_ok();
            let entries = if exists { collect_entries(directory)? } else { Vec::new() };

            collected.push((directory.clone(), entries, exists));
        }

        task = Some(collected);
    }

    let mut stores = Vec::new();

    for (kind, key, label) in STORES {
        if options.target.includes(kind) {
            let stats = store_stats(&store_directories(kind, home_cache.as_deref()?))?;

            stores.push((key, label, stats));
        }
    }

    if options.format == Format::Json {
        let mut sections = Vec::new();

        if let Some(collected) = &task {
            let mut rows = Vec::new();

            for (directory, entries, exists) in collected {
                let total = total_size(entries)?;

                rows.push(format!(
                    "    {{\n      \"directory\": {},\n      \"entries\": {},\n      \"exists\": {exists},\n      \"newestEntry\": {},\n      \"oldestEntry\": {},\n      \"totalBytes\": {total}\n    }}",
                    json_string(directory),
                    entries.len(),
                    iso_or_null(entries.first().map(|entry| entry.mtime_ms))?,
                    iso_or_null(entries.last().map(|entry| entry.mtime_ms))?
                ));
            }

            sections.push(format!("  \"task\": [\n{}\n  ]", rows.join(",\n")));
        }

        for (key, _, stats) in &stores {
            sections.push(format!(
                "  \"{key}\": {{\n    \"entries\": {},\n    \"newestEntry\": {},\n    \"oldestEntry\": {},\n    \"totalBytes\": {}\n  }}",
                stats.entries,
                iso_or_null(stats.newest)?,
                iso_or_null(stats.oldest)?,
                stats.total
            ));
        }

        return Some(format!("{{\n{}\n}}\n", sections.join(",\n")));
    }

    let mut out = String::new();

    if let Some(collected) = &task {
        // Several directories print a `# <dir>` pail header, and a missing one a pail line.
        let [(directory, entries, true)] = collected.as_slice() else {
            return None;
        };

        let stats = Stats::of_entries(entries)?;

        out.push_str(&stats_block("Task cache", Some(directory), &stats)?);
    }

    for (_, label, stats) in &stores {
        out.push_str(&stats_block(label, None, stats)?);
    }

    Some(out)
}

/// The workspace root of a run the cache commands can answer, or `None` when Node must: the pnpm root
/// [`monorepo_root`] finds, with CI set, a quiet stderr, no Deno file and no inherited root for another
/// directory. The commands that print pail blocks add their own layout checks on top.
pub(crate) fn quiet_workspace_root(cwd: &Path) -> Option<PathBuf> {
    let root = monorepo_root(cwd)?;

    if !in_ci() || io::stderr().is_terminal() || crate::term::node_warns_about_colour() {
        return None;
    }

    // Debug output and cerebro's output level change what the Node CLI logs around the command.
    if ["DEBUG", "CEREBRO_OUTPUT_LEVEL", "CEREBRO_MIN_NODE_VERSION"].iter().any(|key| env::var_os(key).is_some()) {
        return None;
    }

    // An inherited root for another directory is the parent process's, not this run's.
    if env::var_os("VIS_MONOREPO_ROOT").is_some_and(|inherited| !inherited.is_empty() && Path::new(&inherited) != root)
    {
        return None;
    }

    if [cwd, root.as_path()].iter().any(|directory| any_ancestor_has(directory, &DENO_FILES)) {
        return None;
    }

    Some(root)
}

/// The text to print, or `None` when Node must answer.
fn answer(args: &[String]) -> Option<String> {
    let options = parse(args)?;
    let cwd = env::current_dir().ok()?;
    let root = quiet_workspace_root(&cwd)?;

    let settings = read_settings(&cwd, &root)?;
    let directories = read_directories(&root, options.cache_dir.as_deref(), options.scope, &settings)?;

    match options.command {
        Subcommand::List => match directories.as_slice() {
            [directory] => list_output(directory, options.format),
            // Several directories print a `# <dir>` pail header on stdout.
            _ => None,
        },
        Subcommand::Size => size_output(&options, &directories),
    }
}

/// Answers `vis cache list` / `vis cache size` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    if !cfg!(unix) {
        crate::process::delegate(raw_args);
    }

    match answer(args) {
        Some(text) => {
            let mut stdout = io::stdout().lock();

            if stdout.write_all(text.as_bytes()).and_then(|()| stdout.flush()).is_err() {
                exit(1);
            }

            exit(0);
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

    #[test]
    fn only_the_plain_shapes_parse() {
        assert!(parse(&argv(&["cache", "list"])).is_some());
        assert!(parse(&argv(&["cache", "list", "--format", "json", "--scope=all", "--cache-dir", "x"])).is_some());
        assert!(parse(&argv(&["cache", "size", "--type=deps-dev"])).is_some());

        for shape in [
            &["cache", "list", "--type", "ai"][..],
            &["cache", "list", "--format", "yaml"],
            &["cache", "list", "--format=JSON"],
            &["cache", "list", "--scope", "bogus"],
            &["cache", "size", "--type=nope"],
            &["cache", "list", "--format"],
            &["cache", "list", "--format", "json", "--format", "table"],
            &["cache", "list", "--cache-dir="],
            &["cache", "list", "extra"],
            &["cache", "list", "--cwd", "."],
            &["cache", "clean"],
        ] {
            assert!(parse(&argv(shape)).is_none(), "{shape:?}");
        }
    }
}
