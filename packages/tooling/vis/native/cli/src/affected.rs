//! Native `vis affected <target> --sparse-checkout`: the affected project roots, one per line.
//!
//! The Node command (`src/commands/affected/handler.ts`) does its own work only for
//! `--sparse-checkout`; every other shape forwards to `vis run --affected`, which is not native.
//! So this module answers that one shape and hands the invocation to Node otherwise: a missing
//! or extra positional, a repeated or unknown flag, an empty value, `--query` / `--tag`, an
//! invalid scope or git ref, and a failing git call all delegate before anything is printed.
//!
//! The selection mirrors `selectAffectedProjects` (`src/task/affected-selection.ts`) and
//! `getAffectedProjects` (`packages/tooling/task-runner/src/affected.ts`) for a JS-only workspace
//! with no vis config, in a CI context with a quiet stderr (the gate `list` uses). Such a
//! workspace has no `affectedIgnore`, no `fileOwners` and, with no inference detector applying,
//! no external inputs, so the changed files map to projects by root and spread along the
//! dependency graph alone. Git is read with the commands Node runs.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::env;
use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::graph::{project_graph, GraphResult, ProjectGraph};
use crate::node_context::{monorepo_root, quiet_context};
use crate::output::write_stdout;
use crate::vis_config::{self, ConfigState};

/// `maxBuffer` of Node's `execFile` / `spawnSync`. Output at or above it makes Node fail, so the
/// native path leaves that case to Node.
const MAX_BUFFER: usize = 1024 * 1024;

const ZERO_SHA: &str = "0000000000000000000000000000000000000000";

/// How far a selection follows the graph (`--downstream` / `--upstream`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Scope {
    None,
    Direct,
    Deep,
}

impl Scope {
    fn parse(value: &str) -> Option<Scope> {
        match value {
            "none" => Some(Scope::None),
            "direct" => Some(Scope::Direct),
            "deep" => Some(Scope::Deep),
            _ => None,
        }
    }
}

/// The flags of one `affected --sparse-checkout` invocation.
#[derive(Debug, PartialEq)]
struct Options {
    base: Option<String>,
    head: Option<String>,
    /// `Some(true)` for `--uncommitted`, `Some(false)` for `--no-uncommitted`, `None` for auto.
    uncommitted: Option<bool>,
    downstream: Scope,
    upstream: Scope,
}

/// Parses `affected <target> --sparse-checkout [...]`. `args[0]` is `affected`. Returns `None` for
/// every shape this module does not answer.
fn parse(args: &[String]) -> Option<Options> {
    let target = args.get(1)?;

    if target.is_empty() || target.starts_with('-') {
        return None;
    }

    let mut sparse = false;
    let mut base: Option<String> = None;
    let mut head: Option<String> = None;
    let mut uncommitted: Option<bool> = None;
    let mut downstream: Option<Scope> = None;
    let mut upstream: Option<Scope> = None;
    let mut tokens = args.iter().skip(2);

    while let Some(token) = tokens.next() {
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (token.as_str(), None),
        };

        match name {
            "--sparse-checkout" | "--uncommitted" | "--no-uncommitted" => {
                if inline.is_some() {
                    return None;
                }

                match name {
                    "--sparse-checkout" if !sparse => sparse = true,
                    "--uncommitted" if uncommitted.is_none() => uncommitted = Some(true),
                    "--no-uncommitted" if uncommitted.is_none() => uncommitted = Some(false),
                    _ => return None,
                }
            }
            "--base" | "--head" | "--downstream" | "--upstream" => {
                let value = match inline {
                    Some(value) => value,
                    None => tokens.next()?.as_str(),
                };

                // An empty value, or one that reads as another option, is left to cerebro.
                if value.is_empty() || value.starts_with('-') {
                    return None;
                }

                match name {
                    "--base" if base.is_none() => base = Some(value.to_owned()),
                    "--head" if head.is_none() => head = Some(value.to_owned()),
                    "--downstream" if downstream.is_none() => downstream = Some(Scope::parse(value)?),
                    "--upstream" if upstream.is_none() => upstream = Some(Scope::parse(value)?),
                    _ => return None,
                }
            }
            _ => return None,
        }
    }

    if !sparse {
        return None;
    }

    Some(Options {
        base,
        head,
        uncommitted,
        downstream: downstream.unwrap_or(Scope::Deep),
        upstream: upstream.unwrap_or(Scope::None),
    })
}

