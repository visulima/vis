//! `vis task-why <project>:<target>` — the native fast path.
//!
//! The Node handler (`packages/tooling/vis/src/commands/task-why/handler.ts`) builds the task graph of every target
//! of every project and walks it upward from the task. It never hashes a file and never reads the cache, so this
//! module reads no task key either: the answer depends on the workspace alone. It prints ids and edges only: not the
//! command of a task, its outputs, whether it is cached or why, so of what a `tasks` entry configures only `dependsOn`
//! (and, through the targets a `command` adds to every project, which tasks exist) reaches the output.
//!
//! Two workspace shapes are answered, and both print what Node prints byte for byte:
//!
//! - **No config.** A pnpm workspace of script-only JS projects, no `vis.config`, no inference marker
//!   (`targets::script_targets`). No target has a `dependsOn`: nothing but a config, a `project.json`, a `vis.task.*`
//!   overlay or an inferred target can give one. The graph then has no edge, so every task is a root, nothing depends
//!   on it and it depends on nothing, and the output of a task that exists is one fixed text.
//! - **A literal `vis.config` with a `tasks` block** (a `.ts`/`.js` file the binary reads as data, unix only). The
//!   graph is the one `task_runner_core::build_configured_graph` builds for [`Seeds::AllTargets`], and the walk of
//!   [`render`] is the handler's, over it. The builder refuses every config shape it does not reproduce (see its module
//!   documentation) and this module hands those to Node. What the builder leaves to the caller is vouched for here: no
//!   project has a `project.json` or a `vis.task.*` overlay (the membership read refuses a workspace that has one) and
//!   inference cannot add or change a target (`inferTargets: false`, or no detector marker and no fallback dependency
//!   in any project). The order of the `tasks` keys is read from the text of the file, because the config reader keeps
//!   its keys sorted and the order decides which target a `command` adds first and which edge is found first.
//!
//! What it answers, and what goes to Node:
//!
//! - one argument, `<project>:<target>` with exactly one colon (the handler splits at the colon with a limit of two,
//!   which truncates a longer id), in printable ASCII and not starting with `-`;
//! - a project the workspace holds, with a target of that name; every error (an unknown project or target, a task
//!   that is not in the graph) prints a stack trace on stderr, which Node alone can reproduce;
//! - the workspace root as the working directory, in a CI context off a terminal (`native_context`), without the
//!   settings that change what Node prints (`output_settings_are_default`); the output holds no path and no colour,
//!   so the plain shape is the same on every platform;
//! - not the root project (`.`): Node drops its scripts that only forward to another project;
//! - with a config: every project, script and `tasks` name in a plain charset (letters, digits and `-_.@/`, a colon
//!   only inside a target name), because the output prints the ids of other tasks and a project name with a colon makes
//!   two ids collide. A `dependsOn.projects` selector that matches nothing is no edge and prints nothing: the handler
//!   gives `createTaskGraph` no callback for it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::path::Path;

use oxc_ast::ast::Expression;
use serde_json::Value;
use task_runner_core::{
    build_configured_graph, Assumptions, ConfigProject, ConfiguredTaskGraph, DependencyKind, InferenceState,
    ProjectDependency, Seeds, TaskConfig,
};

use crate::graph::{project_graph_vetted_with_manifests, EdgeKind};
use crate::js::PROTOTYPE_NAMES;
use crate::list::Manifest;
use crate::node_context::{config_context_is_native, portable_context_is_native};
use crate::output::write_stdout;
use crate::root_search::read_json;
use crate::targets::{directory_names, inference_applies, script_targets, Targets};
use crate::text::is_ascii_graphic;
use crate::vis_config::{config_file_in, convert_default_export, has_vis_config, object_properties, read, ConfigState};
use crate::workspace::names_hold_non_js_marker;

/// What the handler prints for a task nothing depends on and that depends on nothing: a blank line, the title, a blank
/// line, the root notice, a blank line.
fn text(id: &str) -> String {
    format!("\nWhy {id}?\n\n  This task is itself a root \u{2014} nothing upstream depends on it.\n\n")
}

/// `(task id, project, target)` of `task-why <id>` with an id in the shape this module answers, or `None`.
fn parse(args: &[String]) -> Option<(&str, &str, &str)> {
    let [command, id] = args else { return None };

    if command != "task-why" || id.starts_with('-') || !is_ascii_graphic(id) {
        return None;
    }

    let (project, target) = id.split_once(':')?;

    (!project.is_empty() && !target.is_empty() && !target.contains(':')).then_some((id.as_str(), project, target))
}

