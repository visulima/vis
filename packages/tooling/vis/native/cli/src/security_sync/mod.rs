//! `vis security sync [--skip-allow-builds] [--skip-min-release-age]` — the native port of
//! `src/commands/security/sync.ts` for a pnpm workspace: push `security.policies.installScripts.allow` and
//! `security.policies.firstSeen` of `vis.config` into `pnpm-workspace.yaml` and `package.json`.
//!
//! The command makes no request. It reads the `security` block as data (the reader of `security list`, see
//! [`crate::security_list::sync_input`]), rewrites the two files the way Node's `writeFileSync` does (see [`stage`]) and prints
//! its actions as pail blocks. The binary answers only the context it can prove, like `security list`: a unix CI run
//! off a terminal at the root of a pnpm workspace, pail's layout decided by the environment, and every message on one line.
//!
//! Everything else goes to Node before anything is printed or written:
//!
//! - any argument but the two skip flags, each at most once;
//! - another package manager (the other branches of `native-config-sync.ts` and `min-release-age.ts` are not ported);
//! - a config Node must evaluate or reads differently, an `allow` value that is truthy but not `true`, and a name
//!   or file the text edits do not reproduce (see [`pnpm`]);
//! - a failure to stage the files, or to replace the first one: no target is renamed before all temporary files exist,
//!   so the files are still untouched.

pub(crate) mod pnpm;
pub(crate) mod stage;
mod text;

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use vis_core::detect::detect_package_manager;

use crate::node_context::{any_ancestor_has, ci_root_context, DENO_FILES};
use crate::output::Output;
use crate::pail::{Layout, Level};
use crate::security_list::sync_input;

use pnpm::{plan, Settings, Skips};

/// Answers `vis security sync` natively or hands the whole invocation to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok(output) => output.emit("security"),
        Err(reason) => crate::process::delegate_because(&reason, raw_args),
    }
}

fn parse(args: &[String]) -> Option<Skips> {
    let flags = args.strip_prefix(&["security".to_owned(), "sync".to_owned()])?;
    let mut skips = Skips { allow_builds: false, min_release_age: false };

    for flag in flags {
        let slot = match flag.as_str() {
            "--skip-allow-builds" => &mut skips.allow_builds,
            "--skip-min-release-age" => &mut skips.min_release_age,
            _ => return None,
        };

        if std::mem::replace(slot, true) {
            return None;
        }
    }

    Some(skips)
}

/// The working directory when Node would reach the same answer from the workspace root.
fn context() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;

    (ci_root_context(&cwd) && !any_ancestor_has(&cwd, &DENO_FILES)).then_some(cwd)
}

fn answer(args: &[String]) -> Result<Output, String> {
    let skips = parse(args).ok_or("not `security sync` with only --skip-allow-builds and --skip-min-release-age")?;
    let layout = Layout::detect(args).ok_or("pail's layout is not decided by the environment")?;
    let cwd = context().ok_or("not a CI run at the root of a pnpm workspace")?;
    let cwd_text = cwd.to_str().ok_or("the working directory is not text")?;

    if detect_package_manager(cwd_text, None).name != "pnpm" {
        return Err("the package manager is not pnpm".to_owned());
    }

    let input = sync_input(&cwd).ok_or("the config needs Node")?;
    // The Node loader fills `security` with its defaults, so a config without the block (or none at all) syncs
    // the same empty settings as `security: {}`; the "no `security` block" warning of `sync.ts` is never reached.
    if !input.allow_all_true {
        return Err("an allow entry is truthy but not `true`".to_owned());
    }

    let settings = Settings { allow: input.allow, minutes: input.minutes, exclude: input.exclude };
    let plan = plan(&cwd, &settings, skips).ok_or("a file or name the text edits do not reproduce")?;
    let mut messages: Vec<(Level, String)> = Vec::new();

    if plan.actions.is_empty() {
        messages
            .push((Level::Success, "Nothing to sync \u{2014} vis.config and native PM config are aligned.".to_owned()));
    } else {
        messages.push((Level::Info, "Syncing vis.config security settings to pnpm native config\u{2026}\n".to_owned()));
        messages.extend(plan.actions.iter().map(|action| (Level::Success, format!("  {action}"))));
    }

    // Decided before the first write: a message that would wrap is Node's.
    if !messages.iter().all(|(_, message)| layout.fits_one_line(message)) {
        return Err("a message does not fit one line".to_owned());
    }

    if let Err(failure) = stage::write_all(&plan.files) {
        return match failure {
            stage::Failure::Staging(error) => Err(format!("cannot stage the files: {error}")),
            stage::Failure::Renaming { renamed: 0, error } => Err(format!("cannot replace the first file: {error}")),
            stage::Failure::Renaming { error, .. } => {
                crate::error::WrapperError::write("security", "the files", error).exit()
            }
        };
    }

    let mut output = Output::default();

    for (level, message) in &messages {
        output.say(layout, *level, message);
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn the_two_skip_flags_are_native_once_each_in_any_order() {
        assert!(parse(&args(&["security", "sync"])).is_some());

        let both = parse(&args(&["security", "sync", "--skip-min-release-age", "--skip-allow-builds"])).unwrap();

        assert!(both.allow_builds && both.min_release_age);
        assert!(parse(&args(&["security", "sync", "--skip-allow-builds"])).is_some_and(|skips| !skips.min_release_age));
    }

    #[test]
    fn every_other_shape_is_node_s() {
        for shape in [
            &["security", "sync", "--skip-allow-builds", "--skip-allow-builds"][..],
            &["security", "sync", "--skip-allow-builds=true"],
            &["security", "sync", "--no-skip-allow-builds"],
            &["security", "sync", "--cwd", "."],
            &["security", "sync", "extra"],
            &["security", "sync", "--"],
            &["security", "list"],
            &["security"],
        ] {
            assert!(parse(&args(shape)).is_none(), "{shape:?}");
        }
    }
}