/// `validateGitRef` in `task-runner/src/affected.ts`: `^[\w./~^@{}][\w.\-/~^@{}]*$`.
fn valid_ref(reference: &str) -> bool {
    let mut chars = reference.chars();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let first = |c: char| word(c) || "./~^@{}".contains(c);
    let rest = |c: char| first(c) || c == '-';

    chars.next().is_some_and(first) && chars.all(rest)
}

/// The `{base, head}` pair of `resolveAffectedShas` (`src/runtime/affected-shas.ts`).
#[derive(Debug, PartialEq)]
struct Shas {
    base: String,
    head: String,
}

/// Where `resolve_shas` reads its inputs, so a test can supply them.
trait Source {
    fn env(&self, key: &str) -> Option<String>;
    /// `git <args>` in the workspace root, trimmed stdout, `None` on a non-zero exit.
    fn git(&self, args: &[&str]) -> Option<String>;
    /// Parsed JSON object of the event payload at `path`; `None` when it cannot be read.
    fn event_payload(&self, path: &str) -> Option<serde_json::Value>;
}

fn non_empty_sha(value: Option<String>) -> Option<String> {
    value.filter(|sha| !sha.is_empty() && sha != ZERO_SHA)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// Port of `resolveAffectedShas` for the default base branch `main`. `None` hands the call to Node:
/// the one path that has no equal here is a GitHub event payload that cannot be read.
fn resolve_shas(source: &dyn Source) -> Option<Shas> {
    const DEFAULT_BASE: &str = "main";

    let env = |key: &str| source.env(key);
    let head_from = |key: &str| env(key).unwrap_or_else(|| "HEAD".to_owned());

    if env("GITHUB_ACTIONS").as_deref() == Some("true") {
        let head = head_from("GITHUB_SHA");

        if let Some(base_ref) = non_empty(env("GITHUB_BASE_REF")) {
            return Some(Shas { base: format!("origin/{base_ref}"), head });
        }

        if let Some(path) = non_empty(env("GITHUB_EVENT_PATH")) {
            let payload = source.event_payload(&path)?;

            // A merge queue run has no pull request base: the queue entry names the commit it was built on.
            let merge_group_base = payload
                .get("merge_group")
                .and_then(|group| group.get("base_sha"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);

            if let Some(base) = non_empty_sha(merge_group_base) {
                return Some(Shas { base, head });
            }

            let before = payload.get("before").and_then(serde_json::Value::as_str).map(str::to_owned);

            if let Some(before) = non_empty_sha(before) {
                return Some(Shas { base: before, head });
            }
        }

        return Some(Shas { base: format!("origin/{DEFAULT_BASE}"), head });
    }

    if env("GITLAB_CI").as_deref() == Some("true") {
        let head = head_from("CI_COMMIT_SHA");

        if env("CI_PIPELINE_SOURCE").as_deref() == Some("merge_request_event") {
            if let Some(base) = non_empty_sha(env("CI_MERGE_REQUEST_DIFF_BASE_SHA")) {
                return Some(Shas { base, head });
            }

            if let Some(target) = non_empty(env("CI_MERGE_REQUEST_TARGET_BRANCH_NAME")) {
                return Some(Shas { base: format!("origin/{target}"), head });
            }
        }

        if let Some(base) = non_empty_sha(env("CI_COMMIT_BEFORE_SHA")) {
            return Some(Shas { base, head });
        }

        let default_branch = env("CI_DEFAULT_BRANCH").unwrap_or_else(|| DEFAULT_BASE.to_owned());

        return Some(Shas { base: format!("origin/{default_branch}"), head });
    }

    if env("TF_BUILD").is_some_and(|value| value.eq_ignore_ascii_case("true")) {
        let head = head_from("BUILD_SOURCEVERSION");
        let name = non_empty(env("SYSTEM_PULLREQUEST_TARGETBRANCHNAME"));
        let target = name.or_else(|| {
            env("SYSTEM_PULLREQUEST_TARGETBRANCH")
                .map(|full| full.strip_prefix("refs/heads/").unwrap_or(&full).to_owned())
        });

        return Some(match non_empty(target) {
            Some(branch) => Shas { base: format!("origin/{branch}"), head },
            None => Shas { base: format!("origin/{DEFAULT_BASE}"), head },
        });
    }

    for (flag, head_key, base_key) in [
        ("BUILDKITE", "BUILDKITE_COMMIT", "BUILDKITE_PULL_REQUEST_BASE_BRANCH"),
        ("CIRCLECI", "CIRCLE_SHA1", "CIRCLE_PR_BASE_BRANCH"),
    ] {
        if env(flag).as_deref() == Some("true") {
            let head = head_from(head_key);

            return Some(match non_empty(env(base_key)) {
                Some(branch) => Shas { base: format!("origin/{branch}"), head },
                None => Shas { base: format!("origin/{DEFAULT_BASE}"), head },
            });
        }
    }

    // Local: the merge base with the default branch when git has one.
    let merge_base = source.git(&["merge-base", "HEAD", &format!("origin/{DEFAULT_BASE}")]);

    Some(match non_empty(merge_base) {
        Some(base) => Shas { base, head: "HEAD".to_owned() },
        None => Shas { base: format!("origin/{DEFAULT_BASE}"), head: "HEAD".to_owned() },
    })
}

/// Port of `parsePorcelainStatus`: the paths in `git status --porcelain -z`, with the source path of
/// a rename or copy after its destination. `None` when an entry is not split at a character
/// boundary, which only a malformed status can produce.
fn parse_porcelain(raw: &str) -> Option<Vec<String>> {
    let mut files = Vec::new();
    let mut fields = raw.split('\0');

    while let Some(entry) = fields.next() {
        if entry.is_empty() || entry.encode_utf16().count() < 4 {
            continue;
        }

        if !entry.is_char_boundary(3) {
            return None;
        }

        let status = &entry[..2];
        let path = &entry[3..];

        if !path.is_empty() {
            files.push(path.to_owned());
        }

        if status.contains('R') || status.contains('C') {
            if let Some(source) = fields.next().filter(|source| !source.is_empty()) {
                files.push(source.to_owned());
            }
        }
    }

    Some(files)
}

/// What `git <args>` did in a directory.
enum GitRun {
    /// It ran and exited zero; this is its stdout.
    Done(Vec<u8>),
    /// It did not start, or exited non-zero.
    Failed,
}

fn git_output(root: &Path, args: &[&str]) -> GitRun {
    match Command::new("git").args(args).current_dir(root).stdin(Stdio::null()).stderr(Stdio::null()).output() {
        Ok(output) if output.status.success() => GitRun::Done(output.stdout),
        _ => GitRun::Failed,
    }
}

/// Runs `git <args>` in `root` and returns stdout as text. `None` on a launch failure, a non-zero
/// exit, output at the `maxBuffer` limit or output that is not UTF-8: every one of those is an
/// error path (or a decoding) Node owns.
fn run_git(root: &Path, args: &[&str]) -> Option<String> {
    match git_output(root, args) {
        GitRun::Done(stdout) if stdout.len() < MAX_BUFFER => String::from_utf8(stdout).ok(),
        _ => None,
    }
}

/// Whether `file` is `directory` or lies below it (both `/`-separated, relative to the same root).
fn is_within(file: &str, directory: &str) -> bool {
    file == directory || file.strip_prefix(directory).is_some_and(|rest| rest.starts_with('/'))
}

struct RealSource<'a> {
    root: &'a Path,
}

impl Source for RealSource<'_> {
    fn env(&self, key: &str) -> Option<String> {
        env::var_os(key).map(|value| value.to_string_lossy().into_owned())
    }

    fn git(&self, args: &[&str]) -> Option<String> {
        run_git(self.root, args).map(|text| text.trim().to_owned())
    }

    fn event_payload(&self, path: &str) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(path).ok()?;

        // A byte-order mark is a case the Node reader may treat differently.
        if text.starts_with('\u{feff}') {
            return None;
        }

        serde_json::from_str(&text).ok()
    }
}

