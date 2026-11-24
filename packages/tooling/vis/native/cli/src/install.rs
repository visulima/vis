//! `vis install` with no packages — the native fast path.
//!
//! The Node handler (`src/commands/install/handler.ts`) scans `package.json` for typosquats, picks
//! the package manager, maps the flags to its command line (frozen lockfile by default, lifecycle
//! scripts blocked unless `--run-scripts`), runs it with its output teed, and prints a hint when the
//! output has peer-dependency warnings. This module does the same, in the contexts it can prove, and
//! hands everything else to Node:
//!
//! - flags: only the exact tokens below, each at most once, and no package names (those go to the
//!   `add` pipeline);
//! - context: CI, no terminal, a unix platform, and no environment that changes which
//!   installer Node picks or what its plugins print;
//! - workspace: the working directory is either where Node finds no monorepo root (it then loads no
//!   config and runs no plugin), or the root itself (it then prints the security line below);
//! - config: none, or a plain literal with no key Node must evaluate and no `install` key;
//! - `package.json`: no dependency name or alias matches the typosquat blocklist, because Node
//!   prompts or aborts for those.
//!
//! Every reason to delegate is decided before the package manager starts, because a delegation after
//! it ran would install twice. If the package manager cannot be started at all, nothing has run and
//! Node answers.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use regex::bytes::{Regex, RegexBuilder};
use serde_json::Value;
use vis_core::resolve::{resolve_install, InstallOptions};

use crate::pail::{Layout, Level};
use crate::pm_run::{filter_value, security_notices, setup, Root};
use crate::typosquat::{self, Scan};

/// The hint Node prints after an install whose output has peer-dependency warnings
/// (`PEER_HINT` in `src/util/peer-warnings.ts`).
const PEER_HINT: &str =
    "Peer dependency issues detected. Run `vis update --peer` to inspect and bump mismatched peer dependencies.";

/// How much of the package manager's output is kept to look for peer warnings
/// (`MAX_CAPTURED_BYTES` in `src/util/spawn-tee.ts`).
const MAX_CAPTURED_BYTES: usize = 256 * 1024;

/// What the flags asked for.
#[derive(Debug, Default, PartialEq, Eq)]
struct Flags {
    /// The command was typed as `i`: Node's plugins match the typed name, so the alias runs none of them.
    alias: bool,
    dev: bool,
    filter: Vec<String>,
    force: bool,
    lockfile_only: bool,
    no_frozen_lockfile: bool,
    no_optional: bool,
    offline: bool,
    prod: bool,
    recursive: bool,
    run_scripts: bool,
    silent: bool,
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
    silent: bool,
    layout: Layout,
}

/// Answer `vis install` natively, or delegate to Node. Never returns.
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // What Node's own startup adds to the environment of everything it runs: cerebro's default output level,
    // and the root it found. (Any `CEREBRO_*` of the caller's has kept the command in Node.)
    command.env("CEREBRO_OUTPUT_LEVEL", "32");

    if let Some(root) = &plan.root {
        command.env("VIS_MONOREPO_ROOT", root);
    }

    // Nothing has been printed yet, so a package manager that cannot start is Node's to report.
    let Ok(mut child) = command.spawn() else {
        crate::delegate(raw);
    };

    let mut stderr = io::stderr().lock();

    for notice in &plan.notices {
        let _ = writeln!(stderr, "{notice}");
    }

    drop(stderr);

    let captured = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();

    if let Some(pipe) = child.stdout.take() {
        let captured = Arc::clone(&captured);

        readers.push(thread::spawn(move || tee(pipe, io::stdout(), &captured)));
    }

    if let Some(pipe) = child.stderr.take() {
        let captured = Arc::clone(&captured);

        readers.push(thread::spawn(move || tee(pipe, io::stderr(), &captured)));
    }

    // Node reports a child without an exit code (a signal) as 1.
    let code = child.wait().map_or(1, crate::node_exit_code);

    for reader in readers {
        let _ = reader.join();
    }

    let output = captured.lock().map(|buffer| buffer.clone()).unwrap_or_default();

    // After the package manager's own report, and only when it printed the warnings.
    if code == 0 && !plan.silent && has_peer_dependency_warnings(&output) {
        let mut stdout = io::stdout().lock();

        let _ = stdout.write_all(plan.layout.block(Level::Info, PEER_HINT).as_bytes());
        let _ = stdout.flush();
    }

    exit(code)
}

