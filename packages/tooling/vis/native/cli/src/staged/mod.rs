//! `vis staged` — the native path for a plain-command config.
//!
//! The Node command (`src/commands/staged/handler.ts`, `src/staged/`) takes the staged files, matches them against the
//! patterns of the `staged` block of `vis.config`, makes a backup stash, runs each pattern's commands over its files,
//! re-stages what the commands changed, and drops the backup (or keeps it, and says so, when the run failed). Its output
//! is the plain renderer's lines on stderr, and its result is the exit status plus the state of the index, the working
//! tree and the stash list.
//!
//! The binary answers a run only when it can reproduce all of that, and it decides before it changes anything: the
//! whole of [`prepare`] reads and never writes, and a `None` from it hands the invocation to Node untouched. What it
//! answers (everything else is Node's):
//!
//! - unix, a CI run off a terminal at the root of a pnpm workspace that is also the root of the git repository, with none
//!   of the settings that change what Node prints (`config_context_is_native`);
//! - the options of [`args`], which also require `--diff <range>` or `--quiet`, because an emptied commit makes Node
//!   print a stack trace (`ApplyEmptyCommitError`) that names the files of its bundle, and only those two runs cannot
//!   reach it;
//! - a `vis.config` that is a literal holding nothing but `staged` and keys no staged run reads, whose `staged` block
//!   maps patterns of the subset [`glob`] matches to command strings (or lists of them), with the keys in plain order;
//! - commands that split into words, whose program exists on the search path and runs without a shell ([`tasks`]);
//! - one effective worker: one matching pattern, or `--concurrent false` / `1`. With several the lines of Node's output
//!   follow the order the tasks finish in;
//! - files that are valid UTF-8, none of them partially staged (Node would hide the unstaged part with a patch,
//!   `git checkout` and `git apply`), no intent-to-add entry, no conflict, no merge in progress and a repository with
//!   a commit.
//!
//! What it does not reproduce, and where it differs from Node:
//!
//! - an error the git commands raise in the middle of a `--diff` run that is not quiet (they only fail on a broken
//!   repository): Node prints the message and a stack trace, the binary prints the message in red and exits 1. A quiet
//!   run prints the message alone in both;
//! - a signal sent to the process: the backup stash stays where it is, which is the safe state, but Node's warning and
//!   its orderly cleanup are not reproduced;
//! - `�` where a task's output holds a multi-byte character that Node's stream decoder splits across two chunks.

mod args;
mod git;
mod glob;
mod render;
mod tasks;

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::exit;

use oxc_ast::ast::Expression;
use serde_json::Value;

use crate::config_workspace::{module_config, INERT};
use crate::js::{is_index_like, trim};
use crate::node_context::config_context_is_native;
use crate::term::piped_stdout_colour_level;
use crate::vis_config::{convert_default_export, object_properties};
use args::{Concurrency, Options};
use git::{Failure, Git};
use render::{Renderer, Status};

/// The variable Node reads the concurrency from when `--concurrent` is not given.
const CONCURRENT_ENV_VAR: &str = "VIS_STAGED_CONCURRENT";

/// The oldest git the Node workflow accepts.
const MIN_GIT: (u32, u32) = (2, 32);

/// One command of a pattern.
struct Task {
    title: String,
    words: Vec<String>,
}

/// A pattern of the config that matched at least one file.
struct Pattern {
    title: String,
    /// The files as the commands get them: absolute, or relative with `--relative`.
    files: Vec<String>,
    tasks: Vec<Task>,
}

/// A run the binary answers, with everything it read.
struct Plan {
    options: Options,
    cwd: PathBuf,
    search: OsString,
    git_directory: PathBuf,
    /// The paths of the run, relative to the working tree.
    staged: Vec<String>,
    patterns: Vec<Pattern>,
    colour: bool,
}