/// `git diff --name-only <merge-base> <head>`, split into paths. A failure of either call is left
/// to Node, whose fallback (`base...head`) and error messages are not reproduced.
fn changed_files(root: &Path, base: &str, head: &str) -> Option<Vec<String>> {
    let merge_base = run_git(root, &["merge-base", base, head])?;
    let merge_base = merge_base.trim();
    let diff = run_git(root, &["diff", "--name-only", merge_base, head])?;
    let trimmed = diff.trim();

    // JS `trim()` also strips characters Rust does not; stay with plain ASCII output.
    if !trimmed.is_ascii() {
        return None;
    }

    Some(trimmed.split('\n').filter(|line| !line.is_empty()).map(str::to_owned).collect())
}

/// The files of `git status --porcelain -z` that lie in a known project. A status that cannot be
/// read is an empty list, as in Node.
fn working_tree_files(root: &Path, project_roots: &[&str]) -> Option<Vec<String>> {
    let GitRun::Done(stdout) = git_output(root, &["status", "--porcelain", "-z"]) else {
        return Some(Vec::new());
    };

    if stdout.len() >= MAX_BUFFER {
        return None;
    }

    let files = parse_porcelain(&String::from_utf8(stdout).ok()?)?;

    Some(files.into_iter().filter(|file| project_roots.iter().any(|project| is_within(file, project))).collect())
}

