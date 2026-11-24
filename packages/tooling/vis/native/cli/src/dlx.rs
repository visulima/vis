//! `vis dlx <package> [args...]` — the native fast path for the runs where Node's first-run gate stays out.
//!
//! The Node handler (`src/commands/dlx/handler.ts`, run by the lean entry `cli-exec.ts`: no config, no
//! workspace root, no plugins) shows a first-run info panel for a registry package before it runs the
//! package manager's `dlx`. The gate skips itself in CI, without a terminal and with `--yes`, and for a
//! package it has seen; otherwise it fetches package metadata and may prompt. It decides that at run time
//! from the terminal, the CI variables and a state file in the home directory, none of which this module
//! reads. So it answers only the runs where the gate does nothing whatever those are, and hands everything
//! else to Node before any output:
//!
//! - the gate is off: `--no-info` or a truthy `VIS_DLX_NO_INFO`, or none of the packages it would vet is a
//!   registry spec (shell mode vets only the `-p` packages; paths, URLs and aliases are skipped);
//! - flags: `--no-info`, `-y`/`--yes`, `--offline`, `-s`/`--silent`, `-c`/`--shell-mode`, each at most once, and
//!   `-p`/`--package <word>` directly followed by another flag (the option takes every word up to the next
//!   flag, so a package or argument after it would be swallowed). The other words are the package and its
//!   arguments, none starting with a dash: Node drops an unknown flag and has a `--` of its own;
//! - installer: what the project's lockfiles say, with nothing in the environment or a `packageManager` pin
//!   that Node reads (`VIS_INSTALLER`, `VIS_RUNTIME`, `aube` on `PATH`, Corepack).
//!
//! Every reason to delegate is decided before the package manager starts. A manager that is not on `PATH`,
//! or that warns (yarn berry with shell mode or `--offline`, bun with `--offline`), is Node's to report.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};

use vis_core::detect::{detect_package_manager, DetectPackageManagerOptions};
use vis_core::resolve::{resolve_dlx, DlxOptions, ResolvedCommand};

/// What the command line asked for.
#[derive(Debug, Default, PartialEq, Eq)]
struct Flags {
    no_info: bool,
    offline: bool,
    /// The `-p` packages, in order.
    packages: Vec<String>,
    shell_mode: bool,
    silent: bool,
    /// The package (or, in shell mode, the command), then its arguments.
    words: Vec<String>,
}

/// Answer `vis dlx` natively, or delegate to Node. Never returns.
///
/// `raw` is the untouched argv, handed to Node as it arrived; `args` is the lossy view used for parsing.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let Some((resolved, cwd)) = plan(args, raw) else {
        crate::delegate(raw);
    };

    let mut command = Command::new(&resolved.bin);

    command
        .args(&resolved.args)
        .current_dir(&cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    node_startup_environment(&mut command, None);

    match command.status() {
        // Node reports a child without an exit code (a signal) as 1.
        Ok(status) => exit(crate::node_exit_code(status)),
        // Found on `PATH` but could not start; nothing has been printed, so Node reports it.
        Err(_) => crate::delegate(raw),
    }
}

/// What Node's own startup adds to the environment of everything it runs: cerebro's default output level and
/// the monorepo root it found, if any. (Any `CEREBRO_*` of the caller's has kept the command in Node.) The
/// launcher's own variables (`VIS_NODE`, `VIS_FALLBACK_ENTRY`, `VIS_VERSION`, `VIS_LAUNCHER`) stay in the
/// environment, as for every native command that runs a child.
pub(crate) fn node_startup_environment(command: &mut Command, root: Option<&Path>) {
    command.env("CEREBRO_OUTPUT_LEVEL", "32");

    if let Some(root) = root {
        command.env("VIS_MONOREPO_ROOT", root);
    }
}

