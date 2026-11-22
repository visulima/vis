//! `vis self-update [version] [--check] [--force] [--silent]` — the native fast path.
//!
//! The Node handler (`src/commands/upgrade/handler.ts`) asks npm for the latest published version,
//! compares it with the running one and prints a verdict, or runs `npm install -g` for it. This
//! module makes the same query and prints the same bytes for the verdicts that need no install
//! (`--check`, up to date). It answers only what it can reproduce:
//!
//! - not Windows, in a CI context with neither stream a terminal (the after-command tips, notices
//!   and update check of the Node CLI are off there), and no `vis.config.*` or Deno file at or above
//!   the working directory (Node's config loader can print errors of its own for those);
//! - `VIS_VERSION` is set (the running version) and none of `DEBUG`, `CEREBRO_*` or `VIS_MONOREPO_ROOT` is,
//!   since the first two change what Node logs and the last changes the root Node reads;
//! - the arguments are `self-update` with at most one plain `x.y.z[-pre][+build]` version and each of
//!   `--check`, `--force`, `--silent` at most once.
//!
//! The query (`npm view`) runs before anything is printed, so a failure there (npm missing or failing,
//! an answer that is not one word) delegates with nothing printed and Node repeats the read-only
//! query and reports the error itself. The query's stderr is held back and shown after the first
//! line, the order Node's inherited stderr produces.
//!
//! The install is never native. A failed `npm install -g` is reported by Node as a plain `Error`
//! that the CLI error handler renders with a stack of bundle paths, which cannot be reproduced byte
//! for byte, and a failure cannot be taken back once lines are printed. So when the verdict is
//! "install", the call is delegated before anything is printed and Node does the whole run. The
//! cost is one more read-only `npm view` on the install path.

use std::env;
use std::ffi::OsString;
use std::io::{self, IsTerminal, Write};
use std::process::{exit, Command, Stdio};

use crate::error::WrapperError;

const PACKAGE: &str = "@visulima/vis";

/// The arguments the native path accepts.
#[derive(Debug, Default, PartialEq, Eq)]
struct Options {
    check: bool,
    force: bool,
    /// The target version, as given.
    version: Option<String>,
}

/// What the command does once the latest version is known.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// Nothing to install: the lines to print, in order.
    UpToDate(Vec<String>),
    /// Only report what was found (`--check`).
    Found(String),
    /// An install is needed: Node's to run.
    Install,
}

/// Answer `vis self-update` natively, or delegate to Node. Never returns.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let (Some(options), Some(current)) = (parse(args), native_context()) else {
        crate::delegate(raw);
    };

    let Some((latest, query_stderr)) = query_latest() else {
        crate::delegate(raw);
    };

    let target = options.version.clone().unwrap_or(latest);
    let verdict = decide(&options, &current, &target);

    // Nothing is printed yet, so Node can take over and repeat the (read-only) query.
    if verdict == Verdict::Install {
        crate::delegate(raw);
    }

    say("info: checking for updates...");
    show_stderr(&query_stderr);

    match verdict {
        Verdict::UpToDate(lines) => lines.iter().for_each(|text| say(text)),
        Verdict::Found(text) => say(&text),
        Verdict::Install => unreachable!("an install is delegated above"),
    }

    exit(0)
}

/// The options when the arguments are a shape the native path knows, else `None`.
fn parse(args: &[String]) -> Option<Options> {
    if args.first().map(String::as_str) != Some("self-update") {
        return None;
    }

    let mut options = Options::default();
    let mut silent = false;

    for argument in &args[1..] {
        let slot = match argument.as_str() {
            "--check" => &mut options.check,
            "--force" => &mut options.force,
            "--silent" => &mut silent,
            text if options.version.is_none() && is_plain_version(text) => {
                options.version = Some(text.to_owned());
                continue;
            }
            _ => return None,
        };

        if *slot {
            return None;
        }

        *slot = true;
    }

    Some(options)
}

