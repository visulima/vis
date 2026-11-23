//! The cache key of every task of a `run <target>` in the supported shape,
//! computed the way the declared-hash path of the TypeScript orchestrator does:
//! `InProcessTaskHasher.hashTask`, then the dependency fold of
//! `#foldDependencyHashes`, then `computeTaskHash`.

use std::collections::HashMap;
use std::path::Path;

use crate::file_hasher::{collect_files, hash_bytes, hash_files_batch};
use crate::run_graph::{
    build_task_graph, has_glob_magic, unkeyed_tasks, DependsOn, NotReproducible, RunProject, RunTask, RunTaskGraph,
};
use crate::task_hasher::{compute_task_hash, hash_command, TaskHashDetails};

/// The workspace-root files every task key covers, in this order
/// (`DEFAULT_GLOBAL_INPUTS` in `task-hasher.ts`).
const GLOBAL_INPUTS: [&str; 6] =
    ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.base.json", "tsconfig.json", ".env"];

/// The key of one task and what it was computed from.
#[derive(Clone, Debug)]
pub struct TaskKey {
    pub id: String,
    /// The cache key: the name of the task's cache entry directory.
    pub hash: String,
    /// False when a dependency could not be keyed, so a cache hit could not vouch
    /// for the run (never the case in a plain run).
    pub keyed: bool,
    /// The parts the key hashes, as Node records them in `hashDetails`.
    pub details: TaskHashDetails,
}

/// The task graph of a run and the key of each of its tasks, in graph order.
#[derive(Clone, Debug)]
pub struct TaskKeys {
    pub graph: RunTaskGraph,
    pub keys: Vec<TaskKey>,
}

impl TaskKeys {
    pub fn key(&self, id: &str) -> Option<&TaskKey> {
        self.keys.iter().find(|key| key.id == id)
    }
}

/// Serialises `text` as `JSON.stringify` does: the escapes `\"` `\\` `\b` `\f` `\n`
/// `\r` `\t`, `\u00xx` for the other control characters, everything else verbatim
/// (Rust strings cannot hold the lone surrogates `JSON.stringify` escapes).
pub(crate) fn js_json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);

    out.push('"');

    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }

    out.push('"');

    out
}

