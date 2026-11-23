//! Inspection probes for the shared task-key code (`task-runner-core`'s `run_key`
//! and `cache_entry`): the task keys and the cache lookup the native `vis run`
//! computes, exposed so the TypeScript suite can assert they equal Node's.
//! Nothing in the engine calls them.

use napi_derive::napi;
use task_runner_core as core;

/// An edge of the project graph: `kind` is `static`, `dev` or `peer`.
#[napi(object)]
pub struct NativeRunDependency {
    pub project: String,
    pub kind: String,
}

/// A workspace project and its script for the run target.
#[napi(object)]
pub struct NativeRunProject {
    pub name: String,
    pub root: String,
    pub script: Option<String>,
    pub cache: Option<bool>,
    pub outputs: Option<Vec<String>>,
    pub dependencies: Option<Vec<NativeRunDependency>>,
}

/// The key of one task.
#[napi(object)]
pub struct NativeRunTaskKey {
    pub id: String,
    pub hash: String,
    pub dependencies: Vec<String>,
    pub keyed: bool,
}

/// The task keys of a run, or why they cannot be reproduced.
#[napi(object)]
pub struct NativeRunTaskKeys {
    pub keys: Vec<NativeRunTaskKey>,
    pub roots: Vec<String>,
    pub not_reproducible: Option<String>,
}

fn project(native: NativeRunProject) -> core::RunProject {
    core::RunProject {
        name: native.name,
        root: native.root,
        script: native.script,
        cache: native.cache,
        outputs: native.outputs.unwrap_or_default(),
        dependencies: native
            .dependencies
            .unwrap_or_default()
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
    }
}

/// Computes the task keys of `run <target>` for a script-only workspace.
/// `depends_on_dependencies` selects `dependsOn: ["^<target>"]`; the default
/// target has no `dependsOn`.
#[napi(catch_unwind)]
pub fn native_run_task_keys(
    workspace_root: String,
    target: String,
    projects: Vec<NativeRunProject>,
    depends_on_dependencies: bool,
) -> NativeRunTaskKeys {
    let projects: Vec<core::RunProject> = projects.into_iter().map(project).collect();
    let depends_on =
        if depends_on_dependencies { core::DependsOn::DependenciesSameTarget } else { core::DependsOn::Nothing };

    match core::compute_task_keys(&workspace_root, &target, &projects, depends_on) {
        Ok(computed) => NativeRunTaskKeys {
            keys: computed
                .keys
                .iter()
                .zip(&computed.graph.tasks)
                .map(|(key, task)| NativeRunTaskKey {
                    id: key.id.clone(),
                    hash: key.hash.clone(),
                    dependencies: task.dependencies.clone(),
                    keyed: key.keyed,
                })
                .collect(),
            roots: computed.graph.roots,
            not_reproducible: None,
        },
        Err(reason) => {
            NativeRunTaskKeys { keys: Vec::new(), roots: Vec::new(), not_reproducible: Some(reason.to_string()) }
        }
    }
}

/// The answer of a cache lookup: `status` is `hit`, `miss` or `not-reproducible`.
#[napi(object)]
pub struct NativeRunCacheLookup {
    pub status: String,
    pub code: Option<i64>,
    pub terminal_output: Option<String>,
    pub not_reproducible: Option<String>,
}

/// Looks up the local cache entry of `hash` in `cache_dir`, read-only.
#[napi(catch_unwind)]
pub fn native_run_lookup_entry(cache_dir: String, hash: String) -> NativeRunCacheLookup {
    let none = |status: &str| NativeRunCacheLookup {
        status: status.to_owned(),
        code: None,
        terminal_output: None,
        not_reproducible: None,
    };

    match core::lookup_entry(std::path::Path::new(&cache_dir), &hash) {
        Ok(core::CacheLookup::Hit(entry)) => {
            NativeRunCacheLookup { code: Some(entry.code), terminal_output: Some(entry.terminal_output), ..none("hit") }
        }
        Ok(core::CacheLookup::Miss) => none("miss"),
        Err(reason) => NativeRunCacheLookup { not_reproducible: Some(reason.to_string()), ..none("not-reproducible") },
    }
}
