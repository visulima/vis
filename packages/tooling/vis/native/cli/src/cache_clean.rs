//! `vis cache clean [--type <store>] [--cache-dir <dir>] [--dry-run] [--force]` — the native fast path.
//!
//! Mirrors `runClean` and `cacheCleanExecute` in `src/commands/cache/{clean,handler}.ts`: the workspace task cache
//! (the shared directory, since `clean` takes no `--scope`) and the four per-user stores under `~/.vis/cache`
//! (AI responses, Socket.dev reports, deps.dev records, Snyk records). The binary answers only what it can
//! reproduce byte for byte, with the same files left on disk, and hands everything else to Node before it prints or
//! removes anything (a removal that fails despite the checks is the one exception, see [`run`]):
//!
//! - the flags of [`parse`], each once, with a known `--type`;
//! - the quiet context of the cache commands, without a terminal on stdout, stderr or (for the confirmation case)
//!   stdin, with a layout pail's header can be reproduced for ([`Layout::detect`]) and printable ASCII paths;
//! - a task cache that is only deleted at the default location (`<root>/node_modules/.cache/vis`, which a linked
//!   worktree resolves to the main checkout), never a directory that holds the working directory, the workspace root
//!   or `HOME`, and only when this process can remove the whole tree. `--dry-run`, the refusals and the stores work
//!   with any directory;
//! - the stores' `.json` files being plain files in directories this process can write to; a directory named
//!   `x.json`, a store that is not a directory or a failing read is the warning path of Node's `*Safe` functions,
//!   which stays Node's.
//!
//! The confirmation prompt of an out-of-workspace cache needs a terminal on stdin, so only its non-interactive
//! refusal ("without --force (stdin is not a TTY)") is native.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::exit;

use crate::cache::{
    add_safe, collect_entries, eviction_directories, format_bytes, has_backslash, quiet_workspace_root, read_settings,
    resolve, resolve_cache_directory, store_directories, store_stats, vis_cache_dir, Target,
};
use crate::node_context::output_settings_are_default;
use crate::output::write_streams;
use crate::pail::{plain, Layout, Level};
use crate::removal::{removable_directory, removable_file};

/// What the user asked for.
struct Request {
    cache_dir: Option<String>,
    target: Target,
    dry_run: bool,
    force: bool,
}

/// What one run prints, split the way pail splits it, and the exit status.
#[derive(Default)]
struct Output {
    stdout: String,
    stderr: String,
    code: i32,
}

/// A removal decided before anything is printed.
enum Removal {
    /// A task cache. Inside the workspace Node clears it with `Cache.clear`, which swallows a failure; outside it
    /// (`--force`) a plain `rm` throws.
    Tree { path: PathBuf, inside_workspace: bool },
    /// The `.json` files of a store, which Node removes one by one and warns about the first failure.
    Files(Vec<PathBuf>),
}

struct Plan {
    output: Output,
    removals: Vec<Removal>,
}

/// `(target, noun)` of each per-user store: "cached <noun>(s)".
const STORES: [(Target, &str); 4] = [
    (Target::Ai, "AI response"),
    (Target::Socket, "Socket.dev report"),
    (Target::DepsDev, "deps.dev record"),
    (Target::Snyk, "Snyk record"),
];

/// Answer `vis cache clean` natively, or delegate to Node. Never returns.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let Some(plan) = plan(args) else {
        crate::process::delegate(raw);
    };

    // A failure that Node reports (an error or a warning with its own wording) is Node's to report: the run goes
    // there, and it meets the same entry again. One that Node swallows is not an error. What Node prints for the
    // sections that finished before the failure is not reproduced then, because they are done by the time it runs.
    let mut reported_failure = false;

    for removal in &plan.removals {
        match removal {
            Removal::Tree { path, inside_workspace } => {
                if fs::remove_dir_all(path).is_err() && !inside_workspace {
                    // The `rm` throws, which ends Node's run before it reaches the stores.
                    reported_failure = true;

                    break;
                }
            }
            Removal::Files(files) => {
                // `rmSync` throws at the first file it cannot remove and leaves the rest.
                if files.iter().any(|file| fs::remove_file(file).is_err()) {
                    reported_failure = true;
                }
            }
        }
    }

    if reported_failure {
        crate::process::delegate(raw);
    }

    write_streams("cache clean", &plan.output.stdout, &plan.output.stderr);

    exit(plan.output.code)
}

