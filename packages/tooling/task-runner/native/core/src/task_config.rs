//! The task graph of a workspace whose targets are `package.json` scripts and the `tasks` defaults of a
//! literal `vis.config`, built the way Node builds it, or refused.
//!
//! # What Node does (the order this module mirrors)
//!
//! 1. `discoverWorkspace` gives every project its targets. For each `package.json` script `name` the target is
//!    `mergeTarget(defaults[name], script)`: the `tasks[name]` default wins, and the script text becomes the
//!    `command` only when the default has none. A `tasks` default that carries a `command` (or an `executor`)
//!    materialises as a target of every project, after the scripts, in `tasks` order. A default without a command
//!    is a default *for* a target, never a declaration of one. `project.json` targets, a `vis.task.ts` overlay,
//!    `scopedTasks`, presets, `type` and the inference of detectors all add to this; none of them is read here.
//! 2. `createTaskGraph` starts from the seed tasks and walks breadth first. A task's `dependsOn` is the target's
//!    (the merged default); `"^t"` is target `t` on every project this one depends on (self and peer edges and
//!    projects without the target skipped, in project-graph order), `"t"` is target `t` on the same project, and
//!    `{ target, dependencies: true }` is `"^t"`. `{ target, projects }` is `t` on every project the selectors name:
//!    an exact project name wins, otherwise a selector with `*` or `?` is a glob over project names (`*` crosses
//!    `/`), and the declaring task is dropped from its own matches. `dependencies: true` wins over `projects`; a
//!    `projects` of `""` falls through to the same-project form while `[]` yields no edge. A selector that matches
//!    nothing yields no edge and a warning. Every resolved dependency is one edge, a duplicate included, and a task
//!    is visited once, in the order it was first queued. A cycle through `devDependencies` edges only is broken with
//!    a warning; any other cycle stays and the run reports it.
//! 3. The seeds are one task per project that has the run target, in project order (`Seeds::Target`, what `run`
//!    builds), or every target of every project (`Seeds::AllTargets`, what `task-why` builds).
//!
//! # What is read, and what is refused
//!
//! The `tasks` entries may carry `command`, `cache`, `dependsOn`, `outputs`, `inputs` and `description`; any other
//! key is refused, and so is any other top-level config key except `$schema` and `inferTargets` (see
//! [`TaskConfig::parse`]). `{ group }` entries, `executor`, `options`, `splitCompound`, `aliases`, `type`, `preset`
//! and the rest need a model of the run that is not here. A cycle, a task whose command has a `${` token, an empty
//! command, a name that JavaScript would reorder or resolve through `Object.prototype`, and every `dependsOn` entry
//! Node rejects while it loads the workspace are refused too: the caller hands those to Node, which reports them.
//!
//! The config is the file as written. `loadVisConfig` hands `discoverWorkspace` that object with the `security` and
//! `update` defaults added and `extends` merged in; the first two leave `tasks`, `inferTargets` and the discovery
//! keys alone and `extends` is refused here, so what is read below reaches Node unchanged. The config that already
//! went through the defaults has those two keys and is refused too.
//!
//! The caller owns what is not in the input, and says so in [`Assumptions`]: no project has a `project.json` or a
//! `vis.task.*` overlay, and inference cannot add or change a target.
//!
//! # Who uses what
//!
//! `task-why` seeds every target of every project ([`Seeds::AllTargets`]) and checks that a project has a target
//! with [`project_targets`]; `status` counts targets with [`project_targets`]; `run` and `action-graph` seed one
//! target ([`Seeds::Target`]), which does not take a subset of the projects yet. `graph` renders the project graph
//! and builds no task graph. The remaining work per command is kept with the plan, not here.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;

use serde_json::Value;

use crate::run_graph::{DependencyKind, ProjectDependency};

/// Why a graph cannot be built here. Each variant names one input outside the supported shape; Node handles all of
/// them, and reports the ones that are errors there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GraphRefusal {
    /// The config is not an object.
    ConfigNotAnObject,
    /// A top-level config key this module does not read.
    UnsupportedConfigKey(String),
    /// `inferTargets` is not a boolean.
    UnsupportedInferTargets,
    /// Inference of targets was neither switched off nor checked to have nothing to infer.
    InferenceNotRuledOut,
    /// A `project.json` or `vis.task.*` overlay may exist, which adds targets and changes their configuration.
    ProjectFilesNotRuledOut,
    /// `tasks` is not an object, or its key order is not a permutation of its keys.
    InvalidTasks,
    /// A `tasks` entry is not an object.
    TargetNotAnObject(String),
    /// A `tasks` entry key this module does not read.
    UnsupportedTargetKey { target: String, key: String },
    /// A `tasks` entry value of a type Node would treat differently.
    InvalidTargetValue { target: String, key: &'static str },
    /// A `dependsOn` entry Node rejects (or crashes on) while it loads the workspace.
    InvalidDependsOn { target: String, reason: &'static str },
    /// A `dependsOn` entry this module does not resolve, such as `{ group }`.
    UnsupportedDependsOn { target: String, reason: &'static str },
    /// A project, target or selector name JavaScript would reorder, resolve through `Object.prototype`, or match
    /// differently as a regular expression.
    UnsafeName(String),
    /// Two projects share a name.
    DuplicateProject(String),
    /// A project lists the same dependency twice: `buildProjectGraph` lists a project once per dependent, whatever
    /// the dependency kinds, so the input is not the project graph Node builds.
    DuplicateEdge { project: String, dependency: String },
    /// The seeds are empty: no project has the target.
    NoTasks,
    /// A task whose command is empty, or that has none.
    EmptyCommand(String),
    /// A command with a `${` token, which Node rewrites before it hashes the command.
    CommandNeedsTokenExpansion(String),
    /// The task graph has a cycle, which Node reports or breaks with a warning.
    Cycle,
}

impl fmt::Display for GraphRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConfigNotAnObject => f.write_str("the config is not an object"),
            Self::UnsupportedConfigKey(key) => write!(f, "config key {key:?} is not read natively"),
            Self::UnsupportedInferTargets => f.write_str("`inferTargets` is not a boolean"),
            Self::InferenceNotRuledOut => f.write_str("target inference is neither disabled nor checked"),
            Self::ProjectFilesNotRuledOut => f.write_str("a project.json or vis.task overlay may exist"),
            Self::InvalidTasks => f.write_str("`tasks` is not an object in a known key order"),
            Self::TargetNotAnObject(target) => write!(f, "tasks entry {target:?} is not an object"),
            Self::UnsupportedTargetKey { target, key } => {
                write!(f, "tasks entry {target:?} has the key {key:?}, which is not read natively")
            }
            Self::InvalidTargetValue { target, key } => {
                write!(f, "tasks entry {target:?} has an unsupported value for {key:?}")
            }
            Self::InvalidDependsOn { target, reason } => {
                write!(f, "tasks entry {target:?} has a dependsOn entry Node rejects: {reason}")
            }
            Self::UnsupportedDependsOn { target, reason } => {
                write!(f, "tasks entry {target:?} has a dependsOn entry that is not read natively: {reason}")
            }
            Self::UnsafeName(name) => write!(f, "name {name:?} is not reproducible"),
            Self::DuplicateProject(name) => write!(f, "project name {name} is used twice"),
            Self::DuplicateEdge { project, dependency } => {
                write!(f, "project {project} lists the dependency {dependency} twice")
            }
            Self::NoTasks => f.write_str("no project has the target"),
            Self::EmptyCommand(id) => write!(f, "task {id} has no command"),
            Self::CommandNeedsTokenExpansion(id) => write!(f, "the command of task {id} contains a `${{` token"),
            Self::Cycle => f.write_str("the task graph has a cycle"),
        }
    }
}