/// `x.y.z` with an optional `-pre` and `+build` part, in the characters semver allows.
fn is_plain_version(text: &str) -> bool {
    let (core, build) = text.split_once('+').map_or((text, None), |(core, build)| (core, Some(build)));
    let (core, pre) = core.split_once('-').map_or((core, None), |(core, pre)| (core, Some(pre)));
    let numbers: Vec<&str> = core.split('.').collect();
    let part = |text: &str| {
        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    };

    numbers.len() == 3
        && numbers.iter().all(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
        && pre.is_none_or(part)
        && build.is_none_or(part)
}

/// The running version when the invocation is native, or `None` to delegate.
fn native_context() -> Option<String> {
    if !cfg!(unix) {
        return None;
    }

    let current = env::var("VIS_VERSION").ok().filter(|version| !version.is_empty())?;

    // `CEREBRO_*` settings can change what Node's CLI logs, so any of them leaves the call to Node.
    let cerebro_setting = env::vars_os().any(|(key, _)| key.to_string_lossy().starts_with("CEREBRO_"));

    if cerebro_setting
        || env::var_os("DEBUG").is_some()
        || env::var_os("VIS_MONOREPO_ROOT").is_some()
        || io::stdout().is_terminal()
    {
        return None;
    }

    let cwd = env::current_dir().ok()?;

    crate::advisories::quiet_context(&cwd, &cwd).then_some(current)
}

/// `npm view @visulima/vis version`: the trimmed answer and the stderr text, or `None` when npm cannot
/// be run, fails, or does not answer with a single word.
fn query_latest() -> Option<(String, Vec<u8>)> {
    let output = Command::new("npm")
        .args(["view", PACKAGE, "version"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    // Only ASCII is trimmed or accepted, so JS's `trim` (Node) and this agree on the answer.
    let answer = String::from_utf8(output.stdout).ok()?;
    let answer = answer.trim_matches([' ', '\t', '\r', '\n']);

    (!answer.is_empty() && answer.bytes().all(|byte| byte.is_ascii_graphic()))
        .then(|| (answer.to_owned(), output.stderr))
}

/// What Node's handler prints and does for the running version `current` and the target `latest`.
fn decide(options: &Options, current: &str, latest: &str) -> Verdict {
    let same = current == latest;

    if same && !options.force {
        return Verdict::UpToDate(vec![String::new(), format!("✓ Already up to date ({current})")]);
    }

    if options.check && same {
        return Verdict::UpToDate(vec![format!("✓ Already up to date ({current})")]);
    }

    if options.check {
        Verdict::Found(format!("info: found {PACKAGE}@{latest} (current: {current})"))
    } else {
        Verdict::Install
    }
}

/// One line on stdout, flushed as it is written.
fn say(text: &str) {
    finish_write(write_all(&mut io::stdout().lock(), format!("{text}\n").as_bytes()));
}

fn show_stderr(bytes: &[u8]) {
    if !bytes.is_empty() {
        finish_write(write_all(&mut io::stderr().lock(), bytes));
    }
}

fn write_all(stream: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    stream.write_all(bytes)?;
    stream.flush()
}

/// A closed pipe is not worth reporting; any other write failure is.
fn finish_write(result: io::Result<()>) {
    match result {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {}
        Err(error) => WrapperError::write("self-update", "the output", error).exit(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|text| (*text).to_owned()).collect()
    }

    #[test]
    fn parses_the_plain_shapes() {
        assert_eq!(parse(&args(&["self-update"])), Some(Options::default()));
        assert_eq!(
            parse(&args(&["self-update", "--force", "2.0.0-next.1", "--check", "--silent"])),
            Some(Options { check: true, force: true, version: Some("2.0.0-next.1".to_owned()) })
        );
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["self-update", "--check", "--check"][..],
            &["self-update", "--bogus"],
            &["self-update", "latest"],
            &["self-update", "2"],
            &["self-update", "v2.0.0"],
            &["self-update", "1.0.0", "2.0.0"],
            &["self-update", "--check=true"],
            &["self-update", "--"],
            &["self-update", ""],
            &["self-update", "1.0.0 "],
            &["self-update", "1.0.0-"],
            &["self-update", "--help"],
            &["update"],
        ] {
            assert_eq!(parse(&args(shape)), None, "{shape:?}");
        }
    }

    #[test]
    fn decides_like_the_node_handler() {
        let plain = Options::default();
        let check = Options { check: true, ..Options::default() };
        let force = Options { force: true, ..Options::default() };
        let both = Options { check: true, force: true, version: None };
        let found = "info: found @visulima/vis@2.0.0 (current: 1.0.0)".to_owned();

        assert_eq!(
            decide(&plain, "1.0.0", "1.0.0"),
            Verdict::UpToDate(vec![String::new(), "✓ Already up to date (1.0.0)".to_owned()])
        );
        assert_eq!(
            decide(&check, "1.0.0", "1.0.0"),
            Verdict::UpToDate(vec![String::new(), "✓ Already up to date (1.0.0)".to_owned()])
        );
        assert_eq!(decide(&both, "1.0.0", "1.0.0"), Verdict::UpToDate(vec!["✓ Already up to date (1.0.0)".to_owned()]));
        assert_eq!(decide(&check, "1.0.0", "2.0.0"), Verdict::Found(found));
        assert_eq!(decide(&plain, "1.0.0", "2.0.0"), Verdict::Install);
        assert_eq!(decide(&force, "2.0.0", "2.0.0"), Verdict::Install);
    }
}