/// Parses the arguments after `cache clean`, or `None` for a shape that is Node's.
fn parse(args: &[String]) -> Option<Request> {
    if args.get(1).map(String::as_str) != Some("clean") {
        return None;
    }

    let (mut cache_dir, mut target): (Option<&str>, Option<&str>) = (None, None);
    let (mut dry_run, mut force) = (false, false);
    let mut tokens = args.iter().skip(2);

    while let Some(token) = tokens.next() {
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (token.as_str(), None),
        };

        let slot = match (name, inline) {
            ("--dry-run", None) if !dry_run => {
                dry_run = true;

                continue;
            }
            ("--force", None) if !force => {
                force = true;

                continue;
            }
            ("--cache-dir", _) => &mut cache_dir,
            ("--type", _) => &mut target,
            _ => return None,
        };

        let value = match inline {
            Some(value) => value,
            None => tokens.next()?.as_str(),
        };

        // An empty or dash-led value is cerebro's to interpret, and a repeated flag is an array there.
        if slot.is_some() || value.is_empty() || value.starts_with('-') {
            return None;
        }

        *slot = Some(value);
    }

    Some(Request {
        cache_dir: cache_dir.map(str::to_owned),
        target: match target {
            None | Some("all") => Target::All,
            Some("task") => Target::Task,
            Some("ai") => Target::Ai,
            Some("socket") => Target::Socket,
            Some("deps-dev") => Target::DepsDev,
            Some("snyk") => Target::Snyk,
            Some(_) => return None,
        },
        dry_run,
        force,
    })
}

/// The plan when the invocation is native, or `None` to delegate.
fn plan(args: &[String]) -> Option<Plan> {
    let request = parse(args)?;
    let cwd = env::current_dir().ok()?;
    let root = quiet_workspace_root(&cwd)?;

    if io::stdout().is_terminal() || !output_settings_are_default() {
        return None;
    }

    let layout = Layout::detect(args)?;
    let mut plan = Plan { output: Output::default(), removals: Vec::new() };

    // Read for every target: a config that has to be evaluated is Node's whichever store is cleared.
    let settings = read_settings(&cwd, &root)?;

    if request.target.includes(Target::Task) {
        let directory = resolve_cache_directory(
            &root,
            request.cache_dir.as_deref(),
            settings.cache_directory.as_deref(),
            settings.shared_worktree,
        )?;

        task_cache(&request, &directory, &cwd, &root, layout, &mut plan)?;
    }

    let stores: Vec<_> = STORES.iter().filter(|(target, _)| request.target.includes(*target)).collect();

    if !stores.is_empty() {
        let home_cache = vis_cache_dir()?;

        for (target, noun) in stores {
            store(&request, *target, noun, &home_cache, layout, &mut plan)?;
        }
    }

    Some(plan)
}

/// One pail block, on the stream pail prints its level on.
fn say(layout: Layout, output: &mut Output, level: Level, message: &str) {
    let buffer = if level.to_stderr() { &mut output.stderr } else { &mut output.stdout };

    buffer.push_str(&layout.block(level, message));
}

/// `isCacheDirectoryInsideWorkspace`: a proper descendant of the root, both normalised the way `@visulima/path` does.
fn inside_workspace(directory: &str, root: &str) -> bool {
    let directory = resolve(directory, &[]);

    directory != root && directory.starts_with(&format!("{root}/"))
}

/// Whether `directory` is, or is an ancestor of, one of `places` (symbolic links resolved where they can be).
fn holds_any(directory: &Path, places: &[&Path]) -> bool {
    places
        .iter()
        .any(|place| place.starts_with(directory) || place.canonicalize().is_ok_and(|real| real.starts_with(directory)))
}

/// A cache directory of the default shape, which is all this module deletes.
fn default_location(directory: &str) -> bool {
    resolve(directory, &[]).ends_with("/node_modules/.cache/vis")
}

/// `runClean` for one directory of the task cache.
fn task_cache(
    request: &Request,
    directory: &str,
    cwd: &Path,
    root: &Path,
    layout: Layout,
    plan: &mut Plan,
) -> Option<()> {
    let root_text = root.to_str()?;

    if !plain(directory) || !plain(root_text) {
        return None;
    }

    if fs::metadata(directory).is_err() {
        say(layout, &mut plan.output, Level::Info, &format!("No cache directory to clean at {directory}"));

        return Some(());
    }

    if request.dry_run {
        // `evictionDirectories(directory, true)`: the base and every branch subtree.
        let mut count: usize = 0;
        let mut bytes: u64 = 0;

        for entries_directory in eviction_directories(directory, true, false)? {
            let entries = collect_entries(&entries_directory)?;

            count += entries.len();
            bytes = entries.iter().try_fold(bytes, |total, entry| add_safe(total, entry.size))?;
        }

        let noun = if count == 1 { "y" } else { "ies" };

        say(
            layout,
            &mut plan.output,
            Level::Info,
            &format!("Would remove {count} cache entr{noun} ({}) from {directory}", format_bytes(bytes)?),
        );

        return Some(());
    }

    // A path that cannot be resolved is skipped by Node, which then goes on to the deletion.
    if let (Ok(cache), Ok(workspace)) = (fs::canonicalize(directory), fs::canonicalize(root)) {
        if cache == workspace {
            say(
                layout,
                &mut plan.output,
                Level::Error,
                "Refusing to delete the workspace root. The cache directory resolved to the same path as the workspace.",
            );
            plan.output.code = 1;

            return Some(());
        }
    }

    if !inside_workspace(directory, root_text) && !request.force {
        say(
            layout,
            &mut plan.output,
            Level::Warning,
            &format!("Cache directory is outside the workspace root: {directory}"),
        );
        say(
            layout,
            &mut plan.output,
            Level::Warning,
            "This will recursively delete the entire directory, including anything stored there by other tools.",
        );

        // With a terminal on stdin Node asks for a confirmation.
        if io::stdin().is_terminal() {
            return None;
        }

        say(
            layout,
            &mut plan.output,
            Level::Error,
            "Refusing to clean an out-of-workspace cache without --force (stdin is not a TTY).",
        );
        plan.output.code = 1;

        return Some(());
    }

    let target = Path::new(directory);
    let home = env::var_os("HOME").map(PathBuf::from);

    // Only the default location is deleted, and never a directory that holds the place the command runs from.
    if !default_location(directory) || holds_any(target, &[cwd, root, home.as_deref().unwrap_or(root)]) {
        return None;
    }

    if !removable_directory(target, target.parent()?) {
        return None;
    }

    plan.removals
        .push(Removal::Tree { path: target.to_path_buf(), inside_workspace: inside_workspace(directory, root_text) });
    say(layout, &mut plan.output, Level::Success, &format!("Cleared cache: {directory}"));

    Some(())
}