/// The text the handler prints for `id` over `graph`: the shortest path to a root (a breadth-first walk over the
/// reverse edges, in the order the tasks were visited), the tasks that depend on it directly, and the tasks it depends
/// on, with a dependency that resolved twice listed twice. `None` when `id` is not a task of the graph.
fn render(graph: &ConfiguredTaskGraph, id: &str) -> Option<String> {
    let task = graph.tasks.iter().find(|task| task.id == id)?;
    let roots: HashSet<&str> = graph.roots.iter().map(String::as_str).collect();
    let mut reverse: HashMap<&str, Vec<&str>> = HashMap::new();

    for parent in &graph.tasks {
        for dependency in &parent.dependencies {
            reverse.entry(dependency.as_str()).or_default().push(parent.id.as_str());
        }
    }

    let mut visited: HashSet<&str> = HashSet::from([id]);
    let mut queue: VecDeque<(&str, Vec<&str>)> = VecDeque::from([(id, vec![id])]);
    let mut found: Option<Vec<&str>> = None;

    while let Some((node, path)) = queue.pop_front() {
        if roots.contains(node) {
            found = Some(path);

            break;
        }

        for &parent in reverse.get(node).into_iter().flatten() {
            if visited.insert(parent) {
                let mut next = vec![parent];

                next.extend(&path);
                queue.push_back((parent, next));
            }
        }
    }

    // A task that no root reaches is its own chain, as in the handler.
    let path = found.unwrap_or_else(|| vec![id]);
    let mut lines: Vec<String> = vec![String::new(), format!("Why {id}?"), String::new()];

    if path.len() > 1 {
        lines.push("Shortest path from a root to this task:".to_owned());

        for (index, node) in path.iter().enumerate() {
            lines.push(if index == 0 {
                format!("  {node}")
            } else {
                format!("{}\u{2514}\u{2500} {node}", "  ".repeat(index + 1))
            });
        }
    } else {
        lines.push("  This task is itself a root \u{2014} nothing upstream depends on it.".to_owned());
    }

    lines.push(String::new());

    let mut parents: Vec<&str> = graph
        .tasks
        .iter()
        .filter(|parent| parent.dependencies.iter().any(|dependency| dependency == id))
        .map(|parent| parent.id.as_str())
        .collect();

    parents.sort_unstable();

    if !parents.is_empty() {
        lines.push(format!("Directly depended on by {} task(s):", parents.len()));
        lines.extend(parents.iter().map(|parent| format!("  - {parent}")));
        lines.push(String::new());
    }

    let mut dependencies: Vec<&str> = task.dependencies.iter().map(String::as_str).collect();

    dependencies.sort_unstable();

    if !dependencies.is_empty() {
        lines.push(format!("This task depends on {} task(s):", dependencies.len()));
        lines.extend(dependencies.iter().map(|dependency| format!("  - {dependency}")));
        lines.push(String::new());
    }

    Some(lines.iter().map(|line| format!("{line}\n")).collect())
}

/// A name the output prints as part of an id: letters, digits and `-_.@/`, and a colon where `allow_colon` (a target
/// may hold one, a project may not, or `a:b` + `c` and `a` + `b:c` would be one id). Anything else, a space, a `%` or
/// a non-ASCII letter, is left to Node, which formats it with the logger.
fn is_plain(name: &str, allow_colon: bool) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b'@' | b'/')
                || (allow_colon && byte == b':')
        })
}

/// The keys of the `tasks` object of the config at `path`, in the order the file lists them. `None` for a file that
/// is not a literal object with plain `key: value` properties. A `tasks` that is not an object gives no keys here, and
/// the parse of the value refuses it.
fn task_order(path: &Path) -> Option<Vec<String>> {
    convert_default_export(path, |config| {
        let Expression::ObjectExpression(config) = config else { return None };
        let Some((_, tasks)) = object_properties(config)?.into_iter().find(|(key, _)| key == "tasks") else {
            return Some(Vec::new());
        };
        let Expression::ObjectExpression(tasks) = tasks else { return Some(Vec::new()) };

        Some(object_properties(tasks)?.into_iter().map(|(key, _)| key).collect())
    })
}

