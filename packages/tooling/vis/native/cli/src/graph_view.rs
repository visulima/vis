//! Native `vis graph`: the project dependency graph as ASCII, DOT or JSON, for a JS-only workspace.
//!
//! Mirrors `packages/tooling/vis/src/commands/graph/handler.ts` and `projectGraphToDot`
//! (`packages/tooling/task-runner/src/graph-visualizer.ts`). The graph itself is [`crate::graph`]'s.
//!
//! What stays Node, each decided before anything is printed:
//!
//! - `--format html` (it bundles a browser viewer) and `--output` (a file write plus a log line);
//! - the interactive viewer (`--format tui`, or no format, on a terminal): stdout here is never a terminal, so
//!   `tui` and the default are the ASCII tree, as in Node's non-terminal fallback;
//! - a format name other than `ascii`, `dot`, `json` and `tui`, which Node answers with the ASCII tree but
//!   which more likely is a typo that deserves Node's own handling;
//! - any workspace [`crate::graph::project_graph`] hands to Node, one whose project names JavaScript would not
//!   keep in discovery order (all-digit names) or that are not ASCII, and a project at the workspace root;
//! - a `vis.config` that is not a literal the binary reads as data, or one with a key that can change the projects or
//!   their edges. The graph depends on the config through `projectIgnore`, the `discover` flags of the non-JS
//!   ecosystems and a `project.json` (which the membership read refuses), so a literal config whose other keys are
//!   harmless is answered with its `projectIgnore` applied (`crate::config_workspace` lists what is harmless and why).
//!   The workspace root must be the working directory, as for `task-why`: Node loads the config of the root only.

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::path::Path;

use crate::config_workspace::{read_vetted, Consumer, Vetted};
use crate::graph::{
    project_graph, project_graph_vetted_with_manifests, EdgeKind, GraphResult, ProjectGraph, ProjectType,
};
use crate::js::is_index_like;
use crate::json::{stringify, Json};
use crate::node_context::{config_context_is_native, monorepo_root, output_settings_are_default, quiet_context};
use crate::output::{node_may_cut_short, write_stdout, STREAM_LIMIT};
use crate::term::{piped_stdout_colour_level, Style};
use crate::vis_config::has_vis_config;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Format {
    Ascii,
    Dot,
    Json,
}

#[derive(Debug, PartialEq)]
struct Options {
    format: Format,
    /// `--depth`: how many levels of dependencies the tree shows. `u64::MAX` when unlimited.
    depth: u64,
}

/// A non-negative integer as `Number(text)` reads it, or `None` for any other text. A value too large for
/// `u64` is unlimited for every graph a workspace can hold.
fn parse_depth(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    Some(text.parse().unwrap_or(u64::MAX))
}

fn parse_format(text: &str) -> Option<Format> {
    match text {
        "ascii" | "tui" => Some(Format::Ascii),
        "dot" => Some(Format::Dot),
        "json" => Some(Format::Json),
        _ => None,
    }
}

/// Parses `graph [--format|-f <name>] [--depth|-d <n>]`. `args[0]` is `graph`. Every flag may appear once, with
/// its value after a space or an `=` (`--format=json`; the short names take a space only). `None` for every other
/// shape.
fn parse(args: &[String]) -> Option<Options> {
    let mut format: Option<Format> = None;
    let mut depth: Option<u64> = None;
    let mut tokens = args.iter().skip(1);

    while let Some(token) = tokens.next() {
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (token.as_str(), None),
        };

        match name {
            "--format" | "-f" if format.is_none() => {
                let value = inline.or_else(|| tokens.next().map(String::as_str))?;

                format = Some(parse_format(value)?);
            }
            "--depth" | "-d" if depth.is_none() => {
                let value = inline.or_else(|| tokens.next().map(String::as_str))?;

                depth = Some(parse_depth(value)?);
            }
            // `-f=json` lands here too: only the long names are split at an `=`, and cerebro does not read the short
            // ones that way.
            _ => return None,
        }
    }

    Some(Options { format: format.unwrap_or(Format::Ascii), depth: depth.unwrap_or(u64::MAX) })
}

