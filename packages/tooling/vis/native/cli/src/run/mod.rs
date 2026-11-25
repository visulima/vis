//! Native `vis run <target>` for a run in which every task is a local cache hit.
//!
//! Everything else is Node's. The native attempt reads the workspace, then keys each task and looks its key up in
//! the cache (the tasks side by side, a task's key reading only its own project's files and the global inputs) **before
//! it prints or writes anything**; the first thing that is not a clean hit
//! (a miss, a key it cannot reproduce, an entry that holds outputs, an expired entry, a stale install, a
//! toolchain pin that is not met, ...) hands the whole invocation to the Node CLI untouched. Only when every task hits
//! does it write `.vis/last-summary.json` and print what the Node static renderer prints for such a run.
//!
//! What the answer covers:
//!
//! * the invocation `run <target>` and nothing else: no flag, no further argument;
//! * a CI context (`CI` set, stderr and stdout not terminals), with the colour codes and the log grouping
//!   (GitHub Actions, GitLab CI, Buildkite, Azure Pipelines) the Node renderer prints for that environment;
//!   the Node version the summary records is the launcher's `process.version` (`VIS_NODE_VERSION`) when it started
//!   the binary, and otherwise the answer of `node --version` from the Node the run would be handed to;
//! * fewer than 1000 project directories and fewer than 1000 tasks (a bigger one is Node's before its files are read);
//! * a pnpm workspace of script-only JS projects (`targets::script_targets`), no `vis.config`, no
//!   `dependsOn`, default inputs, no outputs, no `cache: false`;
//! * a workspace whose startup preflights print nothing: no toolchain pin, or one that every pinned tool meets
//!   (`toolchain.rs`), a lockfile that is fresh against `node_modules`, no legacy task-runner directory, no run
//!   history.
//!
//! Output order: Node prints the lines of tasks that run side by side in the order they happen to finish.
//! This module prints them in a fixed order (project order, three tasks in flight like the default
//! `--parallel`). The set of lines is the same; the order of the interleaved lines may differ.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::{Duration, Instant, SystemTime};

use rayon::prelude::*;
use task_runner_core::{lookup_entry, CacheLookup, RunProject, TaskKey, TaskKeyer};

use crate::targets::{script_targets_below, Targets};
use crate::text::is_ascii_graphic;
use crate::toolchain::{self, Versions};

mod preflight;
mod render;
mod summary_json;

use preflight::{gates, lockfile_is_fresh, node_version_text, nothing_to_sweep, Gates};
use render::{layout_fits, Look};

/// Threads the workspace read, the keys and the lookups share. They are made of small file system calls that stop
/// scaling past a few threads (a 200-project workspace is answered faster on 4 threads than on 10, where the extra
/// threads wait on the file system or land on slow cores), so a many-core machine does not get more.
const MAX_THREADS: usize = 4;

/// A run of this many tasks or more is Node's: the summary line and the counts change layout.
const MAX_TASKS: usize = 1000;

/// Whether the arguments are `run <target>` with a plain target.
fn parse(args: &[String]) -> Option<&str> {
    let [command, target] = args else { return None };

    (command == "run" && is_target_word(target)).then_some(target.as_str())
}

/// A name that renders on one line and needs no escaping: printable ASCII, no space, not a flag.
fn is_target_word(text: &str) -> bool {
    !text.starts_with('-') && !text.is_empty() && is_ascii_graphic(text)
}

/// One task that hit, with the times its lookup took.
struct Hit {
    key: TaskKey,
    /// Position of the task in the task graph (project order).
    graph_index: usize,
    terminal_output: String,
    started: SystemTime,
    ended: SystemTime,
    milliseconds: u64,
}

/// The whole answer, built before anything is printed or written.
struct Answer {
    look: Look,
    hits: Vec<Hit>,
    target: String,
    started: SystemTime,
    ended: SystemTime,
    milliseconds: u64,
    arch: &'static str,
    platform: &'static str,
    node_version: String,
}

/// Sets the size of the thread pool the parallel parts below run on. The first call wins; a pool that already exists
/// (an earlier call, or `RAYON_NUM_THREADS` read by a library) is left as it is.
fn size_thread_pool() {
    let threads = std::thread::available_parallelism().map_or(1, std::num::NonZero::get).min(MAX_THREADS);

    let _ = rayon::ThreadPoolBuilder::new().num_threads(threads).build_global();
}