/// The projects of the workspace as the builder takes them: in discovery order, the scripts in file order and the edges
/// of the project graph. `None` when Node must answer: the membership or the graph is not one this reads, the root is a
/// project, a name is not plain, or (unless `inference_disabled`) a detector could apply to a project.
fn configured_projects(root: &Path, inference_disabled: bool) -> Option<Vec<ConfigProject>> {
    let (graph, manifests) = project_graph_vetted_with_manifests(root)?;

    graph
        .order
        .iter()
        .map(|name| {
            let project = graph.projects.get(name)?;
            let manifest = Manifest::read(manifests.get(name)?)?;

            if project.directory == "."
                || !project.directory.is_ascii()
                || !is_plain(name, false)
                || manifest.scripts.0.iter().any(|(script, _)| !is_plain(script, true))
            {
                return None;
            }

            let absolute = root.join(&project.directory);
            let names = directory_names(&absolute)?;

            // A manifest of another ecosystem decides which directories are projects and who owns them, not only what
            // inference adds, so `inferTargets: false` does not excuse it.
            if names_hold_non_js_marker(&names) {
                return None;
            }

            if !inference_disabled && inference_applies(&absolute, &names, &|dependency| manifest.declares(dependency))?
            {
                return None;
            }

            Some(ConfigProject {
                dependencies: project
                    .edges
                    .iter()
                    .map(|edge| ProjectDependency {
                        kind: match edge.kind {
                            EdgeKind::Static => DependencyKind::Static,
                            EdgeKind::DevDependency => DependencyKind::Dev,
                            EdgeKind::PeerDependency => DependencyKind::Peer,
                        },
                        project: edge.target.clone(),
                    })
                    .collect(),
                name: name.clone(),
                root: project.directory.clone(),
                scripts: manifest.scripts.0,
            })
        })
        .collect()
}

/// The text Node prints for a workspace with a literal `vis.config`, or `None` when Node has to answer.
fn configured_answer(root: &Path, id: &str) -> Option<String> {
    // Node loads `vis.config` from the workspace root only and never a `.json` one, so a config elsewhere on the way
    // up, or a `.json` file next to the real one, is a situation this cannot tell Node's treatment of.
    if !config_context_is_native() || root.join("vis.config.json").exists() {
        return None;
    }

    let path = config_file_in(root)?;

    // Node loads a `.cts` or `.cjs` file as CommonJS, where `export default` is a syntax error: it prints a failure and
    // goes on with the defaults, which a literal read of the file would not reproduce. A `.js` file is read as a module
    // by the syntax it holds (every Node the CLI supports detects that), unless the root `package.json` says `commonjs`.
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("ts" | "mts" | "mjs") => {}
        Some("js") => match read_json(&root.join("package.json"))?.get("type") {
            None => {}
            Some(Value::String(kind)) if kind == "module" => {}
            Some(_) => return None,
        },
        _ => return None,
    }

    let ConfigState::Static(value) = read(root) else { return None };
    let config = TaskConfig::parse(&value, &task_order(&path)?).ok()?;

    if config.defaults.iter().any(|(name, _)| !is_plain(name, true)) {
        return None;
    }

    let projects = configured_projects(root, config.inference_disabled)?;
    let assumptions = Assumptions {
        inference: if config.inference_disabled { InferenceState::Disabled } else { InferenceState::NothingToInfer },
        no_project_files: true,
    };
    let graph = build_configured_graph(&projects, &config, Seeds::AllTargets, assumptions).ok()?;

    // The handler passes no `onUnmatchedProjectSelector`, so a selector that matched nothing is no edge and no output;
    // `graph.warnings` has nothing to add. An unknown task is Node's error, which `render` leaves to it.
    render(&graph, id)
}

/// The text Node prints, or `None` when Node has to answer.
fn answer(args: &[String]) -> Option<String> {
    let (id, project, target) = parse(args)?;

    // `workspace.projects[name]` finds an inherited member of `Object.prototype` for these names in Node.
    if PROTOTYPE_NAMES.contains(&project) {
        return None;
    }

    let root = std::env::current_dir().ok()?;

    if has_vis_config(&root) {
        return configured_answer(&root, id);
    }

    if !portable_context_is_native() {
        return None;
    }

    let Targets::Native(projects) = script_targets(&root) else { return None };
    let found = projects.iter().find(|candidate| candidate.name == project)?;

    (found.directory != "." && found.targets.contains_key(target)).then(|| text(id))
}