/// The graph in the order Node holds it: projects in discovery order, each with its edges.
struct Ordered<'a> {
    graph: &'a ProjectGraph,
}

impl Ordered<'_> {
    fn names(&self) -> impl Iterator<Item = &str> {
        self.graph.order.iter().map(String::as_str)
    }

    fn type_of(&self, name: &str) -> ProjectType {
        self.graph.projects[name].project_type
    }

    fn edges(&self, name: &str) -> &[crate::graph::Edge] {
        &self.graph.projects[name].edges
    }
}

fn edge_type(kind: EdgeKind) -> &'static str {
    match kind {
        EdgeKind::Static => "static",
        EdgeKind::DevDependency => "devDependency",
        EdgeKind::PeerDependency => "peerDependency",
    }
}

fn to_json(graph: &Ordered) -> String {
    let edges: Vec<Json> = graph
        .names()
        .flat_map(|name| graph.edges(name))
        .map(|edge| {
            Json::Object(vec![
                ("source".to_owned(), Json::Str(edge.source.clone())),
                ("target".to_owned(), Json::Str(edge.target.clone())),
                ("type".to_owned(), Json::Str(edge_type(edge.kind).to_owned())),
            ])
        })
        .collect();
    let nodes: Vec<Json> = graph
        .names()
        .map(|name| {
            Json::Object(vec![
                ("name".to_owned(), Json::Str(name.to_owned())),
                ("type".to_owned(), Json::Str(graph.type_of(name).as_str().to_owned())),
            ])
        })
        .collect();

    stringify(
        &Json::Object(vec![("edges".to_owned(), Json::Array(edges)), ("nodes".to_owned(), Json::Array(nodes))]),
        "  ",
    )
}

fn to_dot(graph: &Ordered) -> String {
    let mut lines = vec![
        "digraph ProjectGraph {".to_owned(),
        "  rankdir=LR;".to_owned(),
        "  node [shape=box, style=filled, fillcolor=\"#87CEEB\", fontname=\"monospace\"];".to_owned(),
    ];

    for name in graph.names() {
        let colour = match graph.type_of(name) {
            ProjectType::Application => "#FFD700",
            ProjectType::Library => "#87CEEB",
        };

        lines.push(format!("  \"{name}\" [fillcolor=\"{colour}\"];"));
    }

    for name in graph.names() {
        for edge in graph.edges(name) {
            let attributes = match edge.kind {
                EdgeKind::DevDependency => "style=dotted, color=\"#888888\"",
                EdgeKind::PeerDependency => "style=dashed, color=\"#CC8800\"",
                EdgeKind::Static => "style=solid",
            };

            lines.push(format!("  \"{name}\" -> \"{}\" [{attributes}];", edge.target));
        }
    }

    lines.push("}".to_owned());

    lines.join("\n")
}

/// The ASCII tree's state: what every node line needs.
struct Tree<'a> {
    graph: &'a Ordered<'a>,
    style: Style,
    max_depth: u64,
    lines: Vec<String>,
    /// The bytes of the text so far, a newline after every line.
    size: usize,
    /// The size Node still delivers whole on this stdout, when it is a pipe or a socket.
    limit: Option<usize>,
}

