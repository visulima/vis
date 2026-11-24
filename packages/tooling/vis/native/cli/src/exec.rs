//! Native `vis exec <command> [args...]` — run a local `node_modules/.bin`
//! command via the project's package manager (no remote fallback).
//!
//! Matches the Node *lean* exec path (`src/cli-exec.ts` → `src/commands/exec`):
//! the runtime is resolved from `--runtime` / `VIS_RUNTIME` / lockfile detection,
//! and `vis.config.ts` is intentionally NOT read (same trade-off the lean path
//! documents). Flag surface mirrors `src/commands/exec/index.ts`.
//!
//! What Node does that this path does not reproduce goes to Node before anything is printed: a binary in
//! `node_modules/.bin` (Node runs it directly, `runLocalExec`), a runtime that is neither `node` nor
//! `bun` (Node's error text), and an installer chosen by `VIS_INSTALLER`, `aube` on `PATH` or Corepack.

use std::env;
use std::ffi::OsString;
use std::path::Path;

use vis_core::detect::detect_package_manager;
use vis_core::resolve::{resolve_exec, ExecOptions};

use crate::error::{self, WrapperError};
use crate::pm_run::run_resolved;

struct Parsed {
    runtime: Option<String>,
    opts: ExecOptions,
}

/// Entry point. `args` is the full invocation including the leading `exec`, `raw_args` the same argv as
/// the OS gave it (what a hand-off to Node replays). Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    error::finish(try_run(args, raw_args))
}

/// Whether `command` is in the `node_modules/.bin` of `cwd` or an ancestor, which is where Node's
/// `resolveLocalBin` looks (a name with a path separator is an explicit path and never matches).
fn has_local_bin(command: &str, cwd: &Path) -> bool {
    let extensions: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ".ps1", ""] } else { &[""] };

    !command.contains(['/', '\\'])
        && cwd.ancestors().any(|directory| {
            let bin = directory.join("node_modules").join(".bin");

            extensions.iter().any(|extension| bin.join(format!("{command}{extension}")).exists())
        })
}

/// Whether Node, not this path, must run the command. Node takes a local binary directly when the call
/// targets one package; it rejects a runtime that is neither node nor bun; and it picks the installer from
/// `VIS_INSTALLER`, `aube` on `PATH` and Corepack, where this path reads the lockfile.
fn left_to_node(parsed: &Parsed, cwd: &Path) -> bool {
    let opts = &parsed.opts;
    let single_package = !opts.recursive
        && !opts.workspace_root
        && !opts.parallel
        && !opts.reverse
        && !opts.shell_mode
        && opts.filter.is_empty();
    let unknown_runtime = crate::x::requested_runtime(parsed.runtime.as_deref())
        .is_some_and(|(_, runtime)| runtime != "node" && runtime != "bun");

    (single_package && has_local_bin(&opts.command, cwd))
        || unknown_runtime
        || env::var_os("VIS_INSTALLER").is_some()
        || crate::pm_detect::binary_on_path("aube")
        || crate::pm_detect::corepack_applies(cwd)
}

/// Runs the command and returns the exit status to adopt, or the failure to report.
fn try_run(args: &[String], raw_args: &[OsString]) -> Result<i32, WrapperError> {
    let parsed = parse(&args[1..]).map_err(|message| WrapperError::usage("exec", message))?;
    let opts = &parsed.opts;

    if opts.command.is_empty() {
        return Err(WrapperError::usage("exec", "No command specified. Usage: vis exec <command> [args...]"));
    }

    let directory = env::current_dir().unwrap_or_else(|_| ".".into());

    if left_to_node(&parsed, &directory) {
        crate::delegate(raw_args);
    }

    let Parsed { runtime, opts } = parsed;
    let cwd = directory.to_string_lossy().into_owned();
    let (pm, version) = resolve_pm(runtime.as_deref(), &cwd);

    let resolved = resolve_exec(&pm, &version, opts).map_err(|message| WrapperError::usage("exec", message))?;

    run_resolved("exec", &resolved, Path::new(&cwd))
}

/// Resolve the package manager + version to drive `resolve_exec`. A `bun` runtime
/// (flag or VIS_RUNTIME) forces bun; otherwise the PM is detected from the cwd.
fn resolve_pm(runtime: Option<&str>, cwd: &str) -> (String, String) {
    if crate::x::requested_runtime(runtime).is_some_and(|(_, runtime)| runtime == "bun") {
        return ("bun".to_owned(), String::new());
    }

    let detected = detect_package_manager(cwd, None);

    (detected.name, detected.version.unwrap_or_default())
}

