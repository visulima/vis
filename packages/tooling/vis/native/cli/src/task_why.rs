//! `vis task-why <project>:<target>` — the native fast path.
//!
//! The Node handler (`packages/tooling/vis/src/commands/task-why/handler.ts`) builds the task graph of every target
//! of every project and walks it upward from the task. It never hashes a file and never reads the cache, so this
//! module reads no task key either: the answer depends on the workspace alone.
//!
//! In a workspace the binary reads (a pnpm workspace of script-only JS projects, no `vis.config`, no inference
//! marker; `targets::script_targets`), no target has a `dependsOn`: nothing but a config, a `project.json`, a
//! `vis.task.*` overlay or an inferred target can give one. The graph then has no edge, so every task is a root,
//! nothing depends on it and it depends on nothing, and the output of a task that exists is one fixed text.
//!
//! What it answers, and what goes to Node:
//!
//! - one argument, `<project>:<target>` with exactly one colon (the handler splits at the colon with a limit of two,
//!   which truncates a longer id), in printable ASCII and not starting with `-`;
//! - a project the workspace holds, with a script of that name; every error (an unknown project or target, a task
//!   that is not in the graph) prints a stack trace on stderr, which Node alone can reproduce;
//! - the workspace root as the working directory, in a CI context off a terminal (`native_context`), without the
//!   settings that change what Node prints (`output_settings_are_default`), on a Unix system;
//! - not the root project (`.`): Node drops its scripts that only forward to another project.

use std::ffi::OsString;
use std::io::IsTerminal;

use crate::advisories::{native_context, output_settings_are_default, write_stdout};
use crate::js::PROTOTYPE_NAMES;
use crate::targets::{script_targets, Targets};

/// What the handler prints for a task nothing depends on and that depends on nothing: a blank line, the title, a blank
/// line, the root notice, a blank line.
fn text(id: &str) -> String {
    format!("\nWhy {id}?\n\n  This task is itself a root \u{2014} nothing upstream depends on it.\n\n")
}

/// `(task id, project, target)` of `task-why <id>` with an id in the shape this module answers, or `None`.
fn parse(args: &[String]) -> Option<(&str, &str, &str)> {
    let [command, id] = args else { return None };

    if command != "task-why" || id.starts_with('-') || !id.bytes().all(|byte| byte.is_ascii_graphic()) {
        return None;
    }

    let (project, target) = id.split_once(':')?;

    (!project.is_empty() && !target.is_empty() && !target.contains(':')).then_some((id.as_str(), project, target))
}

/// The text Node prints, or `None` when Node has to answer.
fn answer(args: &[String]) -> Option<String> {
    let (id, project, target) = parse(args)?;

    // `workspace.projects[name]` finds an inherited member of `Object.prototype` for these names in Node.
    if !cfg!(unix)
        || PROTOTYPE_NAMES.contains(&project)
        || !output_settings_are_default()
        || std::io::stdout().is_terminal()
        || !native_context()
    {
        return None;
    }

    let root = std::env::current_dir().ok()?;
    let Targets::Native(projects) = script_targets(&root) else { return None };
    let found = projects.iter().find(|candidate| candidate.name == project)?;

    (found.directory != "." && found.targets.contains_key(target)).then(|| text(id))
}

/// Answers `vis task-why <id>` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(text) = answer(args) else { crate::delegate(raw_args) };

    write_stdout("task-why", "the task explanation", &text);

    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn one_id_with_one_colon_is_parsed() {
        assert_eq!(parse(&argv(&["task-why", "app:build"])), Some(("app:build", "app", "build")));
        assert_eq!(parse(&argv(&["task-why", "@acme/app:build"])), Some(("@acme/app:build", "@acme/app", "build")));
    }

    #[test]
    fn every_other_shape_is_left_to_node() {
        for shape in [
            &["task-why"][..],
            &["task-why", "app"],
            &["task-why", ":build"],
            &["task-why", "app:"],
            &["task-why", "app:build:ci"],
            &["task-why", "a:b:c"],
            &["task-why", "-x:build"],
            &["task-why", "--help"],
            &["task-why", "app:build", "extra"],
            &["task-why", "app:build", "--json"],
            &["task-why", "app: build"],
            &["task-why", "\u{e4}pp:build"],
            &["task-why", ""],
            &["why", "app:build"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    #[test]
    fn the_text_names_the_task() {
        assert_eq!(
            text("app:build"),
            "\nWhy app:build?\n\n  This task is itself a root \u{2014} nothing upstream depends on it.\n\n"
        );
    }
}
