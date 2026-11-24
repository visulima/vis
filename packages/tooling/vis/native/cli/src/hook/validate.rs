//! `vis hook validate` — the native fast path for a hooks directory with nothing to report.
//!
//! The Node handler (`src/commands/hook/validate.ts`) checks `core.hooksPath`, the dispatcher directory of every
//! checkout, each stage script (owner-executable, `sh -n`) and `config.json`, and logs one line per issue. A warning
//! or an error is logged through pail and ends in a thrown `Error` with a stack trace, which only Node reproduces. So
//! the binary answers the one verdict that has no issue ("looks good", exit 0) and hands every other outcome to Node
//! before it prints anything. The checks only read (`git config`, `git rev-parse`, `git worktree list`, `sh -n`),
//! so a hand-off after them has no effect to undo.
//!
//! It also hands over what [`super::list`] hands over for the arguments and the context, a `core.hooksPath` that is
//! not a plain relative path (the handler joins and normalises it), and any `config.json` that [`super::config`]
//! does not accept (Node words that error).

use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};

use serde_json::Value;

use super::config;
use super::list::{context_is_native, parse, STAGES};
use crate::output::write_stdout;

/// Entries of the hooks directory that are neither stage scripts nor an issue.
const IGNORED_ENTRIES: [&str; 3] = ["_", "config.json", "README.md"];

/// What `git <args>` printed in `directory`.
enum Git {
    /// It exited non-zero or did not start: the handler falls back to a default or reports an issue.
    Failed,
    /// Its trimmed standard output.
    Text(String),
}

/// Runs `git <args>` in `directory`. `None` when it printed text that is not ASCII, which the handler reads as UTF-8 and
/// this module does not reproduce.
fn git(directory: &Path, args: &[&str]) -> Option<Git> {
    let Ok(output) = Command::new("git").args(args).current_dir(directory).stderr(Stdio::null()).output() else {
        return Some(Git::Failed);
    };

    if !output.status.success() {
        return Some(Git::Failed);
    }

    if !output.stdout.is_ascii() {
        return None;
    }

    Some(Git::Text(String::from_utf8(output.stdout).ok()?.trim().to_owned()))
}

/// A `core.hooksPath` that names the hooks directory's dispatcher the way the handler expects, as a plain relative
/// path (no empty, `.` or `..` segment, which `join` would normalise).
fn expected_hooks_path(configured: &str, hooks_directory: &str) -> bool {
    let expected = format!("{hooks_directory}/_");

    (configured == expected || configured.ends_with(&format!("/{expected}")))
        && configured.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// `checkoutRoots` (`src/commands/hook/install.ts`): the checkouts of the repository that exist, or `top_level`.
fn checkout_roots(top_level: &Path) -> Option<Vec<PathBuf>> {
    let mut roots: Vec<String> = Vec::new();

    if let Git::Text(listing) = git(top_level, &["worktree", "list", "--porcelain"])? {
        let mut current: Option<String> = None;

        for line in listing.split('\n') {
            if let Some(path) = line.strip_prefix("worktree ") {
                current = Some(path.trim().to_owned()).filter(|path| !path.is_empty());
            } else if line == "bare" || line == "locked" || line.starts_with("locked ") || line.starts_with("prunable")
            {
                current = None;
            } else if line.is_empty() {
                roots.extend(current.take());
            }
        }

        roots.extend(current);
    }

    let present: Vec<PathBuf> = roots.into_iter().map(PathBuf::from).filter(|root| root.exists()).collect();

    Some(if present.is_empty() { vec![top_level.to_path_buf()] } else { present })
}

/// Whether `sh -n` accepts the script.
fn shell_accepts(script: &Path) -> bool {
    Command::new("sh")
        .arg("-n")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Whether every stage script of `directory` is owner-executable and passes `sh -n`, and whether there was one; `None`
/// when the directory holds an entry the handler warns about or one that cannot be read.
fn scripts_are_clean(directory: &Path) -> Option<bool> {
    let mut saw_stage_script = false;

    for entry in fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;

        if name.starts_with('.') || IGNORED_ENTRIES.contains(&name) {
            continue;
        }

        if !STAGES.contains(&name) {
            return None;
        }

        let metadata = fs::metadata(entry.path()).ok()?;

        if !metadata.is_file() {
            continue;
        }

        saw_stage_script = true;

        if metadata.permissions().mode() & 0o100 == 0 || !shell_accepts(&entry.path()) {
            return None;
        }
    }

    Some(saw_stage_script)
}

/// Whether the handler finds no issue for `root` and `hooks_directory`.
fn is_clean(root: &Path, hooks_directory: &str) -> Option<()> {
    let Git::Text(configured) = git(root, &["config", "--local", "core.hooksPath"])? else { return None };

    if !expected_hooks_path(&configured, hooks_directory) {
        return None;
    }

    let top_level = match git(root, &["rev-parse", "--show-toplevel"])? {
        Git::Text(path) if !path.is_empty() => PathBuf::from(path),
        _ => root.to_path_buf(),
    };

    for checkout in checkout_roots(&top_level)? {
        if !checkout.join(&configured).exists() {
            return None;
        }
    }

    let directory = root.join(hooks_directory);

    if !directory.exists() {
        return None;
    }

    if scripts_are_clean(&directory)? {
        let text = fs::read_to_string(directory.join("config.json")).ok()?;

        config::parse(&serde_json::from_str::<Value>(&text).ok()?)?;
    }

    Some(())
}

/// The text Node prints, or `None` when Node has to answer.
fn answer(args: &[String]) -> Option<String> {
    let hooks_directory = parse(args, "validate")?;

    if !context_is_native() {
        return None;
    }

    is_clean(&std::env::current_dir().ok()?, &hooks_directory)?;

    Some(format!("Hook directory {hooks_directory}/ looks good.\n"))
}

/// Answers `vis hook validate` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(text) = answer(args) else { crate::delegate(raw_args) };

    write_stdout("hook", "the hook validation", &text);

    exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hooks_path_must_name_the_dispatcher_of_the_hooks_directory() {
        assert!(expected_hooks_path(".vis/hooks/_", ".vis/hooks"));
        assert!(expected_hooks_path("packages/app/.vis/hooks/_", ".vis/hooks"));
        assert!(!expected_hooks_path(".githooks/_", ".vis/hooks"));
        assert!(!expected_hooks_path("x.vis/hooks/_", ".vis/hooks"));
        assert!(!expected_hooks_path("/abs/.vis/hooks/_", ".vis/hooks"));
        assert!(!expected_hooks_path("a/../.vis/hooks/_", ".vis/hooks"));
        assert!(!expected_hooks_path("./.vis/hooks/_", ".vis/hooks"));
    }
}