/// The key of every task, in project order, computed side by side. `None` for a key that cannot be reproduced.
fn keys_of(keyer: &TaskKeyer) -> Option<Vec<String>> {
    (0..keyer.tasks().len()).into_par_iter().map(|index| keyer.key(index).ok().map(|key| key.hash)).collect()
}

/// Keys each task and looks its key up, in project order in the result. Tasks depend on nothing in this shape, so a
/// task's key reads only its own project's files and the global inputs, and the tasks are independent: they are
/// worked on side by side and the first one that is not a clean hit stops the rest, which is `None`. Nothing
/// is printed or written before every task has hit.
fn look_up_all(keyer: &TaskKeyer, cache: &Path) -> Option<Vec<Hit>> {
    (0..keyer.tasks().len())
        .into_par_iter()
        .map(|graph_index| {
            let key = keyer.key(graph_index).ok()?;
            let lookup_started = SystemTime::now();
            let lookup_clock = Instant::now();
            let CacheLookup::Hit(entry) = lookup_entry(cache, &key.hash).ok()? else { return None };

            // A stored failure is a hit with exit 0 in Node; that is not reproduced.
            if entry.code != 0 {
                return None;
            }

            Some(Hit {
                key,
                graph_index,
                terminal_output: entry.terminal_output,
                started: lookup_started,
                ended: SystemTime::now(),
                milliseconds: lookup_clock.elapsed().as_millis() as u64,
            })
        })
        .collect()
}

/// Gives the tasks, in project order, the lookup times in the order the lookups began: the lookups ran side by side,
/// and the summary lists tasks by start time.
fn sort_times(hits: &mut [Hit]) {
    let mut times: Vec<(SystemTime, SystemTime, u64)> =
        hits.iter().map(|hit| (hit.started, hit.ended, hit.milliseconds)).collect();

    times.sort_by_key(|time| time.0);

    for (hit, (started, ended, milliseconds)) in hits.iter_mut().zip(times) {
        (hit.started, hit.ended, hit.milliseconds) = (started, ended, milliseconds);
    }
}

/// One run project for each project of the workspace, `None` when one of them is not a plain script project.
fn projects(root: &Path, target: &str) -> Option<Vec<RunProject>> {
    // A run of `MAX_TASKS` tasks is Node's, so a workspace with that many projects is too, before its manifests are read.
    let Targets::Native(workspace) = script_targets_below(root, MAX_TASKS) else { return None };
    let mut projects = Vec::new();

    for project in workspace {
        if !is_target_word(&project.name) {
            return None;
        }

        projects.push(RunProject {
            name: project.name,
            root: project.directory,
            script: project.targets.get(target).cloned(),
            ..Default::default()
        });
    }

    Some(projects)
}

/// Where the Node version of the summary comes from.
enum NodeVersion {
    /// `process.version` of the launcher that started the binary.
    Launcher(String),
    /// A start without the launcher asks the Node it would delegate to, with this command.
    Probe(PathBuf),
}

impl NodeVersion {
    fn launcher(&self) -> Option<&str> {
        match self {
            Self::Launcher(version) => Some(version),
            Self::Probe(_) => None,
        }
    }

    fn probe(&self) -> Option<&Path> {
        match self {
            Self::Launcher(_) => None,
            Self::Probe(command) => Some(command),
        }
    }
}

/// What the questions asked after the hits settled.
struct Probed {
    node_version: String,
    /// When the questions began, which is where the run ends.
    started: SystemTime,
    /// How long they took, which is not part of the run's duration.
    took: Duration,
}