/// The `staged` entries of the config in the order the file lists them, with the commands of each: `None` for any
/// shape that is not a literal Node reads the same way.
fn staged_entries(path: &Path, config: &Value) -> Option<Vec<(String, Vec<String>)>> {
    let object = config.as_object()?;

    if !object.keys().all(|key| key == "staged" || key == "$schema" || INERT.contains(&key.as_str())) {
        return None;
    }

    let blocks = object.get("staged")?.as_object()?;

    let order: Vec<String> = convert_default_export(path, |config| {
        let Expression::ObjectExpression(config) = config else { return None };
        let properties = object_properties(config)?;
        let names: HashSet<&String> = properties.iter().map(|(name, _)| name).collect();

        // A key that is listed twice is read once by Node, at the position of its first listing and with its last value.
        if names.len() != properties.len() {
            return None;
        }

        let (_, staged) = properties.into_iter().find(|(name, _)| name == "staged")?;
        let Expression::ObjectExpression(staged) = staged else { return None };

        Some(object_properties(staged)?.into_iter().map(|(name, _)| name).collect())
    })?;

    if order.is_empty() || order.len() != blocks.len() || order.iter().collect::<HashSet<_>>().len() != order.len() {
        return None;
    }

    order
        .into_iter()
        .map(|pattern| {
            if is_index_like(&pattern) || trim(&pattern).is_empty() {
                return None;
            }

            let mut commands = Vec::new();

            collect_commands(blocks.get(&pattern)?, &mut commands)?;

            Some((pattern, commands))
        })
        .collect()
}

/// The command strings of a task: a string, or a list of tasks. An object or a function (which a literal config
/// cannot hold anyway) and a blank string or an empty list, which Node rejects as a configuration error, are `None`.
fn collect_commands(task: &Value, commands: &mut Vec<String>) -> Option<()> {
    match task {
        Value::String(command) if !trim(command).is_empty() => commands.push(command.clone()),
        Value::Array(items) if !items.is_empty() => {
            for item in items {
                collect_commands(item, commands)?;
            }
        }
        _ => return None,
    }

    Some(())
}

/// `isFsCaseSensitive`: whether the working directory is on a file system that tells `/A` from `/a`. It asks whether the
/// path with every letter's case inverted exists. `None` where Node would write a probe file instead (no letter in
/// the path) or the path is not ASCII.
fn is_case_sensitive(cwd: &Path) -> Option<bool> {
    let text = cwd.to_str().filter(|text| text.is_ascii())?;
    let inverted: String = text
        .chars()
        .map(|character| {
            if character.is_ascii_uppercase() {
                character.to_ascii_lowercase()
            } else {
                character.to_ascii_uppercase()
            }
        })
        .collect();

    (inverted != text && cwd.exists()).then(|| !Path::new(&inverted).exists())
}

/// `(major, minor)` of `git --version`, as `parseGitVersion` reads it.
fn git_version(text: &str) -> Option<(u32, u32)> {
    let rest = text.split("git version ").nth(1)?;
    let mut numbers = rest.split(|character: char| !character.is_ascii_digit());
    let major = numbers.next()?.parse().ok()?;
    let minor = numbers.next()?.parse().ok()?;

    Some((major, minor))
}

