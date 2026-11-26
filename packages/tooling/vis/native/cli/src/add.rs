//! `vis add <packages...>` — the native fast path.
//!
//! The Node handler (`src/commands/add/handler.ts`) checks the package names for typosquats, runs the
//! marshall pipeline (a registry lookup per package) and the Socket.dev check, maps the flags to the
//! package manager's command line, blocks lifecycle scripts unless `--run-scripts`, and runs the manager
//! with the terminal's own stdio. This module answers the run in which the checks find nothing, in the contexts it can
//! prove, and hands everything else to Node before the manager starts:
//!
//! - flags: the exact tokens below, each at most once; `--filter` only after the packages (Node reads every word after
//!   it as another filter);
//! - packages: plain `name[@spec]` or `@scope/name[@spec]`, none of them a typosquat of the blocklist;
//! - context, workspace root and config: the gates of `vis install` (`install::setup`), plus a config without a
//!   `security` or `install` key, which `requires_node` already covers (the marshalls, the Socket.dev check and every
//!   other provider are configured there, so none is on);
//! - the marshall check, unless `--no-marshall-check` skips it: see [`crate::marshall_check`]. A run in which a marshall
//!   finds something (Node then prints a table and may prompt), or this binary cannot tell, is Node's. Of the
//!   `MARSHALL_*` variables only the `MARSHALL_DISABLE_*` of the marshalls the check runs are read; any other one
//!   switches off the typosquat scan or the security notice, which Node decides.
//!
//! Every reason to delegate is decided before the package manager starts, because a delegation after it
//! ran would add twice; the check, which asks the network, comes last, and the cache it fills is written only
//! once the run is sure to answer. A manager that is not on `PATH` is Node's to report, so it is looked up before
//! anything is printed.

use std::env;
use std::ffi::OsString;

use vis_core::resolve::{resolve_add, AddOptions};

use crate::inspect::commit;
use crate::pm_run::{filter_value, on_path, security_notices, setup_allowing, ManagerRun, Root};
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

/// Answer `vis add` natively, or delegate to Node. Never returns.
///
/// `raw` is the untouched argv, handed to Node as it arrived; `args` is the lossy view used for parsing.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let Some(plan) = plan(args, raw) else {
        crate::process::delegate(raw);
    };

    // The marshall check asked the registry, so it comes after every reason to delegate that needs no request, and
    // what it cached is written only once the run is sure to answer.
    if let Some(packages) = &plan.check {
        match crate::marshall_check::check(packages, &plan.run.cwd, plan.outside_root) {
            Ok(cache) => {
                if let Err(reason) = commit(&cache) {
                    crate::process::delegate_because(&reason, raw);
                }
            }
            Err(reason) => crate::process::delegate_because(&reason, raw),
        }
    }

    plan.run.run_inherited(raw, |code| code)
}

/// The manager to run, and the packages the marshall check looks up first (none with `--no-marshall-check`).
struct Plan {
    run: ManagerRun,
    check: Option<Vec<String>>,
    /// Node finds no workspace root, so its packument lookups ignore `.npmrc`.
    outside_root: bool,
}

/// The plan for this invocation, or `None` to delegate.
fn plan(args: &[String], raw: &[OsString]) -> Option<Plan> {
    let flags = parse(args)?;

    // The `MARSHALL_DISABLE_*` variables of the marshalls the check runs are its own to read; any other `MARSHALL_*`
    // variable changes what Node does before it installs.
    let setup = setup_allowing(args, raw, &crate::marshall_check::disable_variables())?;

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
        notices.extend(security_notices(&setup.manager, &setup.cwd)?);
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
        run: ManagerRun {
            args,
            bin: resolved.bin,
            cwd: setup.cwd.clone(),
            notices,
            root: (setup.root == Root::Here).then_some(setup.cwd),
        },
        check: (!flags.no_marshall_check).then(|| flags.packages.clone()),
        outside_root: setup.root == Root::None,
    })
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
                flags.filter.push(filter_value(args.get(index)?)?);
                index += 1;

                continue;
            }
            _ if token.starts_with("--filter=") => {
                flags.filter.push(filter_value(&token["--filter=".len()..])?);
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
pub(crate) fn parse_package_argument(argument: &str) -> Option<(&str, Option<&str>)> {
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