impl std::error::Error for GraphRefusal {}

/// What Node warns about while it builds the graph and goes on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GraphWarning {
    /// A `dependsOn.projects` entry that matched no project, so no edge was created.
    UnmatchedProjectSelector(String),
}

/// Whether Node's target inference can add or change a target of the workspace. The caller knows: it is the
/// `inferTargets` setting and, when that is not `false`, whether any detector's marker exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InferenceState {
    /// Nothing was checked.
    Unchecked,
    /// `inferTargets` is `false`, which the config says itself.
    Disabled,
    /// No detector has a marker in any project, so inference finds nothing to add or change.
    NothingToInfer,
}

/// What the input does not show and the caller vouches for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Assumptions {
    pub inference: InferenceState,
    /// No project has a `project.json` or a `vis.task.*` overlay.
    pub no_project_files: bool,
}

/// One entry of a target's `dependsOn`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DependsOnEntry {
    /// `"t"`, and `{ target: "t" }` with no selector: the target on the same project.
    SameProject(String),
    /// `"^t"`, and `{ target: "t", dependencies: true }`: the target on every project this one depends on.
    Dependencies(String),
    /// `{ target: "t", projects }`: the target on every project a selector names, an exact name or a glob.
    Projects { target: String, selectors: Vec<String> },
}

/// An output of a target: a path or glob with its tokens still in it, or the `{ auto: true }` marker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutputEntry {
    Pattern(String),
    Auto,
}

/// One `tasks` entry of the config, the part this module reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TargetDefaults {
    pub command: Option<String>,
    pub cache: Option<bool>,
    pub depends_on: Option<Vec<DependsOnEntry>>,
    pub outputs: Option<Vec<OutputEntry>>,
    /// `inputs` is present, whatever it holds: the one thing the task graph carries of it.
    pub declares_inputs: bool,
}

/// The `tasks` defaults of a config, in the key order of the file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskConfig {
    pub defaults: Vec<(String, TargetDefaults)>,
    /// `inferTargets` is `false`.
    pub inference_disabled: bool,
}

const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// Whether JavaScript would put the key first in an object, in numeric order, whatever the order it was written in
/// (an array index: `0` or digits with no leading zero, below 2^32 - 1).
fn is_integer_like(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| byte.is_ascii_digit())
        && (name == "0" || !name.starts_with('0'))
        && name.parse::<u64>().is_ok_and(|number| number < u64::from(u32::MAX))
}

/// A name that reads the same through every lookup Node makes: as an object key, in a glob and in a task id.
fn check_name(name: &str) -> Result<(), GraphRefusal> {
    let unsafe_name = name.is_empty()
        || is_integer_like(name)
        || OBJECT_PROTOTYPE_KEYS.contains(&name)
        || name.chars().any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}' || u32::from(c) > 0xFFFF);

    if unsafe_name {
        return Err(GraphRefusal::UnsafeName(name.to_owned()));
    }

    Ok(())
}

/// The rule of `validateDependsOnEntries`: a name that is a file pattern, a token or empty is an error in Node.
fn check_depends_on_name(target: &str, name: &str) -> Result<(), GraphRefusal> {
    let reject = |reason| Err(GraphRefusal::InvalidDependsOn { target: target.to_owned(), reason });

    if name.is_empty() {
        return reject("it names no target");
    }

    let looks_like_file = (name.contains('/') || name.contains('\\')) && has_file_extension(name);

    if name.contains(['*', '{', '}']) || looks_like_file {
        return reject("it is a file pattern, not a target name");
    }

    check_name(name)
}

/// The `/\.[a-z0-9]+$/i` test.
fn has_file_extension(name: &str) -> bool {
    let Some((_, extension)) = name.rsplit_once('.') else { return false };

    !extension.is_empty() && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// `looksLikeInputUri`: an optional `!`, a scheme and `://`.
fn looks_like_input_uri(input: &str) -> bool {
    let body = input.strip_prefix('!').unwrap_or(input);
    let Some((scheme, _)) = body.split_once("://") else { return false };
    let mut chars = scheme.chars();

    chars.next().is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

const INHERIT: &str = "@inherit";

/// An array of a `tasks` entry with the `@inherit` entries dropped: they splice the parent's values in, and a
/// config default has no parent.
fn without_inherit<'a>(target: &str, key: &'static str, value: &'a Value) -> Result<Vec<&'a Value>, GraphRefusal> {
    let Value::Array(items) = value else {
        return Err(GraphRefusal::InvalidTargetValue { target: target.to_owned(), key });
    };

    Ok(items.iter().filter(|item| item.as_str() != Some(INHERIT)).collect())
}

fn parse_depends_on(target: &str, value: &Value) -> Result<Vec<DependsOnEntry>, GraphRefusal> {
    let invalid = |reason| GraphRefusal::InvalidDependsOn { target: target.to_owned(), reason };
    let mut entries = Vec::new();

    for item in without_inherit(target, "dependsOn", value)? {
        match item {
            Value::String(text) => {
                if let Some(name) = text.strip_prefix('^') {
                    check_depends_on_name(target, name)?;
                    entries.push(DependsOnEntry::Dependencies(name.to_owned()));
                } else {
                    check_depends_on_name(target, text)?;
                    entries.push(DependsOnEntry::SameProject(text.clone()));
                }
            }
            Value::Object(object) => {
                if object.contains_key("group") {
                    return Err(GraphRefusal::UnsupportedDependsOn {
                        target: target.to_owned(),
                        reason: "a task group",
                    });
                }

                if object.keys().any(|key| !matches!(key.as_str(), "target" | "dependencies" | "projects" | "params")) {
                    return Err(GraphRefusal::UnsupportedDependsOn {
                        target: target.to_owned(),
                        reason: "an unknown key",
                    });
                }

                let Some(Value::String(name)) = object.get("target") else {
                    return Err(invalid("an object entry needs a string `target`"));
                };

                check_depends_on_name(target, name)?;

                if !matches!(object.get("params"), None | Some(Value::Null) | Some(Value::String(_))) {
                    return Err(GraphRefusal::InvalidTargetValue { target: target.to_owned(), key: "dependsOn" });
                }

                if let Some(Value::String(params)) = object.get("params") {
                    if params != "forward" && params != "ignore" {
                        return Err(GraphRefusal::InvalidTargetValue { target: target.to_owned(), key: "dependsOn" });
                    }
                }

                let dependencies = match object.get("dependencies") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(flag)) => *flag,
                    Some(_) => {
                        return Err(GraphRefusal::InvalidTargetValue { target: target.to_owned(), key: "dependsOn" })
                    }
                };
                let selectors: Option<Vec<String>> = match object.get("projects") {
                    None | Some(Value::Null) => None,
                    // An empty string is falsy: the entry falls through to the same-project form.
                    Some(Value::String(selector)) if selector.is_empty() => None,
                    Some(Value::String(selector)) => Some(vec![selector.clone()]),
                    // An empty array is truthy: it selects nothing and gives no edge.
                    Some(Value::Array(items)) => {
                        let mut selectors = Vec::new();

                        for item in items {
                            let Value::String(selector) = item else {
                                return Err(GraphRefusal::InvalidTargetValue {
                                    target: target.to_owned(),
                                    key: "dependsOn",
                                });
                            };

                            selectors.push(selector.clone());
                        }

                        Some(selectors)
                    }
                    Some(_) => {
                        return Err(GraphRefusal::InvalidTargetValue { target: target.to_owned(), key: "dependsOn" })
                    }
                };

                if dependencies {
                    entries.push(DependsOnEntry::Dependencies(name.clone()));
                } else if let Some(selectors) = selectors {
                    for selector in &selectors {
                        if selector
                            .chars()
                            .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}' || u32::from(c) > 0xFFFF)
                        {
                            return Err(GraphRefusal::UnsafeName(selector.clone()));
                        }
                    }

                    entries.push(DependsOnEntry::Projects { target: name.clone(), selectors });
                } else {
                    entries.push(DependsOnEntry::SameProject(name.clone()));
                }
            }
            _ => return Err(invalid("an entry is neither a string nor an object")),
        }
    }

    Ok(entries)
}

