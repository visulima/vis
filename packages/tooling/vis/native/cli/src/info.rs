//! `vis info <package> [field...] [--json]` (alias `view`) — the native fast path.
//!
//! The Node handler (`src/commands/info/handler.ts`) picks the package manager and runs its registry
//! view (`npm view`, `pnpm view`, `yarn info`, `bun pm view`) with the terminal's own stdio. It reports
//! exit code 1 as a normal outcome ("not found") and forwards any other code. This module answers the
//! shape whose result it can prove, and hands everything else to Node:
//!
//! - arguments: one or more plain words (the package, then the fields) and `--json` at most once;
//! - context, workspace root and config: the gates of `vis install` (`install::setup`), which also leave
//!   to Node every run whose installer or runtime a config, a pin or the environment could change;
//! - no warning from the resolver (a bun without `pm view`, yarn's single-field limits): Node words those.
//!
//! Every reason to delegate is decided before the package manager starts. A manager that is not on
//! `PATH` is Node's to report, so it is looked up before anything runs.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{exit, Command, Stdio};

use vis_core::resolve::ResolvedCommand;

use crate::pm_run::{node_startup_environment, on_path, setup, Root};

/// What the command line asked for.
#[derive(Debug, Default, PartialEq, Eq)]
struct Flags {
    json: bool,
    /// The package, then the fields.
    words: Vec<String>,
}

struct Plan {
    bin: String,
    args: Vec<String>,
    cwd: PathBuf,
    /// Node puts the root it found into the environment of everything it runs.
    root: Option<PathBuf>,
}

/// Answer `vis info` natively, or delegate to Node. Never returns.
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

    node_startup_environment(&mut command, plan.root.as_deref());

    match command.status() {
        // Node treats exit 1 ("not found", an empty result) as an ordinary outcome and forwards any other
        // code. A child without an exit code (a signal) is reported as 1 there, so it ends the same way.
        Ok(status) => exit(match crate::node_exit_code(status) {
            1 => 0,
            code => code,
        }),
        // Found on `PATH` but could not start; nothing has been printed, so Node reports it.
        Err(_) => crate::delegate(raw),
    }
}

/// The plan for this invocation, or `None` to delegate.
fn plan(args: &[String], raw: &[OsString]) -> Option<Plan> {
    let flags = parse(args)?;
    let setup = setup(args, raw)?;
    let resolved = resolve_info(&setup.manager, &setup.version, &flags)?;

    // A manager that is not on `PATH` fails in Node with its own report.
    if !on_path(&resolved.bin) {
        return None;
    }

    Some(Plan {
        args: resolved.args,
        bin: resolved.bin,
        cwd: setup.cwd.clone(),
        root: (setup.root == Root::Here).then_some(setup.cwd),
    })
}

/// The words and `--json` after `info` or `view`: plain words (no flag, no `--`), `--json` at most once.
fn parse(args: &[String]) -> Option<Flags> {
    if !matches!(args.first().map(String::as_str), Some("info" | "view")) {
        return None;
    }

    let mut flags = Flags::default();

    for token in &args[1..] {
        if token == "--json" {
            if flags.json {
                return None;
            }

            flags.json = true;
        } else if is_plain_word(token) {
            flags.words.push(token.clone());
        } else {
            return None;
        }
    }

    (!flags.words.is_empty()).then_some(flags)
}

/// A word the argument parser passes through as it is: no leading dash, and only characters of a package
/// name, a version spec or a field path (`dist.tarball`, `versions`, `react@^18`, `@scope/pkg`). A word the
/// parser could read as a number, a boolean or a flag value is left to Node.
fn is_plain_word(token: &str) -> bool {
    token.chars().next().is_some_and(|first| first.is_ascii_alphabetic() || first == '@')
        && token != "true"
        && token != "false"
        && token.chars().all(|character| character.is_ascii_alphanumeric() || "@/._~^<>=*|+:#,-".contains(character))
}

