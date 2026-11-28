//! The literal `vis.config` of a workspace root, read for the commands that read the workspace (`task-why`, `graph`,
//! `status`), and the projects of that workspace as the task graph builder takes them.
//!
//! What Node does with the config before one of these commands prints anything: the config loader reads the file
//! (`loadVisConfig`), refuses the removed keys and a malformed `scopedTasks`, merges `extends`, applies the `security`
//! and `update` defaults and checks `versionConstraint`; `discoverWorkspace` then reads `projectIgnore`, the
//! `discover` flags of the non-JS ecosystems, `tasks`, `scopedTasks`, `fileGroups`, `taskGroups` and `inferTargets`;
//! the notices after the command (`sponsor`, `mcpPromote`, the tips) are silent in CI, which every native command
//! here requires. Nothing else on that path reads the config.
//!
//! [`vet`] decides, per top-level key, whether Node's answer can depend on it:
//!
//! - `tasks` and `inferTargets` change the targets, not the projects or their edges. They are read by
//!   `TaskConfig::parse`, whose refusals cover what Node rejects while it loads the workspace (a `dependsOn` entry
//!   that is a file pattern, a URI-shaped input, a task group), so a config it accepts loads. `graph` ignores the
//!   targets; `task-why` and `status` build them.
//! - `projectIgnore` changes which directories are projects: each entry becomes a `!` pattern that joins the
//!   `.gitignore` rules of the root. It is accepted only as an array of plain, non-blank entries that the native
//!   `.gitignore` rules read, and [`crate::workspace`] applies it with them.
//! - the `discover` flags of `composer`, `dart`, `gem`, `go`, `gradle`, `hex`, `maven`, `nuget`, `python`, `swift`
//!   and `zig` add projects that have no `package.json` when they are `true`; a flag that is `false` or absent (and no
//!   other key of that block) changes nothing.
//! - [`INERT`] lists keys nothing on the path reads. `constraints` is one for `graph` only: `status` counts its
//!   violations.
//! - every other key is Node's: `extends`, `runtime`, `versionConstraint`, `security`, `plugins` and `install` change
//!   how the config loads or run hooks; `scopedTasks`, `taskGroups` and `fileGroups` change targets and can throw;
//!   `targetDefaults`, `taskRunnerOptions` and `taskDefaults` make the loader fail. A key that is not in any list is
//!   Node's too, because it has not been shown to be harmless.

use std::path::{Path, PathBuf};

use oxc_ast::ast::Expression;
use serde_json::{Map, Value};
use task_runner_core::{Assumptions, ConfigProject, DependencyKind, InferenceState, ProjectDependency, TaskConfig};

use crate::graph::{project_graph_vetted_with_manifests, EdgeKind};
use crate::list::Manifest;
use crate::root_search::read_json;
use crate::targets::{directory_names, inference_applies};
use crate::vis_config::{config_file_in, convert_default_export, object_properties, read, ConfigState};
use crate::workspace::names_hold_non_js_marker;

/// The command a config is read for: what it prints decides which keys are harmless.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Consumer {
    /// `vis graph`: the project graph, whose targets nothing prints.
    Graph,
    /// `vis status`: the number of unique targets, and the violations of `constraints`.
    Status,
    /// `vis task-why`: the task graph.
    TaskWhy,
}

/// Top-level keys that nothing on the path of these commands reads (see the module documentation).
const INERT: [&str; 13] = [
    "affectedIgnore",
    "ai",
    "branchScopedCache",
    "codeowners",
    "defaultBase",
    "generator",
    "mcpPromote",
    "namedInputs",
    "preflight",
    "sharedWorktreeCache",
    "sponsor",
    "strictEnv",
    "tui",
];

/// The configs of the ecosystems `discoverWorkspace` finds projects for when `<key>.discover` is `true`.
const DISCOVER_KEYS: [&str; 11] =
    ["composer", "dart", "gem", "go", "gradle", "hex", "maven", "nuget", "python", "swift", "zig"];

/// What a vetted config holds.
#[derive(Debug)]
pub(crate) struct Vetted {
    /// The `projectIgnore` entries as `.gitignore` lines, with the trailing slashes Node drops already gone.
    pub ignore: Vec<String>,
    pub tasks: TaskConfig,
}

/// The `projectIgnore` entries of the config as the lines Node adds to the matcher (`!` + entry, trailing slashes
/// removed), or `None` for a shape that is Node's: not an array of strings, an entry that is blank, a comment or
/// ends up empty. Whether the native rules read a line is checked where they are built.
fn project_ignore(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|entry| {
            let line = entry.as_str()?.trim_end_matches('/');

            (line.bytes().any(|byte| byte != b' ' && byte != b'\t') && !line.starts_with('#')).then(|| line.to_owned())
        })
        .collect()
}

