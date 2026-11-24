//! `vis deps` — the native fast path for the dependency-policy lints of a pnpm workspace.
//!
//! The Node handler (`src/commands/deps/handler.ts`) runs up to thirteen lints over the `package.json` files of the
//! workspace and prints the findings as text, JSON or tab-separated lines, exiting 1 when any lint finds something.
//! This module runs the same lints with no `policy` (no `vis.config` is read natively) and prints the same bytes.
//! Every shape and input it cannot reproduce goes to Node before anything is printed:
//!
//! - an argument other than the lint selectors, `--quiet` and `--format human|json|minimal` (each at most once), so
//!   `--fix`, `--ban`, `--pin`, `--dep`, `--resolve`, `--fix-specifier` and `--propose-min` stay in Node (they write
//!   files or take a policy), and `--banned-deps` without `--quiet` (Node warns that there is no policy to check);
//! - the context of the other read-only commands (`context_is_native`: a CI context off a terminal at the root of a
//!   pnpm workspace, no `vis.config`) and, for the human format, a colour level the binary can tell;
//! - a workspace Node reads differently: `package.json#workspaces`, `overrides` in the workspace YAML, a manifest
//!   that is not strict JSON, a dependency block that is an array, a pattern outside the shapes of `workspace.rs`;
//! - a drift between packages (`workspace-versions`, `custom-types`): the canonical specifier comes from a semver
//!   order, so Node alone words those reports.

mod data;
mod lint;
mod print;

use std::ffi::OsString;
use std::process::exit;

use crate::node_context::context_is_native;
use crate::output::write_stdout;

/// Which lints run, from the flags.
#[derive(Default)]
pub(crate) struct Selection {
    pub(crate) banned_deps: bool,
    pub(crate) custom_types: bool,
    pub(crate) dead_workspace_patterns: bool,
    pub(crate) empty_deps: bool,
    pub(crate) missing_package_json: bool,
    pub(crate) redefine_root: bool,
    pub(crate) root_deps: bool,
    pub(crate) root_package_manager: bool,
    pub(crate) root_private: bool,
    pub(crate) similar_deps: bool,
    pub(crate) types_in_deps: bool,
    pub(crate) workspace_protocol: bool,
    pub(crate) workspace_versions: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Human,
    Json,
    Minimal,
}

struct Options {
    format: Format,
    quiet: bool,
    selection: Selection,
}

impl Selection {
    /// Every lint, which is what no selector means.
    const fn all() -> Self {
        Self {
            banned_deps: true,
            custom_types: true,
            dead_workspace_patterns: true,
            empty_deps: true,
            missing_package_json: true,
            redefine_root: true,
            root_deps: true,
            root_package_manager: true,
            root_private: true,
            similar_deps: true,
            types_in_deps: true,
            workspace_protocol: true,
            workspace_versions: true,
        }
    }

    fn any(&self) -> bool {
        [
            self.banned_deps,
            self.custom_types,
            self.dead_workspace_patterns,
            self.empty_deps,
            self.missing_package_json,
            self.redefine_root,
            self.root_deps,
            self.root_package_manager,
            self.root_private,
            self.similar_deps,
            self.types_in_deps,
            self.workspace_protocol,
            self.workspace_versions,
        ]
        .contains(&true)
    }
}

/// The lint selectors, by flag.
fn selector<'a>(selection: &'a mut Selection, flag: &str) -> Option<&'a mut bool> {
    Some(match flag {
        "--banned-deps" => &mut selection.banned_deps,
        "--custom-types" => &mut selection.custom_types,
        "--dead-workspace-patterns" => &mut selection.dead_workspace_patterns,
        "--empty-deps" => &mut selection.empty_deps,
        "--missing-package-json" => &mut selection.missing_package_json,
        "--redefine-root" => &mut selection.redefine_root,
        "--root-deps" => &mut selection.root_deps,
        "--root-package-manager" => &mut selection.root_package_manager,
        "--root-private" => &mut selection.root_private,
        "--similar-deps" => &mut selection.similar_deps,
        "--types-in-deps" => &mut selection.types_in_deps,
        "--workspace-protocol" => &mut selection.workspace_protocol,
        "--workspace-versions" => &mut selection.workspace_versions,
        _ => return None,
    })
}

fn parse_format(value: &str) -> Option<Format> {
    match value {
        "human" => Some(Format::Human),
        "json" => Some(Format::Json),
        "minimal" => Some(Format::Minimal),
        _ => None,
    }
}

