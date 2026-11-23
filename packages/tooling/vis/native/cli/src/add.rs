//! `vis add <packages...> --no-marshall-check` — the native fast path.
//!
//! The Node handler (`src/commands/add/handler.ts`) checks the package names for typosquats, runs the
//! marshall pipeline (a registry lookup per package) and the Socket.dev check, maps the flags to the
//! package manager's command line, blocks lifecycle scripts unless `--run-scripts`, and runs the manager
//! with the terminal's own stdio. The marshall pipeline has no counterpart here, so the default form is
//! Node's. This module answers the form that skips it, in the contexts it can prove, and hands everything
//! else to Node:
//!
//! - flags: the exact tokens below, each at most once, with `--no-marshall-check` among them; `--filter`
//!   only after the packages (Node reads every word after it as another filter);
//! - packages: plain `name[@spec]` or `@scope/name[@spec]`, none of them a typosquat of the blocklist;
//! - context, workspace root and config: the gates of `vis install` (`install::setup`), plus a config
//!   without a `security` or `install` key, which `requires_node` already covers;
//! - no environment variable starting with `MARSHALL_`: they switch the typosquat check and the
//!   security notice, and Node resolves package versions from the registry before it looks at them.
//!
//! Every reason to delegate is decided before the package manager starts, because a delegation after it
//! ran would add twice. A manager that is not on `PATH` is Node's to report, so it is looked up before
//! anything is printed.

use std::env;
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};

use vis_core::resolve::{resolve_add, AddOptions};

use crate::install::{self, Root};
use crate::typosquat;

/// What the flags asked for.
#[derive(Debug, Default, PartialEq, Eq)]
struct Flags {
    exact: bool,
    filter: Vec<String>,
    global: bool,
    no_marshall_check: bool,
    no_typosquat_check: bool,
    optional: bool,
    packages: Vec<String>,
    peer: bool,
    run_scripts: bool,
    save_dev: bool,
    workspace: bool,
    workspace_root: bool,
}

struct Plan {
    bin: String,
    args: Vec<String>,
    /// Lines for stderr, before the package manager starts: the security-enforcement notice and the resolver's warnings.
    notices: Vec<String>,
    cwd: PathBuf,
    /// Node puts the root it found into the environment of everything it runs.
    root: Option<PathBuf>,
}

/// Answer `vis add` natively, or delegate to Node. Never returns.
///
/// `raw` is the untouched argv, handed to Node as it arrived; `args` is the lossy view used for parsing.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let Some(plan) = plan(args, raw) else {
        crate::delegate(raw);
    };

    let mut command = Command::new(&plan.bin);

    command
        .args(&plan.args)
        .current_dir(&plan.cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    // What Node's own startup adds to the environment of everything it runs: cerebro's default output level,
    // and the root it found. (Any `CEREBRO_*` of the caller's has kept the command in Node.)
    command.env("CEREBRO_OUTPUT_LEVEL", "32");

    if let Some(root) = &plan.root {
        command.env("VIS_MONOREPO_ROOT", root);
    }

    // The manager inherits the terminal, so the notices must be out before it starts.
    let mut stderr = io::stderr().lock();

    for notice in &plan.notices {
        let _ = writeln!(stderr, "{notice}");
    }

    let _ = stderr.flush();

    drop(stderr);

    match command.status() {
        // Node reports a child without an exit code (a signal) as 1.
        Ok(status) => exit(status.code().unwrap_or(1)),
        // The manager was found on `PATH` but could not start. With nothing printed yet, Node reports it;
        // after a notice, a second run in Node would print the notice twice.
        Err(_) if plan.notices.is_empty() => crate::delegate(raw),
        Err(error) => {
            eprintln!("Error: Failed to execute '{}': {error}", plan.bin);

            exit(1)
        }
    }
}