/// Everything the run needs, read without changing anything, or `None` when Node must answer.
fn prepare(args: &[String]) -> Option<Plan> {
    let options = args::parse(args)?;

    if env::var_os(CONCURRENT_ENV_VAR).is_some() || !config_context_is_native() {
        return None;
    }

    let colour = piped_stdout_colour_level(args)? > 0;
    let cwd = env::current_dir().ok()?;
    let (path, config) = module_config(&cwd)?;
    let entries = staged_entries(&path, &config)?;
    let search = tasks::search_path(&cwd)?;
    let git = Git::new(&cwd, &search);

    let inside = git.run(&["rev-parse", "--is-inside-work-tree"], None)?;

    if inside.code != 0 || inside.text() != "true" || git_version(&git.out(&["--version"]).ok()?)? < MIN_GIT {
        return None;
    }

    // The commands below run from the repository root, and the matching, the paths and the file view all take the
    // working directory for it.
    if git.out(&["rev-parse", "--show-toplevel"]).ok()? != cwd.to_str()? {
        return None;
    }

    let git_directory = PathBuf::from(git.out(&["rev-parse", "--absolute-git-dir"]).ok()?);

    // No commit yet: `git stash create` and `git diff HEAD` fail.
    if git.run(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], None)?.code != 0 {
        return None;
    }

    let staged: Vec<String> = git::staged_files(&git, options.diff.as_deref())?
        .into_iter()
        .map(|path| String::from_utf8(path).ok())
        .collect::<Option<_>>()?;
    let partial = if staged.is_empty() { Vec::new() } else { git::partially_staged(&git)? };

    if git::MERGE_FILES.iter().any(|name| git_directory.join(name).exists())
        || git::has_unmerged(&git)?
        || !git::intent_to_add(&git)?.is_empty()
    {
        return None;
    }

    // Node hides the unstaged part of a partially staged file before the tasks run, and warns when it makes no backup
    // (`--no-stash`, or a `--diff` run) next to one.
    let makes_backup = !options.no_stash && options.diff.is_none();

    if staged.iter().any(|path| partial.contains(path)) || (!makes_backup && !partial.is_empty()) {
        return None;
    }

    let fold_case = !is_case_sensitive(&cwd)?;

    if fold_case && !staged.iter().all(|path| path.is_ascii()) {
        return None;
    }

    let mut patterns = Vec::new();

    for (pattern, commands) in entries {
        let glob = glob::compile(&pattern, fold_case)?;
        let matched: Vec<&String> = staged
            .iter()
            .filter(|path| {
                let candidate = if glob.basename { path.rsplit('/').next().unwrap_or(path) } else { path.as_str() };

                if fold_case {
                    glob.is_match(&candidate.to_ascii_lowercase())
                } else {
                    glob.is_match(candidate)
                }
            })
            .collect();

        if matched.is_empty() {
            continue;
        }

        let files = matched
            .iter()
            .map(
                |path| {
                    if options.relative {
                        Some((*path).clone())
                    } else {
                        cwd.join(path).to_str().map(str::to_owned)
                    }
                },
            )
            .collect::<Option<Vec<_>>>()?;
        let mut tasks = Vec::new();

        for command in commands {
            let words = tasks::split_command(&command).filter(|words| !words.is_empty())?;

            // A program that is not there now may be made by an earlier task; Node handles that run.
            tasks::resolve(&words[0], &search, &cwd)?;
            tasks.push(Task { title: command, words });
        }

        let count = matched.len();

        patterns.push(Pattern {
            title: format!("{pattern} \u{2014} {count} file{}", if count == 1 { "" } else { "s" }),
            files,
            tasks,
        });
    }

    // With several workers the lines come in the order the tasks finish in.
    if patterns.len() > 1 && !matches!(options.concurrency, Concurrency::Serial | Concurrency::Limit(1)) {
        return None;
    }

    Some(Plan { options, cwd, search, git_directory, staged, patterns, colour })
}

/// The state of a run.
struct Run<'a> {
    plan: &'a Plan,
    git: Git,
    renderer: Renderer,
    /// The sha of the backup stash, while it exists.
    backup: Option<String>,
    revert_applied: bool,
}