/// The options of `deps <flags>`, or `None` when the shape is not one this module answers.
fn parse(args: &[String]) -> Option<Options> {
    let (command, flags) = args.split_first()?;

    if command != "deps" {
        return None;
    }

    let mut selection = Selection::default();
    let mut format = None;
    let mut quiet = false;
    let mut explicit_ban_check = false;
    let mut index = 0;

    while index < flags.len() {
        let flag = flags[index].as_str();
        index += 1;

        if flag == "--quiet" && !quiet {
            quiet = true;
        } else if flag == "--format" || flag.starts_with("--format=") {
            let value = match flag.strip_prefix("--format=") {
                Some(value) => value,
                None => {
                    index += 1;

                    flags.get(index - 1)?.as_str()
                }
            };

            if format.is_some() {
                return None;
            }

            format = Some(parse_format(value)?);
        } else {
            let selected = selector(&mut selection, flag)?;

            if *selected {
                return None;
            }

            *selected = true;
            explicit_ban_check |= flag == "--banned-deps";
        }
    }

    // Node warns on stderr that there is no `policy.bannedDeps` to check.
    if explicit_ban_check && !quiet {
        return None;
    }

    if !selection.any() {
        selection = Selection::all();
    }

    Some(Options { format: format.unwrap_or(Format::Human), quiet, selection })
}

/// What the run prints and the exit status, or `None` when Node has to answer.
fn answer(args: &[String]) -> Option<(String, i32)> {
    let options = parse(args)?;

    if !context_is_native() {
        return None;
    }

    // Only the human format is coloured; its escape codes depend on the detection the binary shares with Node.
    let colour = if options.format == Format::Human && !options.quiet {
        crate::term::piped_colour_level(args)? > 0
    } else {
        false
    };
    let workspace = data::read(&std::env::current_dir().ok()?)?;
    let report = lint::run(&workspace, &options.selection)?;
    let selection = &options.selection;
    let issues = [
        selection.workspace_protocol.then_some(report.workspace_protocol.len()),
        selection.redefine_root.then_some(report.redefine_root.len()),
        selection.empty_deps.then_some(report.empty_deps.len()),
        selection.root_private.then_some(usize::from(report.root_private.is_some())),
        selection.root_package_manager.then_some(usize::from(report.root_package_manager)),
        selection.root_deps.then_some(usize::from(report.root_deps.is_some())),
        selection.missing_package_json.then_some(report.missing_package_json.len()),
        selection.dead_workspace_patterns.then_some(report.dead_patterns.len()),
        selection.types_in_deps.then_some(report.types_in_deps.len()),
        selection.similar_deps.then_some(report.similar_deps.len()),
    ]
    .into_iter()
    .flatten()
    .sum::<usize>();
    let status = i32::from(issues > 0);

    if options.quiet {
        return Some((String::new(), status));
    }

    let text = match options.format {
        Format::Human => print::human(&workspace, &report, selection, colour),
        Format::Json => print::json(&workspace, &report, selection),
        Format::Minimal => print::minimal(&workspace.packages, &report, selection),
    };

    Some((text, status))
}

/// Answers `vis deps` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some((text, status)) = answer(args) else { crate::process::delegate(raw_args) };

    write_stdout("deps", "the dependency report", &text);

    exit(status);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn no_selector_runs_every_lint() {
        let options = parse(&argv(&["deps"])).expect("the plain command");

        assert!(
            options.selection.banned_deps && options.selection.similar_deps && options.selection.workspace_versions
        );
        assert!(options.format == Format::Human && !options.quiet);
    }

    #[test]
    fn a_selector_runs_only_that_lint() {
        let options = parse(&argv(&["deps", "--root-private", "--format=json", "--quiet"])).expect("a selector");

        assert!(options.selection.root_private && !options.selection.root_deps);
        assert!(options.format == Format::Json && options.quiet);
    }

    #[test]
    fn every_other_shape_is_left_to_node() {
        for shape in [
            &["deps", "--fix"][..],
            &["deps", "--ban", "x"],
            &["deps", "--pin", "x@1"],
            &["deps", "--format"],
            &["deps", "--format", "xml"],
            &["deps", "--format=json", "--format", "json"],
            &["deps", "--quiet", "--quiet"],
            &["deps", "--root-deps", "--root-deps"],
            &["deps", "--banned-deps"],
            &["deps", "extra"],
            &["deps", "--no-quiet"],
            &["sbom"],
        ] {
            assert!(parse(&argv(shape)).is_none(), "{shape:?}");
        }

        assert!(parse(&argv(&["deps", "--banned-deps", "--quiet"])).is_some());
    }
}