/// The command to run and where, or `None` to delegate.
fn plan(args: &[String], raw: &[OsString]) -> Option<(ResolvedCommand, PathBuf)> {
    // Windows keeps the Node path: it runs the package manager through a shell there.
    if !cfg!(unix) || raw.iter().any(|argument| argument.to_str().is_none()) {
        return None;
    }

    let flags = parse(args)?;

    if !gate_is_off(&flags)? {
        return None;
    }

    // The Node runtime warns on stderr about conflicting colour variables, with its process id in the text, and
    // `DEBUG` and `CEREBRO_*` change cerebro's output (a debug trace on stdout) and the environment the manager gets.
    if crate::term::node_warns_about_colour()
        || env::var_os("DEBUG").is_some()
        || env::vars_os().any(|(name, _)| name.to_string_lossy().starts_with("CEREBRO_"))
        || crate::pm_family::installer_selected_by_environment()
    {
        return None;
    }

    let cwd = env::current_dir().ok()?;

    // Node runs the installer a `packageManager` pin names through Corepack, which it reads from any ancestor.
    if crate::pm_family::ancestor_pins_package_manager(&cwd) {
        return None;
    }

    let (manager, version) = installer(&cwd);
    let (package, rest) = flags.words.split_first()?;
    let mut resolved = resolve_dlx(
        &manager,
        &version,
        DlxOptions {
            additional_packages: flags.packages.clone(),
            args: rest.to_vec(),
            package: package.clone(),
            shell_mode: flags.shell_mode,
            silent: flags.silent,
        },
    )
    .ok()?;

    if flags.offline {
        apply_offline(&mut resolved, &manager);
    }

    // A warning is worded and coloured by Node's logger.
    if !resolved.warnings.is_empty() {
        return None;
    }

    // A manager that is not on `PATH` fails in Node with its own report.
    crate::add::on_path(&resolved.bin).then_some((resolved, cwd))
}

/// The manager Node's `resolveInstaller` picks for the lean entry, which reads no config: a bun lockfile
/// as the nearest one makes the runtime bun and so the manager bun; otherwise the detection of the
/// lockfiles. The version is unknown (`latest`) wherever no `packageManager` pin or classic `yarn.lock` names one.
fn installer(cwd: &Path) -> (String, String) {
    if nearest_lockfile_is_bun(cwd) {
        return ("bun".to_owned(), "latest".to_owned());
    }

    let detected = detect_package_manager(&cwd.to_string_lossy(), Some(DetectPackageManagerOptions::default()));

    (detected.name, detected.version.filter(|version| !version.is_empty()).unwrap_or_else(|| "latest".to_owned()))
}

/// `detectFromLockfile` of `resolveRuntime`: the nearest directory with a lockfile of either runtime decides,
/// and a bun lockfile there wins.
fn nearest_lockfile_is_bun(cwd: &Path) -> bool {
    const LOCKFILES: [&str; 6] =
        ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json"];

    cwd.ancestors()
        .find_map(|directory| LOCKFILES.iter().find(|name| directory.join(name).exists()))
        .is_some_and(|name| name.starts_with("bun.lock"))
}

/// `applyDlxOffline`: the manager's own offline flag right after the `dlx` word. A manager with no such flag
/// gets a warning in Node, which the caller leaves to it.
fn apply_offline(resolved: &mut ResolvedCommand, manager: &str) {
    if resolved.args.iter().any(|argument| argument == "--offline" || argument == "--cached-only") {
        return;
    }

    match manager {
        "pnpm" | "npm" => resolved.args.insert(1, "--offline".to_owned()),
        // bun and yarn berry (the version is never a v1 here): no flag, only a warning.
        _ => resolved.warnings.push("no offline mode".to_owned()),
    }
}

/// Whether Node's first-run gate does nothing for these flags: it is switched off, or no package it would
/// vet is a registry spec. `None` when the environment variable is not plain ASCII.
fn gate_is_off(flags: &Flags) -> Option<bool> {
    let no_info = flags.no_info
        || match env::var_os("VIS_DLX_NO_INFO") {
            None => false,
            // JavaScript's `trim` and Rust's differ on some Unicode space, so only ASCII is decided here.
            Some(value) => is_truthy(value.to_str().filter(|text| text.is_ascii())?),
        };

    // Shell mode vets the `-p` packages only; otherwise the positional comes first.
    let mut targets = flags.words.first().filter(|_| !flags.shell_mode).into_iter().chain(&flags.packages);

    Some(no_info || !targets.any(|target| is_registry_spec(target)))
}

/// `isTruthyEnv`: on unless empty, `0`, `false` or `no`, ignoring case and surrounding space.
fn is_truthy(value: &str) -> bool {
    !matches!(value.trim().to_lowercase().as_str(), "" | "0" | "false" | "no")
}

/// `isRegistrySpec`: a bare registry name, optionally scoped and versioned. A path, a URL and a protocol alias are not.
fn is_registry_spec(package: &str) -> bool {
    if package.is_empty() || package.starts_with(['.', '/', '~']) {
        return false;
    }

    !package.strip_prefix('@').unwrap_or(package).contains(':')
}

