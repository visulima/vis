//! The task graph of one `run <target>` in the shape the native run covers: a JS
//! workspace whose targets are `package.json` scripts, with no `dependsOn`
//! configuration. Everything outside that shape is a [`NotReproducible`] answer,
//! never a guess, so a caller can hand the run to the Node implementation.

use std::collections::HashSet;
use std::fmt;

use crate::graph::{topological_sort, TaskGraph};

/// Why a run cannot be answered here. Each variant names one input outside the
/// supported shape; the Node implementation handles all of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotReproducible {
    /// The workspace root is not a plain absolute path: on Windows that is a drive-letter path, so a verbatim
    /// (`\\?\`), network (UNC) or device root is not one.
    UnsafeWorkspaceRoot(String),
    /// A project root is not a plain workspace-relative path (root project, `..`, glob characters).
    UnsafeProjectRoot { project: String, root: String },
    /// The target name is empty or uses selector syntax.
    InvalidTarget(String),
    /// Two projects share a name.
    DuplicateProject(String),
    /// No project has the target; Node reports that as an error.
    NoTasks,
    /// A script that is empty, so the task has no command.
    EmptyScript(String),
    /// A script with `${`: Node rewrites those tokens before it hashes the command.
    ScriptNeedsTokenExpansion(String),
    /// The task opts out of the cache; it can never be a hit.
    CacheDisabled(String),
    /// The task declares outputs, which a cache entry would have to restore.
    DeclaredOutputs(String),
    /// The task graph has a cycle.
    Cycle,
    /// No file of the project matched, so Node would warn and key on no content.
    NoInputFiles(String),
    /// A path the walk produced is not valid UTF-8.
    NonUtf8Path(String),
    /// A file could not be read, so its hash would be a sentinel.
    UnreadableFile { path: String, reason: String },
    /// The cache hash is not 32 lowercase hex characters.
    InvalidHash(String),
    /// A cache entry holds outputs to restore.
    EntryHasOutputs(String),
    /// A cache entry written by a traced (fingerprint) run.
    EntryIsTraced(String),
    /// A cache entry file is not valid UTF-8.
    EntryNotUtf8 { entry: String, file: &'static str },
}

impl fmt::Display for NotReproducible {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsafeWorkspaceRoot(root) => write!(f, "workspace root {root:?} is not a plain absolute path"),
            Self::UnsafeProjectRoot { project, root } => {
                write!(f, "root {root:?} of project {project} is not a plain workspace-relative path")
            }
            Self::InvalidTarget(target) => write!(f, "target {target:?} is not a plain target name"),
            Self::DuplicateProject(name) => write!(f, "project name {name} is used twice"),
            Self::NoTasks => f.write_str("no project has the target"),
            Self::EmptyScript(id) => write!(f, "task {id} has an empty script"),
            Self::ScriptNeedsTokenExpansion(id) => write!(f, "the script of task {id} contains a `${{` token"),
            Self::CacheDisabled(id) => write!(f, "task {id} disables the cache"),
            Self::DeclaredOutputs(id) => write!(f, "task {id} declares outputs"),
            Self::Cycle => f.write_str("the task graph has a cycle"),
            Self::NoInputFiles(id) => write!(f, "task {id} has no input files"),
            Self::NonUtf8Path(path) => write!(f, "path {path:?} is not valid UTF-8"),
            Self::UnreadableFile { path, reason } => write!(f, "cannot read {path}: {reason}"),
            Self::InvalidHash(hash) => write!(f, "{hash:?} is not a task hash"),
            Self::EntryHasOutputs(hash) => write!(f, "cache entry {hash} holds outputs to restore"),
            Self::EntryIsTraced(hash) => write!(f, "cache entry {hash} was written by a traced run"),
            Self::EntryNotUtf8 { entry, file } => write!(f, "{file} of cache entry {entry} is not valid UTF-8"),
        }
    }
}

impl std::error::Error for NotReproducible {}