/// `resolveInfo` for the managers a plain run can have: the version is unknown (`latest`) wherever neither a
/// `packageManager` pin nor a classic `yarn.lock` names one, and a pin never reaches here. `None` for a warning or an unknown version.
fn resolve_info(manager: &str, version: &str, flags: &Flags) -> Option<ResolvedCommand> {
    if version != "latest" {
        return None;
    }

    let (package, fields) = flags.words.split_first()?;
    let mut args: Vec<String> = Vec::new();

    match manager {
        "bun" => args.extend(["pm".to_owned(), "view".to_owned()]),
        "npm" | "pnpm" => args.push("view".to_owned()),
        // yarn berry: `npm info` takes no field arguments, which Node drops with a warning.
        "yarn" if fields.is_empty() => args.extend(["npm".to_owned(), "info".to_owned()]),
        _ => return None,
    }

    // `--json` goes before `--`, which ends the flags: after it the manager reads it as a field name. The
    // `--` keeps a package name that starts with a dash from being read as a flag.
    if flags.json {
        args.push("--json".to_owned());
    }

    args.push("--".to_owned());
    args.push(package.clone());
    args.extend(fields.iter().cloned());

    Some(ResolvedCommand { args, bin: manager.to_owned(), warnings: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::{is_plain_word, parse, resolve_info, Flags};

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn words_and_json_parse_and_everything_else_does_not() {
        let flags = parse(&tokens(&["info", "react", "version", "--json"])).unwrap();

        assert_eq!(flags, Flags { json: true, words: vec!["react".into(), "version".into()] });
        assert!(parse(&tokens(&["view", "@scope/pkg@^1"])).is_some());
        assert!(parse(&tokens(&["info", "--json", "react"])).is_some_and(|flags| flags.json));
        assert!(parse(&tokens(&["info"])).is_none());
        assert!(parse(&tokens(&["info", "--json"])).is_none());
        assert!(parse(&tokens(&["info", "react", "--json", "--json"])).is_none());
        assert!(parse(&tokens(&["info", "react", "--registry=x"])).is_none());
        assert!(parse(&tokens(&["info", "react", "--"])).is_none());
        assert!(parse(&tokens(&["info", "-rf"])).is_none());
        assert!(parse(&tokens(&["info", "react", "-h"])).is_none());
        assert!(parse(&tokens(&["info", "react", "18"])).is_none());
        assert!(parse(&tokens(&["info", "react", ""])).is_none());
        assert!(parse(&tokens(&["info", "react", "true"])).is_none());
        assert!(parse(&tokens(&["add", "react"])).is_none());
    }

    #[test]
    fn plain_words_are_package_names_specs_and_field_paths() {
        for word in ["react", "@scope/pkg", "react@18.2.0", "dist.tarball", "dist-tags", "a@>=1.0.0"] {
            assert!(is_plain_word(word), "{word}");
        }

        for word in ["", "-x", "1", "1.2.3", "true", "a b", "ré", "a;b", "a$b", "./x", "a\nb"] {
            assert!(!is_plain_word(word), "{word}");
        }
    }

    #[test]
    fn the_view_command_of_each_manager() {
        let flags = Flags { json: true, words: vec!["react".into(), "version".into()] };
        let line = |manager: &str, flags: &Flags| {
            resolve_info(manager, "latest", flags).map(|resolved| (resolved.bin, resolved.args.join(" ")))
        };

        assert_eq!(line("pnpm", &flags), Some(("pnpm".into(), "view --json -- react version".into())));
        assert_eq!(line("npm", &flags), Some(("npm".into(), "view --json -- react version".into())));
        assert_eq!(line("bun", &flags), Some(("bun".into(), "pm view --json -- react version".into())));
        // A field on yarn berry is a warning in Node.
        assert_eq!(line("yarn", &flags), None);

        let plain = Flags { json: false, words: vec!["react".into()] };

        assert_eq!(line("yarn", &plain), Some(("yarn".into(), "npm info -- react".into())));
        assert_eq!(resolve_info("pnpm", "9.0.0", &plain).map(|resolved| resolved.args), None);
    }
}
