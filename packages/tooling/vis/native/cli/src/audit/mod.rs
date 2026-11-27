//! `vis audit --format json --policies none` — the native answer for a scan that finds nothing.
//!
//! The Node handler (`src/commands/audit/handler.ts`) reads the lockfile, asks OSV about every package and
//! prints a report. When OSV lists no finding and the policy engine is skipped, the report holds no result: the
//! packages scanned, the duplicate versions, and a row on stderr that says `none found`. This module prints
//! exactly that, on the client of [`crate::http`], and nothing else.
//!
//! `--policies none` is required because the engine is not skipped otherwise: the default config turns on the
//! `publisherChange` policy, which reads the registry's packument of every package and may report a block (and
//! exit 1) or write its packument cache. Nothing here reproduces that.
//!
//! Everything else goes to Node before a byte is printed, and Node then asks OSV itself:
//!
//! - every other output format, every flag but `--severity`, `--fail-on` and `--exit-code` (which change nothing
//!   when there is no finding), and every other package manager;
//! - an answer that lists a finding or that Node would read differently, and a request that fails (see [`osv`]);
//! - an environment where Node's `fetch` and this client would not reach the same server the same way (see
//!   [`crate::http::node_fetch`]), a `VIS_AUDIT_BACKEND` or a `VIS_INSTALLER` (the audit may then run `aube audit`; an
//!   `aube` on `PATH` alone does not make it), a `packageManager` pin (Node reads the manager from it), a
//!   `pnpm-workspace.yaml` with an `auditConfig` (Node prints a line about its ignored advisories), a `vis.config`,
//!   and a lockfile this crate does not read exactly;
//! - a lockfile with no package (Node says to install first), and a name or version outside printable ASCII
//!   (`localeCompare` and the escapes of the report are only reproduced for it);
//! - a package under `node_modules` that ships other packages inside itself (`bundleDependencies`) or a vendored tree
//!   (`dist/compiled`): Node scans the first and reports the unversioned ones of the second as not scanned, which this
//!   crate does not read (see [`bundled`]).
//!
//! The URL is `https://api.osv.dev/v1/querybatch`, fixed like Node's. The environment cannot change it, so the tests
//! reach the code behind the gates ([`scan_workspace`]) with the address of a stub instead.

mod bundled;
mod osv;
mod report;

#[cfg(test)]
mod tests;

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::process::exit;

use crate::collation::root_collation;
use crate::http::node_fetch;
use crate::js::iso_now;
use crate::node_context::context_decline;
use crate::output::{node_may_cut_short, write_streams};
use crate::pm_detect::ancestor_pins_package_manager;
use crate::pnpm_lock;
use crate::term::{piped_colour_level, Style};
use crate::text::{is_ascii_graphic, is_ascii_graphic_path};
use crate::vis_config::{self, ConfigState};
use report::Package;

/// The values `--severity` and `--fail-on` take; with no finding they change nothing, and Node reads any other
/// value (or none) its own way.
const LEVELS: [&str; 4] = ["low", "medium", "high", "critical"];

/// Whether `args` (the whole argv) are `audit --format json --policies none` with at most one each of
/// `--severity <level>`, `--fail-on <level>` and `--exit-code`. A value follows its flag as `--name value` or
/// `--name=value`.
fn parse(args: &[String]) -> bool {
    let mut rest = args.iter().skip(1);
    let (mut format, mut policies, mut severity, mut fail_on, mut exit_code) = (false, false, false, false, false);

    while let Some(argument) = rest.next() {
        let (name, inline) = match argument.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (argument.as_str(), None),
        };

        if name == "--exit-code" {
            if inline.is_some() || std::mem::replace(&mut exit_code, true) {
                return false;
            }

            continue;
        }

        let seen = match name {
            "--format" => &mut format,
            "--policies" => &mut policies,
            "--severity" => &mut severity,
            "--fail-on" => &mut fail_on,
            _ => return false,
        };
        let Some(value) = inline.or_else(|| rest.next().map(String::as_str)) else {
            return false;
        };
        let accepted = match name {
            "--format" => value == "json",
            "--policies" => value == "none",
            _ => LEVELS.contains(&value),
        };

        if !accepted || std::mem::replace(seen, true) {
            return false;
        }
    }

    format && policies
}

