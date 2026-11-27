//! `vis security tripwire [--status|--remove]` — the native port of `src/commands/security/tripwire.ts` for the runs
//! that only read `package.json`: the status report, the "already installed" answer, and the "not present" answer of
//! `--remove`.
//!
//! The command installs a dev dependency with the package manager, or rewrites `package.json` with
//! `JSON.stringify(pkg, null, 2)`. Neither is reproduced: a run that would install, and a `--remove` that would find the
//! package and write the file (key order and number spelling are JavaScript's), go to Node before anything is printed.
//! What is native:
//!
//! - `--status`: `package.json` missing (an error, exit 1), the package listed in `devDependencies` or `dependencies`
//!   with a truthy value, or not listed;
//! - no flag, with the package already listed: one info line;
//! - `--remove`, when neither dependency block holds the package: one info line, and nothing is written.
//!
//! The file is read as Node reads it (`readJsonSync`: a UTF-8 decode that drops a leading byte-order mark, then
//! `JSON.parse`). A read that fails counts as "not installed" there, because the handler catches it, and so it does
//! here; a text this crate cannot parse is Node's, since `serde_json` and `JSON.parse` disagree on a few inputs (a lone
//! surrogate escape, a number outside a double, a depth over 128) and Node would parse it.
//!
//! The context is the one of `security sync`: a unix CI run off a terminal at the root of a pnpm workspace, a config
//! the reader of `security list` reads exactly, and pail's layout decided by the environment.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::js::is_truthy;
use crate::node_context::{any_ancestor_has, ci_root_context, DENO_FILES};
use crate::output::Output;
use crate::pail::{Layout, Level};
use crate::security_list::sync_input;

const PACKAGE: &str = "@lavamoat/preinstall-always-fail";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Install,
    Status,
    Remove,
}

/// What `package.json` is, as far as this command reads it.
enum Manifest {
    /// `isAccessibleSync` is false.
    Absent,
    /// There is a file, and reading it fails (a directory, no permission): the handler's `catch`.
    Unreadable,
    Parsed(Value),
}

/// Answers `vis security tripwire` natively or hands the whole invocation to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok(output) => output.emit("security"),
        Err(reason) => crate::process::delegate_because(&reason, raw_args),
    }
}

fn parse(args: &[String]) -> Option<Mode> {
    match args {
        [security, tripwire] if security == "security" && tripwire == "tripwire" => Some(Mode::Install),
        [security, tripwire, flag] if security == "security" && tripwire == "tripwire" => match flag.as_str() {
            "--status" => Some(Mode::Status),
            "--remove" => Some(Mode::Remove),
            _ => None,
        },
        _ => None,
    }
}

/// The working directory when Node would reach the same answer from the workspace root.
fn context() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;

    (ci_root_context(&cwd) && !any_ancestor_has(&cwd, &DENO_FILES)).then_some(cwd)
}

/// `readJsonSync(package.json)` behind `isAccessibleSync`, or the reason this crate cannot tell what Node sees.
fn read_manifest(cwd: &Path) -> Result<Manifest, String> {
    let path = cwd.join("package.json");

    match fs::metadata(&path) {
        Ok(_) => {}
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Ok(Manifest::Absent);
        }
        Err(error) => return Err(format!("package.json cannot be inspected: {error}")),
    }

    let Ok(bytes) = fs::read(&path) else {
        return Ok(Manifest::Unreadable);
    };

    manifest_from(&bytes).map(Manifest::Parsed)
}

/// The parsed text of `package.json`: the decode of `TextDecoder` (a leading byte-order mark is dropped; bytes that are not
/// UTF-8 become U+FFFD, which this crate does not reproduce) and a strict JSON parse.
fn manifest_from(bytes: &[u8]) -> Result<Value, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "package.json is not UTF-8".to_owned())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);

    serde_json::from_str(text)
        .map_err(|error| format!("package.json does not parse here, and Node may read it: {error}"))
}

/// `pkg.devDependencies?.[PACKAGE] || pkg.dependencies?.[PACKAGE]` is truthy. A value that is not an object has no such
/// property (`null` throws, and the handler's `catch` turns that into "not installed" as well).
fn is_installed(manifest: &Value) -> bool {
    let Value::Object(package) = manifest else {
        return false;
    };

    ["devDependencies", "dependencies"].into_iter().any(|block| match package.get(block) {
        Some(Value::Object(dependencies)) => dependencies.get(PACKAGE).is_some_and(is_truthy),
        _ => false,
    })
}

/// A dependency block that lists the package (`PACKAGE in block`), which `--remove` strips and writes the file for.
fn would_be_removed(manifest: &Value) -> bool {
    let Value::Object(package) = manifest else {
        return false;
    };

    ["devDependencies", "dependencies"].into_iter().any(
        |block| matches!(package.get(block), Some(Value::Object(dependencies)) if dependencies.contains_key(PACKAGE)),
    )
}