/// Whether the config block of a non-JS ecosystem adds no project: an object with no `discover` flag, or one that is
/// `false`, and no other key.
fn discovers_nothing(value: &Value) -> bool {
    value.as_object().is_some_and(|block| {
        block.keys().all(|key| key == "discover")
            && block.get("discover").is_none_or(|flag| *flag == Value::Bool(false))
    })
}

/// The part of the config that matters to `consumer`, or `None` when Node must answer. `order` is the order of the
/// keys of `tasks` in the file (see [`task_order`]).
pub(crate) fn vet(config: &Value, order: &[String], consumer: Consumer) -> Option<Vetted> {
    let object = config.as_object()?;
    let mut graph_keys = Map::new();
    let mut ignore = Vec::new();

    for (key, value) in object {
        match key.as_str() {
            "$schema" | "tasks" | "inferTargets" => {
                graph_keys.insert(key.clone(), value.clone());
            }
            "projectIgnore" => ignore = project_ignore(value)?,
            "constraints" if consumer != Consumer::Status => {}
            key if DISCOVER_KEYS.contains(&key) => {
                if !discovers_nothing(value) {
                    return None;
                }
            }
            key if INERT.contains(&key) => {}
            _ => return None,
        }
    }

    // `task-why` answers only the keys `TaskConfig::parse` reads, as it did before this module existed: no `projectIgnore`
    // and none of the harmless keys, which its parity suite does not cover.
    if consumer == Consumer::TaskWhy && (!ignore.is_empty() || object.len() != graph_keys.len()) {
        return None;
    }

    let tasks = TaskConfig::parse(&Value::Object(graph_keys), order).ok()?;

    Some(Vetted { ignore, tasks })
}

/// The config file of the workspace root and its value, when Node loads exactly that file and the file is a literal
/// the binary reads as data. `None` for everything else, which only Node can load as it does.
///
/// Node loads `vis.config` from the workspace root only and never a `.json` one, so a config elsewhere on the way up,
/// or a `.json` file next to the real one, is a situation this cannot tell Node's treatment of. A `.cts` or `.cjs`
/// file is CommonJS to Node, where `export default` is a syntax error: it prints a failure and goes on with the
/// defaults, which a literal read of the file would not reproduce. A `.js` file is read as a module by the syntax it
/// holds (every Node the CLI supports detects that), unless the root `package.json` says `commonjs`.
pub(crate) fn module_config(root: &Path) -> Option<(PathBuf, Value)> {
    if root.join("vis.config.json").exists() {
        return None;
    }

    let path = config_file_in(root)?;

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

    Some((path, value))
}

/// The keys of the `tasks` object of the config at `path`, in the order the file lists them. `None` for a file that
/// is not a literal object with plain `key: value` properties. A `tasks` that is not an object gives no keys here, and
/// the parse of the value refuses it.
pub(crate) fn task_order(path: &Path) -> Option<Vec<String>> {
    convert_default_export(path, |config| {
        let Expression::ObjectExpression(config) = config else { return None };
        let Some((_, tasks)) = object_properties(config)?.into_iter().find(|(key, _)| key == "tasks") else {
            return Some(Vec::new());
        };
        let Expression::ObjectExpression(tasks) = tasks else { return Some(Vec::new()) };

        Some(object_properties(tasks)?.into_iter().map(|(key, _)| key).collect())
    })
}

/// The config of the workspace root, read and vetted for `consumer`, or `None` when Node must answer.
pub(crate) fn read_vetted(root: &Path, consumer: Consumer) -> Option<Vetted> {
    let (path, value) = module_config(root)?;

    vet(&value, &task_order(&path)?, consumer)
}

/// A name the output prints as part of an id: letters, digits and `-_.@/`, and a colon where `allow_colon` (a target
/// may hold one, a project may not, or `a:b` + `c` and `a` + `b:c` would be one id). Anything else, a space, a `%` or
/// a non-ASCII letter, is left to Node, which formats it with the logger.
pub(crate) fn is_plain(name: &str, allow_colon: bool) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b'@' | b'/')
                || (allow_colon && byte == b':')
        })
}

/// What the caller vouches for to the builder after [`configured_projects`] accepted the workspace: no project has a
/// `project.json` or a `vis.task.*` overlay (the membership read refuses a workspace that has one) and inference
/// cannot add or change a target (it is off, or no detector could apply to any project).
pub(crate) fn assumptions(config: &TaskConfig) -> Assumptions {
    Assumptions {
        inference: if config.inference_disabled { InferenceState::Disabled } else { InferenceState::NothingToInfer },
        no_project_files: true,
    }
}