/// The project that owns `file`: the deepest project root containing it.
fn owner<'a>(file: &str, roots: &'a BTreeMap<&'a str, &'a str>) -> Option<&'a str> {
    let mut best: Option<(&str, usize)> = None;

    for (name, root) in roots {
        if is_within(file, root) && root.len() > best.map_or(0, |(_, length)| length) {
            best = Some((name, root.len()));
        }
    }

    best.map(|(name, _)| name)
}

/// Spreads `seeds` along `adjacency`, one step for `Direct` and to the fixed point for `Deep`.
fn expand(
    affected: &mut BTreeSet<String>,
    seeds: &BTreeSet<String>,
    adjacency: &BTreeMap<&str, BTreeSet<&str>>,
    scope: Scope,
) {
    if scope == Scope::None {
        return;
    }

    let mut visited: BTreeSet<&str> = seeds.iter().map(String::as_str).collect();
    let mut queue: VecDeque<&str> = seeds.iter().map(String::as_str).collect();

    while let Some(project) = queue.pop_front() {
        let Some(neighbors) = adjacency.get(project) else { continue };

        for neighbor in neighbors {
            if visited.insert(neighbor) {
                affected.insert((*neighbor).to_owned());

                if scope == Scope::Deep {
                    queue.push_back(neighbor);
                }
            }
        }
    }
}

/// The affected project names for a set of changed files.
fn affected_projects(graph: &ProjectGraph, files: &[String], downstream: Scope, upstream: Scope) -> BTreeSet<String> {
    let roots: BTreeMap<&str, &str> =
        graph.directories.iter().map(|(name, root)| (name.as_str(), root.as_str())).collect();
    let mut changed: BTreeSet<String> = BTreeSet::new();

    for file in files {
        match owner(file, &roots) {
            Some(project) => {
                changed.insert(project.to_owned());
            }
            // A file outside every project is a change to the whole workspace.
            None => return graph.nodes.keys().cloned().collect(),
        }
    }

    let mut dependents: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let mut dependencies: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();

    for edges in graph.dependencies.values() {
        for edge in edges {
            dependents.entry(edge.target.as_str()).or_default().insert(edge.source.as_str());
            dependencies.entry(edge.source.as_str()).or_default().insert(edge.target.as_str());
        }
    }

    let mut affected = changed.clone();

    expand(&mut affected, &changed, &dependents, downstream);
    expand(&mut affected, &changed, &dependencies, upstream);

    affected
}