fn parse_outputs(target: &str, value: &Value) -> Result<Vec<OutputEntry>, GraphRefusal> {
    let mut outputs = Vec::new();

    for item in without_inherit(target, "outputs", value)? {
        match item {
            Value::String(pattern) => outputs.push(OutputEntry::Pattern(pattern.clone())),
            Value::Object(object) if object.len() == 1 && object.get("auto") == Some(&Value::Bool(true)) => {
                outputs.push(OutputEntry::Auto)
            }
            _ => return Err(GraphRefusal::InvalidTargetValue { target: target.to_owned(), key: "outputs" }),
        }
    }

    Ok(outputs)
}

/// `inputs` only has to be a list of plain glob strings: a URI-shaped entry is validated (and may throw) while
/// Node loads the workspace, and a file group entry is resolved against `fileGroups`.
fn check_inputs(target: &str, value: &Value) -> Result<(), GraphRefusal> {
    for item in without_inherit(target, "inputs", value)? {
        let plain = item.as_str().is_some_and(|input| !input.starts_with('@') && !looks_like_input_uri(input));

        if !plain {
            return Err(GraphRefusal::InvalidTargetValue { target: target.to_owned(), key: "inputs" });
        }
    }

    Ok(())
}

impl TargetDefaults {
    /// Reads one `tasks` entry.
    pub fn parse(target: &str, value: &Value) -> Result<Self, GraphRefusal> {
        let Value::Object(object) = value else { return Err(GraphRefusal::TargetNotAnObject(target.to_owned())) };
        let mut defaults = Self::default();
        let invalid = |key| GraphRefusal::InvalidTargetValue { target: target.to_owned(), key };

        for (key, value) in object {
            match key.as_str() {
                "command" => defaults.command = Some(value.as_str().ok_or_else(|| invalid("command"))?.to_owned()),
                "cache" => defaults.cache = Some(value.as_bool().ok_or_else(|| invalid("cache"))?),
                "dependsOn" => defaults.depends_on = Some(parse_depends_on(target, value)?),
                "outputs" => defaults.outputs = Some(parse_outputs(target, value)?),
                "inputs" => {
                    check_inputs(target, value)?;
                    defaults.declares_inputs = true;
                }
                "description" if value.is_string() => {}
                "description" => return Err(invalid("description")),
                _ => return Err(GraphRefusal::UnsupportedTargetKey { target: target.to_owned(), key: key.clone() }),
            }
        }

        Ok(defaults)
    }
}

impl TaskConfig {
    /// Reads a config: `config` is the value of the whole file, `task_order` the keys of its `tasks` in the order
    /// the file lists them (a permutation of the keys of `tasks`, which the parsed value has lost).
    ///
    /// Top-level keys other than `$schema`, `tasks` and `inferTargets` are refused: each of the others either
    /// changes which projects and targets exist (`scopedTasks`, `projectIgnore`, the `discover` flags,
    /// `taskGroups`, `fileGroups`) or has not been checked to leave the graph alone. A key of `tasks` that is an
    /// array index is refused, since JavaScript lists those first whatever the file says.
    pub fn parse(config: &Value, task_order: &[String]) -> Result<Self, GraphRefusal> {
        let object = match config {
            Value::Null => return Self::from_tasks(None, task_order, false),
            Value::Object(object) => object,
            _ => return Err(GraphRefusal::ConfigNotAnObject),
        };

        for key in object.keys() {
            if !matches!(key.as_str(), "$schema" | "tasks" | "inferTargets") {
                return Err(GraphRefusal::UnsupportedConfigKey(key.clone()));
            }
        }

        let inference_disabled = match object.get("inferTargets") {
            None | Some(Value::Bool(true)) => false,
            Some(Value::Bool(false)) => true,
            Some(_) => return Err(GraphRefusal::UnsupportedInferTargets),
        };

        Self::from_tasks(object.get("tasks"), task_order, inference_disabled)
    }

    fn from_tasks(
        tasks: Option<&Value>,
        task_order: &[String],
        inference_disabled: bool,
    ) -> Result<Self, GraphRefusal> {
        let entries = match tasks {
            None => None,
            Some(Value::Object(entries)) => Some(entries),
            Some(_) => return Err(GraphRefusal::InvalidTasks),
        };
        let count = entries.map_or(0, serde_json::Map::len);
        let unique: HashSet<&String> = task_order.iter().collect();

        if task_order.len() != count || unique.len() != count {
            return Err(GraphRefusal::InvalidTasks);
        }

        let mut defaults = Vec::with_capacity(count);

        for name in task_order {
            let Some(value) = entries.and_then(|entries| entries.get(name)) else {
                return Err(GraphRefusal::InvalidTasks);
            };

            check_name(name)?;
            defaults.push((name.clone(), TargetDefaults::parse(name, value)?));
        }

        Ok(Self { defaults, inference_disabled })
    }
}

/// One workspace project as the graph sees it.
#[derive(Clone, Debug, Default)]
pub struct ConfigProject {
    /// The project name Node keys the workspace by.
    pub name: String,
    /// The project directory, relative to the workspace root, with `/` separators (empty for the workspace root).
    pub root: String,
    /// The `package.json` scripts, in the order of the file, each a target of the project.
    pub scripts: Vec<(String, String)>,
    /// The project graph's edges from this project, in project-graph order, one per project (the way
    /// `buildProjectGraph` lists them: a project that is a `dependency` and a `devDependency` is one `static`
    /// edge). A project listed twice is refused.
    pub dependencies: Vec<ProjectDependency>,
}

/// Which tasks the graph starts from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seeds<'a> {
    /// One task per project that has the target, in project order: the tasks `run <target>` asks for.
    Target(&'a str),
    /// Every target of every project, in project order and target order: the tasks `task-why` seeds.
    AllTargets,
}

/// One task of the graph.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfiguredTask {
    /// `<project>:<target>`.
    pub id: String,
    pub project: String,
    pub target: String,
    /// The project directory, relative to the workspace root.
    pub root: String,
    /// The command Node runs: the default's `command`, or else the script text. [`Seeds::AllTargets`] carries the
    /// text as written and does not check it (an empty one, a `${` token), since that graph never runs or hashes it.
    pub command: String,
    pub cache: Option<bool>,
    /// The outputs with `{projectRoot}` (`.` for the workspace root) and `{projectName}` replaced.
    pub outputs: Vec<OutputEntry>,
    pub declares_inputs: bool,
    /// Ids of the tasks this one depends on, one per resolved dependency, in resolution order.
    pub dependencies: Vec<String>,
}

/// The task graph: the tasks in the order Node first visits them, and the tasks nothing depends on in that order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfiguredTaskGraph {
    pub tasks: Vec<ConfiguredTask>,
    pub roots: Vec<String>,
    pub warnings: Vec<GraphWarning>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct TaskRef {
    project: usize,
    target: String,
}

struct Builder<'a> {
    projects: &'a [ConfigProject],
    by_name: HashMap<&'a str, usize>,
    /// `tasks` defaults by target name.
    defaults: HashMap<&'a str, &'a TargetDefaults>,
    /// The targets a default with a command adds to every project, in `tasks` order.
    default_targets: Vec<&'a str>,
    /// Per project, its scripts by name.
    scripts: Vec<HashMap<&'a str, &'a str>>,
    warnings: Vec<GraphWarning>,
}

