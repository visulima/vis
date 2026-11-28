//! What `vis run` settles before it reads a workspace file or keys a task: the process environment, the working
//! directory, the lockfile and the pins, and (after every task has hit) whether Node's background sweep would
//! delete anything. Each check that cannot be decided sends the run to Node.

use std::env;
use std::fs;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::cache::dirs::default_task_cache_directory;
use crate::cache::entries::{is_sweep_candidate, DEFAULT_MAX_CACHE_AGE};
use crate::node_context::{in_ci, native_context};
use crate::term;
use crate::toolchain::Pins;

use super::render::{unicode_symbols, Grouping, Look};

/// An entry this close to the sweep window is treated as expired: the native answer never depends on the
/// edge of a race with the sweep.
const SWEEP_MARGIN: Duration = Duration::from_secs(60 * 60);

/// Variables that change what Node does for `run`: remote cache, cache location, selection, runtime
/// choice, concurrency, logging. Any of them set sends the run to Node.
const NODE_ONLY_VARIABLES: [&str; 14] = [
    "CACHE_TOKEN",
    "DEBUG",
    "PAIL_LOG_LEVEL",
    "TURBO_API",
    "TURBO_TEAM",
    "TURBO_TOKEN",
    "VIS_AFFECTED_FILES",
    "VIS_CACHE_DIRECTORY",
    "VIS_CLI_TEST",
    "VIS_PARTITION",
    "VIS_POLYFILL",
    "VIS_RUNNER_TAGS",
    "VIS_RUNTIME",
    "VIS_RUN_CONCURRENCY_LIMIT",
];

/// Lockfiles of the other package managers; the lockfile preflight looks at the first one it finds.
const OTHER_LOCKFILES: [&str; 6] =
    ["aube-lock.yaml", "bun.lock", "bun.lockb", "npm-shrinkwrap.json", "package-lock.json", "yarn.lock"];

/// `MTIME_SKEW_MS` of the lockfile preflight.
const MTIME_SKEW_MS: f64 = 1000.0;

/// `CI` itself is set to something other than `0`, `false` or nothing. Parts of the Node run read
/// `process.env.CI` directly while the CI check (`is-in-ci`) also accepts `CONTINUOUS_INTEGRATION`, so
/// only the case where both agree is answered here.
fn ci_variable() -> bool {
    env::var("CI").is_ok_and(|value| !value.is_empty() && value != "0" && value != "false")
}

fn variable_set(name: &str) -> bool {
    env::var_os(name).is_some()
}

/// A `CEREBRO_*` variable (cerebro's output settings), up to case where the platform ignores it.
pub(super) fn is_cerebro_variable(name: &str, ignore_case: bool) -> bool {
    const PREFIX: &str = "CEREBRO_";

    if ignore_case {
        name.get(..PREFIX.len()).is_some_and(|start| start.eq_ignore_ascii_case(PREFIX))
    } else {
        name.starts_with(PREFIX)
    }
}

/// The part of the context only the process knows: where the output goes, which variables are set,
/// who started the binary. The workspace is looked at later. `None` means "Node answers".
fn environment_look(args: &[String]) -> Option<Look> {
    if !in_ci() || !ci_variable() || std::io::stdout().is_terminal() || std::io::stderr().is_terminal() {
        return None;
    }

    if NODE_ONLY_VARIABLES.iter().any(|name| variable_set(name)) {
        return None;
    }

    // Windows names its variables without regard to case, and Node reads `process.env.CEREBRO_*` the same way.
    if env::vars_os().any(|(key, _)| key.to_str().is_some_and(|key| is_cerebro_variable(key, cfg!(windows)))) {
        return None;
    }

    if matches!(env::var("NODE_ENV").as_deref(), Ok("debug" | "test")) {
        return None;
    }

    // The renderer's colour follows the same detection as pail's: any level above 0 prints the same
    // sixteen-colour codes, `None` is a case only Node can decide. The run prints no pail header and so no pail
    // clock, which is the one thing `piped_colour_level` leaves to Node on Windows for; off Windows the two are the
    // same call.
    let colour = term::piped_stdout_colour_level(args)? > 0;

    Some(Look { colour, unicode: unicode_symbols(), grouping: Grouping::detect() })
}

/// `process.arch` and `process.platform` as Node names them; anything else is Node's.
fn node_environment() -> Option<(&'static str, &'static str)> {
    let arch = match env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return None,
    };
    let platform = match env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "win32",
        _ => return None,
    };

    Some((arch, platform))
}

/// `process.version` as a recorded value: `v22.1.0` style, nothing that would need escaping.
pub(super) fn node_version_text(version: &str) -> Option<String> {
    let digits = version.strip_prefix('v')?;

    (!digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+')))
    .then(|| version.to_owned())
}

/// `process.version` of the Node that runs the launcher, `v22.1.0` style. The launcher hand-off sets it
/// (`node_contract::init` drops it for any other start), so a binary started on its own has none and asks the
/// Node it would delegate to (see [`super::probe_and_recheck`]).
fn launcher_node_version() -> Option<String> {
    node_version_text(&env::var("VIS_NODE_VERSION").ok()?)
}

fn exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

fn modified_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;

    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0)
}

