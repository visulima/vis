//! Native `vis pm <subcommand> [args...]` — package-manager utility passthrough
//! (cache, publish, audit, list, view, config, …).
//!
//! Matches the Node handler (src/commands/pm/handler.ts): detect the PM, map the
//! subcommand via `resolve_pm_command`, and exec it. `pm` defines no options, so
//! everything after the subcommand is forwarded to the PM (the Node handler was
//! fixed to do the same instead of dropping flags).

use std::env;
use std::process::Command;

use vis_core::detect::detect_package_manager;
use vis_core::resolve::resolve_pm_command;

use crate::error::{self, WrapperError};

const USAGE: &str = "No subcommand specified. Available: cache, publish, audit, list, view, config, whoami, login, logout, pack, owner, dist-tag, search, fund, ping, token, deprecate, rebuild, prune, plugin";

/// Entry point. `args` is everything after the `pm` subcommand. Never returns.
pub fn run(args: &[String]) -> ! {
    error::finish(try_run(args))
}

/// Runs the subcommand and returns the exit status to adopt, or the failure to report.
fn try_run(args: &[String]) -> Result<i32, WrapperError> {
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(WrapperError::usage("pm", USAGE));
    };

    let extra = if args.len() > 1 { args[1..].to_vec() } else { Vec::new() };

    let cwd = env::current_dir().map(|path| path.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".to_owned());
    let detected = detect_package_manager(&cwd, None);

    let resolved = resolve_pm_command(&detected.name, &detected.version.unwrap_or_default(), subcommand, extra)
        .map_err(|message| WrapperError::usage("pm", message))?;

    for warning in &resolved.warnings {
        eprintln!("vis pm: {warning}");
    }

    Command::new(&resolved.bin)
        .args(&resolved.args)
        .current_dir(&cwd)
        .status()
        .map(crate::forward_code)
        .map_err(|source| WrapperError::spawn("pm", &resolved.bin, source))
}
