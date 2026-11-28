//! `vis check` (and its alias `c`): the outdated-dependency check, answered natively where the answer is Node's byte
//! for byte, handed to Node before anything is printed or written where it is not.
//!
//! The Node handler (`src/commands/check/handler.ts`) reads the dependency ranges of the workspace, asks the registry
//! for every package name once, picks the target version of each range, asks OSV about the versions in use, and prints
//! the entries as a table, a JSON document or minimal lines, ending with status 1 under `--exit-code` when any is
//! outdated. It keeps the answer of a run for a minute in `node_modules/.cache/vis/outdated-cache.json`. This module
//! does the same in a CI context off a terminal at the root of a workspace (the context `vis add` answers in), for
//! these shapes:
//!
//! - flags: `--format table|json|minimal`, `--target`, `--include`, `--exclude`, `--dev`, `--prod`, `--peer`,
//!   `--prerelease`, `--exit-code`, `--no-security` and package patterns (see [`args`]);
//! - a workspace whose dependencies are plain version ranges in `package.json` files, with no package manager catalogs
//!   (see [`catalogs`]), and a config without an `update`, `ai`, `plugins` or any key the other native commands leave
//!   to Node;
//! - registries read from `.npmrc` with no credential and no `${VAR}` (see [`npmrc`]), reached by plain `http(s)` URLs
//!   in an environment with no proxy, CA file or Node option;
//! - the OSV query of a run without `--no-security`, answered only when OSV lists nothing: what it lists is printed by
//!   Node, which asks again.
//!
//! The run is computed whole before a byte is printed, so every reason to hand it over (a redirect, a version this
//! crate orders differently, a wide table, a finding) still can. Everything else is Node's, which also prints the
//! errors: an unknown target, `--dev` with `--prod`, an unreadable manifest.

mod args;
mod cache;
mod catalogs;
mod npmrc;
mod outdated;
mod registry;
mod render;
mod version;

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::process::exit;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::audit::report::Package;
use crate::http::node_fetch;
use crate::output::{node_may_cut_short, write_streams};
use crate::pm_run::{setup_allowing, Root};
use crate::vis_config::{self, ConfigState};

use args::{Flags, Format};
use catalogs::Fields;
use outdated::{Outdated, Rules};
use version::Target;

/// What a run prints and the status it ends with.
struct Outcome {
    stdout: String,
    stderr: String,
    status: i32,
}

/// Answers `vis check` natively or hands the whole invocation to Node. A hand-off names its reason on stderr when
/// `VIS_DEBUG_DECLINE` is set (see `delegate_because`).
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    match answer(args, raw) {
        Ok(outcome) => {
            write_streams("check", &outcome.stdout, &outcome.stderr);

            exit(outcome.status)
        }
        Err(reason) => crate::process::delegate_because(&reason, raw),
    }
}

/// Config keys that change what the command computes, beyond the ones `requires_node` already hands over.
const CONFIG_KEYS: [&str; 3] = ["update", "ai", "plugins"];

/// Whether the environment and the config leave the run to this port; the reason when they do not.
fn context(args: &[String], raw: &[OsString]) -> Result<std::path::PathBuf, String> {
    let setup =
        setup_allowing(args, raw, &[]).ok_or("not a CI run off a terminal at a workspace root this crate reads")?;

    if setup.root != Root::Here {
        return Err("the working directory is not the workspace root".to_owned());
    }

    // The tables and the summary are only known to match Node's where no colour is on and `TERM` leaves the terminal unknown.
    let plain_term = env::var("TERM").map_or(true, |term| {
        let term = term.to_lowercase();

        term.contains("dumb") || term.contains("mono")
    });

    if setup.layout.colour || !plain_term {
        return Err("a colour environment this port does not reproduce".to_owned());
    }

    if !node_fetch::network_environment_is_plain() {
        return Err("a proxy, CA or Node option is set in the environment".to_owned());
    }

    if let ConfigState::Static(config) = vis_config::read(&setup.cwd) {
        if CONFIG_KEYS.iter().any(|key| config.get(*key).is_some()) {
            return Err("the config sets keys the command reads".to_owned());
        }
    }

    Ok(setup.cwd)
}

fn now_ms() -> Result<i64, String> {
    let elapsed =
        SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| format!("the clock is before 1970: {error}"))?;

    i64::try_from(elapsed.as_millis()).map_err(|_| "the clock is out of range".to_owned())
}

