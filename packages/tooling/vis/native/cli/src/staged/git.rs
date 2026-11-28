//! The git side of a `staged` run (`src/staged/git/`).
//!
//! The same commands, in the same order, with the same arguments as the Node workflow, because what a run leaves in
//! the index, the working tree and the stash list is the contract. Every call runs `git` from the working tree root on
//! the `PATH` Node's `tinyexec` hands it ([`super::tasks::search_path`]).

use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::js::fill_random;

/// What Node's `git()` wrapper throws for a command that fails.
pub(super) struct Failure {
    pub message: String,
}

pub(super) struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Output {
    /// The standard output as Node reads it: UTF-8, trimmed.
    pub(super) fn text(&self) -> String {
        crate::js::trim(&String::from_utf8_lossy(&self.stdout)).to_owned()
    }
}

/// The `git` of one run.
pub(super) struct Git {
    cwd: PathBuf,
    search: OsString,
}

impl Git {
    pub(super) fn new(cwd: &Path, search: &OsStr) -> Self {
        Self { cwd: cwd.to_owned(), search: search.to_owned() }
    }

    /// Runs `git args`, feeding `input` to its standard input; `None` when it cannot be started.
    pub(super) fn run(&self, args: &[&str], input: Option<&[u8]>) -> Option<Output> {
        let path = super::tasks::resolve("git", &self.search, &self.cwd)?;
        let mut child = Command::new(path)
            .arg0("git")
            .args(args)
            .current_dir(&self.cwd)
            .env("PATH", &self.search)
            .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;

        // The input is small next to the pipe's buffer for the path lists this sends; a writer thread keeps a long
        // one from blocking on a child that is writing too.
        let writer = input.map(|bytes| {
            let mut stdin = child.stdin.take();
            let bytes = bytes.to_vec();

            std::thread::spawn(move || {
                if let Some(stdin) = stdin.as_mut() {
                    let _ = stdin.write_all(&bytes);
                }
            })
        });
        let output = child.wait_with_output().ok()?;

        if let Some(writer) = writer {
            let _ = writer.join();
        }

        Some(Output { code: output.status.code().unwrap_or(1), stdout: output.stdout, stderr: output.stderr })
    }

    /// `git()`: the output of a command that succeeded, the failure Node would throw otherwise.
    pub(super) fn checked(&self, args: &[&str], input: Option<&[u8]>) -> Result<Output, Failure> {
        let Some(output) = self.run(args, input) else {
            return Err(Failure {
                message: format!("git {} failed with exit code 1: spawn git ENOENT", args.join(" ")),
            });
        };

        if output.code != 0 {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let preview: String = if stderr.chars().count() > 2048 {
                format!("{}\u{2026}", stderr.chars().take(2048).collect::<String>())
            } else {
                stderr.into_owned()
            };

            return Err(Failure {
                message: format!(
                    "git {} failed with exit code {}: {}",
                    args.join(" "),
                    output.code,
                    crate::js::trim(&preview)
                ),
            });
        }

        Ok(output)
    }

    /// `gitOut()`: trimmed standard output of a command that succeeded.
    pub(super) fn out(&self, args: &[&str]) -> Result<String, Failure> {
        self.checked(args, None).map(|output| output.text())
    }
}

/// `stdout.split("\u0000").filter((item) => item.length > 0)`.
pub(super) fn split_nul(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes).split('\0').filter(|item| !item.is_empty()).map(str::to_owned).collect()
}

/// `getFiles`: the paths of the diff (the index against `HEAD`, or the range of `--diff`), relative to the working
/// tree. `None` when git rejects the range.
pub(super) fn staged_files(git: &Git, diff: Option<&str>) -> Option<Vec<Vec<u8>>> {
    let mut args = vec!["diff", "--name-only", "-z", "--diff-filter=ACMR"];

    args.push(diff.unwrap_or("--staged"));

    let output = git.run(&args, None)?;

    (output.code == 0)
        .then(|| output.stdout.split(|byte| *byte == 0).filter(|item| !item.is_empty()).map(<[u8]>::to_vec).collect())
}

/// Whether the index holds an unmerged entry (a conflict). Node's calls on such an index fail in ways it prints a
/// stack trace for.
pub(super) fn has_unmerged(git: &Git) -> Option<bool> {
    let output = git.run(&["ls-files", "-u", "-z"], None)?;

    (output.code == 0).then_some(!output.stdout.is_empty())
}

/// `getPartiallyStagedFiles`: the worktree-relative paths with both a staged and an unstaged change. Renames and
/// copies use two records, whose second one holds the old path.
pub(super) fn partially_staged(git: &Git) -> Option<Vec<String>> {
    let output = git.run(&["status", "--porcelain=v1", "-z"], None)?;

    if output.code != 0 {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let records: Vec<&str> = text.split('\0').collect();
    let mut partial = Vec::new();
    let mut index = 0;

    while index < records.len() {
        let record = records[index];
        let characters: Vec<char> = record.chars().collect();

        if characters.len() >= 4 {
            let (staged, worktree) = (characters[0], characters[1]);
            let path: String = characters[3..].iter().collect();
            let consumes_next = matches!(staged, 'R' | 'C') || matches!(worktree, 'R' | 'C');

            if !matches!(staged, ' ' | '?') && !matches!(worktree, ' ' | '?') {
                partial.push(path);
            }

            if consumes_next {
                index += 1;
            }
        }

        index += 1;
    }

    Some(partial)
}

/// `getIntentToAddPaths`: the paths marked with `git add -N`, which `git diff-files --raw` lists as an addition whose
/// new blob is all zeros.
pub(super) fn intent_to_add(git: &Git) -> Option<Vec<String>> {
    let output = git.run(&["diff-files", "--raw", "-z"], None)?;

    if output.code != 0 {
        return None;
    }

    let tokens = split_nul(&output.stdout);
    let mut paths = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let header = &tokens[index];

        if let Some(fields) = header.strip_prefix(':') {
            let parts: Vec<&str> = fields.split(' ').collect();
            let path = tokens.get(index + 1);

            index += 1;

            if let (Some(destination), Some(status), Some(path)) = (parts.get(3), parts.get(4), path) {
                if *status == "A" && !destination.is_empty() && destination.bytes().all(|byte| byte == b'0') {
                    paths.push(path.clone());
                }
            }
        }

        index += 1;
    }

    Some(paths)
}