/// The clear or the preview of one per-user store.
fn store(
    request: &Request,
    target: Target,
    noun: &str,
    home_cache: &str,
    layout: Layout,
    plan: &mut Plan,
) -> Option<()> {
    let directories = store_directories(target, home_cache);

    if request.dry_run {
        let count = store_stats(&directories)?.entries;

        say(layout, &mut plan.output, Level::Info, &format!("Would clear {count} cached {noun}{}.", plural(count)));

        return Some(());
    }

    let mut files: Vec<PathBuf> = Vec::new();

    for directory in &directories {
        let Ok(metadata) = fs::metadata(directory) else {
            continue;
        };

        if !metadata.is_dir() {
            return None;
        }

        let before = files.len();

        for entry in fs::read_dir(directory).ok()? {
            let entry = entry.ok()?;
            let name = entry.file_name();

            if !name.as_encoded_bytes().ends_with(b".json") {
                continue;
            }

            // A name that is not UTF-8 reaches `rmSync` mangled, and a directory fails it.
            name.to_str()?;

            if has_backslash(&name) || entry.file_type().ok()?.is_dir() {
                return None;
            }

            files.push(entry.path());
        }

        if files[before..].iter().any(|file| !removable_file(file, Path::new(directory))) {
            return None;
        }
    }

    let count = files.len() as u64;

    if count > 0 {
        say(layout, &mut plan.output, Level::Info, &format!("Cleared {count} cached {noun}{}.", plural(count)));
        plan.removals.push(Removal::Files(files));
    }

    Some(())
}

fn plural(count: u64) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|argument| (*argument).to_owned()).collect()
    }

    #[test]
    fn parses_the_flags_it_answers() {
        let request =
            parse(&argv(&["cache", "clean", "--dry-run", "--type=task", "--cache-dir", "x", "--force"])).unwrap();

        assert!(request.dry_run && request.force);
        assert!(request.target == Target::Task);
        assert_eq!(request.cache_dir.as_deref(), Some("x"));
        assert!(parse(&argv(&["cache", "clean"])).unwrap().target == Target::All);
    }

    #[test]
    fn declines_every_other_shape() {
        for shape in [
            &["cache", "clean", "--dry-run", "--dry-run"][..],
            &["cache", "clean", "--dry-run=true"],
            &["cache", "clean", "--type", "bogus"],
            &["cache", "clean", "--type"],
            &["cache", "clean", "--type", "ai", "--type", "snyk"],
            &["cache", "clean", "--scope", "all"],
            &["cache", "clean", "extra"],
            &["cache", "clean", "--cache-dir", ""],
            &["cache", "clean", "--cache-dir", "--force"],
        ] {
            assert!(parse(&argv(shape)).is_none(), "{shape:?}");
        }
    }

    #[test]
    fn a_directory_is_inside_only_below_the_root() {
        assert!(inside_workspace("/w/node_modules/.cache/vis", "/w"));
        assert!(!inside_workspace("/w", "/w"));
        assert!(!inside_workspace("/w/../x", "/w"));
        assert!(!inside_workspace("/other/node_modules/.cache/vis", "/w"));
        assert!(!inside_workspace("/wx", "/w"));
    }

    #[test]
    fn a_directory_that_holds_a_place_the_command_runs_from_is_never_deleted() {
        assert!(holds_any(Path::new("/w/node_modules/.cache/vis"), &[Path::new("/w/node_modules/.cache/vis/x")]));
        assert!(holds_any(Path::new("/w"), &[Path::new("/w/node_modules")]));
        assert!(!holds_any(
            Path::new("/w/node_modules/.cache/vis"),
            &[Path::new("/w/packages/app"), Path::new("/home/u")]
        ));
    }

    #[test]
    fn only_the_default_location_is_deleted() {
        assert!(default_location("/main/node_modules/.cache/vis"));
        assert!(default_location("/main/node_modules/.cache/vis/"));
        assert!(!default_location("/main/node_modules"));
        assert!(!default_location("/main/custom"));
    }
}