/// Answers `vis audit --format json` natively or hands the whole invocation to Node. A hand-off names its reason on
/// stderr when `VIS_DEBUG_DECLINE` is set (see `delegate_because`).
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok((stdout, stderr)) => {
            write_streams("audit", &stdout, &stderr);

            exit(0)
        }
        Err(reason) => crate::process::delegate_because(&reason, raw_args),
    }
}

/// The lockfile's packages, in the order Node lists them (a name and version listed twice counts once), or the reason
/// this crate cannot read them exactly.
fn read_packages(root: &Path) -> Result<Vec<pnpm_lock::Entry>, String> {
    let bytes =
        fs::read(root.join("pnpm-lock.yaml")).map_err(|error| format!("pnpm-lock.yaml cannot be read: {error}"))?;
    let entries = pnpm_lock::parse(&bytes).ok_or("pnpm-lock.yaml is not text this crate reads exactly")?;

    if entries.is_empty() {
        return Err("the lockfile lists no package (Node says to install first)".to_owned());
    }

    if !entries.iter().all(|entry| is_ascii_graphic(&entry.name) && is_ascii_graphic(&entry.version)) {
        return Err("a package name or version is not printable ASCII".to_owned());
    }

    Ok(entries)
}

/// Why Node would not print the same for this directory and environment, or `None` when it would.
fn environment_decline(cwd: &Path) -> Option<&'static str> {
    [
        (!root_collation(), "a locale with its own collation is set"),
        (!node_fetch::network_environment_is_plain(), "a proxy, CA or Node option is set in the environment"),
        (
            env::var_os("VIS_AUDIT_BACKEND").is_some() || env::var_os("VIS_INSTALLER").is_some(),
            "the audit backend or installer is chosen by the environment",
        ),
        (!is_ascii_graphic_path(cwd), "the working directory is not printable ASCII"),
        (ancestor_pins_package_manager(cwd), "a package.json pins the package manager"),
        (vis_config::read(cwd) != ConfigState::Absent, "a vis config applies"),
        (
            !fs::read_to_string(cwd.join("pnpm-workspace.yaml")).is_ok_and(|text| !text.contains("auditConfig")),
            "pnpm-workspace.yaml cannot be read, or holds an auditConfig (Node prints a line about it)",
        ),
    ]
    .into_iter()
    .find_map(|(declined, reason)| declined.then_some(reason))
}

/// What a clean run prints on stdout and stderr, or the reason it is Node's.
fn answer(args: &[String]) -> Result<(String, String), String> {
    if !parse(args) {
        return Err("not `audit --format json` with the flags it takes".to_owned());
    }

    if let Some(reason) = context_decline() {
        return Err(reason.to_owned());
    }

    let cwd = env::current_dir().map_err(|error| format!("the working directory cannot be read: {error}"))?;

    if let Some(reason) = environment_decline(&cwd) {
        return Err(reason.to_owned());
    }

    let colour = piped_colour_level(args).ok_or("the colour level cannot be told without Node")? > 0;
    let term_is_linux = env::var_os("TERM").is_some_and(|term| term == "linux");

    scan_workspace(&cwd, osv::URL, Style { colour }, term_is_linux, &iso_now())
}

/// The scan behind the gates: reads the lockfile of `root`, asks OSV at `url` and, when nothing is listed, returns the
/// report for stdout and the row for stderr.
fn scan_workspace(
    root: &Path,
    url: &str,
    style: Style,
    term_is_linux: bool,
    generated_at: &str,
) -> Result<(String, String), String> {
    let entries = read_packages(root)?;

    // Node scans the packages a package ships inside itself and names the vendored ones it cannot scan; this crate
    // reads the lockfile only, so it hands the run over before it asks OSV anything.
    if let Some(reason) = bundled::decline(root) {
        return Err(reason.to_owned());
    }

    let packages: Vec<Package<'_>> =
        entries.iter().map(|entry| Package { name: &entry.name, version: &entry.version }).collect();
    let took = osv::scan_is_clean(url, &packages)?;
    let workspace_root = root.to_str().ok_or("the working directory is not UTF-8")?;
    let stdout = report::clean_report(packages.len(), &report::duplicates(&packages), generated_at, workspace_root);

    if node_may_cut_short(stdout.len()) {
        return Err("the report is larger than Node reliably writes to a pipe".to_owned());
    }

    Ok((stdout, report::progress_row(style, took, term_is_linux)))
}