impl<'a> Builder<'a> {
    fn new(projects: &'a [ConfigProject], config: &'a TaskConfig) -> Result<Self, GraphRefusal> {
        let mut by_name = HashMap::new();
        let mut scripts = Vec::with_capacity(projects.len());

        for (index, project) in projects.iter().enumerate() {
            check_name(&project.name)?;

            if by_name.insert(project.name.as_str(), index).is_some() {
                return Err(GraphRefusal::DuplicateProject(project.name.clone()));
            }

            let mut listed = HashSet::new();

            for dependency in &project.dependencies {
                if !listed.insert(dependency.project.as_str()) {
                    return Err(GraphRefusal::DuplicateEdge {
                        project: project.name.clone(),
                        dependency: dependency.project.clone(),
                    });
                }
            }

            let mut project_scripts = HashMap::new();

            for (name, command) in &project.scripts {
                check_name(name)?;
                project_scripts.insert(name.as_str(), command.as_str());
            }

            scripts.push(project_scripts);
        }

        let defaults: HashMap<&str, &TargetDefaults> =
            config.defaults.iter().map(|(name, defaults)| (name.as_str(), defaults)).collect();
        let default_targets = config
            .defaults
            .iter()
            .filter(|(_, defaults)| defaults.command.is_some())
            .map(|(name, _)| name.as_str())
            .collect();

        Ok(Self { projects, by_name, defaults, default_targets, scripts, warnings: Vec::new() })
    }

    /// `projectHasTarget`: a script of the project, or a default that brings its own command.
    fn has_target(&self, project: usize, target: &str) -> bool {
        self.scripts[project].contains_key(target)
            || self.defaults.get(target).is_some_and(|defaults| defaults.command.is_some())
    }

    fn task(&self, project: usize, target: &str) -> Option<TaskRef> {
        self.has_target(project, target).then(|| TaskRef { project, target: target.to_owned() })
    }

    fn id(&self, task: &TaskRef) -> String {
        format!("{}:{}", self.projects[task.project].name, task.target)
    }

    /// `getDependencyProjectTasks`.
    fn dependency_tasks(&self, project: usize, target: &str) -> Vec<TaskRef> {
        let name = self.projects[project].name.as_str();
        let mut tasks = Vec::new();

        for dependency in &self.projects[project].dependencies {
            if dependency.project == name || dependency.kind == DependencyKind::Peer {
                continue;
            }

            let Some(&dependency_project) = self.by_name.get(dependency.project.as_str()) else { continue };

            tasks.extend(self.task(dependency_project, target));
        }

        tasks
    }

    /// `expandProjectSelector`: an exact project name, else a glob over the project names in project order.
    fn expand_selector(&self, selector: &str) -> Vec<usize> {
        if let Some(&project) = self.by_name.get(selector) {
            return vec![project];
        }

        if !selector.contains(['*', '?']) {
            return Vec::new();
        }

        let pattern: Vec<char> = selector.chars().collect();

        self.projects
            .iter()
            .enumerate()
            .filter(|(_, project)| glob_matches(&pattern, &project.name.chars().collect::<Vec<_>>()))
            .map(|(index, _)| index)
            .collect()
    }

    /// `resolveTaskDependencies`: the dependencies of a task, one entry per resolved task.
    fn resolve(&mut self, task: &TaskRef) -> Vec<TaskRef> {
        let Some(entries) = self.defaults.get(task.target.as_str()).and_then(|defaults| defaults.depends_on.as_ref())
        else {
            return Vec::new();
        };
        let entries = entries.clone();
        let own_id = self.id(task);
        let mut resolved = Vec::new();

        for entry in &entries {
            match entry {
                DependsOnEntry::SameProject(target) => resolved.extend(self.task(task.project, target)),
                DependsOnEntry::Dependencies(target) => resolved.extend(self.dependency_tasks(task.project, target)),
                DependsOnEntry::Projects { target, selectors } => {
                    for selector in selectors {
                        let matched = self.expand_selector(selector);

                        if matched.is_empty() {
                            self.warnings.push(GraphWarning::UnmatchedProjectSelector(selector.clone()));

                            continue;
                        }

                        for project in matched {
                            // The declaring task is dropped from its own matches, by task id.
                            resolved
                                .extend(self.task(project, target).filter(|candidate| self.id(candidate) != own_id));
                        }
                    }
                }
            }
        }

        resolved
    }

    /// The targets of a project in the order of Node's `targets` object: the scripts in file order, then the
    /// targets the defaults with a command add, in `tasks` order.
    fn targets_of(&self, project: usize) -> impl Iterator<Item = &'a str> + '_ {
        let scripts = self.projects[project].scripts.iter().map(|(name, _)| name.as_str());
        let defaults =
            self.default_targets.iter().copied().filter(move |name| !self.scripts[project].contains_key(name));

        scripts.chain(defaults)
    }

    fn seeds(&self, seeds: Seeds<'_>) -> Vec<TaskRef> {
        let mut tasks = Vec::new();

        for project in 0..self.projects.len() {
            match seeds {
                Seeds::Target(target) => tasks.extend(self.task(project, target)),
                Seeds::AllTargets => {
                    tasks.extend(self.targets_of(project).map(|target| TaskRef { project, target: target.to_owned() }));
                }
            }
        }

        tasks
    }