/// Copy `from` to `to` as it arrives, and keep the last `MAX_CAPTURED_BYTES` of it in `captured`.
fn tee(mut from: impl Read, mut to: impl Write, captured: &Mutex<Vec<u8>>) {
    let mut chunk = vec![0_u8; 64 * 1024];

    loop {
        let read = match from.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };

        let _ = to.write_all(&chunk[..read]);
        let _ = to.flush();

        if let Ok(mut buffer) = captured.lock() {
            buffer.extend_from_slice(&chunk[..read]);

            if buffer.len() > MAX_CAPTURED_BYTES {
                let excess = buffer.len() - MAX_CAPTURED_BYTES;

                buffer.drain(..excess);
            }
        }
    }
}

/// The patterns of `PEER_WARNING_PATTERNS` in `src/util/peer-warnings.ts`, with their flags. JavaScript
/// regexes without the `u` flag are ASCII: `\b` and the case folding only know ASCII letters.
fn peer_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();

    PATTERNS.get_or_init(|| {
        [
            (r"Issues with peer dependencies found", true),
            (r"\bunmet peer\b", true),
            (r"\bERESOLVE\b", false),
            (r"unmet peer dependency", true),
            (r"\bYN0060\b", false),
            (r"incorrect peer dependency", true),
        ]
        .iter()
        .map(|(pattern, ignore_case)| {
            RegexBuilder::new(pattern)
                .unicode(false)
                .case_insensitive(*ignore_case)
                .build()
                .expect("peer pattern compiles")
        })
        .collect()
    })
}

/// `hasPeerDependencyWarnings`.
fn has_peer_dependency_warnings(output: &[u8]) -> bool {
    peer_patterns().iter().any(|pattern| pattern.is_match(output))
}

/// The plan for this invocation, or `None` to delegate.
fn plan(args: &[String], raw: &[OsString]) -> Option<Plan> {
    let flags = parse(args)?;
    let setup = setup(args, raw)?;

    if typosquat_scan(&setup.cwd) != Scan::Clean {
        return None;
    }

    let mut notices = Vec::new();

    // The security-enforcement plugin acts on the typed command name `install`, not on its alias.
    if setup.root == Root::Here && !flags.alias {
        notices.extend(security_notices(&setup.manager, &setup.cwd)?);
    }

    let resolved = resolve_install(
        &setup.manager,
        &setup.version,
        InstallOptions {
            dev: flags.dev,
            filter: flags.filter.clone(),
            force: flags.force,
            // Node freezes unless `--no-frozen-lockfile` says otherwise, lockfile or not.
            frozen_lockfile: !flags.no_frozen_lockfile,
            ignore_scripts: !flags.run_scripts,
            lockfile_only: flags.lockfile_only,
            no_optional: flags.no_optional,
            offline: flags.offline,
            prod: flags.prod,
            recursive: flags.recursive,
            silent: flags.silent,
            workspace_root: flags.workspace_root,
        },
    )
    .ok()?;

    notices.extend(resolved.warnings.iter().map(|warning| format!("warning: {warning}")));

    Some(Plan {
        args: resolved.args,
        bin: resolved.bin,
        cwd: setup.cwd.clone(),
        notices,
        root: (setup.root == Root::Here).then_some(setup.cwd),
        silent: flags.silent,
        layout: setup.layout,
    })
}