impl Tree<'_> {
    fn name(&self, name: &str) -> String {
        if self.graph.type_of(name) == ProjectType::Application {
            self.style.bold(name)
        } else {
            name.to_owned()
        }
    }

    fn push(&mut self, line: String) {
        self.size += line.len() + 1;
        self.lines.push(line);
    }

    /// Whether the text is already one Node would cut short, so no more of it needs to be built.
    fn too_long(&self) -> bool {
        self.limit.is_some_and(|limit| self.size > limit)
    }

    fn dependency(&mut self, name: &str, prefix: &str, is_last: bool, printed: &mut HashSet<String>, depth: u64) {
        let connector = self.style.dim(if is_last { "└── " } else { "├── " });
        let duplicate = printed.contains(name);
        let suffix = if duplicate { self.style.dim(" (*)") } else { String::new() };

        self.push(format!("{prefix}{connector}{}{suffix}", self.name(name)));

        if duplicate || self.too_long() {
            return;
        }

        printed.insert(name.to_owned());

        let edges = self.graph.edges(name);
        let child_prefix =
            if is_last { format!("{prefix}    ") } else { format!("{prefix}{}   ", self.style.dim("│")) };

        if depth >= self.max_depth && !edges.is_empty() {
            self.push(format!("{child_prefix}{}", self.style.dim(&format!("... {} more", edges.len()))));

            return;
        }

        for (index, edge) in edges.iter().enumerate() {
            self.dependency(&edge.target, &child_prefix, index == edges.len() - 1, printed, depth + 1);

            if self.too_long() {
                return;
            }
        }
    }

    fn root(&mut self, name: &str, printed: &mut HashSet<String>, indent: &str) {
        self.push(format!("{indent}{}", self.name(name)));
        printed.insert(name.to_owned());

        let edges = self.graph.edges(name);

        if edges.is_empty() {
            self.push(format!("{indent}  {}", self.style.dim("(no dependencies)")));

            return;
        }

        if self.max_depth == 0 {
            self.push(format!("{indent}  {}", self.style.dim(&format!("... {} dependencies", edges.len()))));

            return;
        }

        for (index, edge) in edges.iter().enumerate() {
            self.dependency(&edge.target, indent, index == edges.len() - 1, printed, 1);

            if self.too_long() {
                return;
            }
        }
    }
}

/// The ASCII tree, or `None` as soon as it is longer than Node delivers whole on a pipe, without building the rest.
fn to_ascii(graph: &Ordered, max_depth: u64, style: Style, limit: Option<usize>) -> Option<String> {
    let mut apps: Vec<&str> = Vec::new();
    let mut libraries: Vec<&str> = Vec::new();

    for name in graph.names() {
        match graph.type_of(name) {
            ProjectType::Application => apps.push(name),
            ProjectType::Library => libraries.push(name),
        }
    }

    // The names are ASCII, so byte order is the UTF-16 order of `Array.prototype.sort`.
    apps.sort_unstable();
    libraries.sort_unstable();

    let total_dependencies: usize = graph.names().map(|name| graph.edges(name).len()).sum();
    let mut tree = Tree { graph, style, max_depth, lines: Vec::new(), size: 0, limit };

    tree.push(style.bold("Project Dependency Graph"));
    tree.push(String::new());

    for (group, label) in [(&apps, "Applications"), (&libraries, "Libraries")] {
        if group.is_empty() {
            continue;
        }

        tree.push(format!(" {}", style.bold(&style.cyan(&format!("{label} ({})", group.len())))));
        tree.push(String::new());

        for name in group {
            tree.root(name, &mut HashSet::new(), "  ");
            tree.push(String::new());

            if tree.too_long() {
                return None;
            }
        }
    }

    // `process.stdout.columns || 80`, capped at 60: stdout is not a terminal here, so it is 80.
    tree.push(style.dim(&"─".repeat(60)));
    tree.push(format!(
        "{} packages {} {} dependencies {} {} apps{} {} libraries",
        style.bold(&(apps.len() + libraries.len()).to_string()),
        style.dim("·"),
        style.bold(&total_dependencies.to_string()),
        style.dim("·"),
        style.bold(&apps.len().to_string()),
        style.dim(","),
        style.bold(&libraries.len().to_string()),
    ));

    let mut shown: HashSet<&str> = HashSet::new();
    let mut has_duplicates = false;

    for name in apps.iter().chain(&libraries) {
        for edge in graph.edges(name) {
            has_duplicates |= !shown.insert(edge.target.as_str());
        }

        shown.insert(*name);
    }

    if has_duplicates {
        tree.push(style.dim("(*) = already shown above"));
    }

    // The last line has no newline of its own: the text ends with the one `text_for` adds.
    (!tree.too_long()).then(|| tree.lines.join("\n"))
}