/// How a project depends on another one in the project graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DependencyKind {
    /// `dependencies`, `optionalDependencies` and every other build-ordering edge.
    Static,
    /// `devDependencies`: a real edge, but a cycle made only of these is tolerated by Node.
    Dev,
    /// `peerDependencies`: never an ordering edge for tasks.
    Peer,
}

/// One edge of the project graph, from a project to a project it depends on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectDependency {
    pub project: String,
    pub kind: DependencyKind,
}

/// One workspace project as the native run sees it.
#[derive(Clone, Debug, Default)]
pub struct RunProject {
    /// The `package.json` name.
    pub name: String,
    /// The project directory, relative to the workspace root, with `/` separators.
    pub root: String,
    /// The text of the project's script for the run target; `None` when it has none.
    pub script: Option<String>,
    /// `Some(false)` when the target opts out of the cache.
    pub cache: Option<bool>,
    /// Declared outputs of the target; the supported shape has none.
    pub outputs: Vec<String>,
    /// Edges to the projects this one depends on, in project-graph order.
    pub dependencies: Vec<ProjectDependency>,
}

/// Which `dependsOn` the target has. The Node default for a script target is
/// [`DependsOn::Nothing`]: a task depends on no other task, however the packages
/// depend on each other.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DependsOn {
    /// No `dependsOn`: no task has a dependency.
    #[default]
    Nothing,
    /// `dependsOn: ["^<target>"]`: the same target of every project this one depends on.
    DependenciesSameTarget,
}

/// One task of the run, `<project>:<target>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunTask {
    pub id: String,
    pub project: String,
    /// The project directory, relative to the workspace root.
    pub root: String,
    /// The script text, which Node runs and hashes.
    pub command: String,
    /// Ids of the tasks this one depends on: one per project-graph edge, in project-graph order. A project reached
    /// by two edges (a `dependencies` and a `devDependencies` entry) is listed twice, as Node lists it.
    pub dependencies: Vec<String>,
}

/// The tasks of a run in project order, and the ones nothing depends on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunTaskGraph {
    pub tasks: Vec<RunTask>,
    pub roots: Vec<String>,
}

impl RunTaskGraph {
    /// Task ids with every dependency before its dependents.
    pub fn execution_order(&self) -> Result<Vec<String>, NotReproducible> {
        let graph = TaskGraph {
            task_ids: self.tasks.iter().map(|task| task.id.clone()).collect(),
            edges: self
                .tasks
                .iter()
                .flat_map(|task| task.dependencies.iter().map(|dependency| vec![dependency.clone(), task.id.clone()]))
                .collect(),
        };

        topological_sort(&graph).map_err(|_| NotReproducible::Cycle)
    }
}

/// The ids of tasks that could not be keyed completely: a task whose dependency is
/// one of `seeds` (a dependency left to an earlier run that has no key), or whose
/// dependency is itself unkeyed, however many levels away. Mirrors the
/// orchestrator's `#unkeyedTasks` / `#hasUnkeyedDependency`.
///
/// A plain run has no seeds (they exist only for `--deps-only` / `--skip-deps`),
/// so every task is keyed; the rule is kept pure so that stays checkable.
pub fn unkeyed_tasks(graph: &RunTaskGraph, seeds: &HashSet<String>) -> Result<HashSet<String>, NotReproducible> {
    let mut unkeyed: HashSet<String> = HashSet::new();

    for id in graph.execution_order()? {
        let task = graph.tasks.iter().find(|task| task.id == id).expect("execution order lists known tasks");

        if task.dependencies.iter().any(|dependency| seeds.contains(dependency) || unkeyed.contains(dependency)) {
            unkeyed.insert(id);
        }
    }

    Ok(unkeyed)
}

/// Whether `target` is a plain script name: no selector syntax (`:`, `~`, `#`, `/`,
/// `^`), no whitespace and no comma list.
fn is_plain_target(target: &str) -> bool {
    !target.is_empty()
        && !target.starts_with('-')
        && !target.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, ':' | '~' | '#' | '/' | '^' | ',' | '\\' | '*' | '?')
        })
}

