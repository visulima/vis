use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::process::Command;

/// Allowed binaries that can be executed via NAPI.
/// Intentionally excludes `sh`/`bash` to prevent arbitrary command execution.
const ALLOWED_BINS: &[&str] =
    &["pnpm", "npm", "npx", "yarn", "bun", "bunx", "aube", "corepack", "node", "echo", "where", "which"];

fn validate_bin(bin: &str) -> napi::Result<()> {
    let name = std::path::Path::new(bin).file_name().and_then(|n| n.to_str()).unwrap_or(bin);

    if ALLOWED_BINS.contains(&name) {
        Ok(())
    } else {
        Err(Error::new(
            Status::InvalidArg,
            format!("Disallowed binary: '{}'. Allowed: {}", bin, ALLOWED_BINS.join(", ")),
        ))
    }
}

/// Executes a package manager command with inherited stdio (interactive).
/// Returns exit code. Throws JS error for disallowed binaries or spawn failures.
#[napi(catch_unwind)]
pub fn exec_pm_command_interactive(bin: String, args: Vec<String>, cwd: String) -> napi::Result<i32> {
    validate_bin(&bin)?;

    let status = Command::new(&bin)
        .args(&args)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to execute '{}': {}", bin, e)))?;

    Ok(status.code().unwrap_or(1))
}

/// Finds the full path to a binary using `which`-style lookup.
/// Returns None if not found.
#[napi(catch_unwind)]
pub fn which_bin(name: String) -> Option<String> {
    if name.is_empty() {
        return None;
    }

    which::which(&name).ok().map(|p| p.to_string_lossy().into_owned())
}