/// Asks the pinned tools (and Node, for the summary) for their versions, which costs a process each, so it waits
/// until every task has hit; they are asked at the same time. Node asks before it starts the clock of the run, so the
/// time this takes is not part of the run's duration. Then checks that asking changed nothing the hits depended on.
fn probe_and_recheck(gates: &Gates, target: &str, projects: &[RunProject], hits: &[Hit]) -> Option<Probed> {
    let clock = Instant::now();
    let started = SystemTime::now();
    let pin_binaries = gates.pins.binaries()?;
    let node = match &gates.launcher_version {
        Some(version) => NodeVersion::Launcher(version.clone()),
        None => NodeVersion::Probe(toolchain::resolve_command(&crate::process::node_program().to_string_lossy())?),
    };
    let mut versions = Versions::with_launcher_node(env::var("VIS_NODE").ok().as_deref(), node.launcher());
    let wanted: Vec<PathBuf> = pin_binaries.iter().cloned().chain(node.probe().map(Path::to_path_buf)).collect();

    versions.fetch(&wanted);

    if !gates.pins.are_met(&pin_binaries, &mut versions) {
        return None;
    }

    // Node asks the pinned tools before it reads the lockfile and keys the tasks, and a tool may change files while
    // it answers (a pnpm that manages its own version records the pin in the lockfile the first time). The same
    // question here comes after the lookups, so the lockfile and the keys are checked again, and a run whose
    // answer moved them is Node's. Any executable asked after the hits can do that, the Node of a start without the
    // launcher included (a wrapper or a version manager's shim), so this does not depend on a pin.
    if !gates.pins.is_empty() || node.probe().is_some() {
        let again = TaskKeyer::new(gates.root.to_str()?, target, projects).ok()?;
        let keys = keys_of(&again)?;

        if !lockfile_is_fresh(&gates.root) || keys.iter().ne(hits.iter().map(|hit| &hit.key.hash)) {
            return None;
        }
    }

    let node_version = match node {
        NodeVersion::Launcher(version) => version,
        NodeVersion::Probe(command) => node_version_text(versions.output(&command)?.strip_suffix('\n')?)?,
    };

    Some(Probed { node_version, started, took: clock.elapsed() })
}

/// Reads the workspace, keys every task, and looks every key up. `None` means "Node answers".
fn attempt(args: &[String]) -> Option<Answer> {
    let started = SystemTime::now();
    let clock = Instant::now();
    let target = parse(args)?.to_owned();
    let gates = gates(args)?;

    size_thread_pool();

    let projects = projects(&gates.root, &target)?;
    let keyer = TaskKeyer::new(gates.root.to_str()?, &target, &projects).ok()?;
    let ids: Vec<&str> = keyer.tasks().iter().map(|task| task.id.as_str()).collect();

    // What the answer could not print is known before a file is read.
    if !ids.iter().all(|id| is_target_word(id)) || !layout_fits(&target, &ids) {
        return None;
    }

    let mut hits = look_up_all(&keyer, &gates.cache)?;

    sort_times(&mut hits);

    if !nothing_to_sweep(&gates.cache) {
        return None;
    }

    let probed = probe_and_recheck(&gates, &target, &projects, &hits)?;

    // The run ends where the questions began, which is after every task on this one timeline; a wall clock that was
    // set back in between must not put the end before a task's own end.
    let ended = hits.iter().map(|hit| hit.ended).fold(probed.started, SystemTime::max);
    let answer = Answer {
        look: gates.look,
        hits,
        target,
        started,
        ended,
        milliseconds: clock.elapsed().saturating_sub(probed.took).as_millis() as u64,
        arch: gates.arch,
        platform: gates.platform,
        node_version: probed.node_version,
    };

    answer.fits().then_some(answer)
}

/// Writes `.vis/last-summary.json` exactly where and how a hit run does.
fn write_summary(answer: &Answer) -> Option<()> {
    let directory = env::current_dir().ok()?.join(".vis");

    fs::create_dir_all(&directory).ok()?;
    fs::write(directory.join("last-summary.json"), answer.summary()?).ok()
}

/// The status a run is handed back with: `EX_TEMPFAIL`, which a launcher that is not waiting for it shows as a
/// failure and never as success. The launcher (`HANDBACK_STATUS` in `bin/vis.mjs`) names this same value.
const HANDBACK_STATUS: i32 = 75;