/// Answers `vis task-why <id>` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(text) = answer(args) else { crate::process::delegate(raw_args) };

    write_stdout("task-why", "the task explanation", &text);

    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use task_runner_core::ConfiguredTask;

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

    fn task(id: &str, dependencies: &[&str]) -> ConfiguredTask {
        let (project, target) = id.split_once(':').unwrap();

        ConfiguredTask {
            command: String::new(),
            cache: None,
            declares_inputs: false,
            dependencies: dependencies.iter().map(|dependency| (*dependency).to_owned()).collect(),
            id: id.to_owned(),
            outputs: Vec::new(),
            project: project.to_owned(),
            root: String::new(),
            target: target.to_owned(),
        }
    }

    /// The graph of a list of `(id, dependencies)` in visiting order; the roots are the tasks nothing depends on.
    fn graph(tasks: &[(&str, &[&str])]) -> ConfiguredTaskGraph {
        let tasks: Vec<ConfiguredTask> = tasks.iter().map(|(id, dependencies)| task(id, dependencies)).collect();
        let depended_on: HashSet<&str> =
            tasks.iter().flat_map(|task| task.dependencies.iter().map(String::as_str)).collect();
        let roots = tasks.iter().filter(|task| !depended_on.contains(task.id.as_str())).map(|task| task.id.clone());

        ConfiguredTaskGraph { roots: roots.collect(), tasks, warnings: Vec::new() }
    }

    #[test]
    fn a_task_nothing_touches_is_a_root() {
        assert_eq!(render(&graph(&[("a:build", &[])]), "a:build").unwrap(), text("a:build"));
    }

    #[test]
    fn the_chain_goes_from_the_first_root_found_and_both_lists_are_sorted() {
        // `z:build` and `m:build` both depend on `lib:build`; the walk reaches `z:build` first (the order the tasks were
        // visited in), and the direct lists are sorted whatever that order is.
        let graph = graph(&[
            ("z:build", &["lib:build", "a:gen"]),
            ("m:build", &["lib:build"]),
            ("lib:build", &["core:build"]),
            ("a:gen", &[]),
            ("core:build", &[]),
        ]);

        assert_eq!(
            render(&graph, "lib:build").unwrap(),
            "\nWhy lib:build?\n\nShortest path from a root to this task:\n  z:build\n    \u{2514}\u{2500} lib:build\n\nDirectly depended on by 2 task(s):\n  - m:build\n  - z:build\n\nThis task depends on 1 task(s):\n  - core:build\n\n"
        );
        assert_eq!(
            render(&graph, "core:build").unwrap(),
            "\nWhy core:build?\n\nShortest path from a root to this task:\n  z:build\n    \u{2514}\u{2500} lib:build\n      \u{2514}\u{2500} core:build\n\nDirectly depended on by 1 task(s):\n  - lib:build\n\n"
        );
    }

    #[test]
    fn a_dependency_resolved_twice_is_listed_twice_and_its_parent_once() {
        let graph = graph(&[("app:build", &["lib:build", "lib:build"]), ("lib:build", &[])]);

        assert_eq!(
            render(&graph, "app:build").unwrap(),
            "\nWhy app:build?\n\n  This task is itself a root \u{2014} nothing upstream depends on it.\n\nThis task depends on 2 task(s):\n  - lib:build\n  - lib:build\n\n"
        );
        assert_eq!(
            render(&graph, "lib:build").unwrap(),
            "\nWhy lib:build?\n\nShortest path from a root to this task:\n  app:build\n    \u{2514}\u{2500} lib:build\n\nDirectly depended on by 1 task(s):\n  - app:build\n\n"
        );
    }

    #[test]
    fn a_task_the_graph_does_not_hold_is_nodes_error() {
        assert_eq!(render(&graph(&[("a:build", &[])]), "a:test"), None);
    }

    #[test]
    fn names_are_plain_or_left_to_node() {
        for name in ["build", "@acme/app", "a-b_c.d", "build:ci"] {
            assert!(is_plain(name, true), "{name}");
        }

        for name in ["", "a b", "100%", "a$b", "\u{e4}", "a'b"] {
            assert!(!is_plain(name, true), "{name:?}");
        }

        assert!(!is_plain("a:b", false));
    }

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("vis-task-why-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");

        directory
    }

    #[test]
    fn the_task_order_is_the_order_of_the_file() {
        let directory = scratch("order");
        let path = directory.join("vis.config.ts");

        fs::write(&path, "export default { tasks: { zeta: { command: 'z' }, alpha: {}, mid: { cache: false } } };\n")
            .expect("config");

        assert_eq!(task_order(&path), Some(vec!["zeta".to_owned(), "alpha".to_owned(), "mid".to_owned()]));

        fs::write(&path, "export default { inferTargets: false };\n").expect("config");

        assert_eq!(task_order(&path), Some(Vec::new()));

        // A spread or a computed key is not a plain property, so the order is not the file's to give.
        fs::write(&path, "const base = {};\nexport default { tasks: { ...base, a: {} } };\n").expect("config");

        assert_eq!(task_order(&path), None);

        let _ = fs::remove_dir_all(&directory);
    }
}