/// The sorted, deduplicated project roots, one per line (`--sparse-checkout`'s output).
fn render(graph: &ProjectGraph, affected: &BTreeSet<String>) -> String {
    let roots: BTreeSet<&str> =
        affected.iter().filter_map(|name| graph.directories.get(name).map(String::as_str)).collect();

    if roots.is_empty() {
        return String::new();
    }

    let mut text = roots.into_iter().collect::<Vec<_>>().join("\n");

    text.push('\n');
    text
}

/// Whether Node's selection reads a `project.json` of this workspace: the root's, or one in a project directory.
/// Its `targets[].inputs` (external inputs), `implicitDependencies` and `tags` change which projects are selected,
/// and none of them is reproduced here. Membership already delegates such a root; this keeps the selection from
/// depending on that.
fn reads_project_json(root: &Path, graph: &ProjectGraph) -> bool {
    root.join("project.json").exists()
        || graph.directories.values().any(|directory| root.join(directory).join("project.json").exists())
}

/// The text `vis affected … --sparse-checkout` prints, or `None` when Node must answer.
fn answer(args: &[String]) -> Option<String> {
    let options = parse(args)?;
    let cwd = env::current_dir().ok()?;
    let root = monorepo_root(&cwd)?;

    if !quiet_context(&cwd, &root) || vis_config::read(&root) != ConfigState::Absent {
        return None;
    }

    let GraphResult::Native(graph) = project_graph(&root) else {
        return None;
    };

    // Every project must be free of the inference that could add inputs. The gate also leaves a
    // project at the root directory and a non-ASCII directory to Node.
    if !crate::list::inference_free(&root, &graph) || reads_project_json(&root, &graph) {
        return None;
    }

    let source = RealSource { root: &root };
    let (mut base, mut head) = (options.base.clone(), options.head.clone());

    // `||` in Node: an empty value does not count as given. `parse` never yields one.
    if base.is_none() || head.is_none() {
        let resolved = resolve_shas(&source)?;

        base = base.or(Some(resolved.base));
        head = head.or(Some(resolved.head));
    }

    let (base, head) = (base?, head?);

    if !valid_ref(&base) || !valid_ref(&head) {
        return None;
    }

    // `--uncommitted` is off by default in CI, and only a head of `HEAD` has a working tree.
    let mut files = Vec::new();
    let head_is_working_tree = head == "HEAD";
    let diffed = changed_files(&root, &base, &head)?;

    if options.uncommitted == Some(true) && head_is_working_tree {
        let project_roots: Vec<&str> =
            graph.directories.values().map(|directory| directory.trim_end_matches('/')).collect();

        files = working_tree_files(&root, &project_roots)?;
    }

    let mut changed = diffed;

    for file in files {
        if !changed.contains(&file) {
            changed.push(file);
        }
    }

    Some(render(&graph, &affected_projects(&graph, &changed, options.downstream, options.upstream)))
}

