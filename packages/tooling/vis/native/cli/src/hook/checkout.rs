//! What `hook validate`, `hook install` and `hook uninstall` read from git: `core.hooksPath` and the checkouts of the
//! repository (`checkoutRoots` and `readRepoHooksPath` in `src/commands/hook/install.ts`). Every call only reads.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What `git <args>` printed in `directory`.
pub(super) enum Git {
    /// It exited non-zero: the handler falls back to a default or reports an issue.
    Failed,
    /// It did not start (no `git` on `PATH`).
    Unavailable,
    /// Its trimmed standard output.
    Text(String),
}

/// Runs `git <args>` in `directory`. `None` when it printed text that is not ASCII, which the handlers read as UTF-8 and
/// this module does not reproduce.
pub(super) fn git(directory: &Path, args: &[&str]) -> Option<Git> {
    let Ok(output) = Command::new("git").args(args).current_dir(directory).stderr(Stdio::null()).output() else {
        return Some(Git::Unavailable);
    };

    if !output.status.success() {
        return Some(Git::Failed);
    }

    if !output.stdout.is_ascii() {
        return None;
    }

    Some(Git::Text(String::from_utf8(output.stdout).ok()?.trim().to_owned()))
}

/// A `core.hooksPath` that names the hooks directory's dispatcher the way the handlers expect, as a plain relative
/// path (no empty, `.` or `..` segment, which `join` would normalise).
pub(super) fn expected_hooks_path(configured: &str, hooks_directory: &str) -> bool {
    let expected = format!("{hooks_directory}/_");

    (configured == expected || configured.ends_with(&format!("/{expected}")))
        && configured.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// `checkoutRoots` (`src/commands/hook/install.ts`): the checkouts of the repository that exist, or `top_level`.
pub(super) fn checkout_roots(top_level: &Path) -> Option<Vec<PathBuf>> {
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

/// `parseScopedValue`: the value of `git config --show-scope --get`, which counts only when it was set by the repository's
/// own scopes (`local` or `worktree`).
fn scoped_value(output: &str) -> String {
    let Some((scope, value)) = output.split_once('\t') else {
        return String::new();
    };

    if scope == "local" || scope == "worktree" {
        value.trim_end().to_owned()
    } else {
        String::new()
    }
}

/// `readRepoHooksPath`: the `core.hooksPath` this checkout runs with from its repository-level scopes, `""` when it is
/// unset or set only globally or system-wide. `None` when git answers in a way the handler reads through another path (a
/// git older than `--show-scope`, a git that did not start, text that is not ASCII).
pub(super) fn repository_hooks_path(directory: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["config", "--show-scope", "--get", "core.hooksPath"])
        .current_dir(directory)
        .stderr(Stdio::null())
        .output()
        .ok()?;

    match output.status.code()? {
        0 if output.stdout.is_ascii() => Some(scoped_value(&String::from_utf8(output.stdout).ok()?)),
        1 => Some(String::new()),
        _ => None,
    }
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

    #[test]
    fn only_a_value_the_repository_set_counts() {
        assert_eq!(scoped_value("local\t.vis/hooks/_\n"), ".vis/hooks/_");
        assert_eq!(scoped_value("worktree\t.vis/hooks/_"), ".vis/hooks/_");
        assert_eq!(scoped_value("global\t.vis/hooks/_"), "");
        assert_eq!(scoped_value("system\t/etc/hooks"), "");
        assert_eq!(scoped_value("no tab here"), "");
        assert_eq!(scoped_value(""), "");
    }
}
