//! `vis clean [--dry-run] [--lockfile|-l]` — the native fast path.
//!
//! The Node handler (`src/commands/clean/handler.ts`) removes the `node_modules` directories of
//! the monorepo root, and prints its messages through `@visulima/pail`. This module makes the
//! same removals and prints the same bytes. It answers only the context it can prove:
//!
//! - the workspace root is the current directory (a `pnpm-lock.yaml` and a `pnpm-workspace.yaml`
//!   sit there, and no `lerna.json` is at or above it), because Node finds the root with
//!   `@visulima/package`'s search, which this crate does not reproduce;
//! - no `vis.config.*` applies, and no Deno file is at or above it;
//! - CI is set, neither stream is a terminal, and pail would not colour its output (its line
//!   width comes from `COLUMNS`, 80 when unset);
//! - every path it prints is plain ASCII with no spaces, so pail's word wrap is the one
//!   reproduced below.
//!
//! `--empty-packages`, any other flag, a non-UTF-8 or spaced path, and everything else goes to
//! Node. Every check runs before anything is removed, so a delegation never follows a removal.

use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use vis_core::clean::{clean_workspace, find_lockfiles, find_node_modules, list_node_modules, CleanOutcome};

use crate::vis_config::{self, ConfigState};

/// pail's default line width when `COLUMNS` is unset (stdout is not a terminal).
const DEFAULT_WIDTH: usize = 80;

/// Below this width pail's header cannot hold its label, so Node stays in charge.
const MIN_WIDTH: usize = 40;

const DENO_FILES: [&str; 3] = ["deno.json", "deno.jsonc", "deno.lock"];

struct Plan {
    dry_run: bool,
    lockfile: bool,
    root: PathBuf,
    /// `node_modules` directories, in the order the Node path visits them.
    directories: Vec<PathBuf>,
    lockfiles: Vec<PathBuf>,
    width: usize,
}

/// Answer `vis clean` natively, or delegate to Node. Never returns.
pub fn run(args: &[String]) -> ! {
    let Some(plan) = plan(args) else {
        crate::delegate(args);
    };

    let mut out = String::new();

    let mut exit_code = 0;

    if plan.dry_run {
        dry_run_output(&plan, &mut out);
    } else {
        let outcome = clean_workspace(&plan.root, plan.lockfile);

        exit_code = removal_output(&plan, &outcome, &mut out);
    }

    let mut stdout = io::stdout().lock();

    match stdout.write_all(out.as_bytes()).and_then(|()| stdout.flush()) {
        Ok(()) => exit(exit_code),
        // A closed pipe is not an error worth reporting.
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => exit(exit_code),
        Err(error) => {
            eprintln!("vis clean: failed to write the output: {error}");
            exit(1);
        }
    }
}

/// The removal plan when the invocation is native, or `None` to delegate.
fn plan(args: &[String]) -> Option<Plan> {
    // Windows keeps the Node path: its separators come from `@visulima/path`, not the OS.
    if !cfg!(unix) {
        return None;
    }

    let (dry_run, lockfile) = flags(args)?;

    // pail colours its output on a terminal or under FORCE_COLOR; the native path does not.
    if crate::term::color_enabled(args) || !in_ci() || io::stderr().is_terminal() {
        return None;
    }

    let width = pail_width()?;
    let root = env::current_dir().ok()?;

    if !workspace_root_is_cwd(&root) || vis_config::read(&root) != ConfigState::Absent || deno_file_applies(&root) {
        return None;
    }

    let directories = if dry_run { list_node_modules(&root) } else { removal_order(find_node_modules(&root), &root) };
    let lockfiles = if lockfile { find_lockfiles(&root) } else { Vec::new() };

    let printable = directories.iter().chain(lockfiles.iter()).all(|path| is_plain(path));

    if !printable {
        return None;
    }

    Some(Plan { dry_run, lockfile, root, directories, lockfiles, width })
}

/// The flags after `clean`, each accepted at most once. Anything else is `None`.
fn flags(args: &[String]) -> Option<(bool, bool)> {
    if args.first().map(String::as_str) != Some("clean") {
        return None;
    }

    let (mut dry_run, mut lockfile) = (false, false);

    for argument in &args[1..] {
        let slot = match argument.as_str() {
            "--dry-run" => &mut dry_run,
            "--lockfile" | "-l" => &mut lockfile,
            _ => return None,
        };

        if *slot {
            return None;
        }

        *slot = true;
    }

    Some((dry_run, lockfile))
}

/// pail's width: `COLUMNS` when set (it must parse, and be wide enough), else 80.
fn pail_width() -> Option<usize> {
    match env::var("COLUMNS") {
        Err(env::VarError::NotPresent) => Some(DEFAULT_WIDTH),
        Ok(text) => text.trim().parse::<usize>().ok().filter(|&width| width >= MIN_WIDTH),
        Err(env::VarError::NotUnicode(_)) => None,
    }
}

/// Whether Node would find the workspace root at `cwd`: pnpm, with the lockfile and the
/// workspace file both here, and no lerna config above that could claim the root instead.
fn workspace_root_is_cwd(cwd: &Path) -> bool {
    if cwd.ancestors().any(|directory| directory.join("lerna.json").exists()) {
        return false;
    }

    cwd.join("pnpm-lock.yaml").exists() && cwd.join("pnpm-workspace.yaml").exists()
}