/// Whether the names of `graph` are ones this module orders as Node does: ASCII, and none that JavaScript lists
/// ahead of insertion order (an array index) or assigns through a setter (`__proto__`), and no project at the root.
fn names_are_plain(graph: &ProjectGraph) -> bool {
    graph.order.len() == graph.projects.len()
        && graph
            .order
            .iter()
            .all(|name| name.is_ascii() && !is_index_like(name) && graph.projects[name].directory != ".")
}

/// The text of one invocation, or `None` when Node must answer it.
fn answer(args: &[String]) -> Option<String> {
    let options = parse(args)?;
    let cwd = env::current_dir().ok()?;
    let root = monorepo_root(&cwd)?;

    // Node prints the graph through `logger.info`, which a configured log level silences or changes.
    if !output_settings_are_default() {
        return None;
    }

    // A `vis.config` at or above the working directory: a literal one whose keys cannot change the projects or their
    // edges is read (see `config_workspace`), from the workspace root only. Any other is Node's.
    let vetted = if has_vis_config(&cwd) {
        if cwd != root || !config_context_is_native() {
            return None;
        }

        Some(read_vetted(&root, Consumer::Graph)?)
    } else {
        if !quiet_context(&cwd, &root) {
            return None;
        }

        None
    };

    // Pail's level for a run with neither stream on a terminal; `None` for a terminal, a colour flag and the
    // cases only Node can tell.
    let colour = piped_stdout_colour_level(args)? > 0;

    text_for(&root, &options, Style { colour }, vetted.as_ref())
}

/// The graph of `root`: with a vetted config, the one that config's `projectIgnore` leaves; without one, the graph of a
/// workspace that has no config at all.
fn graph_of(root: &Path, vetted: Option<&Vetted>) -> Option<ProjectGraph> {
    match vetted {
        Some(vetted) => Some(project_graph_vetted_with_manifests(root, &vetted.ignore)?.0),
        None => match project_graph(root) {
            GraphResult::Native(graph) => Some(graph),
            GraphResult::Delegate => None,
        },
    }
}

fn text_for(root: &Path, options: &Options, style: Style, vetted: Option<&Vetted>) -> Option<String> {
    let graph = graph_of(root, vetted)?;

    if !names_are_plain(&graph) {
        return None;
    }

    let ordered = Ordered { graph: &graph };
    let mut text = match options.format {
        Format::Ascii => {
            to_ascii(&ordered, options.depth, style, node_may_cut_short(usize::MAX).then_some(STREAM_LIMIT))?
        }
        Format::Dot => to_dot(&ordered),
        Format::Json => to_json(&ordered),
    };

    text.push('\n');

    (!node_may_cut_short(text.len())).then_some(text)
}