/// The projects of the workspace as the builder takes them: in discovery order, the scripts in file order and the edges
/// of the project graph. `ignore` is the `projectIgnore` of the config. `None` when Node must answer: the membership or
/// the graph is not one this reads, the root is a project, a name is not plain, or (unless `inference_disabled`) a
/// detector could apply to a project.
pub(crate) fn configured_projects(
    root: &Path,
    inference_disabled: bool,
    ignore: &[String],
) -> Option<Vec<ConfigProject>> {
    let (graph, manifests) = project_graph_vetted_with_manifests(root, ignore)?;

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

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("vis-config-workspace-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");

        directory
    }

    fn accepted(config: &Value, consumer: Consumer) -> bool {
        let order: Vec<String> = config
            .get("tasks")
            .and_then(Value::as_object)
            .map(|tasks| tasks.keys().cloned().collect())
            .unwrap_or_default();

        vet(config, &order, consumer).is_some()
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

    #[test]
    fn an_inert_key_is_harmless_and_every_other_is_nodes() {
        for key in INERT {
            for consumer in [Consumer::Graph, Consumer::Status] {
                assert!(accepted(&json!({ key: {} }), consumer), "{key}");
            }

            assert!(!accepted(&json!({ key: {} }), Consumer::TaskWhy), "{key}");
        }

        for key in [
            "extends",
            "fileGroups",
            "install",
            "plugins",
            "runtime",
            "scopedTasks",
            "security",
            "targetDefaults",
            "taskGroups",
            "taskRunner",
            "toolchain",
            "update",
            "versionConstraint",
            "somethingNew",
        ] {
            for consumer in [Consumer::Graph, Consumer::Status, Consumer::TaskWhy] {
                assert!(!accepted(&json!({ key: {} }), consumer), "{key}");
            }
        }
    }

    #[test]
    fn constraints_are_harmless_to_the_graph_only() {
        let config = json!({ "constraints": { "rules": [] } });

        assert!(accepted(&config, Consumer::Graph));
        assert!(!accepted(&config, Consumer::Status));
        assert!(!accepted(&config, Consumer::TaskWhy));
    }

    #[test]
    fn a_discover_flag_that_adds_projects_is_nodes() {
        for key in DISCOVER_KEYS {
            assert!(accepted(&json!({ key: { "discover": false } }), Consumer::Graph), "{key}");
            assert!(accepted(&json!({ key: {} }), Consumer::Graph), "{key}");
            assert!(!accepted(&json!({ key: { "discover": true } }), Consumer::Graph), "{key}");
            assert!(!accepted(&json!({ key: { "discover": 1 } }), Consumer::Graph), "{key}");
            assert!(!accepted(&json!({ key: { "discover": false, "other": 1 } }), Consumer::Graph), "{key}");
            assert!(!accepted(&json!({ key: true }), Consumer::Graph), "{key}");
        }
    }

    #[test]
    fn project_ignore_is_an_array_of_plain_entries() {
        let ignore =
            |value: Value| vet(&json!({ "projectIgnore": value }), &[], Consumer::Graph).map(|vetted| vetted.ignore);

        assert_eq!(
            ignore(json!(["legacy", "apps/old/", "/root-only", "pkg-*"])),
            Some(vec!["legacy".into(), "apps/old".into(), "/root-only".into(), "pkg-*".into()])
        );
        assert_eq!(ignore(json!([])), Some(Vec::new()));

        for bad in [
            json!("legacy"),
            json!(null),
            json!({}),
            json!([1]),
            json!([""]),
            json!(["/"]),
            json!(["  "]),
            json!(["# note"]),
        ] {
            assert_eq!(ignore(bad.clone()), None, "{bad}");
        }

        // `task-why` reads no `projectIgnore`.
        assert!(vet(&json!({ "projectIgnore": ["a"] }), &[], Consumer::TaskWhy).is_none());
    }

    #[test]
    fn tasks_go_through_the_builders_parse() {
        assert!(accepted(&json!({ "tasks": { "build": { "dependsOn": ["^build"] } } }), Consumer::Graph));
        assert!(accepted(&json!({ "inferTargets": false }), Consumer::Status));
        assert!(!accepted(&json!({ "inferTargets": { "vite": false } }), Consumer::Graph));
        assert!(!accepted(&json!({ "tasks": { "build": { "dependsOn": ["src/**"] } } }), Consumer::Graph));
        assert!(!accepted(&json!({ "tasks": { "build": { "options": {} } } }), Consumer::Graph));
        assert!(!accepted(&json!({ "tasks": "build" }), Consumer::Graph));
    }

    #[test]
    fn a_config_that_is_not_an_object_is_nodes() {
        assert!(vet(&json!([]), &[], Consumer::Graph).is_none());
        assert!(vet(&Value::Null, &[], Consumer::Graph).is_none());
    }
}