/// The plan for this invocation, or `None` to delegate.
fn plan(args: &[String], raw: &[OsString]) -> Option<Plan> {
    let flags = parse(args)?;

    // Without `--no-marshall-check` Node fetches package data from the registry first.
    if !flags.no_marshall_check {
        return None;
    }

    let setup = install::setup(args, raw)?;

    // Its output has only been compared with Node's where no colour is on and `TERM` leaves the terminal unknown.
    let plain_term = env::var("TERM").map_or(true, |term| {
        let term = term.to_lowercase();

        term.contains("dumb") || term.contains("mono")
    });

    if setup.layout.colour || !plain_term {
        return None;
    }

    if !flags.no_typosquat_check && flags.packages.iter().any(|package| is_typosquat(package)) {
        return None;
    }

    let mut notices = Vec::new();

    // The security-enforcement plugin acts on the typed command name `add`.
    if setup.root == Root::Here {
        notices.extend(install::security_notices(&setup.manager, &setup.cwd)?);
    }

    let resolved = resolve_add(
        &setup.manager,
        &setup.version,
        AddOptions {
            exact: flags.exact,
            filter: flags.filter.clone(),
            global: flags.global,
            optional: flags.optional,
            packages: flags.packages.clone(),
            peer: flags.peer,
            save_dev: flags.save_dev,
            workspace: flags.workspace,
            workspace_root: flags.workspace_root,
        },
    )
    .ok()?;

    let mut args = resolved.args;

    // Lifecycle scripts stay off unless asked for, for every manager.
    if !flags.run_scripts {
        args.push("--ignore-scripts".to_owned());
    }

    // A manager that is not on `PATH` fails in Node with its own report.
    if !on_path(&resolved.bin) {
        return None;
    }

    notices.extend(resolved.warnings.iter().map(|warning| format!("warning: {warning}")));

    Some(Plan {
        args,
        bin: resolved.bin,
        cwd: setup.cwd.clone(),
        notices,
        root: (setup.root == Root::Here).then_some(setup.cwd),
    })
}

/// Whether `bin` is an executable file in a directory of `PATH`, as `execvp` looks it up.
pub(crate) fn on_path(bin: &str) -> bool {
    #[cfg(unix)]
    fn executable(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;

        path.metadata().is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    }

    #[cfg(not(unix))]
    fn executable(path: &Path) -> bool {
        path.is_file()
    }

    env::var_os("PATH").is_some_and(|path| env::split_paths(&path).any(|directory| executable(&directory.join(bin))))
}

