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

use lint::Report;

use crate::node_context::context_is_native;

use crate::output::write_stdout;

/// One lint of `vis deps`. The variants are in the order the lints run and print.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lint {
    WorkspaceProtocol,
    RedefineRoot,
    WorkspaceVersions,
    CustomTypes,
    BannedDeps,
    EmptyDeps,
    RootPrivate,
    RootPackageManager,
    RootDeps,
    MissingPackageJson,
    DeadWorkspacePatterns,
    TypesInDeps,
    SimilarDeps,
}

impl Lint {
    pub(crate) const ALL: [Self; 13] = [
        Self::WorkspaceProtocol,
        Self::RedefineRoot,
        Self::WorkspaceVersions,
        Self::CustomTypes,
        Self::BannedDeps,
        Self::EmptyDeps,
        Self::RootPrivate,
        Self::RootPackageManager,
        Self::RootDeps,
        Self::MissingPackageJson,
        Self::DeadWorkspacePatterns,
        Self::TypesInDeps,
        Self::SimilarDeps,
    ];

    /// The flag that selects the lint.
    const fn flag(self) -> &'static str {
        match self {
            Self::WorkspaceProtocol => "--workspace-protocol",
            Self::RedefineRoot => "--redefine-root",
            Self::WorkspaceVersions => "--workspace-versions",
            Self::CustomTypes => "--custom-types",
            Self::BannedDeps => "--banned-deps",
            Self::EmptyDeps => "--empty-deps",
            Self::RootPrivate => "--root-private",
            Self::RootPackageManager => "--root-package-manager",
            Self::RootDeps => "--root-deps",
            Self::MissingPackageJson => "--missing-package-json",
            Self::DeadWorkspacePatterns => "--dead-workspace-patterns",
            Self::TypesInDeps => "--types-in-deps",
            Self::SimilarDeps => "--similar-deps",
        }
    }

    fn from_flag(flag: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|lint| lint.flag() == flag)
    }

    /// How many issues the lint found in `report`, for the exit status; `None` for the three lints that are not
    /// counted: `workspace-versions` and `custom-types` only ever report a drift, which hands the run to Node
    /// before anything is counted, and `banned-deps` has no policy to check natively (and delegates without
    /// `--quiet`), so none of them can add an issue here.
    fn issues(self, report: &Report) -> Option<usize> {
        Some(match self {
            Self::WorkspaceProtocol => report.workspace_protocol.len(),
            Self::RedefineRoot => report.redefine_root.len(),
            Self::EmptyDeps => report.empty_deps.len(),
            Self::RootPrivate => usize::from(report.root_private.is_some()),
            Self::RootPackageManager => usize::from(report.root_package_manager),
            Self::RootDeps => usize::from(report.root_deps.is_some()),
            Self::MissingPackageJson => report.missing_package_json.len(),
            Self::DeadWorkspacePatterns => report.dead_patterns.len(),
            Self::TypesInDeps => report.types_in_deps.len(),
            Self::SimilarDeps => report.similar_deps.len(),
            Self::WorkspaceVersions | Self::CustomTypes | Self::BannedDeps => return None,
        })
    }
}

/// Which lints run, from the flags.
#[derive(Default)]
pub(crate) struct Selection([bool; 13]);

impl Selection {
    /// Every lint, which is what no selector means.
    const fn all() -> Self {
        Self([true; 13])
    }

    pub(crate) fn has(&self, lint: Lint) -> bool {
        self.0[lint as usize]
    }

    fn any(&self) -> bool {
        self.0.contains(&true)
    }

    /// Selects the lint a flag names; `None` when it is none, or when it was selected already.
    fn select(&mut self, flag: &str) -> Option<()> {
        let lint = Lint::from_flag(flag)?;

        if self.has(lint) {
            return None;
        }

        self.0[lint as usize] = true;

        Some(())
    }
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
            selection.select(flag)?;
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
    let issues: usize =
        Lint::ALL.into_iter().filter(|lint| selection.has(*lint)).filter_map(|lint| lint.issues(&report)).sum();
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
    fn the_lints_are_numbered_in_the_order_they_run_and_each_has_its_flag() {
        for (index, lint) in Lint::ALL.into_iter().enumerate() {
            assert_eq!(lint as usize, index);
            assert_eq!(Lint::from_flag(lint.flag()), Some(lint));
        }

        assert_eq!(Lint::from_flag("--quiet"), None);
    }

    #[test]
    fn no_selector_runs_every_lint() {
        let options = parse(&argv(&["deps"])).expect("the plain command");

        assert!(Lint::ALL.iter().all(|lint| options.selection.has(*lint)));
        assert!(options.format == Format::Human && !options.quiet);
    }

    #[test]
    fn a_selector_runs_only_that_lint() {
        let options = parse(&argv(&["deps", "--root-private", "--format=json", "--quiet"])).expect("a selector");

        assert!(options.selection.has(Lint::RootPrivate) && !options.selection.has(Lint::RootDeps));
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