/// Parse exec's flags. Mirrors cerebro's `stopAtFirstUnknown`: vis options are
/// consumed only until the first positional (the command) or a `--` separator;
/// everything from the command onward is forwarded verbatim to it.
fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut opts = ExecOptions::default();
    let mut runtime = None;
    let mut command_found = false;
    let mut index = 0;

    while index < args.len() {
        let argument = &args[index];

        if command_found {
            opts.args.push(argument.clone());
            index += 1;
            continue;
        }

        match argument.as_str() {
            "--" => {
                index += 1;

                if let Some(command) = args.get(index) {
                    opts.command = command.clone();
                    command_found = true;
                    index += 1;
                }

                continue;
            }
            "-c" | "--shell-mode" => opts.shell_mode = true,
            "-r" | "--recursive" => opts.recursive = true,
            "-w" | "--workspace-root" => opts.workspace_root = true,
            "--parallel" => opts.parallel = true,
            "--reverse" => opts.reverse = true,
            "-F" | "--filter" => {
                index += 1;
                opts.filter.push(args.get(index).ok_or("--filter requires a value")?.clone());
            }
            other if other.starts_with("--filter=") => opts.filter.push(other["--filter=".len()..].to_owned()),
            other if other.starts_with("--runtime=") => runtime = Some(other["--runtime=".len()..].to_owned()),
            "--runtime" => {
                index += 1;
                runtime = Some(args.get(index).ok_or("--runtime requires a value")?.clone());
            }
            // First positional (or any unknown token) is the command; cerebro
            // stops option parsing here and forwards the rest to it.
            other => {
                opts.command = other.to_owned();
                command_found = true;
            }
        }

        index += 1;
    }

    Ok(Parsed { opts, runtime })
}

#[cfg(test)]
mod tests {
    use super::{has_local_bin, parse};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn first_positional_is_the_command() {
        let parsed = parse(&args(&["eslint"])).unwrap();

        assert_eq!(parsed.opts.command, "eslint");
        assert!(parsed.opts.args.is_empty());
    }

    #[test]
    fn vis_flags_before_the_command_are_consumed() {
        let parsed = parse(&args(&["-r", "-w", "eslint"])).unwrap();

        assert!(parsed.opts.recursive);
        assert!(parsed.opts.workspace_root);
        assert_eq!(parsed.opts.command, "eslint");
    }

    #[test]
    fn filter_takes_a_value_in_both_forms() {
        let parsed = parse(&args(&["-F", "@scope/a", "--filter=@scope/b", "eslint"])).unwrap();

        assert_eq!(parsed.opts.filter, ["@scope/a", "@scope/b"]);
        assert_eq!(parsed.opts.command, "eslint");
    }

    #[test]
    fn double_dash_separates_the_command() {
        let parsed = parse(&args(&["-r", "--", "eslint", "."])).unwrap();

        assert!(parsed.opts.recursive);
        assert_eq!(parsed.opts.command, "eslint");
        assert_eq!(parsed.opts.args, ["."]);
    }

    #[test]
    fn runtime_flag_in_both_forms() {
        assert_eq!(parse(&args(&["--runtime", "bun", "x"])).unwrap().runtime.as_deref(), Some("bun"));
        assert_eq!(parse(&args(&["--runtime=bun", "x"])).unwrap().runtime.as_deref(), Some("bun"));
    }

    #[test]
    fn tokens_after_the_command_are_forwarded_verbatim() {
        // Tool flags after the command are forwarded to the tool. This matches
        // the fixed Node handler (verified empirically against cerebro), which
        // now forwards rawUnknown instead of dropping it.
        let parsed = parse(&args(&["eslint", "--fix", "src"])).unwrap();

        assert_eq!(parsed.opts.command, "eslint");
        assert_eq!(parsed.opts.args, ["--fix", "src"]);
    }

    #[test]
    fn a_local_bin_is_found_in_the_nearest_ancestor_and_never_by_path() {
        let root = std::env::temp_dir().join(format!("vis-exec-bin-{}", std::process::id()));
        let app = root.join("packages").join("app");

        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node_modules").join(".bin")).unwrap();
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(root.join("node_modules").join(".bin").join("eslint"), "").unwrap();

        assert!(has_local_bin("eslint", &app));
        assert!(!has_local_bin("prettier", &app));
        assert!(!has_local_bin("./node_modules/.bin/eslint", &app));
        assert!(!has_local_bin("../eslint", &app));

        let _ = std::fs::remove_dir_all(&root);
    }
}
