//! The `vis.config.*` values the cache commands read, from a config this path can read without Node.

use std::path::Path;

use serde_json::Value;

use crate::vis_config::{self, ConfigState};

/// The config values the cache commands read.
pub(crate) struct Settings {
    pub(crate) branch_scoped: bool,
    /// `sharedWorktreeCache !== false`.
    pub(crate) shared_worktree: bool,
    pub(crate) cache_directory: Option<String>,
}

/// The settings of the workspace root, or `None` when Node must answer.
///
/// Node reads `vis.config.*` from the workspace root only, so a config anywhere else on the way up is
/// one this path cannot tell Node's treatment of. At the root the config must be a literal, and free of the
/// keys that change what Node does before the command runs.
pub(crate) fn read_settings(cwd: &Path, root: &Path) -> Option<Settings> {
    let others = cwd
        .ancestors()
        .chain(root.ancestors())
        .filter(|directory| *directory != root)
        .any(|directory| vis_config::config_file_in(directory).is_some());

    if others || root.join("vis.config.json").exists() {
        return None;
    }

    // A config that has to be evaluated is Node's: evaluating it would cost the Node start this path avoids.
    let state = if vis_config::config_file_in(root).is_some() { vis_config::read(root) } else { ConfigState::Absent };

    let config = match state {
        ConfigState::Absent => {
            return Some(Settings { branch_scoped: false, shared_worktree: true, cache_directory: None })
        }
        ConfigState::Dynamic => return None,
        ConfigState::Static(_) if vis_config::requires_node(&state) => return None,
        ConfigState::Static(value) => value,
    };

    let cache_directory = match config.get("taskRunner") {
        None | Some(Value::Null) => None,
        Some(Value::Object(task_runner)) => match task_runner.get("cacheDirectory") {
            None | Some(Value::Null) => None,
            Some(Value::String(path)) => Some(path.clone()),
            Some(_) => return None,
        },
        Some(_) => return None,
    };

    Some(Settings {
        branch_scoped: config.get("branchScopedCache") == Some(&Value::Bool(true)),
        shared_worktree: config.get("sharedWorktreeCache") != Some(&Value::Bool(false)),
        cache_directory,
    })
}
