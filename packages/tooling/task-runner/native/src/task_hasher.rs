use napi_derive::napi;
use task_runner_core as core;

/// Represents the hash details for a task.
#[napi(object)]
pub struct NativeTaskHashDetails {
    /// The command hash.
    pub command: String,
    /// File/node hashes as key-value pairs [key, hash].
    pub nodes: Vec<Vec<String>>,
    /// Implicit dependency hashes as key-value pairs [key, hash].
    pub implicit_deps: Option<Vec<Vec<String>>>,
    /// Runtime hashes as key-value pairs [key, hash].
    pub runtime: Option<Vec<Vec<String>>>,
}

impl From<NativeTaskHashDetails> for core::TaskHashDetails {
    fn from(details: NativeTaskHashDetails) -> Self {
        Self {
            command: details.command,
            nodes: details.nodes,
            implicit_deps: details.implicit_deps,
            runtime: details.runtime,
        }
    }
}

/// Computes the command hash for a task using xxh3-128.
/// Takes project name, target name, optional configuration, and sorted overrides JSON.
#[napi(catch_unwind)]
pub fn hash_command(project: String, target: String, configuration: Option<String>, overrides_json: String) -> String {
    core::hash_command(&project, &target, configuration.as_deref(), &overrides_json)
}

/// Computes the final combined hash from task hash details using xxh3-128.
/// This produces the cache key used for lookup.
#[napi(catch_unwind)]
pub fn compute_task_hash(details: NativeTaskHashDetails) -> String {
    core::compute_task_hash(&details.into())
}

/// Hashes an environment variable name + value pair using xxh3-128.
#[napi(catch_unwind)]
pub fn hash_env_var(name: String, value: String) -> String {
    core::hash_env_var(&name, &value)
}

/// Computes the command hash of a task from the pieces its envelope carries: the JSON text of the command string,
/// the canonical JSON text of the outputs list and the JSON text of the overrides with sorted keys.
#[napi(catch_unwind)]
pub fn hash_task_command(
    project: String,
    target: String,
    configuration: Option<String>,
    command_json: String,
    outputs: String,
    overrides_json: String,
) -> String {
    core::hash_task_command(&project, &target, configuration.as_deref(), &command_json, &outputs, &overrides_json)
}

/// Hashes the global input files `names` below `workspace_root` (a missing or unreadable file is skipped), then the
/// `extra` parts. Returns nothing when there is no content to hash.
#[napi(catch_unwind)]
pub fn hash_global_inputs(workspace_root: String, names: Vec<String>, extra: Vec<String>) -> Option<String> {
    core::hash_global_inputs(&workspace_root, &names, &extra).hash
}
