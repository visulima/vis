//! `vis approve-builds --scan` — the native port of the report `src/commands/approve-builds/handler.ts` prints when vis scans
//! for build scripts itself instead of handing the run to `pnpm approve-builds`.
//!
//! Without `--scan` a pnpm workspace gets `pnpm approve-builds`, an interactive prompt, and that stays in Node. With `--scan` the
//! handler only reads: it triages the installed packages that declare lifecycle scripts against
//! `security.policies.installScripts.allow` (the triage of `security list`, see [`crate::security_list::triage`]) and prints
//! either "No unapproved build scripts found." or the list of the unapproved packages with the snippet to add them to `vis.config`.
//!
//! The binary answers the run in the context of `security list`: a unix CI run off a terminal at the root of a pnpm workspace, a
//! config that is a plain literal, and pail's layout decided by the environment. It hands to Node, before anything is printed:
//!
//! - every other argument, which includes `--write` (it edits `vis.config.ts`), `--sync-native` (it writes the package manager's
//!   config) and `--all` (it only matters to the delegated pnpm prompt), and the run without `--scan`;
//! - a report with stale allowlist entries or entries pinned to an outdated version: those blocks print `—` and `→`, which this
//!   crate does not measure the way pail does everywhere;
//! - a package name, version or hook outside printable ASCII, and everything `security list` hands over (a config Node must
//!   evaluate, a `node_modules` tree or `package.json` it cannot read exactly).
//!
//! Nothing is written, so a delegation never follows a change to a file.

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use vis_core::detect::detect_package_manager;

use crate::node_context::{any_ancestor_has, ci_root_context, DENO_FILES};
use crate::output::Output;
use crate::pail::{Layout, Level};
use crate::security_list::{triage, Triage};

/// Answers `vis approve-builds --scan` natively or hands the whole invocation to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok(output) => output.emit("approve-builds"),
        Err(reason) => crate::process::delegate_because(&reason, raw_args),
    }
}

/// The working directory when Node would reach the same answer from the workspace root.
fn context() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;

    (ci_root_context(&cwd) && !any_ancestor_has(&cwd, &DENO_FILES)).then_some(cwd)
}

/// The lines of the report, in the order the handler logs them: the level of each (warnings go to stderr) and its message.
fn lines(triage: &Triage) -> Vec<(Level, String)> {
    if triage.unapproved.is_empty() {
        return vec![(Level::Success, "No unapproved build scripts found.".to_owned())];
    }

    let count = triage.unapproved.len();
    let plural = if count == 1 { "" } else { "s" };
    let mut lines = vec![(Level::Warning, format!("Found {count} package{plural} with unapproved build scripts:\n"))];

    for entry in &triage.unapproved {
        lines.push((Level::Info, format!("  {} ({})", entry.name, entry.hooks.join(", "))));
    }

    let notice = |message: &str| (Level::Notice, message.to_owned());

    lines.extend([
        notice(""),
        notice("To approve these packages, add them to vis.config.ts:"),
        notice(""),
        notice("  security: {"),
        notice("    policies: {"),
        notice("      installScripts: {"),
        notice("        allow: {"),
    ]);

    for entry in &triage.unapproved {
        // `pinVersions && entry.version`: an empty version is falsy.
        let key = match &entry.version {
            Some(version) if triage.pin_versions && !version.is_empty() => format!("{}@{version}", entry.name),
            _ => entry.name.clone(),
        };

        lines.push((Level::Notice, format!("          \"{key}\": true,")));
    }

    lines.extend([
        notice("        },"),
        notice("      },"),
        notice("    },"),
        notice("  },"),
        notice(""),
        notice("Or run 'pnpm approve-builds' to update pnpm-workspace.yaml directly."),
    ]);

    lines
}