/// Leaves the run to Node, with nothing printed or written. A binary started by the JS launcher, which is
/// already a Node process, gets the run back instead of starting a second Node: the launcher names
/// [`HANDBACK_STATUS`] in `VIS_HANDBACK_STATUS` and runs the Node CLI in its own process when the binary exits
/// with it. Any other value, or a start without the launcher, has the binary start Node itself, so a forged
/// variable cannot make a run that did not happen exit as if it had.
fn leave_to_node(raw_args: &[OsString]) -> ! {
    if env::var("VIS_HANDBACK_STATUS").is_ok_and(|text| text.parse() == Ok(HANDBACK_STATUS)) {
        exit(HANDBACK_STATUS);
    }

    crate::process::delegate(raw_args)
}

/// Answers `vis run <target>` natively when every task hits, or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(answer) = attempt(args) else { leave_to_node(raw_args) };

    // The summary comes first: if it cannot be written, Node reports that (on stderr) and this run
    // has printed nothing.
    if write_summary(&answer).is_none() {
        leave_to_node(raw_args);
    }

    let mut stdout = std::io::stdout().lock();

    if stdout.write_all(answer.stdout().as_bytes()).and_then(|()| stdout.flush()).is_err() {
        exit(1);
    }

    exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn only_run_with_a_plain_target_is_parsed() {
        assert_eq!(parse(&argv(&["run", "build"])), Some("build"));
        assert_eq!(parse(&argv(&["run", "build:ci"])), Some("build:ci"));

        for shape in [
            &["run"][..],
            &["run", "build", "extra"],
            &["run", "--parallel=2"],
            &["run", "-x"],
            &["run", ""],
            &["run", "a b"],
            &["run", "bu\u{e9}"],
            &["list"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("vis-run-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");

        directory.canonicalize().expect("canonical")
    }

    /// A workspace of `count` projects with one source file each, and a cache holding an entry for every task.
    fn cached_workspace(name: &str, count: usize) -> (PathBuf, PathBuf, Vec<RunProject>) {
        let root = scratch(name);
        let cache = root.join("cache");
        let mut projects = Vec::new();

        fs::create_dir_all(&cache).expect("cache");

        for index in 0..count {
            let directory = format!("packages/p{index}");

            fs::create_dir_all(root.join(&directory).join("src")).expect("project");
            fs::write(root.join(&directory).join("package.json"), "{}").expect("manifest");
            fs::write(root.join(&directory).join("src/index.ts"), format!("export const v = {index};"))
                .expect("source");
            projects.push(RunProject {
                name: format!("p{index}"),
                root: directory,
                script: Some("true".to_owned()),
                ..Default::default()
            });
        }

        let keyer = TaskKeyer::new(root.to_str().expect("utf-8"), "build", &projects).expect("keyer");

        for index in 0..count {
            let entry = cache.join(keyer.key(index).expect("key").hash);

            fs::create_dir_all(&entry).expect("entry");
            fs::write(entry.join(".commit"), "").expect("commit");
            fs::write(entry.join("code"), "0").expect("code");
            fs::write(entry.join("terminalOutput"), format!("out {index}\n")).expect("output");
        }

        (root, cache, projects)
    }

    fn look_up(root: &Path, cache: &Path, projects: &[RunProject]) -> Option<Vec<Hit>> {
        look_up_all(&TaskKeyer::new(root.to_str().expect("utf-8"), "build", projects).expect("keyer"), cache)
    }

    #[test]
    fn every_hit_is_listed_in_project_order_with_its_own_output() {
        let (root, cache, projects) = cached_workspace("order", 60);
        let hits = look_up(&root, &cache, &projects).expect("every task hits");

        assert_eq!(hits.len(), 60);

        for (index, hit) in hits.iter().enumerate() {
            assert_eq!(hit.graph_index, index);
            assert_eq!(hit.key.id, format!("p{index}:build"));
            assert_eq!(hit.terminal_output, format!("out {index}\n"));
        }
    }

    #[test]
    fn one_task_that_is_not_a_clean_hit_gives_no_answer_wherever_it_is() {
        for position in [0, 1, 30, 58, 59] {
            let (root, cache, projects) = cached_workspace(&format!("miss-{position}"), 60);

            // A source change gives the project another key, with no entry.
            fs::write(root.join(format!("packages/p{position}/src/index.ts")), "changed").expect("edit");
            assert!(look_up(&root, &cache, &projects).is_none(), "changed source at {position}");

            fs::write(root.join(format!("packages/p{position}/src/index.ts")), format!("export const v = {position};"))
                .expect("restore");
            assert!(look_up(&root, &cache, &projects).is_some(), "restored source at {position}");

            let hash = TaskKeyer::new(root.to_str().expect("utf-8"), "build", &projects)
                .expect("keyer")
                .key(position)
                .expect("key")
                .hash;
            let entry = cache.join(&hash);

            fs::remove_file(entry.join(".commit")).expect("remove");
            assert!(look_up(&root, &cache, &projects).is_none(), "half written entry at {position}");
            fs::write(entry.join(".commit"), "").expect("commit");

            fs::write(entry.join("code"), "1").expect("code");
            assert!(look_up(&root, &cache, &projects).is_none(), "stored failure at {position}");
            fs::write(entry.join("code"), "0").expect("code");

            fs::write(entry.join("outputs-manifest.json"), "{}").expect("manifest");
            assert!(look_up(&root, &cache, &projects).is_none(), "entry with outputs at {position}");
            fs::remove_file(entry.join("outputs-manifest.json")).expect("remove");

            fs::remove_dir_all(&entry).expect("remove entry");
            assert!(look_up(&root, &cache, &projects).is_none(), "missing entry at {position}");
        }
    }

    #[test]
    fn a_project_without_input_files_gives_no_answer() {
        let (root, cache, projects) = cached_workspace("no-files", 8);

        fs::remove_dir_all(root.join("packages/p5")).expect("remove");
        fs::create_dir_all(root.join("packages/p5")).expect("recreate");
        fs::write(root.join("packages/p5/.hidden"), "x").expect("hidden");

        assert!(look_up(&root, &cache, &projects).is_none());
    }

    #[test]
    fn the_lookup_times_run_in_start_order_along_project_order() {
        let (root, cache, projects) = cached_workspace("times", 40);
        let mut hits = look_up(&root, &cache, &projects).expect("every task hits");

        // Lookups that ran side by side finish in any order.
        hits.reverse();
        hits.sort_by_key(|hit| hit.graph_index);

        let before: Vec<SystemTime> = hits.iter().map(|hit| hit.started).collect();

        sort_times(&mut hits);

        assert!(hits.windows(2).all(|pair| pair[0].started <= pair[1].started));
        assert_eq!(hits.iter().map(|hit| hit.graph_index).collect::<Vec<_>>(), (0..40).collect::<Vec<_>>());
        assert!(hits.iter().all(|hit| hit.ended >= hit.started));

        let mut sorted = before;

        sorted.sort();

        assert_eq!(hits.iter().map(|hit| hit.started).collect::<Vec<_>>(), sorted);
    }

    #[test]
    fn the_summary_is_written_like_json_stringify_with_the_hits_in_project_order() {
        let (root, cache, projects) = cached_workspace("summary", 3);
        let hits = look_up(&root, &cache, &projects).expect("every task hits");
        let now = SystemTime::now();
        let answer = Answer {
            look: Look { colour: false, grouping: render::Grouping::Separators },
            hits,
            target: "build".to_owned(),
            started: now,
            ended: now,
            milliseconds: 12,
            arch: "arm64",
            platform: "darwin",
            node_version: "v22.0.0".to_owned(),
        };
        let text = answer.summary().expect("a run id");
        let value: serde_json::Value = serde_json::from_str(&text).expect("JSON");

        // `JSON.stringify(value, undefined, 2)`: two spaces, `[]` for an empty array, no trailing newline.
        assert!(text.starts_with("{\n  \"duration\": 12,\n  \"endTime\": \""));
        assert!(text.contains("      \"dependencies\": [],\n"));
        assert!(text.contains("\n    \"roots\": [\n      \"p0:build\","));
        assert!(text.ends_with("\n}"));
        assert_eq!(value["stats"]["cached"], 3);
        assert_eq!(value["taskGraph"]["roots"], serde_json::json!(["p0:build", "p1:build", "p2:build"]));
        assert_eq!(value["tasks"].as_array().map(Vec::len), Some(3));
        assert_eq!(value["tasks"][0]["hashDetails"]["layout"], 2);
        assert_eq!(value["tasks"][0]["target"]["project"], "p0");
    }
}