    /// The task as Node carries it, with its dependencies filled in by the caller.
    fn describe(
        &self,
        task: &TaskRef,
        dependencies: Vec<String>,
        check_command: bool,
    ) -> Result<ConfiguredTask, GraphRefusal> {
        let project = &self.projects[task.project];
        let id = self.id(task);
        let defaults = self.defaults.get(task.target.as_str());
        let command = match defaults.and_then(|defaults| defaults.command.as_deref()) {
            Some(command) => command,
            None => self.scripts[task.project].get(task.target.as_str()).copied().unwrap_or_default(),
        };

        if check_command && command.is_empty() {
            return Err(GraphRefusal::EmptyCommand(id));
        }

        if check_command && command.contains("${") {
            return Err(GraphRefusal::CommandNeedsTokenExpansion(id));
        }

        let root = if project.root.is_empty() { "." } else { project.root.as_str() };
        let outputs = defaults
            .and_then(|defaults| defaults.outputs.as_ref())
            .map(|outputs| {
                outputs
                    .iter()
                    .map(|output| match output {
                        OutputEntry::Pattern(pattern) => OutputEntry::Pattern(
                            pattern.replace("{projectRoot}", root).replace("{projectName}", &project.name),
                        ),
                        OutputEntry::Auto => OutputEntry::Auto,
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(ConfiguredTask {
            id,
            project: project.name.clone(),
            target: task.target.clone(),
            root: project.root.clone(),
            command: command.to_owned(),
            cache: defaults.and_then(|defaults| defaults.cache),
            outputs,
            declares_inputs: defaults.is_some_and(|defaults| defaults.declares_inputs),
            dependencies,
        })
    }
}

/// A glob over characters where `*` matches any run (a `/` included) and `?` any one character: the regular
/// expression `^...$` Node builds from a selector, over names with no line terminator.
fn glob_matches(pattern: &[char], text: &[char]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;

    while t < text.len() {
        if p < pattern.len() && pattern[p] == '*' {
            backtrack = Some((p, t));
            p += 1;
        } else if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if let Some((star, matched)) = backtrack {
            p = star + 1;
            t = matched + 1;
            backtrack = Some((star, matched + 1));
        } else {
            return false;
        }
    }

    pattern[p..].iter().all(|&c| c == '*')
}

/// Whether the edges, as ids, have a cycle: a task that depends on itself is one.
fn has_cycle(ids: &[String], edges: &[Vec<usize>]) -> bool {
    let mut remaining: Vec<usize> = vec![0; ids.len()];

    for targets in edges {
        for &target in targets {
            remaining[target] += 1;
        }
    }

    let mut ready: Vec<usize> = (0..ids.len()).filter(|&task| remaining[task] == 0).collect();
    let mut seen = 0;

    while let Some(task) = ready.pop() {
        seen += 1;

        for &target in &edges[task] {
            remaining[target] -= 1;

            if remaining[target] == 0 {
                ready.push(target);
            }
        }
    }

    seen != ids.len()
}

fn check_assumptions(config: &TaskConfig, assumptions: Assumptions) -> Result<(), GraphRefusal> {
    if !assumptions.no_project_files {
        return Err(GraphRefusal::ProjectFilesNotRuledOut);
    }

    if assumptions.inference == InferenceState::Unchecked && !config.inference_disabled {
        return Err(GraphRefusal::InferenceNotRuledOut);
    }

    Ok(())
}

/// The targets of every project, in project order and, within a project, in the order of its `targets` object in
/// Node: the scripts in file order, then the targets the defaults with a command add. A `status` that counts targets
/// and a `task-why` that checks one exists need only this, and no graph (so no cycle refuses it).
pub fn project_targets(
    projects: &[ConfigProject],
    config: &TaskConfig,
    assumptions: Assumptions,
) -> Result<Vec<(String, Vec<String>)>, GraphRefusal> {
    check_assumptions(config, assumptions)?;

    let builder = Builder::new(projects, config)?;

    Ok((0..projects.len())
        .map(|project| (projects[project].name.clone(), builder.targets_of(project).map(str::to_owned).collect()))
        .collect())
}

/// Builds the task graph `createTaskGraph` builds for `projects` and the `tasks` defaults of `config`, or says why
/// it cannot: see the module documentation for the shapes.
///
/// A cycle is refused whatever edges make it: Node breaks one that runs only through `devDependencies` edges and
/// warns, and keeps any other, and neither is reproduced.
pub fn build_configured_graph(
    projects: &[ConfigProject],
    config: &TaskConfig,
    seeds: Seeds<'_>,
    assumptions: Assumptions,
) -> Result<ConfiguredTaskGraph, GraphRefusal> {
    check_assumptions(config, assumptions)?;

    let mut builder = Builder::new(projects, config)?;
    let seed_tasks = builder.seeds(seeds);
    // `task-why` never reads a command, so a shell `${VAR}` in a script must not refuse its graph.
    let check_command = matches!(seeds, Seeds::Target(_));

    if seed_tasks.is_empty() {
        return Err(GraphRefusal::NoTasks);
    }

    let mut queued: HashSet<TaskRef> = seed_tasks.iter().cloned().collect();
    let mut queue: VecDeque<TaskRef> = seed_tasks.into();
    let mut visited: HashSet<TaskRef> = HashSet::new();
    let mut tasks: Vec<ConfiguredTask> = Vec::new();

    while let Some(task) = queue.pop_front() {
        if !visited.insert(task.clone()) {
            continue;
        }

        let dependencies = builder.resolve(&task);
        let ids = dependencies.iter().map(|dependency| builder.id(dependency)).collect();

        tasks.push(builder.describe(&task, ids, check_command)?);

        for dependency in dependencies {
            if !visited.contains(&dependency) && !queued.contains(&dependency) {
                queued.insert(dependency.clone());
                queue.push_back(dependency);
            }
        }
    }

    let ids: Vec<String> = tasks.iter().map(|task| task.id.clone()).collect();
    let position: HashMap<&str, usize> = ids.iter().enumerate().map(|(index, id)| (id.as_str(), index)).collect();
    let edges: Vec<Vec<usize>> = tasks
        .iter()
        .map(|task| task.dependencies.iter().map(|dependency| position[dependency.as_str()]).collect())
        .collect();

    if has_cycle(&ids, &edges) {
        return Err(GraphRefusal::Cycle);
    }

    let depended_on: HashSet<&str> =
        tasks.iter().flat_map(|task| task.dependencies.iter().map(String::as_str)).collect();
    let roots =
        tasks.iter().filter(|task| !depended_on.contains(task.id.as_str())).map(|task| task.id.clone()).collect();

    Ok(ConfiguredTaskGraph { tasks, roots, warnings: builder.warnings })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use DependencyKind::{Dev, Peer, Static};

    const CHECKED: Assumptions = Assumptions { inference: InferenceState::NothingToInfer, no_project_files: true };

    fn project(name: &str, scripts: &[&str], dependencies: &[(&str, DependencyKind)]) -> ConfigProject {
        ConfigProject {
            name: name.to_owned(),
            root: format!("packages/{name}"),
            scripts: scripts.iter().map(|script| ((*script).to_owned(), format!("run {script}"))).collect(),
            dependencies: dependencies
                .iter()
                .map(|(project, kind)| ProjectDependency { project: (*project).to_owned(), kind: *kind })
                .collect(),
        }
    }

    fn config(tasks: &Value) -> TaskConfig {
        let order: Vec<String> = tasks.as_object().map(|tasks| tasks.keys().cloned().collect()).unwrap_or_default();

        TaskConfig::parse(&json!({ "tasks": tasks }), &order).unwrap()
    }

    fn graph(projects: &[ConfigProject], tasks: &Value, seeds: Seeds<'_>) -> Result<ConfiguredTaskGraph, GraphRefusal> {
        build_configured_graph(projects, &config(tasks), seeds, CHECKED)
    }

    fn ids(graph: &ConfiguredTaskGraph) -> Vec<&str> {
        graph.tasks.iter().map(|task| task.id.as_str()).collect()
    }

    fn deps<'a>(graph: &'a ConfiguredTaskGraph, id: &str) -> Vec<&'a str> {
        graph.tasks.iter().find(|task| task.id == id).unwrap().dependencies.iter().map(String::as_str).collect()
    }

    #[test]
    fn caret_default_links_the_same_target_of_dependencies_and_visits_breadth_first() {
        let projects = [
            project("app", &["build"], &[("lib", Static), ("util", Dev)]),
            project("lib", &["build"], &[("util", Static)]),
            project("util", &["build"], &[]),
        ];
        let graph = graph(&projects, &json!({ "build": { "dependsOn": ["^build"] } }), Seeds::Target("build")).unwrap();

        // Seeds first, in project order; a dependency is visited once, where it was queued first.
        assert_eq!(ids(&graph), ["app:build", "lib:build", "util:build"]);
        assert_eq!(deps(&graph, "app:build"), ["lib:build", "util:build"]);
        assert_eq!(deps(&graph, "lib:build"), ["util:build"]);
        assert_eq!(graph.roots, ["app:build"]);
    }

    #[test]
    fn a_dependency_that_is_also_a_seed_keeps_its_place_among_the_seeds() {
        // `a` is seeded first and needs `c`, which is also a seed: BFS visits a, b, c, not a, c, b.
        let projects =
            [project("a", &["build"], &[("c", Static)]), project("b", &["build"], &[]), project("c", &["build"], &[])];
        let graph = graph(&projects, &json!({ "build": { "dependsOn": ["^build"] } }), Seeds::Target("build")).unwrap();

        assert_eq!(ids(&graph), ["a:build", "b:build", "c:build"]);
        assert_eq!(graph.roots, ["a:build", "b:build"]);
    }

    #[test]
    fn a_dependency_that_is_not_a_seed_is_visited_after_every_seed() {
        let projects = [project("a", &["build", "gen"], &[]), project("b", &["build"], &[])];
        let graph =
            graph(&projects, &json!({ "build": { "dependsOn": ["gen"] }, "gen": {} }), Seeds::Target("build")).unwrap();

        assert_eq!(ids(&graph), ["a:build", "b:build", "a:gen"]);
        assert_eq!(deps(&graph, "a:build"), ["a:gen"]);
        assert_eq!(deps(&graph, "b:build"), Vec::<&str>::new());
    }

    #[test]
    fn without_a_default_no_task_has_a_dependency() {
        let projects = [project("a", &["build"], &[]), project("b", &["build"], &[("a", Static)])];
        let graph = graph(&projects, &json!({}), Seeds::Target("build")).unwrap();

        assert_eq!(ids(&graph), ["a:build", "b:build"]);
        assert!(graph.tasks.iter().all(|task| task.dependencies.is_empty()));
        assert_eq!(graph.roots, ["a:build", "b:build"]);
    }

    #[test]
    fn caret_skips_self_peer_unknown_and_script_less_projects_and_does_not_bridge() {
        let projects = [
            project("a", &["build"], &[]),
            project("gap", &[], &[("a", Static)]),
            project("b", &["build"], &[("b", Static), ("a", Peer), ("gap", Static), ("ghost", Static)]),
            project("c", &["build"], &[("gap", Static)]),
        ];
        let graph = graph(&projects, &json!({ "build": { "dependsOn": ["^build"] } }), Seeds::Target("build")).unwrap();

        assert_eq!(deps(&graph, "b:build"), Vec::<&str>::new());
        assert_eq!(deps(&graph, "c:build"), Vec::<&str>::new());
    }

    #[test]
    fn a_dependency_resolved_twice_is_listed_twice_and_a_duplicate_project_edge_is_refused() {
        let projects = [project("a", &["build"], &[]), project("b", &["build"], &[("a", Static)])];
        let graph = graph(
            &projects,
            &json!({ "build": { "dependsOn": ["^build", { "target": "build", "dependencies": true }] } }),
            Seeds::Target("build"),
        )
        .unwrap();

        assert_eq!(deps(&graph, "b:build"), ["a:build"; 2]);

        let doubled = [project("a", &["build"], &[]), project("b", &["build"], &[("a", Static), ("a", Dev)])];

        assert_eq!(
            super::build_configured_graph(&doubled, &config(&json!({})), Seeds::Target("build"), CHECKED),
            Err(GraphRefusal::DuplicateEdge { project: "b".into(), dependency: "a".into() })
        );
    }

    #[test]
    fn a_same_project_dependency_on_a_target_the_project_lacks_is_no_edge() {
        let projects = [project("a", &["test"], &[]), project("b", &["test", "build"], &[])];
        let graph = graph(&projects, &json!({ "test": { "dependsOn": ["build"] } }), Seeds::Target("test")).unwrap();

        assert_eq!(ids(&graph), ["a:test", "b:test", "b:build"]);
        assert_eq!(deps(&graph, "a:test"), Vec::<&str>::new());
        assert_eq!(deps(&graph, "b:test"), ["b:build"]);
    }

    #[test]
    fn a_missing_target_in_dependson_gives_no_edge_and_no_warning() {
        let projects = [project("a", &["build"], &[])];
        let graph =
            graph(&projects, &json!({ "build": { "dependsOn": ["nope", "^nope"] } }), Seeds::Target("build")).unwrap();

        assert_eq!(deps(&graph, "a:build"), Vec::<&str>::new());
        assert!(graph.warnings.is_empty());
    }

    #[test]
    fn projects_selectors_resolve_exact_names_before_globs_and_drop_the_declaring_task() {
        let projects = [
            project("@s/a", &["check", "lint"], &[]),
            project("@s/b", &["lint"], &[]),
            project("tool", &["lint"], &[]),
            project("zip", &["lint"], &[]),
        ];
        let tasks = json!({ "check": { "dependsOn": [
            { "target": "lint", "projects": ["@s/*", "tool"] },
            { "target": "lint", "projects": "t??l" },
            // Only `@s/a` has `check`: the glob names it too, and the task does not depend on itself.
            { "target": "check", "projects": ["*"] },
        ] } });
        let graph = graph(&projects, &tasks, Seeds::Target("check")).unwrap();

        // `@s/*` crosses the slash; the exact name `tool` and the glob `t??l` both name `tool`.
        assert_eq!(deps(&graph, "@s/a:check"), ["@s/a:lint", "@s/b:lint", "tool:lint", "tool:lint"]);
        assert_eq!(ids(&graph), ["@s/a:check", "@s/a:lint", "@s/b:lint", "tool:lint"]);
        assert!(graph.warnings.is_empty());
    }

    #[test]
    fn a_glob_of_everything_matches_every_project() {
        let projects = [project("a", &["x"], &[]), project("b", &["x"], &[]), project("c", &["x"], &[])];
        let graph = graph(
            &projects,
            &json!({ "x": { "dependsOn": [{ "target": "x", "projects": ["*"] }] } }),
            Seeds::Target("x"),
        );

        // Every pair of tasks depends on each other: a cycle, which is refused.
        assert_eq!(graph, Err(GraphRefusal::Cycle));
    }

    #[test]
    fn an_unmatched_selector_is_a_warning_and_no_edge() {
        let projects = [project("a", &["build"], &[])];
        let tasks = json!({ "build": { "dependsOn": [{ "target": "gen", "projects": ["missing", "ghost-*"] }] } });
        let graph = graph(&projects, &tasks, Seeds::Target("build")).unwrap();

        assert_eq!(
            graph.warnings,
            [
                GraphWarning::UnmatchedProjectSelector("missing".into()),
                GraphWarning::UnmatchedProjectSelector("ghost-*".into())
            ]
        );
        assert_eq!(deps(&graph, "a:build"), Vec::<&str>::new());
    }

    #[test]
    fn an_empty_projects_list_selects_nothing_and_an_empty_string_means_the_same_project() {
        let projects = [project("a", &["build", "gen"], &[])];
        let empty_list = graph(
            &projects,
            &json!({ "build": { "dependsOn": [{ "target": "gen", "projects": [] }] } }),
            Seeds::Target("build"),
        )
        .unwrap();
        let empty_string = graph(
            &projects,
            &json!({ "build": { "dependsOn": [{ "target": "gen", "projects": "" }] } }),
            Seeds::Target("build"),
        )
        .unwrap();

        assert_eq!(deps(&empty_list, "a:build"), Vec::<&str>::new());
        assert!(empty_list.warnings.is_empty());
        assert_eq!(deps(&empty_string, "a:build"), ["a:gen"]);
    }

    #[test]
    fn dependencies_true_wins_over_projects() {
        let projects =
            [project("a", &["gen"], &[]), project("b", &["gen"], &[("a", Static)]), project("c", &["gen"], &[])];
        let tasks = json!({ "gen": { "dependsOn": [{ "target": "gen", "dependencies": true, "projects": ["c"] }] } });
        let graph = graph(&projects, &tasks, Seeds::Target("gen")).unwrap();

        assert_eq!(deps(&graph, "b:gen"), ["a:gen"]);
    }

    #[test]
    fn a_default_with_a_command_is_a_target_of_every_project() {
        let projects = [project("a", &["build"], &[]), project("b", &[], &[])];
        let tasks = json!({
            "check": { "command": "echo check", "dependsOn": ["build"] },
            "build": {},
        });
        let graph = graph(&projects, &tasks, Seeds::Target("check")).unwrap();

        assert_eq!(ids(&graph), ["a:check", "b:check", "a:build"]);
        assert_eq!(graph.tasks[0].command, "echo check");
        assert_eq!(graph.tasks[1].command, "echo check");
        assert_eq!(deps(&graph, "b:check"), Vec::<&str>::new());
    }

    #[test]
    fn a_default_command_wins_over_the_script() {
        let projects = [project("a", &["build"], &[])];
        let graph = graph(&projects, &json!({ "build": { "command": "tsc -b" } }), Seeds::Target("build")).unwrap();

        assert_eq!(graph.tasks[0].command, "tsc -b");
    }

    #[test]
    fn all_targets_lists_scripts_then_default_commands_in_order() {
        let projects = [project("a", &["test", "build"], &[]), project("b", &["lint"], &[])];
        let tasks = json!({ "zeta": { "command": "z" }, "alpha": { "command": "a" }, "build": {} });
        let order: Vec<String> = ["zeta", "alpha", "build"].map(String::from).to_vec();
        let config = TaskConfig::parse(&json!({ "tasks": tasks }), &order).unwrap();
        let graph = build_configured_graph(&projects, &config, Seeds::AllTargets, CHECKED).unwrap();

        assert_eq!(ids(&graph), ["a:test", "a:build", "a:zeta", "a:alpha", "b:lint", "b:zeta", "b:alpha"]);
    }

    #[test]
    fn project_targets_lists_scripts_then_default_commands_without_a_graph() {
        let projects =
            [project("a", &["test", "build"], &[("b", Static)]), project("b", &["lint", "build"], &[("a", Static)])];
        let tasks =
            json!({ "zeta": { "command": "z" }, "build": { "dependsOn": ["^build"] }, "lint": { "command": "l" } });
        let order: Vec<String> = ["zeta", "build", "lint"].map(String::from).to_vec();
        let config = TaskConfig::parse(&json!({ "tasks": tasks }), &order).unwrap();

        // The two projects depend on each other and `build` depends on `^build`: the graph is a cycle, the targets are not.
        assert_eq!(
            build_configured_graph(&projects, &config, Seeds::Target("build"), CHECKED),
            Err(GraphRefusal::Cycle)
        );
        assert_eq!(
            project_targets(&projects, &config, CHECKED).unwrap(),
            [
                ("a".to_owned(), ["test", "build", "zeta", "lint"].map(String::from).to_vec()),
                ("b".to_owned(), ["lint", "build", "zeta"].map(String::from).to_vec()),
            ]
        );
        assert_eq!(
            project_targets(&projects, &config, Assumptions { no_project_files: false, ..CHECKED }),
            Err(GraphRefusal::ProjectFilesNotRuledOut)
        );
    }

    #[test]
    fn outputs_cache_and_inputs_are_carried_with_their_tokens_expanded() {
        let mut root = project("web", &["build"], &[]);

        root.root = String::new();

        let tasks = json!({ "build": {
            "cache": true,
            "outputs": ["{projectRoot}/dist", "@inherit", { "auto": true }, "{projectName}.log"],
            "inputs": ["src/**", "@inherit"],
        } });
        let graph = graph(&[root, project("lib", &["build"], &[])], &tasks, Seeds::Target("build")).unwrap();

        assert_eq!(
            graph.tasks[0].outputs,
            [OutputEntry::Pattern("./dist".into()), OutputEntry::Auto, OutputEntry::Pattern("web.log".into())]
        );
        assert_eq!(graph.tasks[1].outputs[0], OutputEntry::Pattern("packages/lib/dist".into()));
        assert_eq!(graph.tasks[0].cache, Some(true));
        assert!(graph.tasks[0].declares_inputs);
    }

    #[test]
    fn the_inherit_sentinel_is_dropped_from_depends_on() {
        let projects = [project("a", &["build", "gen"], &[])];
        let graph = graph(&projects, &json!({ "build": { "dependsOn": ["@inherit", "gen"] } }), Seeds::Target("build"))
            .unwrap();

        assert_eq!(deps(&graph, "a:build"), ["a:gen"]);
    }

    #[test]
    fn a_cycle_is_refused_whether_it_is_hard_soft_or_a_self_edge() {
        let hard = [project("a", &["build"], &[("b", Static)]), project("b", &["build"], &[("a", Static)])];
        let soft = [project("a", &["build"], &[("b", Dev)]), project("b", &["build"], &[("a", Static)])];
        let caret = json!({ "build": { "dependsOn": ["^build"] } });

        assert_eq!(graph(&hard, &caret, Seeds::Target("build")), Err(GraphRefusal::Cycle));
        assert_eq!(graph(&soft, &caret, Seeds::Target("build")), Err(GraphRefusal::Cycle));
        assert_eq!(
            graph(
                &[project("a", &["build"], &[])],
                &json!({ "build": { "dependsOn": ["build"] } }),
                Seeds::Target("build")
            ),
            Err(GraphRefusal::Cycle)
        );
    }

    #[test]
    fn a_cycle_between_projects_is_no_cycle_for_tasks_that_do_not_depend_on_each_other() {
        let projects = [project("a", &["build"], &[("b", Static)]), project("b", &["build"], &[("a", Static)])];

        assert!(graph(&projects, &json!({}), Seeds::Target("build")).is_ok());
    }

    #[test]
    fn no_project_with_the_target_is_refused() {
        let projects = [project("a", &["build"], &[])];

        assert_eq!(graph(&projects, &json!({}), Seeds::Target("test")), Err(GraphRefusal::NoTasks));
        assert_eq!(graph(&[], &json!({}), Seeds::AllTargets), Err(GraphRefusal::NoTasks));
    }

    #[test]
    fn what_the_caller_did_not_vouch_for_is_refused() {
        let projects = [project("a", &["build"], &[])];
        let config = config(&json!({}));

        assert_eq!(
            build_configured_graph(
                &projects,
                &config,
                Seeds::Target("build"),
                Assumptions { no_project_files: false, ..CHECKED }
            ),
            Err(GraphRefusal::ProjectFilesNotRuledOut)
        );
        assert_eq!(
            build_configured_graph(
                &projects,
                &config,
                Seeds::Target("build"),
                Assumptions { inference: InferenceState::Unchecked, no_project_files: true }
            ),
            Err(GraphRefusal::InferenceNotRuledOut)
        );

        let disabled = TaskConfig::parse(&json!({ "inferTargets": false }), &[]).unwrap();

        assert!(disabled.inference_disabled);
        assert!(build_configured_graph(
            &projects,
            &disabled,
            Seeds::Target("build"),
            Assumptions { inference: InferenceState::Unchecked, no_project_files: true }
        )
        .is_ok());
    }

    #[test]
    fn unreproducible_commands_names_and_projects_are_refused() {
        let build = |scripts: &[(&str, &str)], name: &str| {
            let mut only = project(name, &[], &[]);

            only.scripts = scripts.iter().map(|(script, command)| ((*script).into(), (*command).into())).collect();

            graph(&[only], &json!({}), Seeds::Target("build"))
        };

        assert_eq!(build(&[("build", "")], "a"), Err(GraphRefusal::EmptyCommand("a:build".into())));
        assert_eq!(
            build(&[("build", "eslint ${affected.files}")], "a"),
            Err(GraphRefusal::CommandNeedsTokenExpansion("a:build".into()))
        );
        assert_eq!(build(&[("build", "x"), ("12", "y")], "a"), Err(GraphRefusal::UnsafeName("12".into())));
        assert_eq!(
            build(&[("build", "x"), ("constructor", "y")], "a"),
            Err(GraphRefusal::UnsafeName("constructor".into()))
        );
        assert_eq!(build(&[("build", "x")], "7"), Err(GraphRefusal::UnsafeName("7".into())));
        assert_eq!(build(&[("build", "x")], "__proto__"), Err(GraphRefusal::UnsafeName("__proto__".into())));
        assert_eq!(build(&[("build", "x")], "a\nb"), Err(GraphRefusal::UnsafeName("a\nb".into())));
        assert!(build(&[("build", "x"), ("01", "y")], "a").is_ok());

        // `task-why` seeds never run or hash a command: a shell `${VAR}` or an empty script does not refuse it.
        let mut shell = project("a", &[], &[]);

        shell.scripts = vec![("build".into(), "echo ${HOME}".into()), ("empty".into(), String::new())];

        let listed = build_configured_graph(&[shell], &config(&json!({})), Seeds::AllTargets, CHECKED).unwrap();

        assert_eq!(listed.tasks[0].command, "echo ${HOME}");
        assert_eq!(listed.tasks[1].command, "");

        let duplicate = [project("a", &["build"], &[]), project("a", &["build"], &[])];

        assert_eq!(
            graph(&duplicate, &json!({}), Seeds::Target("build")),
            Err(GraphRefusal::DuplicateProject("a".into()))
        );
    }

    #[test]
    fn config_shapes_outside_the_slice_are_refused() {
        let parse = |value: Value| {
            let order: Vec<String> = value
                .get("tasks")
                .and_then(Value::as_object)
                .map(|tasks| tasks.keys().cloned().collect())
                .unwrap_or_default();

            TaskConfig::parse(&value, &order)
        };
        let task = |entry: Value| parse(json!({ "tasks": { "build": entry } }));

        for key in
            ["scopedTasks", "taskGroups", "fileGroups", "projectIgnore", "targetDefaults", "ci", "cache", "composer"]
        {
            assert_eq!(parse(json!({ (key): {} })), Err(GraphRefusal::UnsupportedConfigKey(key.into())), "{key}");
        }

        assert_eq!(parse(json!(5)), Err(GraphRefusal::ConfigNotAnObject));
        assert_eq!(parse(json!({ "inferTargets": { "vite": false } })), Err(GraphRefusal::UnsupportedInferTargets));
        assert_eq!(parse(json!({ "tasks": [] })), Err(GraphRefusal::InvalidTasks));
        assert_eq!(parse(json!({ "tasks": { "12": {} } })), Err(GraphRefusal::UnsafeName("12".into())));
        assert_eq!(parse(json!({ "tasks": { "toString": {} } })), Err(GraphRefusal::UnsafeName("toString".into())));
        assert_eq!(task(json!(3)), Err(GraphRefusal::TargetNotAnObject("build".into())));

        for key in
            ["executor", "options", "splitCompound", "aliases", "type", "preset", "always", "when", "hashMode", "env"]
        {
            assert_eq!(
                task(json!({ (key): true })),
                Err(GraphRefusal::UnsupportedTargetKey { target: "build".into(), key: key.into() }),
                "{key}"
            );
        }

        for (key, value) in [
            ("command", json!(1)),
            ("cache", json!("yes")),
            ("cache", Value::Null),
            ("dependsOn", json!("build")),
            ("outputs", json!("dist")),
            ("outputs", json!([{ "auto": false }])),
            ("outputs", json!([{ "auto": true, "x": 1 }])),
            ("inputs", json!([{ "fileset": "src" }])),
            ("inputs", json!(["@filegroup:sources"])),
            ("inputs", json!(["env://HOME"])),
            ("inputs", json!(["!glob://x"])),
            ("description", json!(1)),
        ] {
            assert!(
                matches!(task(json!({ (key): value })), Err(GraphRefusal::InvalidTargetValue { key: refused, .. }) if refused == key),
                "{key}"
            );
        }

        assert!(task(json!({ "inputs": ["src/**", "!src/gen/**", "C:/x", "a:b"], "description": "d" })).is_ok());
        assert_eq!(
            TaskConfig::parse(&json!({ "tasks": { "a": {} } }), &["b".to_owned()]),
            Err(GraphRefusal::InvalidTasks)
        );
        assert_eq!(
            TaskConfig::parse(&json!({ "tasks": { "a": {} } }), &["a".to_owned(), "a".to_owned()]),
            Err(GraphRefusal::InvalidTasks)
        );
        assert_eq!(TaskConfig::parse(&Value::Null, &[]).unwrap(), TaskConfig::default());
        assert!(parse(json!({ "$schema": "x", "inferTargets": true, "tasks": {} })).is_ok());
    }

    #[test]
    fn depends_on_entries_node_rejects_or_this_module_does_not_resolve_are_refused() {
        let entry = |entry: Value| TargetDefaults::parse("build", &json!({ "dependsOn": [entry] }));
        let invalid = |reason| Err(GraphRefusal::InvalidDependsOn { target: "build".into(), reason });

        assert_eq!(entry(json!("")), invalid("it names no target"));
        assert_eq!(entry(json!("^")), invalid("it names no target"));
        assert_eq!(entry(json!("{projectRoot}/gen")), invalid("it is a file pattern, not a target name"));
        assert_eq!(entry(json!("^src/*")), invalid("it is a file pattern, not a target name"));
        assert_eq!(entry(json!("gen/out.ts")), invalid("it is a file pattern, not a target name"));
        assert_eq!(entry(json!({ "target": "{x}" })), invalid("it is a file pattern, not a target name"));
        assert_eq!(entry(json!({ "projects": ["a"] })), invalid("an object entry needs a string `target`"));
        assert_eq!(entry(json!({ "target": 1 })), invalid("an object entry needs a string `target`"));
        assert_eq!(entry(Value::Null), invalid("an entry is neither a string nor an object"));
        assert_eq!(entry(json!(3)), invalid("an entry is neither a string nor an object"));
        assert_eq!(
            entry(json!({ "group": "ci" })),
            Err(GraphRefusal::UnsupportedDependsOn { target: "build".into(), reason: "a task group" })
        );
        assert_eq!(
            entry(json!({ "target": "x", "foo": 1 })),
            Err(GraphRefusal::UnsupportedDependsOn { target: "build".into(), reason: "an unknown key" })
        );
        assert_eq!(entry(json!("constructor")), Err(GraphRefusal::UnsafeName("constructor".into())));
        assert_eq!(entry(json!("^toString")), Err(GraphRefusal::UnsafeName("toString".into())));
        assert_eq!(entry(json!({ "target": "x", "projects": ["a\nb"] })), Err(GraphRefusal::UnsafeName("a\nb".into())));

        for bad in [
            json!({ "target": "x", "dependencies": "yes" }),
            json!({ "target": "x", "projects": 3 }),
            json!({ "target": "x", "projects": [1] }),
            json!({ "target": "x", "params": "other" }),
            json!({ "target": "x", "params": 1 }),
        ] {
            assert!(
                matches!(entry(bad.clone()), Err(GraphRefusal::InvalidTargetValue { key: "dependsOn", .. })),
                "{bad}"
            );
        }

        // These are legal names: a colon is an ordinary character of a script name, `^^x` names the target `^x`.
        assert!(entry(json!("build:types")).is_ok());
        assert!(entry(json!("^^x")).is_ok());
        assert!(entry(json!({ "target": "x", "params": "forward", "projects": "a" })).is_ok());
    }

    #[test]
    fn the_glob_matcher_follows_the_regular_expression_node_builds() {
        let matches = |pattern: &str, text: &str| {
            glob_matches(&pattern.chars().collect::<Vec<_>>(), &text.chars().collect::<Vec<_>>())
        };

        assert!(matches("*", ""));
        assert!(matches("*", "@s/a"));
        assert!(matches("@s/*", "@s/a/b"));
        assert!(matches("a*c*e", "abcde"));
        assert!(matches("a*b", "ab"));
        assert!(matches("?", "x"));
        assert!(!matches("?", ""));
        assert!(!matches("?", "xy"));
        assert!(matches("a.b", "a.b"));
        assert!(!matches("a.b", "axb"));
        assert!(!matches("a*b", "abc"));
        assert!(matches("*b", "aab"));
        assert!(!matches("*bc", "abx"));
        assert!(matches("[x]*", "[x]y"));
        assert!(!matches("[x]*", "xy"));
    }
}
