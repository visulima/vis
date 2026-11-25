//! Package-manager command resolution. Each `resolve_*` maps a vis verb + the
//! detected PM/version + options to the concrete `{bin, args}` to spawn.
//!
//! This is the single implementation: the `vis` CLI binary calls it directly and
//! the napi addon's `pm_resolve.rs` wraps it (converting its JS option objects
//! into these types), so a fix to a flag mapping, warning, or PM version branch
//! lands in one place.

mod add;
mod dedupe;
mod dlx;
mod exec;
mod install;
mod link;
mod outdated;
mod pm_command;
mod remove;
mod why;

pub use add::{resolve_add, AddOptions};
pub use dedupe::resolve_dedupe;
pub use dlx::{resolve_dlx, DlxOptions};
pub use exec::{resolve_exec, ExecOptions};
pub use install::{resolve_install, InstallOptions};
pub use link::{resolve_link, resolve_unlink};
pub use outdated::{resolve_outdated, OutdatedOptions};
pub use pm_command::resolve_pm_command;
pub use remove::{resolve_remove, RemoveOptions};
pub use why::{resolve_why, WhyOptions};

/// The resolved command to spawn, plus any non-fatal warnings to surface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedCommand {
    pub bin: String,
    pub args: Vec<String>,
    pub warnings: Vec<String>,
}

/// Validates that the PM name is one of the supported values.
fn validate_pm(pm: &str) -> Result<(), String> {
    match pm {
        "pnpm" | "npm" | "yarn" | "bun" => Ok(()),
        _ => Err(format!("Unsupported package manager: '{pm}'. Supported: pnpm, npm, yarn, bun")),
    }
}

/// Appends each flag whose option is set, in the order listed.
fn push_flags(args: &mut Vec<String>, flags: &[(bool, &str)]) {
    args.extend(flags.iter().filter(|(set, _)| *set).map(|(_, flag)| (*flag).to_owned()));
}

/// Appends `flag value` for each of the values, as repeated `--filter a --filter b`.
fn push_each(args: &mut Vec<String>, flag: &str, values: &[String]) {
    for value in values {
        args.push(flag.to_owned());
        args.push(value.clone());
    }
}

/// Scope a Yarn command to one workspace: `yarn workspace <name> <cmd>`. `yarn
/// workspace` targets a single workspace, so more than one filter is refused
/// instead of silently running against only the first.
fn yarn_workspace_prefix(filter: &[String], args: &mut Vec<String>) -> Result<(), String> {
    match filter {
        [] => {}
        [workspace] => {
            args.push("workspace".into());
            args.push(workspace.clone());
        }
        _ => return Err("yarn `workspace` supports a single --filter workspace".into()),
    }

    Ok(())
}

/// Scope a Yarn Berry command to several workspaces: `yarn workspaces foreach
/// --all [--include <name>]... <cmd>`. With no filter it runs in every workspace.
fn yarn_foreach_prefix(filter: &[String], args: &mut Vec<String>) {
    args.push("workspaces".into());
    args.push("foreach".into());
    args.push("--all".into());

    for f in filter {
        args.push("--include".into());
        args.push(f.clone());
    }
}

#[cfg(test)]
fn argv(list: &[&str]) -> Vec<String> {
    list.iter().map(|item| (*item).to_owned()).collect()
}
