//! Native `vis pm <subcommand> [args...]` — package-manager utility passthrough
//! (cache, publish, audit, list, view, config, …).
//!
//! Matches the Node handler (src/commands/pm/handler.ts): detect the PM, map the
//! subcommand via `resolve_pm_command`, and exec it. `pm` defines no options, so
//! everything after the subcommand is forwarded to the PM (the Node handler was
//! fixed to do the same instead of dropping flags).
//!
//! Node does three things first that this path does not reproduce, so each of them hands the call to
//! Node before anything is printed: the cross-manager dispatch of `dispatchSubcommand`
//! (`src/pm/pm-subcommand-dispatch.ts`: `yarn npm publish`, the pnpm 11 removals, the subcommands a
//! manager lacks), a working directory that is not the workspace root (Node runs the manager there), and
//! the installer choice (`VIS_INSTALLER`, `aube` on `PATH`, a config pin, Corepack).

use std::env;
use std::ffi::OsString;
use std::path::Path;

use vis_core::detect::detect_package_manager;
use vis_core::resolve::resolve_pm_command;

use crate::error::{self, WrapperError};
use crate::pm_detect::{corepack_applies, installer_selected_by_environment};
use crate::pm_family::uses_global_option;
use crate::pm_run::run_resolved;

const USAGE: &str = "No subcommand specified. Available: cache, publish, audit, list, view, config, whoami, login, logout, pack, owner, dist-tag, search, fund, ping, token, deprecate, rebuild, prune, plugin";

/// The subcommands `dispatchSubcommand` knows. For a manager that models them like the others it
/// answers `passthrough`, but which managers and versions that holds for is Node's to decide.
const DISPATCHED: [&str; 15] = [
    "audit", "config", "dist-tag", "login", "logout", "owner", "ping", "pkg", "plugin", "prune", "publish", "rebuild",
    "search", "token", "whoami",
];

/// Entry point. `args` is the full invocation including the leading `pm`, `raw_args` the same argv as
/// the OS gave it (what a hand-off to Node replays). Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    error::finish(try_run(args, raw_args))
}

/// Whether Node, not this path, must run the command: the subcommand is in Node's dispatch table, the
/// working directory is not the workspace root Node runs the manager in, or Node's installer choice may
/// differ from the lockfile detection used here.
fn left_to_node(args: &[String], subcommand: &str, cwd: &Path) -> bool {
    let config = crate::vis_config::read(cwd);
    let config_decides_installer = config != crate::vis_config::ConfigState::Absent
        && (crate::vis_config::requires_node(&config) || crate::vis_config::native_backend_pin(&config).is_some());

    DISPATCHED.contains(&subcommand)
        || !crate::node_context::native_root_is_cwd(cwd, env::var_os("VIS_MONOREPO_ROOT").as_deref())
        || installer_selected_by_environment()
        || uses_global_option(args)
        || config_decides_installer
        || corepack_applies(cwd)
}

/// Runs the subcommand and returns the exit status to adopt, or the failure to report.
fn try_run(args: &[String], raw_args: &[OsString]) -> Result<i32, WrapperError> {
    let Some(subcommand) = args.get(1).map(String::as_str) else {
        return Err(WrapperError::usage("pm", USAGE));
    };

    let extra = args[2..].to_vec();

    let cwd = env::current_dir().unwrap_or_else(|_| ".".into());

    if left_to_node(args, subcommand, &cwd) {
        crate::process::delegate(raw_args);
    }

    let cwd = cwd.to_string_lossy().into_owned();
    let detected = detect_package_manager(&cwd, None);

    let resolved = resolve_pm_command(&detected.name, &detected.version.unwrap_or_default(), subcommand, extra)
        .map_err(|message| WrapperError::usage("pm", message))?;

    run_resolved("pm", &resolved, Path::new(&cwd))
}

#[cfg(test)]
mod tests {
    use super::DISPATCHED;

    /// The subcommands handed to Node are the `case` labels of Node's dispatch table.
    #[test]
    fn the_dispatch_list_matches_the_table_node_reads() {
        let table = include_str!("../../../src/pm/pm-subcommand-dispatch.ts");
        let mut cases: Vec<&str> =
            table.lines().filter_map(|line| line.trim().strip_prefix("case \"")?.split('"').next()).collect();

        cases.sort_unstable();

        let mut listed = DISPATCHED.to_vec();

        listed.sort_unstable();

        assert_eq!(listed, cases);
    }
}