/// Answers `vis affected` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Some(text) => {
            write_stdout("affected", "the affected projects", &text);

            std::process::exit(0);
        }
        None => crate::process::delegate(raw_args),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::graph::{Edge, EdgeKind, Node, ProjectType};

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn parses_the_sparse_checkout_shapes() {
        let plain = parse(&argv(&["affected", "build", "--sparse-checkout"])).expect("plain");

        assert_eq!(plain.downstream, Scope::Deep);
        assert_eq!(plain.upstream, Scope::None);
        assert_eq!(plain.uncommitted, None);

        let full = parse(&argv(&[
            "affected",
            "build",
            "--sparse-checkout",
            "--base=main",
            "--head",
            "HEAD~1",
            "--no-uncommitted",
            "--downstream=direct",
            "--upstream",
            "deep",
        ]))
        .expect("full");

        assert_eq!(full.base.as_deref(), Some("main"));
        assert_eq!(full.head.as_deref(), Some("HEAD~1"));
        assert_eq!(full.uncommitted, Some(false));
        assert_eq!(full.downstream, Scope::Direct);
        assert_eq!(full.upstream, Scope::Deep);
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["affected"][..],
            &["affected", "build"],
            &["affected", "--sparse-checkout"],
            &["affected", "", "--sparse-checkout"],
            &["affected", "--sparse-checkout", "build"],
            &["affected", "build", "--sparse-checkout", "--sparse-checkout"],
            &["affected", "build", "--sparse-checkout", "--query=x"],
            &["affected", "build", "--sparse-checkout", "--tag", "x"],
            &["affected", "build", "--sparse-checkout", "--base="],
            &["affected", "build", "--sparse-checkout", "--base"],
            &["affected", "build", "--sparse-checkout", "--base", "--head"],
            &["affected", "build", "--sparse-checkout", "--downstream=sideways"],
            &["affected", "build", "--sparse-checkout", "--uncommitted", "--no-uncommitted"],
            &["affected", "build", "--sparse-checkout", "--uncommitted=false"],
            &["affected", "build", "--sparse-checkout", "--dry-run"],
            &["affected", "build", "--sparse-checkout", "--"],
            &["affected", "build", "extra", "--sparse-checkout"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    #[test]
    fn git_refs_follow_the_task_runner_pattern() {
        for good in ["main", "origin/main", "HEAD~1", "HEAD^", "@{u}", "v1.2.3", "a-b", "_x", "./x", "origin/"] {
            assert!(valid_ref(good), "{good}");
        }

        for bad in ["", "-x", "--help", "a b", "a;b", "a\nb", "é", "a$b", "a:b"] {
            assert!(!valid_ref(bad), "{bad}");
        }
    }

    #[test]
    fn porcelain_keeps_renames_in_both_directions() {
        let raw = "?? new.txt\0 M packages/a/index.ts\0R  packages/b/new.ts\0packages/a/old.ts\0\0";

        assert_eq!(
            parse_porcelain(raw).expect("parses"),
            ["new.txt", "packages/a/index.ts", "packages/b/new.ts", "packages/a/old.ts"]
        );

        assert_eq!(parse_porcelain("ab\0").expect("short"), Vec::<String>::new());
    }

    struct Fake {
        env: HashMap<&'static str, &'static str>,
        merge_base: Option<&'static str>,
        payload: Option<serde_json::Value>,
    }

    impl Source for Fake {
        fn env(&self, key: &str) -> Option<String> {
            self.env.get(key).map(|value| (*value).to_owned())
        }

        fn git(&self, _args: &[&str]) -> Option<String> {
            self.merge_base.map(str::to_owned)
        }

        fn event_payload(&self, _path: &str) -> Option<serde_json::Value> {
            self.payload.clone()
        }
    }

    fn fake(env: &[(&'static str, &'static str)]) -> Fake {
        Fake { env: env.iter().copied().collect(), merge_base: None, payload: None }
    }

    fn shas(base: &str, head: &str) -> Option<Shas> {
        Some(Shas { base: base.to_owned(), head: head.to_owned() })
    }

    #[test]
    fn local_resolution_uses_the_merge_base_or_origin_main() {
        let mut source = fake(&[]);

        assert_eq!(resolve_shas(&source), shas("origin/main", "HEAD"));

        source.merge_base = Some("abc");

        assert_eq!(resolve_shas(&source), shas("abc", "HEAD"));
    }

    #[test]
    fn github_resolution_reads_the_pull_request_base_then_the_push_payload() {
        let pull = fake(&[("GITHUB_ACTIONS", "true"), ("GITHUB_BASE_REF", "dev"), ("GITHUB_SHA", "f00")]);

        assert_eq!(resolve_shas(&pull), shas("origin/dev", "f00"));

        let mut push = fake(&[("GITHUB_ACTIONS", "true"), ("GITHUB_EVENT_PATH", "/e.json")]);

        push.payload = Some(serde_json::json!({ "before": "abc123" }));

        assert_eq!(resolve_shas(&push), shas("abc123", "HEAD"));

        push.payload = Some(serde_json::json!({ "before": ZERO_SHA }));

        assert_eq!(resolve_shas(&push), shas("origin/main", "HEAD"));

        push.payload = Some(serde_json::json!(null));

        assert_eq!(resolve_shas(&push), shas("origin/main", "HEAD"));

        // An unreadable payload is Node's to handle.
        push.payload = None;

        assert_eq!(resolve_shas(&push), None);
    }

    #[test]
    fn github_resolution_prefers_the_merge_group_base_over_the_push_before() {
        let mut queue = fake(&[("GITHUB_ACTIONS", "true"), ("GITHUB_EVENT_PATH", "/e.json"), ("GITHUB_SHA", "f00")]);

        queue.payload = Some(serde_json::json!({ "merge_group": { "base_sha": "b45e" } }));

        assert_eq!(resolve_shas(&queue), shas("b45e", "f00"));

        queue.payload = Some(serde_json::json!({ "before": "abc123", "merge_group": { "base_sha": "b45e" } }));

        assert_eq!(resolve_shas(&queue), shas("b45e", "f00"));

        // An empty, zero or non-string base falls through to `before`, then to the default branch.
        for unusable in
            [serde_json::json!(""), serde_json::json!(ZERO_SHA), serde_json::json!(7), serde_json::json!(null)]
        {
            queue.payload =
                Some(serde_json::json!({ "before": "abc123", "merge_group": { "base_sha": unusable.clone() } }));

            assert_eq!(resolve_shas(&queue), shas("abc123", "f00"));

            queue.payload = Some(serde_json::json!({ "merge_group": { "base_sha": unusable } }));

            assert_eq!(resolve_shas(&queue), shas("origin/main", "f00"));
        }

        queue.payload = Some(serde_json::json!({ "before": "abc123", "merge_group": "b45e" }));

        assert_eq!(resolve_shas(&queue), shas("abc123", "f00"));
    }

    #[test]
    fn gitlab_resolution_prefers_the_merge_request_base() {
        let merge_request = fake(&[
            ("GITLAB_CI", "true"),
            ("CI_PIPELINE_SOURCE", "merge_request_event"),
            ("CI_MERGE_REQUEST_DIFF_BASE_SHA", "b4"),
            ("CI_COMMIT_SHA", "h3"),
        ]);

        assert_eq!(resolve_shas(&merge_request), shas("b4", "h3"));

        let branch = fake(&[
            ("GITLAB_CI", "true"),
            ("CI_PIPELINE_SOURCE", "merge_request_event"),
            ("CI_MERGE_REQUEST_TARGET_BRANCH_NAME", "dev"),
        ]);

        assert_eq!(resolve_shas(&branch), shas("origin/dev", "HEAD"));

        let push = fake(&[("GITLAB_CI", "true"), ("CI_COMMIT_BEFORE_SHA", ZERO_SHA), ("CI_DEFAULT_BRANCH", "trunk")]);

        assert_eq!(resolve_shas(&push), shas("origin/trunk", "HEAD"));
    }

    #[test]
    fn azure_buildkite_and_circle_resolve_a_target_branch() {
        let azure = fake(&[
            ("TF_BUILD", "True"),
            ("SYSTEM_PULLREQUEST_TARGETBRANCH", "refs/heads/dev"),
            ("BUILD_SOURCEVERSION", "s1"),
        ]);

        assert_eq!(resolve_shas(&azure), shas("origin/dev", "s1"));
        assert_eq!(resolve_shas(&fake(&[("TF_BUILD", "true")])), shas("origin/main", "HEAD"));
        assert_eq!(
            resolve_shas(&fake(&[("BUILDKITE", "true"), ("BUILDKITE_PULL_REQUEST_BASE_BRANCH", "dev")])),
            shas("origin/dev", "HEAD")
        );
        assert_eq!(resolve_shas(&fake(&[("CIRCLECI", "true"), ("CIRCLE_SHA1", "c1")])), shas("origin/main", "c1"));
    }

    /// `a` <- `b` <- `c` (c depends on b, b on a), `d` stands alone and `e` has only a dev edge to `a`.
    fn graph() -> ProjectGraph {
        let names = ["a", "b", "c", "d", "e"];
        let edge =
            |source: &str, target: &str, kind| Edge { source: source.to_owned(), target: target.to_owned(), kind };
        let mut dependencies: BTreeMap<String, Vec<Edge>> =
            names.iter().map(|name| ((*name).to_owned(), Vec::new())).collect();

        dependencies.insert("b".to_owned(), vec![edge("b", "a", EdgeKind::Static)]);
        dependencies.insert("c".to_owned(), vec![edge("c", "b", EdgeKind::PeerDependency)]);
        dependencies.insert("e".to_owned(), vec![edge("e", "a", EdgeKind::DevDependency)]);

        ProjectGraph {
            nodes: names
                .iter()
                .map(|name| ((*name).to_owned(), Node { name: (*name).to_owned(), project_type: ProjectType::Library }))
                .collect(),
            directories: names.iter().map(|name| ((*name).to_owned(), format!("packages/{name}"))).collect(),
            dependencies,
        }
    }

    fn selected(files: &[&str], downstream: Scope, upstream: Scope) -> Vec<String> {
        let files: Vec<String> = files.iter().map(|file| (*file).to_owned()).collect();

        affected_projects(&graph(), &files, downstream, upstream).into_iter().collect()
    }

    #[test]
    fn downstream_follows_every_edge_kind_and_scope() {
        assert_eq!(selected(&["packages/a/x.ts"], Scope::Deep, Scope::None), ["a", "b", "c", "e"]);
        assert_eq!(selected(&["packages/a/x.ts"], Scope::Direct, Scope::None), ["a", "b", "e"]);
        assert_eq!(selected(&["packages/a/x.ts"], Scope::None, Scope::None), ["a"]);
    }

    #[test]
    fn upstream_adds_dependencies() {
        assert_eq!(selected(&["packages/c/x.ts"], Scope::None, Scope::Deep), ["a", "b", "c"]);
        assert_eq!(selected(&["packages/c/x.ts"], Scope::None, Scope::Direct), ["b", "c"]);
    }

    #[test]
    fn a_file_outside_every_project_affects_all_and_a_prefix_is_not_a_root() {
        assert_eq!(selected(&["package.json"], Scope::None, Scope::None), ["a", "b", "c", "d", "e"]);
        assert_eq!(selected(&["packages/ab/x.ts"], Scope::None, Scope::None), ["a", "b", "c", "d", "e"]);
        assert!(selected(&[], Scope::Deep, Scope::None).is_empty());
        assert_eq!(selected(&["packages/d"], Scope::Deep, Scope::None), ["d"]);
    }

    #[test]
    fn a_project_json_at_the_root_or_in_a_project_is_left_to_node() {
        let root = env::temp_dir().join(format!("vis-affected-project-json-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        std::fs::create_dir_all(root.join("packages/a")).unwrap();

        let graph = graph();
        let mut at_a = graph.directories.clone();

        at_a.insert("a".to_owned(), "packages/a".to_owned());

        let single = ProjectGraph { directories: at_a, ..graph };

        assert!(!reads_project_json(&root, &single));

        std::fs::write(root.join("packages/a/project.json"), "{}").unwrap();

        assert!(reads_project_json(&root, &single));

        std::fs::remove_file(root.join("packages/a/project.json")).unwrap();
        std::fs::write(root.join("project.json"), "{}").unwrap();

        assert!(reads_project_json(&root, &single));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn renders_sorted_deduplicated_roots() {
        let graph = graph();
        let affected: BTreeSet<String> = ["c", "a"].iter().map(|name| (*name).to_owned()).collect();

        assert_eq!(render(&graph, &affected), "packages/a\npackages/c\n");
        assert_eq!(render(&graph, &BTreeSet::new()), "");
    }
}