fn answer(args: &[String]) -> Result<Output, String> {
    if args != ["approve-builds", "--scan"] {
        return Err("not `approve-builds --scan`".to_owned());
    }

    let layout = Layout::detect(args).ok_or("pail's layout is not decided by the environment")?;
    let cwd = context().ok_or("not a CI run at the root of a pnpm workspace")?;
    let cwd_text = cwd.to_str().ok_or("the working directory is not text")?;

    if detect_package_manager(cwd_text, None).name != "pnpm" {
        return Err("the package manager is not pnpm".to_owned());
    }

    let triage = triage(&cwd).ok_or("the config or the installed packages need Node")?;

    if triage.has_excess || triage.has_version_drift {
        return Err("the report has stale or outdated allowlist entries".to_owned());
    }

    let mut output = Output::default();

    for (level, message) in lines(&triage) {
        let block =
            layout.block_fitting(level, &message).ok_or("a message holds a character this crate does not measure")?;

        if level.to_stderr() {
            output.stderr.push_str(&block);
        } else {
            output.stdout.push_str(&block);
        }
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security_list::Unapproved;

    fn entry(name: &str, version: Option<&str>, hooks: &[&str]) -> Unapproved {
        Unapproved {
            name: name.to_owned(),
            version: version.map(str::to_owned),
            hooks: hooks.iter().map(|hook| (*hook).to_owned()).collect(),
        }
    }

    fn report(pin_versions: bool, unapproved: Vec<Unapproved>) -> Vec<(Level, String)> {
        lines(&Triage { unapproved, has_excess: false, has_version_drift: false, pin_versions })
    }

    #[test]
    fn nothing_unapproved_is_one_success_line() {
        assert_eq!(report(false, Vec::new()), [(Level::Success, "No unapproved build scripts found.".to_owned())]);
    }

    #[test]
    fn the_unapproved_packages_are_listed_with_the_snippet_to_approve_them() {
        let lines = report(
            false,
            vec![entry("esbuild", Some("0.21.0"), &["postinstall"]), entry("sharp", None, &["install", "postinstall"])],
        );
        let messages: Vec<&str> = lines.iter().map(|(_, message)| message.as_str()).collect();

        assert_eq!(lines[0], (Level::Warning, "Found 2 packages with unapproved build scripts:\n".to_owned()));
        assert_eq!(&messages[1..3], ["  esbuild (postinstall)", "  sharp (install, postinstall)"]);
        assert!(messages.contains(&"          \"esbuild\": true,"));
        assert!(messages.contains(&"          \"sharp\": true,"));
        assert_eq!(messages.last(), Some(&"Or run 'pnpm approve-builds' to update pnpm-workspace.yaml directly."));
        assert_eq!(
            report(false, vec![entry("a", None, &["install"])])[0].1,
            "Found 1 package with unapproved build scripts:\n"
        );
    }

    #[test]
    fn pinned_versions_name_the_version_in_the_snippet() {
        let lines = report(
            true,
            vec![
                entry("esbuild", Some("0.21.0"), &["postinstall"]),
                entry("sharp", Some(""), &["install"]),
                entry("x", None, &["install"]),
            ],
        );
        let messages: Vec<&str> = lines.iter().map(|(_, message)| message.as_str()).collect();

        assert!(messages.contains(&"          \"esbuild@0.21.0\": true,"));
        assert!(messages.contains(&"          \"sharp\": true,"));
        assert!(messages.contains(&"          \"x\": true,"));
    }

    #[test]
    fn only_the_scan_shape_is_native() {
        for shape in [
            &["approve-builds"][..],
            &["approve-builds", "--all"],
            &["approve-builds", "--scan", "--write"],
            &["approve-builds", "--scan", "--sync-native"],
            &["approve-builds", "--scan", "--all"],
            &["approve-builds", "--scan", "--scan"],
            &["approve-builds", "--scan=true"],
            &["approve-builds", "--no-scan"],
            &["approve-builds", "extra", "--scan"],
        ] {
            let args: Vec<String> = shape.iter().map(|word| (*word).to_owned()).collect();

            assert!(answer(&args).is_err(), "{shape:?}");
        }
    }
}