/// The message of the backup stash: `vis_staged_automatic_backup-<pid>-<ms>-<6 hex digits>`.
pub(super) fn backup_message() -> String {
    let mut bytes = [0u8; 16];
    let _ = fill_random(&mut bytes);
    let milliseconds =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());

    format!(
        "vis_staged_automatic_backup-{}-{milliseconds}-{:02x}{:02x}{:02x}",
        std::process::id(),
        bytes[0],
        bytes[1],
        bytes[2]
    )
}

/// `createBackupStash`: `stash create` and `stash store`, so the working tree and the index stay as they are. `None`
/// when there is nothing to stash.
pub(super) fn create_backup(git: &Git) -> Result<Option<String>, Failure> {
    let sha = git.out(&["stash", "create"])?;

    if sha.is_empty() {
        return Ok(None);
    }

    git.checked(&["stash", "store", "-m", &backup_message(), &sha], None)?;

    Ok(Some(sha))
}

/// `findStashRefBySha`, then the re-check of `resolveDroppableRef`, then the drop: removes the stash entry that
/// resolves to `sha`, when there is one.
pub(super) fn drop_backup(git: &Git, sha: &str) -> Result<(), Failure> {
    let Some(listing) = git.run(&["reflog", "--format=%H %gd", "refs/stash"], None).filter(|output| output.code == 0)
    else {
        return Ok(());
    };

    let listing = String::from_utf8_lossy(&listing.stdout).into_owned();
    let reference = listing.split(['\r', '\n']).find_map(|line| {
        let mut words = line.split_whitespace();

        match (words.next(), words.next()) {
            (Some(entry), Some(reference)) if entry == sha => Some(reference.to_owned()),
            _ => None,
        }
    });
    let Some(reference) = reference else { return Ok(()) };
    let confirmed = git
        .run(&["rev-parse", "--verify", "--quiet", &reference], None)
        .is_some_and(|output| output.code == 0 && output.text() == sha);

    if !confirmed {
        return Ok(());
    }

    git.checked(&["stash", "drop", "--quiet", &reference], None).map(|_| ())
}

/// `applyBackupStash`: puts the index and the working tree back from the backup.
pub(super) fn apply_backup(git: &Git, sha: &str) -> Result<(), Failure> {
    let reachable = git
        .run(&["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")], None)
        .is_some_and(|output| output.code == 0);

    if !reachable {
        return Err(Failure {
            message: format!("Backup stash {sha} is no longer reachable \u{2014} can't revert working tree."),
        });
    }

    git.checked(&["reset", "--hard", "HEAD"], None)?;
    git.checked(&["stash", "apply", "--index", "--quiet", sha], None).map(|_| ())
}

/// `readBackupTrees` and the snapshot of `releaseBackupIfRestored`: whether the working tree and the index hold exactly
/// what the backup holds.
pub(super) fn backup_is_restored(git: &Git, sha: &str) -> Result<bool, Failure> {
    let worktree = git.out(&["rev-parse", &format!("{sha}^{{tree}}")])?;
    let index = git.out(&["rev-parse", &format!("{sha}^2^{{tree}}")])?;
    // Sequential on purpose: two git commands at once fight over `index.lock`.
    let snapshot = git.out(&["stash", "create"])?;
    let snapshot_tree =
        if snapshot.is_empty() { String::new() } else { git.out(&["rev-parse", &format!("{snapshot}^{{tree}}")])? };
    let index_tree = git.out(&["write-tree"])?;

    Ok(snapshot_tree == worktree && index_tree == index)
}

/// `updateIndexAgain`: `update-index --again` (a failure is fine: a deleted path falls through to `add -u`), then
/// `add -u` over the staged paths.
pub(super) fn update_index_again(git: &Git, paths: &[String]) -> Result<(), Failure> {
    let _ = git.run(&["update-index", "--again"], None);

    if paths.is_empty() {
        return Ok(());
    }

    let pathspec = nul_terminated(paths);

    git.checked(&["add", "-u", "--pathspec-from-file=-", "--pathspec-file-nul", "--"], Some(pathspec.as_bytes()))
        .map(|_| ())
}

pub(super) fn nul_terminated(paths: &[String]) -> String {
    format!("{}\0", paths.join("\0"))
}

/// The MERGE_* files of the git directory, as `snapshotMergeState` reads them.
pub(super) const MERGE_FILES: [&str; 3] = ["MERGE_HEAD", "MERGE_MODE", "MERGE_MSG"];

/// `restoreMergeState` for a run that started with none of the files: removes what the tasks left behind.
pub(super) fn remove_merge_state(git_directory: &Path) {
    for name in MERGE_FILES {
        let _ = std::fs::remove_file(git_directory.join(name));
    }
}