/// Answers `vis graph` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Some(text) => {
            write_stdout("graph", "the graph", &text);

            std::process::exit(0);
        }
        None => crate::process::delegate(raw_args),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::graph::{Edge, Project};

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    fn sample() -> ProjectGraph {
        let edge =
            |source: &str, target: &str, kind| Edge { source: source.to_owned(), target: target.to_owned(), kind };
        let project =
            |directory: &str, project_type, edges| Project { directory: directory.to_owned(), project_type, edges };
        let mut projects = BTreeMap::new();

        projects.insert(
            "app".to_owned(),
            project(
                "packages/app",
                ProjectType::Application,
                vec![edge("app", "lib", EdgeKind::Static), edge("app", "util", EdgeKind::DevDependency)],
            ),
        );
        projects.insert(
            "lib".to_owned(),
            project("packages/lib", ProjectType::Library, vec![edge("lib", "util", EdgeKind::PeerDependency)]),
        );
        projects.insert("util".to_owned(), project("packages/util", ProjectType::Library, Vec::new()));

        ProjectGraph { order: vec!["util".to_owned(), "app".to_owned(), "lib".to_owned()], projects }
    }

    #[test]
    fn parses_the_formats_and_the_depth() {
        assert_eq!(parse(&argv(&["graph"])), Some(Options { format: Format::Ascii, depth: u64::MAX }));
        assert_eq!(parse(&argv(&["graph", "--format=json"])), Some(Options { format: Format::Json, depth: u64::MAX }));
        assert_eq!(parse(&argv(&["graph", "-f", "dot", "-d", "2"])), Some(Options { format: Format::Dot, depth: 2 }));
        assert_eq!(
            parse(&argv(&["graph", "--depth=0", "--format", "tui"])),
            Some(Options { format: Format::Ascii, depth: 0 })
        );
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["graph", "--format=html"][..],
            &["graph", "--format=banana"],
            &["graph", "--format"],
            &["graph", "--format=json", "--format=dot"],
            &["graph", "--depth=-1"],
            &["graph", "--depth=1.5"],
            &["graph", "--depth="],
            &["graph", "--output=out.json"],
            &["graph", "-o", "out.json"],
            &["graph", "-f=json"],
            &["graph", "extra"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    #[test]
    fn json_lists_projects_in_discovery_order() {
        let graph = sample();
        let text = to_json(&Ordered { graph: &graph });

        assert!(text.starts_with("{\n  \"edges\": [\n    {\n      \"source\": \"app\","), "{text}");
        assert!(text.contains("\"nodes\": [\n    {\n      \"name\": \"util\",\n      \"type\": \"library\""), "{text}");
    }

    #[test]
    fn an_empty_graph_prints_empty_arrays() {
        let graph = ProjectGraph { order: Vec::new(), projects: BTreeMap::new() };

        assert_eq!(to_json(&Ordered { graph: &graph }), "{\n  \"edges\": [],\n  \"nodes\": []\n}");
    }

    #[test]
    fn dot_styles_the_edges_by_kind() {
        let graph = sample();
        let text = to_dot(&Ordered { graph: &graph });

        assert!(text.contains("  \"app\" [fillcolor=\"#FFD700\"];"));
        assert!(text.contains("  \"app\" -> \"lib\" [style=solid];"));
        assert!(text.contains("  \"app\" -> \"util\" [style=dotted, color=\"#888888\"];"));
        assert!(text.contains("  \"lib\" -> \"util\" [style=dashed, color=\"#CC8800\"];"));
    }

    #[test]
    fn ascii_marks_repeated_projects() {
        let graph = sample();
        let text = to_ascii(&Ordered { graph: &graph }, u64::MAX, Style { colour: false }, None).expect("short");

        assert!(text.contains("  app\n  ├── lib\n  │   └── util\n  └── util (*)"), "{text}");
        assert!(text.ends_with("(*) = already shown above"), "{text}");
        assert!(text.contains("3 packages · 3 dependencies · 1 apps, 2 libraries"), "{text}");
    }

    #[test]
    fn a_tree_longer_than_the_limit_is_given_up_without_building_the_rest() {
        let graph = sample();
        let ordered = Ordered { graph: &graph };
        let whole = to_ascii(&ordered, u64::MAX, Style { colour: false }, None).expect("whole");

        // The whole text plus its newline fits exactly; one byte less does not.
        assert_eq!(
            to_ascii(&ordered, u64::MAX, Style { colour: false }, Some(whole.len() + 1)).as_deref(),
            Some(whole.as_str())
        );
        assert_eq!(to_ascii(&ordered, u64::MAX, Style { colour: false }, Some(whole.len())), None);
        assert_eq!(to_ascii(&ordered, u64::MAX, Style { colour: false }, Some(10)), None);
    }

    #[test]
    fn a_shallow_depth_summarises_what_it_cuts() {
        let graph = sample();
        let flat = to_ascii(&Ordered { graph: &graph }, 0, Style { colour: false }, None).expect("short");
        let one = to_ascii(&Ordered { graph: &graph }, 1, Style { colour: false }, None).expect("short");

        assert!(flat.contains("  app\n    ... 2 dependencies"), "{flat}");
        assert!(one.contains("  ├── lib\n  │   ... 1 more"), "{one}");
    }

    #[test]
    fn names_node_would_reorder_are_left_to_it() {
        let mut graph = sample();

        assert!(names_are_plain(&graph));

        graph.order[0] = "12".to_owned();
        let project = graph.projects.remove("util").unwrap();
        graph.projects.insert("12".to_owned(), project);

        assert!(!names_are_plain(&graph));
    }
}