/// `checkLockfileFreshness` for a pnpm workspace, answering only "passes": every other outcome (an
/// uninitialised install, a lockfile newer than the install) is an error Node reports with a stack
/// trace, and goes to Node.
pub(super) fn lockfile_is_fresh(root: &Path) -> bool {
    if OTHER_LOCKFILES.iter().any(|name| exists(&root.join(name))) {
        return false;
    }

    let lockfile = root.join("pnpm-lock.yaml");
    let copy = root.join("node_modules/.pnpm/lock.yaml");
    let markers = [root.join("node_modules/.modules.yaml"), copy.clone()];
    let freshest =
        markers.iter().filter(|marker| marker.exists()).filter_map(|marker| modified_ms(marker)).reduce(f64::max);

    let Some(freshest) = freshest else { return false };

    // Byte equality with the copy pnpm keeps proves the install matches, whatever the times say.
    if let (Ok(lock), Ok(installed)) = (fs::read(&lockfile), fs::read(&copy)) {
        if lock == installed {
            return true;
        }
    }

    let Some(lockfile_ms) = modified_ms(&lockfile) else { return false };

    // One millisecond of margin towards Node, which compares floating point times.
    lockfile_ms <= freshest + MTIME_SKEW_MS - 1.0
}

/// Whether Node's background sweep (`Cache.removeOldEntries`) would delete anything: a top-level entry
/// other than a dot file or the `v2` store whose modification time is older than the window. Node removes
/// them while it runs, so a run that skipped that would leave a different cache behind, and an expired
/// entry it looks up is a hit or a miss depending on a race.
pub(super) fn nothing_to_sweep(cache: &Path) -> bool {
    let Ok(entries) = fs::read_dir(cache) else { return false };
    let limit = DEFAULT_MAX_CACHE_AGE.saturating_sub(SWEEP_MARGIN);

    for entry in entries {
        let Ok(entry) = entry else { return false };
        if !is_sweep_candidate(&entry.file_name()) {
            continue;
        }

        // `stat` follows links, as Node's does; an entry that cannot be read is skipped by Node.
        let Ok(modified) = fs::metadata(entry.path()).and_then(|metadata| metadata.modified()) else { continue };

        if SystemTime::now().duration_since(modified).is_ok_and(|age| age > limit) {
            return false;
        }
    }

    true
}

/// What the process and the working directory settle before any workspace file is read.
pub(super) struct Gates {
    pub(super) look: Look,
    pub(super) arch: &'static str,
    pub(super) platform: &'static str,
    /// `process.version` of the launcher that started the binary. A start without one asks the Node it would
    /// delegate to, after the hits.
    pub(super) launcher_version: Option<String>,
    pub(super) root: PathBuf,
    pub(super) pins: Pins,
    pub(super) cache: PathBuf,
}

/// The checks `vis run` makes before it reads the workspace: the environment, a root with no config and no Deno file
/// at or above it, a fresh lockfile, no legacy task-runner directory or run history, and a cache directory that
/// exists. `None` means "Node answers".
pub(super) fn gates(args: &[String]) -> Option<Gates> {
    let look = environment_look(args)?;
    let (arch, platform) = node_environment()?;
    let launcher_version = match env::var_os("VIS_NODE_VERSION") {
        Some(_) => Some(launcher_node_version()?),
        None => None,
    };

    // The root is the working directory, with no config and no Deno file at or above it, in a CI context.
    if !native_context() {
        return None;
    }

    let root = env::current_dir().ok()?;

    if [".task-runner", ".task-runner-cache", ".vis/runs"].iter().any(|name| exists(&root.join(name)))
        || !lockfile_is_fresh(&root)
    {
        return None;
    }

    // The pins Node's toolchain preflight reads; the ones this module cannot decide send the run to Node.
    let pins = Pins::read(&root)?;

    // Windows is answered only where nothing is asked of a process. A pinned tool is found by splitting `PATH` on `:`
    // and by an executable bit, and Node's own version is asked of `node` the same way, which on Windows (a `;`
    // separated `PATH`, `.cmd` shims, version managers) is not the lookup Node makes and has never been compared with
    // it. So a workspace with a pin, and a start without the launcher (which supplies Node's version), stay in Node.
    if cfg!(windows) && (!pins.is_empty() || launcher_version.is_none()) {
        return None;
    }

    let cache = default_task_cache_directory(&root)?;

    // No cache directory means no hit; Node creates it.
    if !cache.is_dir() {
        return None;
    }

    Some(Gates { look, arch, platform, launcher_version, root, pins, cache })
}