fn deno_file_applies(cwd: &Path) -> bool {
    cwd.ancestors().any(|directory| DENO_FILES.iter().any(|name| directory.join(name).exists()))
}

/// The removal order of `clean_workspace`: the root's own `node_modules` last.
fn removal_order(mut directories: Vec<PathBuf>, root: &Path) -> Vec<PathBuf> {
    let root_node_modules = root.join("node_modules");

    directories.sort_by_key(|directory| *directory == root_node_modules);

    directories
}

/// A path pail can print exactly: ASCII, no spaces, no control characters.
fn is_plain(path: &Path) -> bool {
    path.to_str().is_some_and(|text| text.bytes().all(|byte| byte.is_ascii_graphic()))
}

fn dry_run_output(plan: &Plan, out: &mut String) {
    if plan.directories.is_empty() {
        pail(plan, out, "INFO", "No node_modules directories found.");
    } else {
        pail(plan, out, "INFO", "Would remove:");

        for directory in &plan.directories {
            out.push_str(&format!("  {}\n", directory.display()));
        }
    }

    if plan.lockfile {
        for lockfile in &plan.lockfiles {
            out.push_str(&format!("  {}\n", lockfile.display()));
        }
    }
}

/// Prints the removal results the way the Node handler does, and returns the exit code.
fn removal_output(plan: &Plan, outcome: &CleanOutcome, out: &mut String) -> i32 {
    for directory in &outcome.removed {
        pail(plan, out, "SUCCESS", &format!("Removed {directory}"));
    }

    for lockfile in &outcome.lockfiles_removed {
        pail(plan, out, "SUCCESS", &format!("Removed {lockfile}"));
    }

    for error in &outcome.errors {
        pail(plan, out, "ERROR", error);
    }

    if outcome.removed.is_empty() && outcome.lockfiles_removed.is_empty() {
        pail(plan, out, "INFO", "No node_modules directories found.");
    } else {
        let count = outcome.removed.len();
        let noun = if count == 1 { "directory" } else { "directories" };

        pail(plan, out, "INFO", &format!("Cleaned {count} node_modules {noun}"));
    }

    if outcome.errors.is_empty() {
        0
    } else {
        1
    }
}

/// One pail block: a header with the local time and the label, filled with dots to the line
/// width, a blank line, then the message word-wrapped to the same width.
fn pail(plan: &Plan, out: &mut String, label: &str, message: &str) {
    let limit = plan.width - 3;
    let head = format!("{} {label} ", clock());

    out.push_str(&head);
    out.push_str(&".".repeat(limit.saturating_sub(head.len())));
    out.push_str("\n\n");

    for line in wrap(message, limit) {
        out.push_str(&line);
        out.push('\n');
    }
}

/// pail's PRESERVE_WORDS wrap, with `trim: false`: the message splits into words and single
/// spaces, a token that would overflow starts a new line without being consumed, and a space
/// that does not fit therefore leads the next line. Widths are byte counts, which is exact for
/// the ASCII the gate lets through.
fn wrap(message: &str, limit: usize) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut start = 0;

    for (index, byte) in message.bytes().enumerate() {
        if byte == b' ' {
            tokens.push(&message[start..index]);
            tokens.push(" ");
            start = index + 1;
        }
    }

    tokens.push(&message[start..]);

    let mut lines = Vec::new();
    let mut current = String::new();
    let mut width = 0;
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index];

        if token.is_empty() {
            index += 1;
            continue;
        }

        if width + token.len() > limit && width > 0 {
            lines.push(std::mem::take(&mut current));
            width = 0;
            continue;
        }

        current.push_str(token);
        width += token.len();
        index += 1;
    }

    if !current.is_empty() {
        lines.push(current);
    }

    lines
}

/// Local wall-clock time as `HH:MM:SS`, the format pail's header uses.
#[cfg(unix)]
fn clock() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());

    let Ok(seconds) = libc::time_t::try_from(now) else {
        return "00:00:00".to_owned();
    };

    // SAFETY: `localtime_r` only writes the `tm` it is given, and `seconds` outlives the call.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };

    if unsafe { libc::localtime_r(&seconds, &mut tm) }.is_null() {
        return "00:00:00".to_owned();
    }

    format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
}

/// Only reached on unix: `plan` delegates everywhere else.
#[cfg(not(unix))]
fn clock() -> String {
    "00:00:00".to_owned()
}

/// `is-in-ci`: `CI` or `CONTINUOUS_INTEGRATION` set to anything but `0` or `false`.
fn in_ci() -> bool {
    ["CI", "CONTINUOUS_INTEGRATION"]
        .iter()
        .any(|key| env::var_os(key).is_some_and(|value| value != "0" && value != "false"))
}

#[cfg(test)]
mod tests {
    use super::wrap;

    #[test]
    fn a_long_path_breaks_after_the_label_and_keeps_its_space() {
        let path = format!("/{}/node_modules", "p".repeat(90));

        assert_eq!(wrap(&format!("Removed {path}"), 77), vec!["Removed ".to_owned(), path]);
    }

    #[test]
    fn a_space_that_does_not_fit_leads_the_next_line() {
        let path = format!("/{}/node_modules:", "p".repeat(80));

        assert_eq!(wrap(&format!("{path} Permission denied"), 77), vec![path, " Permission denied".to_owned()]);
    }

    #[test]
    fn a_short_message_stays_on_one_line() {
        assert_eq!(wrap("Removed /a/node_modules", 77), vec!["Removed /a/node_modules".to_owned()]);
    }
}