impl Run<'_> {
    /// `revert`: the index and the working tree back from the backup, which is then dropped. Nothing to do without one.
    fn revert(&mut self) -> Result<(), Failure> {
        let Some(sha) = self.backup.clone() else { return Ok(()) };

        git::apply_backup(&self.git, &sha).map_err(|_| Failure {
            message: "Revert failed while restoring the backup stash. Use `git stash list` to recover manually."
                .to_owned(),
        })?;
        git::drop_backup(&self.git, &sha)?;
        self.backup = None;
        self.revert_applied = true;

        Ok(())
    }

    /// `runTasks` for one worker: the patterns one after the other, their commands in order, and once a command has
    /// failed every later one is shown as skipped. Whether the run succeeded.
    fn run_tasks(&self) -> bool {
        let mut cancelled = false;

        for pattern in &self.plan.patterns {
            if cancelled {
                for task in &pattern.tasks {
                    self.renderer.command_end(&task.title, Status::Skipped, 0, None, None);
                }

                self.renderer.pattern_end(&pattern.title, Status::Skipped);

                continue;
            }

            self.renderer.pattern_start(&pattern.title);

            let mut status = Status::Success;

            for task in &pattern.tasks {
                if cancelled {
                    self.renderer.command_end(&task.title, Status::Skipped, 0, None, None);

                    if status == Status::Success {
                        status = Status::Skipped;
                    }

                    continue;
                }

                self.renderer.command_start(&task.title);

                let outcome = tasks::run(&task.words, &pattern.files, &self.plan.cwd, &self.plan.search);

                if outcome.failed {
                    // Only a command that ran and ended badly has its message printed twice: as the error and as the output.
                    let output = outcome.task_error.then_some(outcome.text.as_str());

                    self.renderer.command_end(
                        &task.title,
                        Status::Failed,
                        outcome.duration_ms,
                        Some(&outcome.text),
                        output,
                    );

                    cancelled = true;
                    status = Status::Failed;

                    break;
                }

                let output = self.plan.options.verbose.then_some(outcome.text.as_str());

                self.renderer.command_end(&task.title, Status::Success, outcome.duration_ms, None, output);
            }

            self.renderer.pattern_end(&pattern.title, status);
        }

        !cancelled
    }

    /// What follows the tasks: for a run on the index, `applyModifications` and the empty-commit check; on a failed
    /// run, the `--revert` option. Returns whether the run succeeded.
    fn finish_tasks(&mut self, ran_ok: bool, head_tree: &str) -> Result<bool, Failure> {
        if !ran_ok {
            if self.plan.options.revert {
                self.renderer.info("Reverting working tree from backup stash.");
                self.revert()?;
            }

            return Ok(false);
        }

        // A range has no index to refresh and no commit to empty.
        if self.plan.options.diff.is_some() {
            return Ok(true);
        }

        git::update_index_again(&self.git, &self.plan.staged)?;

        let post_tree = self.git.out(&["write-tree"])?;

        if !post_tree.is_empty() && !head_tree.is_empty() && post_tree == head_tree {
            // The commit would be empty and is aborted: the original changes go back from the backup first.
            self.revert()?;
            self.renderer
                .error("All staged changes were reverted by tasks. Re-stage changes or rerun with --allow-empty.");

            return Ok(false);
        }

        Ok(true)
    }

    /// `cleanup`: the merge files the tasks left behind are removed, and the backup is dropped when the run went well,
    /// or when the repository holds exactly what it holds.
    fn cleanup(&mut self, success: bool) -> Result<(), Failure> {
        git::remove_merge_state(&self.plan.git_directory);

        if self.revert_applied {
            return Ok(());
        }

        let Some(sha) = self.backup.clone() else { return Ok(()) };

        if success || git::backup_is_restored(&self.git, &sha)? {
            git::drop_backup(&self.git, &sha)?;
            self.backup = None;
        }

        Ok(())
    }
}

/// The run, from the backup to the cleanup. The exit status.
fn execute(plan: &Plan) -> i32 {
    let options = &plan.options;
    let renderer = Renderer::new(options.quiet, options.verbose, plan.colour);
    let mut run = Run { plan, git: Git::new(&plan.cwd, &plan.search), renderer, backup: None, revert_applied: false };

    // `prepare()`: the backup comes first, and is the first thing that changes anything.
    let started = (|| -> Result<String, Failure> {
        if !options.no_stash && options.diff.is_none() {
            run.backup = git::create_backup(&run.git)?;
        }

        let head = run.git.run(&["rev-parse", "HEAD^{tree}"], None);

        Ok(head.filter(|output| output.code == 0).map(|output| output.text()).unwrap_or_default())
    })();

    // A run whose preparation failed has nothing to clean up, as in Node, where the failure ends it.
    let head_tree = match started {
        Ok(tree) => tree,
        Err(failure) => {
            run.renderer.error(&failure.message);

            return 1;
        }
    };

    let body = (|| -> Result<bool, Failure> {
        if plan.staged.is_empty() {
            run.renderer.info("No staged files found.");

            return Ok(true);
        }

        run.renderer.start(&plan.patterns);

        if plan.patterns.is_empty() {
            run.renderer.info("No staged files matched any pattern.");

            return Ok(true);
        }

        let ran_ok = run.run_tasks();

        run.finish_tasks(ran_ok, &head_tree)
    })();
    let success = match &body {
        Ok(success) => *success,
        Err(failure) => {
            run.renderer.error(&failure.message);

            false
        }
    };

    if run.cleanup(success).is_err() {
        run.renderer.error("Cleanup failed.");
    }

    if !success {
        if let Some(sha) = &run.backup {
            run.renderer.warn(&format!(
                "Backup stash is preserved (sha {}) \u{2014} restore with: git stash apply --index {sha}",
                &sha[..sha.len().min(7)]
            ));
        }
    }

    i32::from(!success)
}

/// Answers `vis staged …` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(plan) = prepare(args) else { crate::process::delegate(raw_args) };

    exit(execute(&plan))
}
