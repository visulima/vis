//! Inspection probe for the configured task graph (`task-runner-core`'s `task_config`): the graph the native
//! code builds from `package.json` scripts and the `tasks` defaults of a literal config, exposed so the TypeScript
//! suite can assert it equals the graph `createTaskGraph` builds. Nothing in the engine calls it.

use napi_derive::napi;
use task_runner_core as core;

use crate::native_run::NativeRunDependency;

/// A `package.json` script of a project.
#[napi(object)]
pub struct NativeConfigScript {
    pub name: String,
    pub command: String,
}

/// A workspace project: its scripts in file order and the edges of the project graph from it.
#[napi(object)]
pub struct NativeConfigProject {
    pub name: String,
    pub root: String,
    pub scripts: Vec<NativeConfigScript>,
    pub dependencies: Vec<NativeRunDependency>,
}

/// One task of the graph. `outputs` is the JSON text of the list: strings and `{ "auto": true }`.
#[napi(object)]
pub struct NativeConfiguredTask {
    pub id: String,
    pub project: String,
    pub target: String,
    pub root: String,
    pub command: String,
    pub cache: Option<bool>,
    pub outputs: String,
    pub declares_inputs: bool,
    pub dependencies: Vec<String>,
}

/// The graph, or why it cannot be built here. `warnings` are the unmatched `dependsOn.projects` selectors.
#[napi(object)]
pub struct NativeConfiguredTaskGraph {
    pub tasks: Vec<NativeConfiguredTask>,
    pub roots: Vec<String>,
    pub warnings: Vec<String>,
    pub refusal: Option<String>,
}

fn refused(reason: impl ToString) -> NativeConfiguredTaskGraph {
    NativeConfiguredTaskGraph {
        tasks: Vec::new(),
        roots: Vec::new(),
        warnings: Vec::new(),
        refusal: Some(reason.to_string()),
    }
}

fn outputs_json(outputs: &[core::OutputEntry]) -> String {
    let list: Vec<serde_json::Value> = outputs
        .iter()
        .map(|output| match output {
            core::OutputEntry::Pattern(pattern) => serde_json::Value::String(pattern.clone()),
            core::OutputEntry::Auto => serde_json::json!({ "auto": true }),
        })
        .collect();

    serde_json::Value::Array(list).to_string()
}

/// Builds the task graph of a workspace. `config` is the JSON text of the config and `task_order` the keys of
/// its `tasks` in the order they are written. `seed_target` selects the tasks of `run <target>`; none selects
/// every target of every project. `inference` is `disabled`, `nothing-to-infer` or anything else for unchecked.
#[napi(catch_unwind)]
pub fn native_configured_task_graph(
    config: String,
    task_order: Vec<String>,
    projects: Vec<NativeConfigProject>,
    seed_target: Option<String>,
    inference: String,
    no_project_files: bool,
) -> NativeConfiguredTaskGraph {
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&config) else {
        return refused("the config is not JSON");
    };
    let config = match core::TaskConfig::parse(&config, &task_order) {
        Ok(config) => config,
        Err(reason) => return refused(reason),
    };
    let projects: Vec<core::ConfigProject> = projects
        .into_iter()
        .map(|project| core::ConfigProject {
            name: project.name,
            root: project.root,
            scripts: project.scripts.into_iter().map(|script| (script.name, script.command)).collect(),
            dependencies: project
                .dependencies
                .into_iter()
                .map(|dependency| core::ProjectDependency {
                    project: dependency.project,
                    kind: match dependency.kind.as_str() {
                        "dev" => core::DependencyKind::Dev,
                        "peer" => core::DependencyKind::Peer,
                        _ => core::DependencyKind::Static,
                    },
                })
                .collect(),
        })
        .collect();
    let assumptions = core::Assumptions {
        inference: match inference.as_str() {
            "disabled" => core::InferenceState::Disabled,
            "nothing-to-infer" => core::InferenceState::NothingToInfer,
            _ => core::InferenceState::Unchecked,
        },
        no_project_files,
    };
    let seeds = match &seed_target {
        Some(target) => core::Seeds::Target(target),
        None => core::Seeds::AllTargets,
    };

    match core::build_configured_graph(&projects, &config, seeds, assumptions) {
        Ok(graph) => NativeConfiguredTaskGraph {
            tasks: graph
                .tasks
                .into_iter()
                .map(|task| NativeConfiguredTask {
                    outputs: outputs_json(&task.outputs),
                    id: task.id,
                    project: task.project,
                    target: task.target,
                    root: task.root,
                    command: task.command,
                    cache: task.cache,
                    declares_inputs: task.declares_inputs,
                    dependencies: task.dependencies,
                })
                .collect(),
            roots: graph.roots,
            warnings: graph
                .warnings
                .into_iter()
                .map(|warning| match warning {
                    core::GraphWarning::UnmatchedProjectSelector(selector) => selector,
                })
                .collect(),
            refusal: None,
        },
        Err(reason) => refused(reason),
    }
}