/// Characters that make a path segment glob magic or an escape for the matcher
/// Node uses to filter a project's files. A path holding one keys on a different
/// walk base in Node, so it is not reproduced.
pub(crate) fn has_glob_magic(path: &str) -> bool {
    path.chars().any(|c| matches!(c, '*' | '?' | '[' | ']' | '{' | '}' | '(' | ')' | '\\' | '!'))
}

fn is_plain_project_root(root: &str) -> bool {
    !root.is_empty()
        && !root.starts_with('/')
        && !has_glob_magic(root)
        && root.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Builds the task graph of `run <target>`: one task per project that has the
/// script, in project order, with the edges `depends_on` asks for.
///
/// Mirrors `createTaskGraph` for the supported shape: a self edge and a peer edge
/// are no ordering edge, a project without the script gets no task and no edge
/// (nothing bridges over it), and a cycle is not reproduced (Node tolerates a
/// dev-only one with a warning).
pub fn build_task_graph(
    target: &str,
    projects: &[RunProject],
    depends_on: DependsOn,
) -> Result<RunTaskGraph, NotReproducible> {
    if !is_plain_target(target) {
        return Err(NotReproducible::InvalidTarget(target.to_owned()));
    }

    let mut names: HashSet<&str> = HashSet::new();

    for project in projects {
        if !names.insert(project.name.as_str()) {
            return Err(NotReproducible::DuplicateProject(project.name.clone()));
        }
    }

    let with_script: HashSet<&str> =
        projects.iter().filter(|project| project.script.is_some()).map(|project| project.name.as_str()).collect();
    let mut tasks = Vec::new();

    for project in projects {
        let Some(script) = &project.script else { continue };
        let id = format!("{}:{target}", project.name);

        if !is_plain_project_root(&project.root) {
            return Err(NotReproducible::UnsafeProjectRoot {
                project: project.name.clone(),
                root: project.root.clone(),
            });
        }

        if script.is_empty() {
            return Err(NotReproducible::EmptyScript(id));
        }

        if script.contains("${") {
            return Err(NotReproducible::ScriptNeedsTokenExpansion(id));
        }

        if project.cache == Some(false) {
            return Err(NotReproducible::CacheDisabled(id));
        }

        if !project.outputs.is_empty() {
            return Err(NotReproducible::DeclaredOutputs(id));
        }

        let mut dependencies: Vec<String> = Vec::new();

        if depends_on == DependsOn::DependenciesSameTarget {
            for dependency in &project.dependencies {
                if dependency.kind == DependencyKind::Peer
                    || dependency.project == project.name
                    || !with_script.contains(dependency.project.as_str())
                {
                    continue;
                }

                dependencies.push(format!("{}:{target}", dependency.project));
            }
        }

        tasks.push(RunTask {
            id,
            project: project.name.clone(),
            root: project.root.clone(),
            command: script.clone(),
            dependencies,
        });
    }

    if tasks.is_empty() {
        return Err(NotReproducible::NoTasks);
    }

    let depended_on: HashSet<&str> =
        tasks.iter().flat_map(|task| task.dependencies.iter().map(String::as_str)).collect();
    let roots =
        tasks.iter().filter(|task| !depended_on.contains(task.id.as_str())).map(|task| task.id.clone()).collect();
    let graph = RunTaskGraph { tasks, roots };

    graph.execution_order()?;

    Ok(graph)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, script: Option<&str>, dependencies: &[(&str, DependencyKind)]) -> RunProject {
        RunProject {
            name: name.to_owned(),
            root: format!("packages/{name}"),
            script: script.map(str::to_owned),
            dependencies: dependencies
                .iter()
                .map(|(project, kind)| ProjectDependency { project: (*project).to_owned(), kind: *kind })
                .collect(),
            ..Default::default()
        }
    }

    fn ids(graph: &RunTaskGraph) -> Vec<&str> {
        graph.tasks.iter().map(|task| task.id.as_str()).collect()
    }

    fn deps<'a>(graph: &'a RunTaskGraph, id: &str) -> Vec<&'a str> {
        graph.tasks.iter().find(|task| task.id == id).unwrap().dependencies.iter().map(String::as_str).collect()
    }

    use DependencyKind::{Dev, Peer, Static};

    #[test]
    fn by_default_no_task_depends_on_another() {
        let projects = [
            project("a", Some("tsc"), &[]),
            project("b", Some("tsc"), &[("a", Static)]),
            project("c", Some("tsc"), &[("b", Static)]),
        ];
        let graph = build_task_graph("build", &projects, DependsOn::Nothing).unwrap();

        assert_eq!(ids(&graph), ["a:build", "b:build", "c:build"]);
        assert!(graph.tasks.iter().all(|task| task.dependencies.is_empty()));
        assert_eq!(graph.roots, ["a:build", "b:build", "c:build"]);
    }

    #[test]
    fn a_project_without_the_script_has_no_task() {
        let projects = [project("a", Some("tsc"), &[]), project("b", None, &[]), project("c", Some("tsc"), &[])];
        let graph = build_task_graph("build", &projects, DependsOn::Nothing).unwrap();

        assert_eq!(ids(&graph), ["a:build", "c:build"]);
    }

    #[test]
    fn caret_target_links_the_same_target_of_dependencies() {
        let projects = [
            project("a", Some("x"), &[]),
            project("b", Some("x"), &[("a", Static)]),
            project("c", Some("x"), &[("a", Static)]),
            project("d", Some("x"), &[("b", Static), ("c", Dev)]),
        ];
        let graph = build_task_graph("build", &projects, DependsOn::DependenciesSameTarget).unwrap();

        assert_eq!(deps(&graph, "d:build"), ["b:build", "c:build"]);
        assert_eq!(deps(&graph, "b:build"), ["a:build"]);
        assert_eq!(graph.roots, ["d:build"]);
    }

    #[test]
    fn caret_target_skips_self_peer_and_script_less_dependencies() {
        let projects = [
            project("a", Some("x"), &[]),
            project("gap", None, &[("a", Static)]),
            project("b", Some("x"), &[("b", Static), ("a", Peer), ("gap", Static)]),
        ];
        let graph = build_task_graph("build", &projects, DependsOn::DependenciesSameTarget).unwrap();

        assert!(deps(&graph, "b:build").is_empty());
        assert_eq!(graph.roots, ["a:build", "b:build"]);
    }

    #[test]
    fn caret_target_does_not_bridge_over_a_script_less_project() {
        let projects = [
            project("a", Some("x"), &[]),
            project("gap", None, &[("a", Static)]),
            project("c", Some("x"), &[("gap", Static)]),
        ];
        let graph = build_task_graph("build", &projects, DependsOn::DependenciesSameTarget).unwrap();

        assert!(deps(&graph, "c:build").is_empty());
    }

    #[test]
    fn a_project_reached_by_two_edges_is_listed_twice_as_node_does() {
        let projects = [project("a", Some("x"), &[]), project("b", Some("x"), &[("a", Static), ("a", Dev)])];
        let graph = build_task_graph("build", &projects, DependsOn::DependenciesSameTarget).unwrap();

        assert_eq!(deps(&graph, "b:build"), ["a:build", "a:build"]);
        assert_eq!(graph.roots, ["b:build"]);
        assert_eq!(graph.execution_order().unwrap().len(), 2);
    }

    #[test]
    fn a_cycle_is_not_reproduced_even_when_only_dev_edges_make_it() {
        let projects = [project("a", Some("x"), &[("b", Dev)]), project("b", Some("x"), &[("a", Static)])];

        assert_eq!(
            build_task_graph("build", &projects, DependsOn::DependenciesSameTarget),
            Err(NotReproducible::Cycle)
        );
    }

    #[test]
    fn a_cycle_between_projects_is_no_cycle_when_no_task_depends_on_another() {
        let projects = [project("a", Some("x"), &[("b", Static)]), project("b", Some("x"), &[("a", Static)])];

        assert!(build_task_graph("build", &projects, DependsOn::Nothing).is_ok());
    }

    #[test]
    fn execution_order_puts_dependencies_first() {
        let projects = [
            project("d", Some("x"), &[("b", Static), ("c", Static)]),
            project("b", Some("x"), &[("a", Static)]),
            project("c", Some("x"), &[("a", Static)]),
            project("a", Some("x"), &[]),
        ];
        let order =
            build_task_graph("build", &projects, DependsOn::DependenciesSameTarget).unwrap().execution_order().unwrap();
        let position = |id: &str| order.iter().position(|candidate| candidate == id).unwrap();

        assert!(position("a:build") < position("b:build"));
        assert!(position("a:build") < position("c:build"));
        assert!(position("b:build") < position("d:build"));
        assert!(position("c:build") < position("d:build"));
    }

    #[test]
    fn unsupported_inputs_are_not_reproducible() {
        let build = |change: &dyn Fn(&mut RunProject)| {
            let mut only = project("a", Some("tsc"), &[]);

            change(&mut only);
            build_task_graph("build", &[only], DependsOn::Nothing)
        };

        assert_eq!(build(&|p| p.script = Some(String::new())), Err(NotReproducible::EmptyScript("a:build".into())));
        assert_eq!(
            build(&|p| p.script = Some("echo ${affected.files}".into())),
            Err(NotReproducible::ScriptNeedsTokenExpansion("a:build".into()))
        );
        assert_eq!(build(&|p| p.cache = Some(false)), Err(NotReproducible::CacheDisabled("a:build".into())));
        assert_eq!(
            build(&|p| p.outputs = vec!["dist".into()]),
            Err(NotReproducible::DeclaredOutputs("a:build".into()))
        );
        assert_eq!(build(&|p| p.script = None), Err(NotReproducible::NoTasks));

        for root in ["", ".", "..", "/abs", "a//b", "a/../b", "pkg/[x]", "pkg/{a,b}", "pkg/a*"] {
            assert!(
                matches!(build(&|p| p.root = root.into()), Err(NotReproducible::UnsafeProjectRoot { .. })),
                "root {root:?}"
            );
        }
    }

    #[test]
    fn a_cache_enabled_task_stays_in_shape() {
        let mut only = project("a", Some("tsc"), &[]);

        only.cache = Some(true);

        assert!(build_task_graph("build", &[only], DependsOn::Nothing).is_ok());
    }

    #[test]
    fn selector_syntax_in_the_target_is_not_reproducible() {
        let projects = [project("a", Some("tsc"), &[])];

        for target in ["", ":build", "~:build", "#tag:build", "a/b", "^build", "build test", "build,test", "-x"] {
            assert_eq!(
                build_task_graph(target, &projects, DependsOn::Nothing),
                Err(NotReproducible::InvalidTarget(target.into())),
                "target {target:?}"
            );
        }
    }

    #[test]
    fn duplicate_project_names_are_not_reproducible() {
        let projects = [project("a", Some("x"), &[]), project("a", Some("x"), &[])];

        assert_eq!(
            build_task_graph("build", &projects, DependsOn::Nothing),
            Err(NotReproducible::DuplicateProject("a".into()))
        );
    }

    #[test]
    fn unkeyed_propagates_through_every_level() {
        let projects = [
            project("a", Some("x"), &[]),
            project("b", Some("x"), &[("a", Static)]),
            project("c", Some("x"), &[("b", Static)]),
            project("d", Some("x"), &[]),
        ];
        let graph = build_task_graph("build", &projects, DependsOn::DependenciesSameTarget).unwrap();
        let seeds: HashSet<String> = ["a:build".to_owned()].into();
        let unkeyed = unkeyed_tasks(&graph, &seeds).unwrap();

        // The seed has no key itself, but only its dependents are "unkeyed".
        assert_eq!(unkeyed, ["b:build".to_owned(), "c:build".to_owned()].into());
    }

    #[test]
    fn without_seeds_every_task_is_keyed() {
        let projects = [project("a", Some("x"), &[]), project("b", Some("x"), &[("a", Static)])];
        let graph = build_task_graph("build", &projects, DependsOn::DependenciesSameTarget).unwrap();

        assert!(unkeyed_tasks(&graph, &HashSet::new()).unwrap().is_empty());
    }
}