/// Asks OSV about the versions in use, as `enrichWithSecurity` does, and passes only when it lists nothing.
fn scan_is_clean(entries: &[outdated::Entry]) -> Result<(), String> {
    let mut seen = HashSet::new();
    let mut versions: Vec<(&str, String)> = Vec::new();

    for entry in entries {
        if let Some(version) = outdated::advisory_version(&entry.range) {
            if seen.insert(format!("{}@{version}", entry.package)) {
                versions.push((&entry.package, version));
            }
        }
    }

    let packages: Vec<Package<'_>> =
        versions.iter().map(|(name, version)| Package { name, version: version.as_str() }).collect();

    if packages.is_empty() {
        return Ok(());
    }

    crate::audit::osv::scan_is_clean(crate::audit::osv::URL, &packages).map(|_| ())
}

/// The names to ask the registry for, once each, in the order the entries name them.
fn unique_packages(entries: &[outdated::Entry]) -> Vec<String> {
    let mut seen = HashSet::new();

    entries.iter().filter(|entry| seen.insert(entry.package.as_str())).map(|entry| entry.package.clone()).collect()
}

/// The outcome of a run, or the reason it is Node's.
fn answer(args: &[String], raw: &[OsString]) -> Result<Outcome, String> {
    let flags = args::parse(args).ok_or("an argument this port does not answer")?;
    let root = context(args, raw)?;

    answer_in(&root, &flags)
}

fn answer_in(root: &std::path::Path, flags: &Flags) -> Result<Outcome, String> {
    let catalogs = catalogs::read(root, Fields { dev: flags.dev, peer: flags.peer, prod: flags.prod })?;

    if catalogs.is_empty() {
        return Ok(Outcome { stdout: "No catalogs found.\n".to_owned(), stderr: String::new(), status: 0 });
    }

    let target = flags.target.unwrap_or(Target::Minor);
    let include: Vec<String> = flags.include.iter().chain(&flags.packages).cloned().collect();
    let rules = Rules { exclude: &flags.exclude, include: &include };
    let entries = outdated::collect_entries(&catalogs, &rules);
    let packages = unique_packages(&entries);
    let security = !flags.no_security;
    let key = cache::Key {
        exclude: &flags.exclude,
        include: &include,
        include_prerelease: flags.prerelease,
        security,
        target: target.label(),
    };
    let hash = cache::hash(&catalogs, &key);
    let file = cache::file(root)?;
    let now = now_ms()?;
    let total: usize = catalogs.iter().map(|catalog| catalog.dependencies.len()).sum();
    let mut stdout = format!("Checking {total} catalog dependencies against npm registry...\n\n");

    // What the cache is to hold once the run has answered: written last, because every reason to hand the run to Node
    // (a finding, a table that does not fit) must come before the first file is written.
    let mut pending: Option<String> = None;

    let (failed, outdated): (Vec<String>, Vec<Outdated>) = match cache::read(&file, &hash, now)? {
        Some(cached) => (cached.failed, cached.outdated),
        None => {
            let fetched = registry::fetch_all(&packages, &npmrc::load(root)?)?;

            for completed in 1..=packages.len() {
                stdout.push_str(&format!("Checking {completed}/{} dependencies...\n", packages.len()));
            }

            let outdated = outdated::build(&entries, &fetched.versions, target, flags.prerelease);
            let filtered =
                outdated::filtered_by_target(&entries, &fetched.versions, &outdated, target, flags.prerelease);

            if security && !outdated.is_empty() {
                scan_is_clean(&entries)?;
            }

            // Node stamps the entry when it writes it, after the requests.
            pending = Some(cache::document(&hash, packages.len(), &fetched.failed, &filtered, &outdated, now_ms()?));

            (fetched.failed, outdated)
        }
    };

    let outcome = print(flags, stdout, &failed, &outdated)?;

    if node_may_cut_short(outcome.stdout.len()) {
        return Err("the output is larger than Node reliably writes to a pipe".to_owned());
    }

    if let Some(text) = pending {
        cache::write(&file, &text);
    }

    Ok(outcome)
}

/// What the command prints for the result: the failures, then the list in the format asked for.
fn print(flags: &Flags, mut stdout: String, failed: &[String], outdated: &[Outdated]) -> Result<Outcome, String> {
    let mut stderr = String::new();

    if !failed.is_empty() {
        stderr.push_str(&format!("Failed to fetch: {}\n", failed.join(", ")));
    }

    if outdated.is_empty() {
        stdout.push_str("All catalog dependencies are up to date.\n");

        return Ok(Outcome { stdout, stderr, status: 0 });
    }

    match flags.format.unwrap_or(Format::Table) {
        Format::Json => {
            stdout.push_str(&render::json_document(failed, outdated));
            stdout.push('\n');
        }
        Format::Minimal => {
            stdout.push_str(&render::minimal(outdated));
            stdout.push('\n');
        }
        Format::Table => {
            stdout.push_str(&render::table(outdated).ok_or("a table this port does not draw the way Node does")?)
        }
    }

    Ok(Outcome { stdout, stderr, status: i32::from(flags.exit_code) })
}