/// The flags after `install` or `i`: exact tokens, each at most once, no packages. Anything else is `None`.
fn parse(args: &[String]) -> Option<Flags> {
    if !matches!(args.first().map(String::as_str), Some("install" | "i")) {
        return None;
    }

    let mut flags = Flags { alias: args[0] == "i", ..Flags::default() };
    let mut seen: Vec<&'static str> = Vec::new();
    let mut index = 1;

    while index < args.len() {
        let token = args[index].as_str();
        let key = match token {
            "-D" | "--dev" => {
                flags.dev = true;
                "dev"
            }
            "-P" | "--prod" => {
                flags.prod = true;
                "prod"
            }
            "-f" | "--force" => {
                flags.force = true;
                "force"
            }
            "--frozen-lockfile" => "frozen-lockfile",
            "--no-frozen-lockfile" => {
                flags.no_frozen_lockfile = true;
                "no-frozen-lockfile"
            }
            "--lockfile-only" => {
                flags.lockfile_only = true;
                "lockfile-only"
            }
            "--no-optional" => {
                flags.no_optional = true;
                "no-optional"
            }
            "--offline" => {
                flags.offline = true;
                "offline"
            }
            "-r" | "--recursive" => {
                flags.recursive = true;
                "recursive"
            }
            "--run-scripts" => {
                flags.run_scripts = true;
                "run-scripts"
            }
            "-s" | "--silent" => {
                flags.silent = true;
                "silent"
            }
            "-w" | "--workspace-root" => {
                flags.workspace_root = true;
                "workspace-root"
            }
            "-F" | "--filter" => {
                index += 1;
                flags.filter.push(filter_value(args.get(index)?)?);
                index += 1;

                continue;
            }
            _ => {
                let value = token.strip_prefix("--filter=")?;

                flags.filter.push(filter_value(value)?);
                index += 1;

                continue;
            }
        };

        // A repeated boolean reaches Node's handler as a list and fails there.
        if seen.contains(&key) {
            return None;
        }

        seen.push(key);
        index += 1;
    }

    // Node rejects these pairs with a usage error.
    if (flags.dev && flags.prod) || (seen.contains(&"frozen-lockfile") && flags.no_frozen_lockfile) {
        return None;
    }

    Some(flags)
}

/// The typosquat scan of `package.json` in `cwd`. A file Node cannot parse stops the command in Node
/// with an error, so it is delegated like a hit.
fn typosquat_scan(cwd: &Path) -> Scan {
    let path = cwd.join("package.json");

    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(manifest) => typosquat::scan_manifest(&manifest),
            Err(_) => Scan::Delegate,
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Scan::Clean,
        Err(_) => Scan::Delegate,
    }
}

#[cfg(test)]
mod tests {
    use super::{has_peer_dependency_warnings, parse, Flags};

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn plain_flags_parse_and_unknown_or_repeated_ones_do_not() {
        let flags = parse(&tokens(&["install", "-D", "--force", "-F", "app", "--filter=lib", "--silent"])).unwrap();

        assert_eq!(
            flags,
            Flags {
                dev: true,
                filter: vec!["app".into(), "lib".into()],
                force: true,
                silent: true,
                ..Flags::default()
            }
        );
        assert!(parse(&tokens(&["i"])).is_some_and(|flags| flags.alias));
        assert!(parse(&tokens(&["install", "react"])).is_none());
        assert!(parse(&tokens(&["install", "--force", "--force"])).is_none());
        assert!(parse(&tokens(&["install", "-D", "--dev"])).is_none());
        assert!(parse(&tokens(&["install", "-D", "--prod"])).is_none());
        assert!(parse(&tokens(&["install", "--frozen-lockfile", "--no-frozen-lockfile"])).is_none());
        assert!(parse(&tokens(&["install", "-F"])).is_none());
        assert!(parse(&tokens(&["install", "-F", "-D"])).is_none());
        assert!(parse(&tokens(&["install", "--filter="])).is_none());
        assert!(parse(&tokens(&["install", "-Df"])).is_none());
        assert!(parse(&tokens(&["install", "--ci"])).is_none());
        assert!(parse(&tokens(&["install", "--"])).is_none());
    }

    #[test]
    fn peer_warnings_follow_the_typescript_patterns() {
        for text in [
            "Issues with peer dependencies found",
            "ISSUES WITH PEER DEPENDENCIES FOUND",
            "WARN  unmet peer react@18",
            "npm ERR! code ERESOLVE",
            "warning x has unmet peer dependency y",
            "xunmet peer dependency",
            "YN0060: incompatible",
            "bun: Incorrect Peer Dependency",
        ] {
            assert!(has_peer_dependency_warnings(text.as_bytes()), "{text}");
        }

        for text in ["", "eresolve", "unmet_peer", "xunmet peerx", "YN00601", "yn0060"] {
            assert!(!has_peer_dependency_warnings(text.as_bytes()), "{text}");
        }
    }
}