/// The flags and words after `dlx`: exact tokens, each flag at most once. Anything else is `None`.
fn parse(args: &[String]) -> Option<Flags> {
    if args.first().map(String::as_str) != Some("dlx") {
        return None;
    }

    let mut flags = Flags::default();
    let mut seen: Vec<&'static str> = Vec::new();
    let mut index = 1;

    while index < args.len() {
        let token = args[index].as_str();
        let key = match token {
            "--no-info" => {
                flags.no_info = true;
                "no-info"
            }
            // Accepted and ignored: with the gate out there is nothing to approve.
            "-y" | "--yes" => "yes",
            "--offline" => {
                flags.offline = true;
                "offline"
            }
            "-s" | "--silent" => {
                flags.silent = true;
                "silent"
            }
            "-c" | "--shell-mode" => {
                flags.shell_mode = true;
                "shell-mode"
            }
            "-p" | "--package" => {
                // The option takes every word up to the next flag: it must be exactly one, then a known flag.
                let value = args.get(index + 1)?;
                let after = args.get(index + 2)?;

                if value.is_empty() || value.starts_with('-') || !is_known_flag(after) {
                    return None;
                }

                flags.packages.push(value.clone());
                index += 2;

                continue;
            }
            // Any other flag, a bundle like `-sc`, a value like `--yes=false`, `--info`, and `--`.
            _ if token.starts_with('-') => return None,
            _ => {
                flags.words.push(token.to_owned());
                index += 1;

                continue;
            }
        };

        // A repeated boolean reaches Node's handler as a list.
        if seen.contains(&key) {
            return None;
        }

        seen.push(key);
        index += 1;
    }

    (!flags.words.is_empty()).then_some(flags)
}

fn is_known_flag(token: &str) -> bool {
    matches!(
        token,
        "--no-info" | "-y" | "--yes" | "--offline" | "-s" | "--silent" | "-c" | "--shell-mode" | "-p" | "--package"
    )
}

#[cfg(test)]
mod tests {
    use super::{apply_offline, is_registry_spec, is_truthy, parse, Flags};
    use vis_core::resolve::ResolvedCommand;

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn flags_words_and_packages_parse_and_everything_else_does_not() {
        let flags = parse(&tokens(&["dlx", "--no-info", "cowsay", "hi", "-s", "-p", "a", "-c"])).unwrap();

        assert_eq!(
            flags,
            Flags {
                no_info: true,
                packages: vec!["a".into()],
                shell_mode: true,
                silent: true,
                words: vec!["cowsay".into(), "hi".into()],
                ..Flags::default()
            }
        );
        assert!(parse(&tokens(&["dlx", "-p", "a", "-p", "b", "-c", "echo hi"])).is_some());
        assert!(parse(&tokens(&["dlx", "-p", "a", "b"])).is_none());
        assert!(parse(&tokens(&["dlx", "-p", "a"])).is_none());
        assert!(parse(&tokens(&["dlx", "-p", "a", "-p", "b"])).is_none());
        assert!(parse(&tokens(&["dlx", "-p", "-c", "x"])).is_none());
        assert!(parse(&tokens(&["dlx", "--package=a", "-c", "x"])).is_none());
        assert!(parse(&tokens(&["dlx"])).is_none());
        assert!(parse(&tokens(&["dlx", "--no-info"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--info"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--version"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "-x"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "-sc"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--yes=false"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "-s", "-s"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--silent", "-s"])).is_none());
        assert!(parse(&tokens(&["x", "cowsay"])).is_none());
    }

    #[test]
    fn registry_specs_are_the_names_the_gate_vets() {
        for spec in ["cowsay", "cowsay@1", "@scope/pkg", "@scope/pkg@^1.0.0", "echo hi"] {
            assert!(is_registry_spec(spec), "{spec}");
        }

        for spec in
            ["", "./x", "../x", "/abs", "~/x", "file:x", "npm:x@1", "github:a/b", "https://x.test/a.tgz", "@scope/x:y"]
        {
            assert!(!is_registry_spec(spec), "{spec}");
        }
    }

    #[test]
    fn truthy_follows_is_truthy_env() {
        for value in ["1", "true", "yes", "on", "anything", " 1 "] {
            assert!(is_truthy(value), "{value}");
        }

        for value in ["", "0", "false", "no", " NO ", "False"] {
            assert!(!is_truthy(value), "{value}");
        }
    }

    #[test]
    fn offline_goes_after_the_dlx_word_where_the_manager_has_it() {
        let resolved =
            || ResolvedCommand { args: vec!["dlx".into(), "cowsay".into()], bin: "pnpm".into(), warnings: Vec::new() };
        let mut pnpm = resolved();

        apply_offline(&mut pnpm, "pnpm");
        assert_eq!(pnpm.args, ["dlx", "--offline", "cowsay"]);

        let mut bun = resolved();

        apply_offline(&mut bun, "bun");
        assert_eq!(bun.args, ["dlx", "cowsay"]);
        assert_eq!(bun.warnings.len(), 1);
    }
}
