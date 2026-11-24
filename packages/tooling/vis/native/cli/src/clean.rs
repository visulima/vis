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
//! - CI is set and neither stream is a terminal. pail's line width comes from `COLUMNS` (80 when
//!   unset), and its colour from the detection in [`crate::term::piped_colour_level`]: the header
//!   of each line is coloured exactly as pail does it, or the run goes to Node;
//! - every path it prints is plain ASCII with no spaces, so pail's word wrap is the one
//!   reproduced below.
//!
//! `--empty-packages`, any other flag, a non-UTF-8 or spaced path, and everything else goes to
//! Node. Every check runs before anything is removed, so a delegation never follows a removal.

use std::env;
use std::ffi::OsString;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::exit;

use vis_core::clean::{find_lockfiles, find_node_modules, list_node_modules, remove_listed, CleanOutcome};

use crate::node_context::{any_ancestor_has, in_ci, DENO_FILES};
use crate::output::write_streams;
use crate::pail::{Layout, Level};
use crate::vis_config::{self, ConfigState};

/// What one run prints, split the way pail splits it: error blocks go to stderr, the rest to
/// stdout.
#[derive(Default)]
struct Output {
    stdout: String,
    stderr: String,
}

struct Plan {
    dry_run: bool,
    lockfile: bool,
    /// `node_modules` directories, in the order the Node path visits them.
    directories: Vec<PathBuf>,
    lockfiles: Vec<PathBuf>,
    layout: Layout,
}

/// Answer `vis clean` natively, or delegate to Node. Never returns.
///
/// `raw` is the untouched argv, forwarded as it arrived on delegation. The lossy `String` view
/// is only used to match arguments.
pub fn run(raw: &[OsString]) -> ! {
    let args: Vec<String> = raw.iter().map(|argument| argument.to_string_lossy().into_owned()).collect();

    let Some(plan) = plan(&args) else {
        crate::delegate(raw);
    };

    let mut out = Output::default();

    let mut exit_code = 0;

    if plan.dry_run {
        dry_run_output(&plan, &mut out);
    } else {
        let outcome = remove_listed(&plan.directories, &plan.lockfiles);

        exit_code = removal_output(&plan, &outcome, &mut out);
    }

    write_streams("clean", &out.stdout, &out.stderr);

    exit(exit_code)
}

/// The removal plan when the invocation is native, or `None` to delegate.
fn plan(args: &[String]) -> Option<Plan> {
    // Windows keeps the Node path: its separators come from `@visulima/path`, not the OS.
    if !cfg!(unix) {
        return None;
    }

    let (dry_run, lockfile) = flags(args)?;

    if !in_ci() || io::stdout().is_terminal() || io::stderr().is_terminal() {
        return None;
    }

    let layout = Layout::detect(args)?;
    let root = env::current_dir().ok()?;

    if !workspace_root_is_cwd(&root)
        || vis_config::read(&root) != ConfigState::Absent
        || any_ancestor_has(&root, &DENO_FILES)
    {
        return None;
    }

    let directories = if dry_run { list_node_modules(&root) } else { removal_order(find_node_modules(&root), &root) };
    let lockfiles = if lockfile { find_lockfiles(&root) } else { Vec::new() };

    let printable = directories.iter().chain(lockfiles.iter()).all(|path| is_plain(path));

    if !printable {
        return None;
    }

    Some(Plan { dry_run, lockfile, directories, lockfiles, layout })
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

/// Whether Node would find the workspace root at `cwd`: pnpm, with the lockfile and the
/// workspace file both here, and no lerna config above that could claim the root instead.
fn workspace_root_is_cwd(cwd: &Path) -> bool {
    if cwd.ancestors().any(|directory| directory.join("lerna.json").exists()) {
        return false;
    }

    // Node's root search stops at the nearest marker above cwd, so any marker there could be the
    // root instead (`turbo.json`, a lockfile, a `package.json`, ...). Delegate rather than guess.
    if cwd
        .ancestors()
        .skip(1)
        .any(|directory| crate::node_context::ROOT_MARKERS.iter().any(|name| directory.join(name).exists()))
    {
        return false;
    }

    cwd.join("pnpm-lock.yaml").exists() && cwd.join("pnpm-workspace.yaml").exists()
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

fn dry_run_output(plan: &Plan, out: &mut Output) {
    if plan.directories.is_empty() {
        pail(plan, out, Level::Info, "No node_modules directories found.");
    } else {
        pail(plan, out, Level::Info, "Would remove:");

        for directory in &plan.directories {
            out.stdout.push_str(&format!("  {}\n", directory.display()));
        }
    }

    if plan.lockfile {
        for lockfile in &plan.lockfiles {
            out.stdout.push_str(&format!("  {}\n", lockfile.display()));
        }
    }
}

/// Prints the removal results the way the Node handler does, and returns the exit code.
fn removal_output(plan: &Plan, outcome: &CleanOutcome, out: &mut Output) -> i32 {
    for directory in &outcome.removed {
        pail(plan, out, Level::Success, &format!("Removed {directory}"));
    }

    for lockfile in &outcome.lockfiles_removed {
        pail(plan, out, Level::Success, &format!("Removed {lockfile}"));
    }

    for error in &outcome.errors {
        pail(plan, out, Level::Error, error);
    }

    if outcome.removed.is_empty() && outcome.lockfiles_removed.is_empty() {
        pail(plan, out, Level::Info, "No node_modules directories found.");
    } else {
        let count = outcome.removed.len();
        let noun = if count == 1 { "directory" } else { "directories" };

        pail(plan, out, Level::Info, &format!("Cleaned {count} node_modules {noun}"));
    }

    if outcome.errors.is_empty() {
        0
    } else {
        1
    }
}

/// One pail block (see [`Layout::block`]). pail sends the error level to stderr and every other
/// level to stdout.
fn pail(plan: &Plan, out: &mut Output, level: Level, message: &str) {
    let buffer = if level.to_stderr() { &mut out.stderr } else { &mut out.stdout };

    buffer.push_str(&plan.layout.block(level, message));
}

#[cfg(test)]
mod tests {
    use super::workspace_root_is_cwd;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("vis-clean-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(directory.join("app")).unwrap();

        directory
    }

    #[test]
    fn a_pnpm_root_with_a_marker_above_it_is_not_the_workspace_root() {
        let directory = scratch("ancestor-marker");
        let app = directory.join("app");

        fs::write(app.join("pnpm-lock.yaml"), "").unwrap();
        fs::write(app.join("pnpm-workspace.yaml"), "").unwrap();
        assert!(workspace_root_is_cwd(&app));

        fs::write(directory.join("turbo.json"), "{}").unwrap();
        assert!(!workspace_root_is_cwd(&app));

        fs::remove_dir_all(&directory).unwrap();
    }
}