fn answer(args: &[String]) -> Result<Output, String> {
    let mode = parse(args).ok_or("not `security tripwire` with `--status`, `--remove` or nothing")?;
    let layout = Layout::detect(args).ok_or("pail's layout is not decided by the environment")?;
    let cwd = context().ok_or("not a CI run at the root of a pnpm workspace")?;

    sync_input(&cwd).ok_or("the config needs Node")?;

    let manifest = read_manifest(&cwd)?;
    let installed = matches!(&manifest, Manifest::Parsed(value) if is_installed(value));
    let mut output = Output::default();
    let lines: Vec<(Level, String)> = match mode {
        Mode::Status if matches!(manifest, Manifest::Absent) => {
            output.exit_code = 1;

            vec![(Level::Error, "No package.json found at the workspace root.".to_owned())]
        }
        Mode::Status if installed => vec![
            (Level::Success, format!("Preinstall tripwire is installed ({PACKAGE}).")),
            (Level::Info, "Removing 'ignore-scripts=true' will cause future installs to fail loudly.".to_owned()),
        ],
        Mode::Status => vec![
            (Level::Warning, "Preinstall tripwire is not installed.".to_owned()),
            (Level::Info, format!("Run 'vis security tripwire' to add {PACKAGE} as a devDependency.")),
        ],
        Mode::Remove if matches!(&manifest, Manifest::Parsed(value) if would_be_removed(value)) => {
            return Err(
                "the package is listed, and removing it rewrites package.json as JavaScript prints it".to_owned()
            );
        }
        Mode::Remove => vec![(Level::Info, format!("{PACKAGE} was not present in package.json."))],
        Mode::Install if installed => vec![(Level::Info, format!("{PACKAGE} is already installed."))],
        Mode::Install => return Err("the package is not installed, so the run installs it".to_owned()),
    };

    for (level, message) in &lines {
        output.say(layout, *level, message);
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    fn parsed(text: &str) -> Value {
        manifest_from(text.as_bytes()).unwrap()
    }

    #[test]
    fn the_three_shapes_are_native() {
        assert_eq!(parse(&args(&["security", "tripwire"])), Some(Mode::Install));
        assert_eq!(parse(&args(&["security", "tripwire", "--status"])), Some(Mode::Status));
        assert_eq!(parse(&args(&["security", "tripwire", "--remove"])), Some(Mode::Remove));
    }

    #[test]
    fn every_other_shape_is_node_s() {
        for shape in [
            &["security", "tripwire", "--status", "--remove"][..],
            &["security", "tripwire", "--status", "--status"],
            &["security", "tripwire", "--status=true"],
            &["security", "tripwire", "--no-status"],
            &["security", "tripwire", "extra"],
            &["security", "tripwire", "--"],
            &["security", "tripwire", "--cwd", "."],
            &["security", "list"],
            &["security"],
        ] {
            assert!(parse(&args(shape)).is_none(), "{shape:?}");
        }
    }

    #[test]
    fn installed_follows_javascript_truthiness_of_either_block() {
        let name = PACKAGE;

        for (text, expected) in [
            (format!(r#"{{"devDependencies":{{"{name}":"^1.0.0"}}}}"#), true),
            (format!(r#"{{"dependencies":{{"{name}":"1"}}}}"#), true),
            (format!(r#"{{"devDependencies":{{"{name}":""}},"dependencies":{{"{name}":"1"}}}}"#), true),
            (format!(r#"{{"devDependencies":{{"{name}":""}}}}"#), false),
            (format!(r#"{{"devDependencies":{{"{name}":0}}}}"#), false),
            (format!(r#"{{"devDependencies":{{"{name}":-0}}}}"#), false),
            (format!(r#"{{"devDependencies":{{"{name}":null}}}}"#), false),
            (format!(r#"{{"devDependencies":{{"{name}":[]}}}}"#), true),
            (format!(r#"{{"devDependencies":"{name}"}}"#), false),
            (format!(r#"{{"devDependencies":["{name}"]}}"#), false),
            (r#"{"devDependencies":{}}"#.to_owned(), false),
            ("[]".to_owned(), false),
            ("null".to_owned(), false),
            ("\"text\"".to_owned(), false),
        ] {
            assert_eq!(is_installed(&parsed(&text)), expected, "{text}");
        }
    }

    #[test]
    fn a_listed_package_is_removed_whatever_its_value() {
        let name = PACKAGE;

        assert!(would_be_removed(&parsed(&format!(r#"{{"devDependencies":{{"{name}":""}}}}"#))));
        assert!(would_be_removed(&parsed(&format!(r#"{{"dependencies":{{"{name}":null}}}}"#))));
        assert!(!would_be_removed(&parsed(&format!(r#"{{"devDependencies":"{name}"}}"#))));
        assert!(!would_be_removed(&parsed(r#"{"devDependencies":{"other":"1"}}"#)));
        assert!(!would_be_removed(&parsed("[]")));
    }

    #[test]
    fn the_text_is_decoded_like_readjsonsync() {
        let with_mark = [b"\xef\xbb\xbf".as_slice(), br#"{"a":1}"#].concat();

        assert!(manifest_from(&with_mark).is_ok());
        assert!(manifest_from(b"\xff{}").is_err());
        assert!(manifest_from(b"").is_err());
        assert!(manifest_from(b"{").is_err());
        // JavaScript reads a lone surrogate escape and a number outside a double; `serde_json` does not.
        assert!(manifest_from(br#"{"a":"\ud800"}"#).is_err());
        assert!(manifest_from(b"1e999").is_err());
    }
}