/// The command hash of a plain script task: `hash_command` over the overrides the
/// run builds for it, `{"command":…,"outputs":"[]","overrides":{"command":…,"visOptions":{}}}`
/// (outputs are always empty in this shape, and `visOptions` is the empty options object).
fn command_hash(task: &RunTask, target: &str) -> String {
    let command = js_json_string(&task.command);
    let overrides =
        format!(r#"{{"command":{command},"outputs":"[]","overrides":{{"command":{command},"visOptions":{{}}}}}}"#);

    hash_command(&task.project, target, None, &overrides)
}

/// `__global__`: xxh3-128 of `name + fileHash` (no separators) for each existing
/// global input file, in order. `None` when none exists.
fn global_hash(workspace_root: &str) -> Result<Option<String>, NotReproducible> {
    let mut combined = Vec::new();

    for name in GLOBAL_INPUTS {
        let path = Path::new(workspace_root).join(name);

        // A missing file, a directory or any other non-file is skipped, as the hasher's `stat` + `readFile` skips it.
        let Ok(metadata) = std::fs::metadata(&path) else { continue };

        if !metadata.is_file() {
            continue;
        }

        let content = std::fs::read(&path).map_err(|error| NotReproducible::UnreadableFile {
            path: path.display().to_string(),
            reason: error.to_string(),
        })?;

        combined.extend_from_slice(name.as_bytes());
        combined.extend_from_slice(hash_bytes(&content).as_bytes());
    }

    Ok((!combined.is_empty()).then(|| hash_bytes(&combined)))
}

/// `nodes`: the files of the project, keyed by workspace-relative path.
///
/// The default input is `{projectRoot}/**/*`. The directory walk is the one the
/// addon runs (`collect_files`); the pattern then drops every file with a path
/// segment under the project root that starts with `.`, which is how the glob
/// matcher treats `*` and `**`.
fn project_nodes(workspace_root: &str, task: &RunTask) -> Result<Vec<Vec<String>>, NotReproducible> {
    let directory = format!("{workspace_root}/{}", task.root);
    let prefix = format!("{directory}/");
    let mut files = Vec::new();

    for path in collect_files(&directory) {
        if path.contains('\u{FFFD}') {
            return Err(NotReproducible::NonUtf8Path(path));
        }

        let Some(relative) = path.strip_prefix(&prefix) else { continue };

        if relative.split('/').all(|segment| !segment.starts_with('.')) {
            files.push(path);
        }
    }

    if files.is_empty() {
        return Err(NotReproducible::NoInputFiles(task.id.clone()));
    }

    let mut nodes = Vec::with_capacity(files.len());

    for file in hash_files_batch(&files, workspace_root) {
        if file.hash.starts_with("ERR:") {
            return Err(NotReproducible::UnreadableFile { path: file.path, reason: "read failed".to_owned() });
        }

        nodes.push(vec![file.path, file.hash]);
    }

    Ok(nodes)
}

/// Computes the key of every task of `run <target>`. Windows is not reproduced.
///
/// `workspace_root` is the absolute workspace directory, `projects` the workspace
/// in project order. See [`build_task_graph`] for the supported shape and
/// [`NotReproducible`] for everything outside it.
pub fn compute_task_keys(
    workspace_root: &str,
    target: &str,
    projects: &[RunProject],
    depends_on: DependsOn,
) -> Result<TaskKeys, NotReproducible> {
    if cfg!(windows) {
        return Err(NotReproducible::UnsupportedPlatform);
    }

    let root = workspace_root.trim_end_matches('/');

    if !root.starts_with('/') || has_glob_magic(root) {
        return Err(NotReproducible::UnsafeWorkspaceRoot(workspace_root.to_owned()));
    }

    let graph = build_task_graph(target, projects, depends_on)?;
    let unkeyed = unkeyed_tasks(&graph, &Default::default())?;
    let global = global_hash(root)?;
    let by_id: HashMap<&str, &RunTask> = graph.tasks.iter().map(|task| (task.id.as_str(), task)).collect();
    let mut hashes: HashMap<String, String> = HashMap::new();
    let mut details_by_id: HashMap<String, TaskHashDetails> = HashMap::new();

    for id in graph.execution_order()? {
        let task = by_id[id.as_str()];
        let mut implicit_deps: Vec<Vec<String>> = Vec::new();

        if let Some(global) = &global {
            implicit_deps.push(vec!["__global__".to_owned(), global.clone()]);
        }

        // A dependency's hash is already known: the order puts dependencies first.
        for dependency in &task.dependencies {
            implicit_deps.push(vec![format!("dep:{dependency}"), hashes[dependency].clone()]);
        }

        let details = TaskHashDetails {
            command: command_hash(task, target),
            nodes: project_nodes(root, task)?,
            implicit_deps: (!implicit_deps.is_empty()).then_some(implicit_deps),
            runtime: None,
        };

        hashes.insert(id.clone(), compute_task_hash(&details));
        details_by_id.insert(id, details);
    }

    let keys = graph
        .tasks
        .iter()
        .map(|task| TaskKey {
            id: task.id.clone(),
            hash: hashes[&task.id].clone(),
            keyed: !unkeyed.contains(&task.id),
            details: details_by_id.remove(&task.id).expect("every task was hashed"),
        })
        .collect();

    Ok(TaskKeys { graph, keys })
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use crate::run_graph::{DependencyKind, ProjectDependency};
    use std::fs;

    /// `xxh3_128` of the parts joined without a separator, the `__global__` layout.
    fn concat_hash(parts: &[&str]) -> String {
        hash_bytes(parts.concat().as_bytes())
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);

        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn workspace(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("run-key-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        root.canonicalize().unwrap()
    }

    fn project(name: &str, script: &str, dependencies: &[&str]) -> RunProject {
        RunProject {
            name: name.to_owned(),
            root: format!("packages/{name}"),
            script: Some(script.to_owned()),
            dependencies: dependencies
                .iter()
                .map(|d| ProjectDependency { project: (*d).to_owned(), kind: DependencyKind::Static })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn json_strings_are_escaped_like_js() {
        assert_eq!(js_json_string("plain"), "\"plain\"");
        assert_eq!(js_json_string("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(js_json_string("l1\nl2\r\t\u{8}\u{c}"), r#""l1\nl2\r\t\b\f""#);
        assert_eq!(js_json_string("\u{0}\u{1f}\u{b}"), r#""\u0000\u001f\u000b""#);
        assert_eq!(js_json_string("é€😀\u{7f}\u{2028}"), "\"é€😀\u{7f}\u{2028}\"");
    }

    /// Golden values of a real `vis run build` (a script `true`, no outputs, a
    /// workspace with no global input file): the overrides string hashes to the
    /// command hash recorded in its summary, and with the two recorded node hashes
    /// the final key is the name of the task's cache directory.
    #[test]
    fn matches_the_values_of_a_recorded_run() {
        let task = RunTask {
            id: "p2:build".into(),
            project: "p2".into(),
            root: "packages/p2".into(),
            command: "true".into(),
            dependencies: Vec::new(),
        };
        let command = command_hash(&task, "build");

        assert_eq!(command, "d75e4fcbc4e2e3070ddf198b6c714098");

        let details = TaskHashDetails {
            command,
            nodes: vec![
                vec!["packages/p2/package.json".into(), "e7c29c236bc93f52ea7f6bef83fe2f16".into()],
                vec!["packages/p2/src/index.ts".into(), "9eb34a2c237edc25b5511383254ae976".into()],
            ],
            implicit_deps: None,
            runtime: None,
        };

        assert_eq!(compute_task_hash(&details), "0bf3560be734757197a4fee351196867");
    }

    #[test]
    fn global_hash_concatenates_name_and_file_hash_without_separator() {
        let root = workspace("global");

        write(&root, "tsconfig.json", "{}");

        let expected = concat_hash(&["tsconfig.json", &hash_bytes(b"{}")]);

        assert_eq!(global_hash(root.to_str().unwrap()).unwrap(), Some(expected));

        write(&root, "pnpm-lock.yaml", "lock");

        let both = concat_hash(&["pnpm-lock.yaml", &hash_bytes(b"lock"), "tsconfig.json", &hash_bytes(b"{}")]);

        assert_eq!(global_hash(root.to_str().unwrap()).unwrap(), Some(both));
    }

    #[test]
    fn global_hash_skips_missing_files_and_directories() {
        let root = workspace("global-none");

        fs::create_dir_all(root.join("yarn.lock")).unwrap();

        assert_eq!(global_hash(root.to_str().unwrap()).unwrap(), None);
    }

    #[test]
    fn keys_depend_on_content_command_and_dependency_keys() {
        let root = workspace("keys");

        write(&root, "packages/a/package.json", "{}");
        write(&root, "packages/a/src/index.ts", "a");
        write(&root, "packages/b/package.json", "{}");

        let root_str = root.to_str().unwrap();
        let projects = [project("a", "tsc", &[]), project("b", "tsc", &["a"])];
        let keys = |depends_on| compute_task_keys(root_str, "build", &projects, depends_on).unwrap();
        let plain = keys(DependsOn::Nothing);
        let chained = keys(DependsOn::DependenciesSameTarget);

        assert_eq!(plain.keys.len(), 2);
        assert!(plain.keys.iter().all(|key| key.keyed && key.hash.len() == 32));
        assert_eq!(plain.key("a:build").unwrap().hash, chained.key("a:build").unwrap().hash);
        assert_ne!(plain.key("b:build").unwrap().hash, chained.key("b:build").unwrap().hash);

        let folded = chained.key("b:build").unwrap();

        assert_eq!(
            folded.details.implicit_deps.as_ref().unwrap(),
            &[vec!["dep:a:build".to_owned(), chained.key("a:build").unwrap().hash.clone()]]
        );

        write(&root, "packages/a/src/index.ts", "a2");

        let changed = keys(DependsOn::DependenciesSameTarget);

        assert_ne!(changed.key("a:build").unwrap().hash, chained.key("a:build").unwrap().hash);
        assert_ne!(
            changed.key("b:build").unwrap().hash,
            chained.key("b:build").unwrap().hash,
            "a changed dependency changes the dependent"
        );
    }

    #[test]
    fn hidden_files_and_ignored_directories_do_not_enter_the_key() {
        let root = workspace("hidden");

        write(&root, "packages/a/package.json", "{}");

        let root_str = root.to_str().unwrap();
        let projects = [project("a", "tsc", &[])];
        let before = compute_task_keys(root_str, "build", &projects, DependsOn::Nothing).unwrap().keys[0].hash.clone();

        write(&root, "packages/a/.hidden", "x");
        write(&root, "packages/a/src/.dot/x.ts", "x");
        write(&root, "packages/a/node_modules/x/i.js", "x");
        write(&root, "packages/a/dist/out.js", "x");

        assert_eq!(compute_task_keys(root_str, "build", &projects, DependsOn::Nothing).unwrap().keys[0].hash, before);

        write(&root, "packages/a/visible.ts", "x");

        assert_ne!(compute_task_keys(root_str, "build", &projects, DependsOn::Nothing).unwrap().keys[0].hash, before);
    }

    #[test]
    fn a_project_without_files_is_not_reproducible() {
        let root = workspace("empty");

        write(&root, "packages/a/.hidden", "x");

        assert_eq!(
            compute_task_keys(root.to_str().unwrap(), "build", &[project("a", "tsc", &[])], DependsOn::Nothing)
                .unwrap_err(),
            NotReproducible::NoInputFiles("a:build".into())
        );
    }

    #[test]
    fn an_unsafe_workspace_root_is_not_reproducible() {
        for root in ["relative/path", "/tmp/with[bracket]", "/tmp/a*b", "/tmp/{a,b}"] {
            assert!(matches!(
                compute_task_keys(root, "build", &[project("a", "tsc", &[])], DependsOn::Nothing),
                Err(NotReproducible::UnsafeWorkspaceRoot(_))
            ));
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_is_handed_to_node() {
        assert_eq!(
            compute_task_keys("C:/ws", "build", &[], DependsOn::Nothing).unwrap_err(),
            NotReproducible::UnsupportedPlatform
        );
    }
}