/// The flags and packages after `add`: exact tokens, each flag at most once. Anything else is `None`.
fn parse(args: &[String]) -> Option<Flags> {
    if args.first().map(String::as_str) != Some("add") {
        return None;
    }

    let mut flags = Flags::default();
    let mut seen: Vec<&'static str> = Vec::new();
    let mut index = 1;

    while index < args.len() {
        let token = args[index].as_str();
        let key = match token {
            "-D" | "--save-dev" => {
                flags.save_dev = true;
                "save-dev"
            }
            "-E" | "--exact" => {
                flags.exact = true;
                "exact"
            }
            "-O" | "--save-optional" => {
                flags.optional = true;
                "save-optional"
            }
            "-P" | "--save-peer" => {
                flags.peer = true;
                "save-peer"
            }
            "-g" | "--global" => {
                flags.global = true;
                "global"
            }
            "-w" | "--workspace-root" => {
                flags.workspace_root = true;
                "workspace-root"
            }
            "--workspace" => {
                flags.workspace = true;
                "workspace"
            }
            "--run-scripts" => {
                flags.run_scripts = true;
                "run-scripts"
            }
            "--no-marshall-check" => {
                flags.no_marshall_check = true;
                "no-marshall-check"
            }
            // No Socket.dev provider is configured where the native path runs, so there is nothing to skip.
            "--no-socket-check" => "no-socket-check",
            "--no-typosquat-check" => {
                flags.no_typosquat_check = true;
                "no-typosquat-check"
            }
            "-F" | "--filter" => {
                index += 1;
                flags.filter.push(install::filter_value(args.get(index)?)?);
                index += 1;

                continue;
            }
            _ if token.starts_with("--filter=") => {
                flags.filter.push(install::filter_value(&token["--filter=".len()..])?);
                index += 1;

                continue;
            }
            // Any other flag, a bundle like `-Dg`, a value like `--exact=true`, and `--`.
            _ if token.starts_with('-') => return None,
            _ => {
                // Node reads every word after `--filter` as another filter, so a package after one is no package.
                if !flags.filter.is_empty() || parse_package_argument(token).is_none() {
                    return None;
                }

                flags.packages.push(token.to_owned());
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

    if flags.packages.is_empty() {
        return None;
    }

    Some(flags)
}

/// `parsePackageArgument`: the name of `name[@spec]` or `@scope/name[@spec]`, and its spec. `None` for
/// anything outside the plain shape, so the caller leaves it to Node.
fn parse_package_argument(argument: &str) -> Option<(&str, Option<&str>)> {
    let name_end = if let Some(scoped) = argument.strip_prefix('@') {
        let slash = scoped.find('/')?;

        if !name_chars(&scoped[..slash]) {
            return None;
        }

        let rest = &scoped[slash + 1..];
        let at = rest.find('@').unwrap_or(rest.len());

        if !name_chars(&rest[..at]) {
            return None;
        }

        1 + slash + 1 + at
    } else {
        let at = argument.find('@').unwrap_or(argument.len());

        if !name_chars(&argument[..at]) {
            return None;
        }

        at
    };

    if name_end == argument.len() {
        return Some((argument, None));
    }

    let spec = &argument[name_end + 1..];

    (!spec.is_empty()
        && spec.chars().all(|character| character.is_ascii_alphanumeric() || "._^~<>=*|+:/#,@-".contains(character)))
    .then_some((&argument[..name_end], Some(spec)))
}

/// A name segment: ASCII letters, digits and `-._~`, starting with a letter or digit.
fn name_chars(segment: &str) -> bool {
    segment.chars().next().is_some_and(|first| first.is_ascii_alphanumeric())
        && segment.chars().all(|character| character.is_ascii_alphanumeric() || "-._~".contains(character))
}

/// Whether the typosquat check flags the package's name.
fn is_typosquat(argument: &str) -> bool {
    parse_package_argument(argument).is_none_or(|(name, _)| typosquat::is_typosquat(name))
}

#[cfg(test)]
mod tests {
    use super::{parse, parse_package_argument, Flags};

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn flags_and_packages_parse_and_everything_else_does_not() {
        let flags =
            parse(&tokens(&["add", "react", "-D", "-E", "lodash@4", "--no-marshall-check", "-F", "app"])).unwrap();

        assert_eq!(
            flags,
            Flags {
                exact: true,
                filter: vec!["app".into()],
                no_marshall_check: true,
                packages: vec!["react".into(), "lodash@4".into()],
                save_dev: true,
                ..Flags::default()
            }
        );
        assert!(parse(&tokens(&["add", "--filter=a", "--filter=b", "react"])).is_none());
        assert!(parse(&tokens(&["add", "react", "--filter=a", "--filter=b"])).is_some());
        assert!(parse(&tokens(&["add", "-g", "-w", "-O", "-P", "--workspace", "--run-scripts", "react"])).is_some());
        assert!(parse(&tokens(&["add"])).is_none());
        assert!(parse(&tokens(&["add", "-D"])).is_none());
        assert!(parse(&tokens(&["add", "react", "react", "-D", "-D"])).is_none());
        assert!(parse(&tokens(&["add", "react", "-F"])).is_none());
        assert!(parse(&tokens(&["add", "react", "-F", "-D"])).is_none());
        assert!(parse(&tokens(&["add", "react", "--filter="])).is_none());
        assert!(parse(&tokens(&["add", "-F", "app", "react"])).is_none());
        assert!(parse(&tokens(&["add", "react", "-F", "app", "lodash"])).is_none());
        assert!(parse(&tokens(&["add", "react", "-r"])).is_none());
        assert!(parse(&tokens(&["add", "react", "--to", "web"])).is_none());
        assert!(parse(&tokens(&["add", "react", "--auto-install-peers"])).is_none());
        assert!(parse(&tokens(&["add", "react", "-Dg"])).is_none());
        assert!(parse(&tokens(&["add", "react", "--exact=true"])).is_none());
        assert!(parse(&tokens(&["add", "react", "--"])).is_none());
        assert!(parse(&tokens(&["install", "react"])).is_none());
    }

    #[test]
    fn package_arguments_follow_parse_package_argument_or_are_left_to_node() {
        assert_eq!(parse_package_argument("react"), Some(("react", None)));
        assert_eq!(parse_package_argument("react@^18.2.0"), Some(("react", Some("^18.2.0"))));
        assert_eq!(parse_package_argument("@scope/pkg"), Some(("@scope/pkg", None)));
        assert_eq!(parse_package_argument("@scope/pkg@latest"), Some(("@scope/pkg", Some("latest"))));
        assert_eq!(parse_package_argument("alias@npm:@scope/real@1"), Some(("alias", Some("npm:@scope/real@1"))));
        assert_eq!(parse_package_argument("a@b@c"), Some(("a", Some("b@c"))));

        for odd in [
            "",
            "@",
            "@scope",
            "@scope/",
            "@/pkg",
            "react@",
            "@scope/pkg@",
            "-D",
            ".bin",
            "a b",
            "a@b c",
            "ré",
            "./local",
            "https://x.test/a.tgz",
            "a\nb",
        ] {
            assert_eq!(parse_package_argument(odd), None, "{odd:?}");
        }
    }
}
