//! `vis hook uninstall` — the native fast path for a `core.hooksPath` that names the vis dispatcher.
//!
//! The Node handler (`src/commands/hook/{handler,uninstall}.ts`) reads `core.hooksPath`, unsets it, and removes the
//! directory it named in every checkout of the repository. In a CI context it prints two plain lines. This module does
//! the same and prints the same lines. It also answers the repository that has no `core.hooksPath` at all, which
//! prints "No custom hooks path configured" and changes nothing.
//!
//! Node removes whatever the configured value names, in each checkout. So the run is native only when the value is a
//! plain relative path ending in `<dir>/_` (or empty, which Node reads as that default), and when every dispatcher
//! that exists is a real directory this process may remove, which is checked before `core.hooksPath` is unset: once
//! the key is gone Node would see a repository with nothing to uninstall, so a hand-off after it would answer another
//! question. Everything else goes to Node before anything is printed or changed.
//!
//! A removal can still fail after it passed that check (a file made immutable, or a directory changed by another
//! process in between). Node words that with its own error text, so the key is set back to the value it had and the
//! run goes to Node, which then unsets it again and removes what is left; the files it removes are the same ones.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::process::{exit, Command, Stdio};

use super::checkout::{checkout_roots, expected_hooks_path, git, Git};
use super::common::parse;
use crate::implode::removable_directory;
use crate::node_context::context_is_native;
use crate::output::write_stdout;

fn say(line: &str) -> String {
    format!("Removing git hooks...\n{line}\n")
}

/// The text Node prints, after the dispatchers are removed; `None` when Node has to answer.
fn uninstall(args: &[String]) -> Option<String> {
    let directory = parse(args, "uninstall")?;

    if !context_is_native() {
        return None;
    }

    let cwd = env::current_dir().ok()?;

    // A failed or missing `git` both read as "no hooks path" in the handler.
    let configured = match git(&cwd, &["config", "--local", "core.hooksPath"])? {
        Git::Failed | Git::Unavailable => return Some(say("No custom hooks path configured")),
        Git::Text(value) => value,
    };
    let target = if configured.is_empty() { format!("{directory}/_") } else { configured.clone() };

    if !expected_hooks_path(&target, &directory) {
        return None;
    }

    let mut dispatchers: Vec<PathBuf> = Vec::new();

    for root in checkout_roots(&cwd)? {
        let dispatcher = root.join(&target);

        // `isAccessibleSync`: a path that cannot be reached (a dangling link included) is skipped.
        if fs::metadata(&dispatcher).is_err() {
            continue;
        }

        let parent = dispatcher.parent()?;

        // `rmSync` of a link removes the link, and of a file the file; only a real directory is handled here.
        if !fs::symlink_metadata(&dispatcher).ok()?.is_dir() || !removable_directory(&dispatcher, parent) {
            return None;
        }

        dispatchers.push(dispatcher);
    }

    let status = Command::new("git")
        .args(["config", "--local", "--unset", "core.hooksPath"])
        .current_dir(&cwd)
        .stderr(Stdio::null())
        .status()
        .ok()?;

    // 5 is "the key is not there", which Node accepts.
    if !status.success() && status.code() != Some(5) {
        return None;
    }

    // Every dispatcher is tried, as Node does, so this does not stop at the first failure.
    let mut removal_failed = false;

    for dispatcher in dispatchers.iter().filter(|dispatcher| fs::metadata(dispatcher).is_ok()) {
        removal_failed |= fs::remove_dir_all(dispatcher).is_err();
    }

    if !removal_failed {
        return Some(say("Git hooks removed successfully."));
    }

    // Node's own warning names the error in its words: give it the repository as it was found.
    Command::new("git")
        .args(["config", "--local", "core.hooksPath", &configured])
        .current_dir(&cwd)
        .stderr(Stdio::null())
        .status()
        .ok()?;

    None
}

/// Answers `vis hook uninstall` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(text) = uninstall(args) else { crate::process::delegate(raw_args) };

    write_stdout("hook", "the hook removal", &text);

    exit(0);
}
