//! Native `vis cache list` and `vis cache size`: read-only inspection of the cache stores.
//!
//! Mirrors `src/commands/cache/{handler,context,entries,list,size}.ts`, the directory resolution of
//! `src/cache/cache-directory.ts` and the store paths of `src/util/vis-paths.ts`. The binary answers only
//! what it can reproduce byte for byte and hands everything else to Node:
//!
//! - flags: `--cache-dir`, `--scope`, `--format` (both commands) and `--type` (`size`), each once, with
//!   a value Node does not rewrite (`shared|worktree|all`, `table|json`, a known store). An unknown value
//!   makes Node warn through pail, so it is Node's;
//! - the workspace root is the pnpm root [`monorepo_root`] finds, with CI set and a quiet stderr. A
//!   `vis.config.*` is read only at that root, and only as a literal (see [`read_settings`]);
//! - output that Node frames with pail (a missing or empty cache directory in table form, the `# <dir>`
//!   header of a multi-directory listing) is Node's, because pail prints a clock. The JSON forms have no
//!   pail output and stay native, except the multi-directory `list`, whose header goes to stdout.
//!
//! Every read and decision runs before the first byte is written, so a delegation never follows output.

use std::cmp::Ordering;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use vis_core::date::iso_from_millis;

use crate::js::{js_number, json_string, MAX_SAFE_INTEGER};
use crate::node_context::{any_ancestor_has, in_ci, monorepo_root, DENO_FILES};
use crate::vis_config::{self, ConfigState};

/// `DEFAULT_WORKSPACE_CACHE_DIRECTORY` in `src/util/vis-paths.ts`.
const DEFAULT_CACHE_DIRECTORY: &str = "node_modules/.cache/vis";

/// `BRANCH_SCOPE_DIRECTORY` in `src/commands/cache/entries.ts`.
const BRANCH_SCOPE_DIRECTORY: &str = "branches";

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Table,
    Json,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Scope {
    Shared,
    Worktree,
    All,
}

/// `CacheTarget` in `context.ts`.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Target {
    All,
    Task,
    Ai,
    Socket,
    DepsDev,
    Snyk,
}

impl Target {
    pub(crate) fn includes(self, kind: Target) -> bool {
        self == Target::All || self == kind
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Subcommand {
    List,
    Size,
}

struct Options {
    command: Subcommand,
    cache_dir: Option<String>,
    format: Format,
    scope: Scope,
    target: Target,
}

/// Parses the arguments after `cache`. `None` for any shape Node must answer.
fn parse(args: &[String]) -> Option<Options> {
    let command = match args.get(1).map(String::as_str) {
        Some("list") => Subcommand::List,
        Some("size") => Subcommand::Size,
        _ => return None,
    };

    let (mut cache_dir, mut format, mut scope, mut target): (Option<&str>, Option<&str>, Option<&str>, Option<&str>) =
        (None, None, None, None);
    let mut tokens = args.iter().skip(2);

    while let Some(token) = tokens.next() {
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (token.as_str(), None),
        };

        let slot = match name {
            "--cache-dir" => &mut cache_dir,
            "--format" => &mut format,
            "--scope" => &mut scope,
            "--type" if command == Subcommand::Size => &mut target,
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

    Some(Options {
        command,
        cache_dir: cache_dir.map(str::to_owned),
        format: match format {
            None | Some("table") => Format::Table,
            Some("json") => Format::Json,
            Some(_) => return None,
        },
        scope: match scope {
            None | Some("shared") => Scope::Shared,
            Some("worktree") => Scope::Worktree,
            Some("all") => Scope::All,
            Some(_) => return None,
        },
        target: match target {
            None | Some("all") => Target::All,
            Some("task") => Target::Task,
            Some("ai") => Target::Ai,
            Some("socket") => Target::Socket,
            Some("deps-dev") => Target::DepsDev,
            Some("snyk") => Target::Snyk,
            Some(_) => return None,
        },
    })
}

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

// ---------------------------------------------------------------------------------------------
// Paths: `@visulima/path` semantics for the plain POSIX paths this module accepts.
// ---------------------------------------------------------------------------------------------

/// Whether `@visulima/path` treats `path` like a plain POSIX path: no separators it rewrites, no drive
/// letter, no UNC form. Anything else is Node's.
pub(crate) fn is_plain(path: &str) -> bool {
    let drive = path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && path.as_bytes().get(1) == Some(&b':');

    !path.contains(['\\', '\0']) && !path.starts_with("//") && !drive
}

/// `resolve(base, ...)` on POSIX for an absolute `base`: joins, then drops `.`, empty and resolved `..`.
pub(crate) fn resolve(base: &str, relative: &[&str]) -> String {
    let mut parts: Vec<&str> = Vec::new();

    for segment in std::iter::once(base).chain(relative.iter().copied()).flat_map(|text| text.split('/')) {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }

    format!("/{}", parts.join("/"))
}

/// `resolveCacheDirectory`: an absolute value is returned as written, a relative one is resolved.
fn normalize(root: &str, value: &str) -> Option<String> {
    if !is_plain(value) {
        return None;
    }

    Some(if value.starts_with('/') { value.to_owned() } else { resolve(root, &[value]) })
}

/// `resolveSharedCacheDirectory`.
pub(crate) fn resolve_cache_directory(
    root: &Path,
    option: Option<&str>,
    config: Option<&str>,
    shared: bool,
) -> Option<String> {
    let root_text = root.to_str().filter(|text| is_plain(text))?;
    let env_value = match env::var("VIS_CACHE_DIRECTORY") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => return None,
    };

    let explicit = option.or(config).or(env_value.as_deref());

    if explicit.is_some_and(|value| !value.is_empty()) {
        let chosen = [option, config, env_value.as_deref()].into_iter().flatten().find(|value| !value.is_empty())?;

        return normalize(root_text, chosen);
    }

    let anchor = if shared {
        task_runner_core::get_main_worktree_root(root.to_str()?).ok().flatten().map(PathBuf::from)
    } else {
        None
    };
    let anchor_text = match &anchor {
        Some(path) => path.to_str().filter(|text| is_plain(text) && text.starts_with('/'))?,
        None => root_text,
    };

    Some(resolve(anchor_text, &[DEFAULT_CACHE_DIRECTORY]))
}

/// `sanitizeBranchSegment`.
fn branch_slug(branch: &str) -> String {
    let mut slug = String::new();
    let mut in_run = false;

    for character in branch.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
            slug.push(character);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }

    // Every character left is ASCII, so bytes and UTF-16 units agree.
    let mut slug = slug.trim_matches('-').to_owned();

    slug.truncate(64);

    slug
}

/// `detectGitBranch`: the same `git` call, with its failures as `None`.
fn detect_git_branch(cwd: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_owned();

    (!branch.is_empty() && branch != "HEAD").then_some(branch)
}

/// `applyBranchScope`.
fn apply_branch_scope(directory: String, root: &Path, enabled: bool) -> String {
    if !enabled {
        return directory;
    }

    let Some(branch) = detect_git_branch(root) else {
        return directory;
    };

    let slug = branch_slug(&branch);

    if slug.is_empty() {
        return directory;
    }

    resolve(&directory, &[BRANCH_SCOPE_DIRECTORY, &slug])
}

/// `hasUnscopedEntries`: a directory entry (a symlink does not count) outside the branch container.
fn has_unscoped_entries(base: &str) -> bool {
    if fs::metadata(base).is_err() {
        return false;
    }

    let Ok(entries) = fs::read_dir(base) else {
        return false;
    };

    // A failing entry makes Node's `readdirSync` throw, which its `catch` turns into `false`.
    let mut found = false;

    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };

        let name = entry.file_name();

        if entry.file_type().is_ok_and(|kind| kind.is_dir())
            && !name.as_encoded_bytes().starts_with(b".")
            && name != BRANCH_SCOPE_DIRECTORY
        {
            found = true;
        }
    }

    found
}

/// The path Node lists for the branch directory at `path`: `Ok(Some(path))` for a UTF-8 name, `Ok(None)` for one
/// that is not (Node reads the mangled path as an empty directory, which adds nothing to a count), and `Err(())`
/// for one that is not when the command prints a block for each directory (`cache prune` names the mangled path
/// in it, which is not reproduced).
#[cfg(unix)]
fn branch_directory(path: &Path, per_directory_output: bool) -> Result<Option<String>, ()> {
    match path.to_str() {
        Some(text) => Ok(Some(text.to_owned())),
        None if per_directory_output => Err(()),
        None => Ok(None),
    }
}

/// `evictionDirectories`: `base` and, when branch scoping applies, the subtree of every branch. `None` when a
/// branch directory has a name `@visulima/path` would rewrite, or (with `per_directory_output`, for a command that
/// prints a block for each directory) a name that is not UTF-8.
#[cfg(unix)]
pub(crate) fn eviction_directories(base: &str, branch_scoped: bool, per_directory_output: bool) -> Option<Vec<String>> {
    let mut directories = vec![base.to_owned()];

    if !branch_scoped {
        return Some(directories);
    }

    let branches = resolve(base, &[BRANCH_SCOPE_DIRECTORY]);

    if fs::metadata(&branches).is_err() {
        return Some(directories);
    }

    // A failing read makes Node's `readdirSync` throw, which its `catch` turns into the base alone.
    let Some(entries) = sorted_entries(Path::new(&branches)) else {
        return Some(directories);
    };

    for entry in entries.iter().filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir())) {
        if has_backslash(&entry.file_name()) {
            return None;
        }

        // A name that is not UTF-8 reaches Node mangled, and the directory it names reads as empty.
        if let Some(path) = branch_directory(&entry.path(), per_directory_output).ok()? {
            directories.push(path);
        }
    }

    Some(directories)
}

/// The `(base, branch-scoped)` directory of each scope `scope` selects, as `resolveCacheDirectoryFromContext` pairs them.
fn selected_directories(
    root: &Path,
    cache_dir: Option<&str>,
    scope: Scope,
    settings: &Settings,
) -> Option<Vec<(String, String)>> {
    let config = settings.cache_directory.as_deref();

    let worktree_base = resolve_cache_directory(root, cache_dir, config, false)?;
    let shared_base = resolve_cache_directory(root, cache_dir, config, settings.shared_worktree)?;
    let worktree_scoped = apply_branch_scope(worktree_base.clone(), root, settings.branch_scoped);
    let shared_scoped = apply_branch_scope(shared_base.clone(), root, settings.branch_scoped);

    Some(match scope {
        Scope::All if shared_scoped == worktree_scoped => vec![(shared_base, shared_scoped)],
        Scope::All => vec![(shared_base, shared_scoped), (worktree_base, worktree_scoped)],
        Scope::Worktree => vec![(worktree_base, worktree_scoped)],
        Scope::Shared => vec![(shared_base, shared_scoped)],
    })
}

/// `directoriesFor("evict")`: retention sees every branch's entries, so each selected base is expanded to the
/// base and its branch subtrees.
#[cfg(unix)]
pub(crate) fn evict_directories(
    root: &Path,
    cache_dir: Option<&str>,
    scope: Scope,
    settings: &Settings,
) -> Option<Vec<String>> {
    let mut directories: Vec<String> = Vec::new();

    for (base, _) in selected_directories(root, cache_dir, scope, settings)? {
        for directory in eviction_directories(&base, settings.branch_scoped, true)? {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        }
    }

    Some(directories)
}

/// `directoriesFor("read")` of `resolveCacheDirectoryFromContext`.
fn read_directories(root: &Path, options: &Options, settings: &Settings) -> Option<Vec<String>> {
    let selected = selected_directories(root, options.cache_dir.as_deref(), options.scope, settings)?;

    let mut directories: Vec<String> = Vec::new();

    for (base, scoped) in selected {
        let mut add = |directory: String| {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        };

        if scoped != base && has_unscoped_entries(&base) {
            add(scoped);
            add(base);
        } else {
            add(scoped);
        }
    }

    Some(directories)
}

// ---------------------------------------------------------------------------------------------
// Entries.
// ---------------------------------------------------------------------------------------------

pub(crate) struct Entry {
    pub(crate) hash: String,
    pub(crate) mtime_ms: f64,
    pub(crate) size: u64,
}

/// `Stats.mtimeMs`: seconds and nanoseconds combined in floating point.
#[cfg(unix)]
pub(crate) fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;

    metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1e6
}

#[cfg(not(unix))]
pub(crate) fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

/// Directory entries in the order `fs.readdir` returns them (libuv sorts by name, bytewise).
pub(crate) fn sorted_entries(directory: &Path) -> Option<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(directory).ok()?.collect::<Result<Vec<_>, _>>().ok()?;

    entries.sort_by(|a, b| a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes()));

    Some(entries)
}

/// `a + b`, or `None` once the sum is one a JavaScript number would round: Node adds sizes as JavaScript numbers, which
/// are exact only up to `Number.MAX_SAFE_INTEGER`.
pub(crate) fn add_safe(a: u64, b: u64) -> Option<u64> {
    a.checked_add(b).filter(|sum| *sum <= MAX_SAFE_INTEGER)
}

/// The summed size of `entries`, or `None` when Node's number would round it.
fn total_size(entries: &[Entry]) -> Option<u64> {
    entries.iter().try_fold(0, |total, entry| add_safe(total, entry.size))
}

/// Whether `@visulima/path` would read a backslash in `name` as a separator: Node joins every name it
/// reads, so a path it builds from such a name is not the one on disk.
pub(crate) fn has_backslash(name: &OsStr) -> bool {
    name.as_encoded_bytes().contains(&b'\\')
}

/// `sumDirectorySize`: files counted by `stat`, symlinks skipped, and a failure ends that directory's
/// loop while keeping what it already added. `None` when Node would not print the same number: a name
/// with a backslash, or a size past what a JavaScript number holds exactly.
pub(crate) fn sum_directory_size(directory: &Path) -> Option<u64> {
    let Some(entries) = sorted_entries(directory) else {
        return Some(0);
    };

    let mut total = 0;

    for entry in entries {
        let Ok(kind) = entry.file_type() else {
            break;
        };

        let name = entry.file_name();

        if has_backslash(&name) {
            return None;
        }

        // Node reads the name as UTF-8 with replacement characters, so a path it builds from a name
        // that is not UTF-8 names nothing: the directory below it reads as empty and a file fails.
        let utf8 = name.to_str().is_some();

        if kind.is_dir() {
            if utf8 {
                total = add_safe(total, sum_directory_size(&entry.path())?)?;
            }
        } else if kind.is_file() {
            match fs::metadata(entry.path()) {
                Ok(metadata) if utf8 => total = add_safe(total, metadata.len())?,
                _ => break,
            }
        }
    }

    Some(total)
}

/// `collectCacheEntries`, newest first. `None` when a name or a size needs Node's own handling.
pub(crate) fn collect_entries(directory: &str) -> Option<Vec<Entry>> {
    let Some(names) = sorted_entries(Path::new(directory)) else {
        return Some(Vec::new());
    };

    let mut entries = Vec::new();

    for entry in names {
        let name = entry.file_name();

        if name.as_encoded_bytes().starts_with(b".") || name == BRANCH_SCOPE_DIRECTORY {
            continue;
        }

        if has_backslash(&name) {
            return None;
        }

        // A name that is not UTF-8 cannot be stat-ed by the path Node builds from it: the entry is dropped.
        let Some(hash) = name.to_str() else {
            continue;
        };

        if !hash.is_ascii() {
            return None;
        }

        let Ok(metadata) = fs::metadata(entry.path()) else {
            continue;
        };

        if !metadata.is_dir() {
            continue;
        }

        entries.push(Entry {
            hash: hash.to_owned(),
            mtime_ms: mtime_ms(&metadata),
            size: sum_directory_size(&entry.path())?,
        });
    }

    // `entries.sort((a, b) => b.mtimeMs - a.mtimeMs)`: stable, so equal times keep name order.
    entries.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(Ordering::Equal));

    Some(entries)
}

/// `AuxStats` without the directory.
#[derive(Default)]
pub(crate) struct Stats {
    pub(crate) entries: u64,
    newest: Option<f64>,
    oldest: Option<f64>,
    total: u64,
}

/// The `getCacheStats` shared by the AI, Socket.dev, deps.dev and Snyk stores: the `.json` files of
/// each directory. `None` when Node would throw (an unreadable directory, a file that cannot be stat-ed).
pub(crate) fn store_stats(directories: &[PathBuf]) -> Option<Stats> {
    let mut stats = Stats::default();

    for directory in directories {
        if fs::metadata(directory).is_err() {
            continue;
        }

        for entry in fs::read_dir(directory).ok()? {
            let name = entry.ok()?.file_name();

            if !name.as_encoded_bytes().ends_with(b".json") {
                continue;
            }

            // A name that is not UTF-8 reaches `statSync` mangled and fails there.
            name.to_str()?;

            if has_backslash(&name) {
                return None;
            }

            let metadata = fs::metadata(directory.join(&name)).ok()?;
            let modified = mtime_ms(&metadata);

            stats.entries += 1;
            stats.total = add_safe(stats.total, metadata.len())?;
            stats.oldest = Some(stats.oldest.map_or(modified, |oldest| oldest.min(modified)));
            stats.newest = Some(stats.newest.map_or(modified, |newest| newest.max(modified)));
        }
    }

    Some(stats)
}

/// `~/.vis/cache`, from a plain absolute `HOME` (what `os.homedir()` returns on POSIX).
pub(crate) fn vis_cache_dir() -> Option<String> {
    let home = env::var("HOME").ok().filter(|home| home.starts_with('/') && is_plain(home))?;

    Some(resolve(&home, &[".vis", "cache"]))
}

// ---------------------------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------------------------

/// Sizes from which the humanizer's `Math.log` ratio can sit on the wrong side of a power of 1024
/// (`2**50 - 1` already prints as petabytes). The integer unit below is exact; Node's is not.
const FORMAT_BYTES_LIMIT: u64 = 1 << 45;

/// `formatBytes(n, { decimals: 1, space: false })` of `@visulima/humanizer`: metric names over 1024
/// steps, one fixed decimal rounded half away from zero, en-US grouping. `None` for sizes the
/// floating-point unit choice of Node could disagree on.
pub(crate) fn format_bytes(bytes: u64) -> Option<String> {
    const UNITS: [&str; 5] = ["Bytes", "KB", "MB", "GB", "TB"];

    if bytes == 0 {
        return Some("0Bytes".to_owned());
    }

    if bytes >= FORMAT_BYTES_LIMIT {
        return None;
    }

    // `Math.floor(Math.log(n) / Math.log(1024))`, which is the integer logarithm below this limit.
    let step = (bytes.ilog2() / 10) as usize;
    let divisor = 1u64 << (10 * step);

    // Tenths, rounded half up on the exact quotient.
    let scaled = u128::from(bytes) * 10;
    let mut tenths = scaled / u128::from(divisor);

    if (scaled % u128::from(divisor)) * 2 >= u128::from(divisor) {
        tenths += 1;
    }

    let whole = (tenths / 10).to_string();
    let mut grouped = String::new();

    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }

        grouped.push(digit);
    }

    Some(format!("{grouped}.{}{}", tenths % 10, UNITS[step]))
}

/// `new Date(ms).toISOString()`, `None` outside the years Node prints without an extended form.
pub(crate) fn iso(ms: f64) -> Option<String> {
    let ms = ms.trunc();

    (0.0..=253_402_300_799_999.0).contains(&ms).then(|| iso_from_millis(ms as i64))
}

/// `formatAge`.
fn format_age(mtime_ms: f64, now: f64) -> String {
    let seconds = ((now - mtime_ms) / 1000.0).floor().max(0.0);

    if seconds < 60.0 {
        format!("{seconds}s")
    } else if seconds < 3600.0 {
        format!("{}m", (seconds / 60.0).floor())
    } else if seconds < 86_400.0 {
        format!("{}h", (seconds / 3600.0).floor())
    } else {
        format!("{}d", (seconds / 86_400.0).floor())
    }
}

pub(crate) fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

// ---------------------------------------------------------------------------------------------
// The commands.
// ---------------------------------------------------------------------------------------------

/// `runList`. `None` for the pail-framed outcomes, which are Node's.
fn list_output(directory: &str, format: Format) -> Option<String> {
    let exists = fs::metadata(directory).is_ok();
    let entries = if exists { collect_entries(directory)? } else { Vec::new() };
    let total = total_size(&entries)?;
    let quoted = json_string(directory);

    if format == Format::Json {
        if entries.is_empty() {
            return Some(format!(
                "{{\n  \"directory\": {quoted},\n  \"entries\": [],\n  \"totalBytes\": 0,\n  \"totalCount\": 0\n}}\n"
            ));
        }

        let now = now_ms();
        let mut rows = Vec::new();

        for entry in &entries {
            rows.push(format!(
                "    {{\n      \"ageMs\": {},\n      \"hash\": {},\n      \"mtimeIso\": \"{}\",\n      \"sizeBytes\": {}\n    }}",
                js_number(now - entry.mtime_ms),
                json_string(&entry.hash),
                iso(entry.mtime_ms)?,
                entry.size
            ));
        }

        return Some(format!(
            "{{\n  \"directory\": {quoted},\n  \"entries\": [\n{}\n  ],\n  \"totalBytes\": {total},\n  \"totalCount\": {}\n}}\n",
            rows.join(",\n"),
            entries.len()
        ));
    }

    // A missing or empty directory is a pail line.
    if entries.is_empty() {
        return None;
    }

    let now = now_ms();
    let rows: Vec<[String; 3]> = entries
        .iter()
        .map(|entry| {
            Some([entry.hash.chars().take(12).collect(), format_bytes(entry.size)?, format_age(entry.mtime_ms, now)])
        })
        .collect::<Option<_>>()?;
    let width = |index: usize, least: usize| rows.iter().map(|row| row[index].len()).fold(least, usize::max);
    let (hash_width, size_width, age_width) = (width(0, 4), width(1, 4), width(2, 3));

    let mut out = format!("Cache directory: {directory}\nEntries: {} ({})\n\n", entries.len(), format_bytes(total)?);

    out.push_str(&format!("  {:hash_width$}  {:size_width$}  {:age_width$}\n", "hash", "size", "age"));
    out.push_str(&format!("  {}  {}  {}\n", "-".repeat(hash_width), "-".repeat(size_width), "-".repeat(age_width)));

    for row in &rows {
        out.push_str(&format!("  {:hash_width$}  {:size_width$}  {:age_width$}\n", row[0], row[1], row[2]));
    }

    Some(out)
}

/// One `printStatsBlock`.
fn stats_block(label: &str, directory: Option<&str>, stats: &Stats) -> Option<String> {
    // `stats.oldestEntry ? ... : "N/A"`: a zero time is as absent as none.
    let time = |value: Option<f64>| -> Option<String> {
        match value {
            Some(ms) if ms != 0.0 => iso(ms),
            _ => Some("N/A".to_owned()),
        }
    };

    let mut out = format!("{label}:\n");

    if let Some(directory) = directory {
        out.push_str(&format!("  Directory:  {directory}\n"));
    }

    out.push_str(&format!("  Entries:    {}\n", stats.entries));
    out.push_str(&format!("  Total size: {}\n", format_bytes(stats.total)?));
    out.push_str(&format!("  Oldest:     {}\n", time(stats.oldest)?));
    out.push_str(&format!("  Newest:     {}\n", time(stats.newest)?));

    Some(out)
}

/// The directories of the auxiliary stores, as `vis-paths.ts` and the security caches lay them out.
pub(crate) fn store_directories(target: Target, home_cache: &str) -> Vec<PathBuf> {
    let join = |parts: &[&str]| PathBuf::from(resolve(home_cache, parts));

    match target {
        Target::Ai => vec![join(&["ai"])],
        Target::Socket => vec![join(&["socket-security"])],
        Target::DepsDev => {
            vec![join(&["deps-dev", "versions"]), join(&["deps-dev", "projects"]), join(&["deps-dev", "advisories"])]
        }
        Target::Snyk => vec![join(&["snyk", "issues"])],
        _ => Vec::new(),
    }
}

const STORES: [(Target, &str, &str); 4] = [
    (Target::Ai, "ai", "AI response cache"),
    (Target::Socket, "socket", "Socket.dev report cache"),
    (Target::DepsDev, "deps-dev", "deps.dev cache"),
    (Target::Snyk, "snyk", "Snyk issue cache"),
];

fn iso_or_null(value: Option<f64>) -> Option<String> {
    match value {
        Some(ms) => Some(format!("\"{}\"", iso(ms)?)),
        None => Some("null".to_owned()),
    }
}

/// `cacheSizeExecute`.
fn size_output(options: &Options, directories: &[String]) -> Option<String> {
    let home_cache = if options.target == Target::Task { None } else { Some(vis_cache_dir()?) };
    let mut task: Option<Vec<(String, Vec<Entry>, bool)>> = None;

    if options.target.includes(Target::Task) {
        let mut collected = Vec::new();

        for directory in directories {
            let exists = fs::metadata(directory).is_ok();
            let entries = if exists { collect_entries(directory)? } else { Vec::new() };

            collected.push((directory.clone(), entries, exists));
        }

        task = Some(collected);
    }

    let mut stores = Vec::new();

    for (kind, key, label) in STORES {
        if options.target.includes(kind) {
            let stats = store_stats(&store_directories(kind, home_cache.as_deref()?))?;

            stores.push((key, label, stats));
        }
    }

    if options.format == Format::Json {
        let mut sections = Vec::new();

        if let Some(collected) = &task {
            let mut rows = Vec::new();

            for (directory, entries, exists) in collected {
                let total = total_size(entries)?;

                rows.push(format!(
                    "    {{\n      \"directory\": {},\n      \"entries\": {},\n      \"exists\": {exists},\n      \"newestEntry\": {},\n      \"oldestEntry\": {},\n      \"totalBytes\": {total}\n    }}",
                    json_string(directory),
                    entries.len(),
                    iso_or_null(entries.first().map(|entry| entry.mtime_ms))?,
                    iso_or_null(entries.last().map(|entry| entry.mtime_ms))?
                ));
            }

            sections.push(format!("  \"task\": [\n{}\n  ]", rows.join(",\n")));
        }

        for (key, _, stats) in &stores {
            sections.push(format!(
                "  \"{key}\": {{\n    \"entries\": {},\n    \"newestEntry\": {},\n    \"oldestEntry\": {},\n    \"totalBytes\": {}\n  }}",
                stats.entries,
                iso_or_null(stats.newest)?,
                iso_or_null(stats.oldest)?,
                stats.total
            ));
        }

        return Some(format!("{{\n{}\n}}\n", sections.join(",\n")));
    }

    let mut out = String::new();

    if let Some(collected) = &task {
        // Several directories print a `# <dir>` pail header, and a missing one a pail line.
        let [(directory, entries, true)] = collected.as_slice() else {
            return None;
        };

        let stats = Stats {
            entries: entries.len() as u64,
            newest: entries.first().map(|entry| entry.mtime_ms),
            oldest: entries.last().map(|entry| entry.mtime_ms),
            total: total_size(entries)?,
        };

        out.push_str(&stats_block("Task cache", Some(directory), &stats)?);
    }

    for (_, label, stats) in &stores {
        out.push_str(&stats_block(label, None, stats)?);
    }

    Some(out)
}

/// The workspace root of a run the cache commands can answer, or `None` when Node must: the pnpm root
/// [`monorepo_root`] finds, with CI set, a quiet stderr, no Deno file and no inherited root for another
/// directory. The commands that print pail blocks add their own layout checks on top.
pub(crate) fn quiet_workspace_root(cwd: &Path) -> Option<PathBuf> {
    let root = monorepo_root(cwd)?;

    if !in_ci() || io::stderr().is_terminal() || crate::term::node_warns_about_colour() {
        return None;
    }

    // Debug output and cerebro's output level change what the Node CLI logs around the command.
    if ["DEBUG", "CEREBRO_OUTPUT_LEVEL", "CEREBRO_MIN_NODE_VERSION"].iter().any(|key| env::var_os(key).is_some()) {
        return None;
    }

    // An inherited root for another directory is the parent process's, not this run's.
    if env::var_os("VIS_MONOREPO_ROOT").is_some_and(|inherited| !inherited.is_empty() && Path::new(&inherited) != root)
    {
        return None;
    }

    if [cwd, root.as_path()].iter().any(|directory| any_ancestor_has(directory, &DENO_FILES)) {
        return None;
    }

    Some(root)
}

/// The text to print, or `None` when Node must answer.
fn answer(args: &[String]) -> Option<String> {
    let options = parse(args)?;
    let cwd = env::current_dir().ok()?;
    let root = quiet_workspace_root(&cwd)?;

    let settings = read_settings(&cwd, &root)?;
    let directories = read_directories(&root, &options, &settings)?;

    match options.command {
        Subcommand::List => match directories.as_slice() {
            [directory] => list_output(directory, options.format),
            // Several directories print a `# <dir>` pail header on stdout.
            _ => None,
        },
        Subcommand::Size => size_output(&options, &directories),
    }
}

/// Answers `vis cache list` / `vis cache size` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    if !cfg!(unix) {
        crate::delegate(raw_args);
    }

    match answer(args) {
        Some(text) => {
            let mut stdout = io::stdout().lock();

            if stdout.write_all(text.as_bytes()).and_then(|()| stdout.flush()).is_err() {
                exit(1);
            }

            exit(0);
        }
        None => crate::delegate(raw_args),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_branch_directory_is_left_to_node_by_a_command_that_prints_each_directory() {
        use std::os::unix::ffi::OsStrExt;

        let name = std::ffi::OsStr::from_bytes(b"/cache/branches/caf\xe9");
        let plain = Path::new("/cache/branches/main");

        // `cache prune` prints a block naming the (mangled) path, which is not reproduced.
        assert_eq!(branch_directory(Path::new(name), true), Err(()));
        // A count reads the mangled path as an empty directory, so the directory adds nothing.
        assert_eq!(branch_directory(Path::new(name), false), Ok(None));
        assert_eq!(branch_directory(plain, true), Ok(Some("/cache/branches/main".to_owned())));
        assert_eq!(branch_directory(plain, false), Ok(Some("/cache/branches/main".to_owned())));
    }

    #[test]
    fn bytes_follow_the_humanizer() {
        for (bytes, text) in [
            (0, "0Bytes"),
            (1, "1.0Bytes"),
            (512, "512.0Bytes"),
            (1023, "1,023.0Bytes"),
            (1024, "1.0KB"),
            (1025, "1.0KB"),
            (1280, "1.3KB"),
            (1536, "1.5KB"),
            (4500, "4.4KB"),
            (1_048_575, "1,024.0KB"),
            (1_048_576, "1.0MB"),
            (1_234_567, "1.2MB"),
            (5_000_000_000, "4.7GB"),
            (1_073_741_823, "1,024.0MB"),
            (1_099_511_627_776, "1.0TB"),
        ] {
            assert_eq!(format_bytes(bytes).as_deref(), Some(text), "{bytes}");
        }
    }

    #[test]
    fn sizes_past_a_javascript_number_are_left_to_node() {
        assert_eq!(add_safe(MAX_SAFE_INTEGER - 1, 1), Some(MAX_SAFE_INTEGER));
        assert_eq!(add_safe(MAX_SAFE_INTEGER, 1), None);
        assert_eq!(add_safe(u64::MAX, 1), None);
        assert_eq!(add_safe(0, MAX_SAFE_INTEGER + 1), None);

        let entry = |size| Entry { hash: String::new(), mtime_ms: 0.0, size };

        assert_eq!(total_size(&[entry(MAX_SAFE_INTEGER - 5), entry(5)]), Some(MAX_SAFE_INTEGER));
        assert_eq!(total_size(&[entry(MAX_SAFE_INTEGER - 5), entry(6)]), None);
    }

    #[test]
    fn backslash_names_are_left_to_node() {
        assert!(has_backslash(OsStr::new("a\\b")));
        assert!(!has_backslash(OsStr::new("a/b")));

        let directory = std::env::temp_dir().join(format!("vis-cache-backslash-{}", std::process::id()));

        fs::create_dir_all(directory.join("entry")).unwrap();
        fs::write(directory.join("entry").join("a\\b"), "x").unwrap();
        assert_eq!(sum_directory_size(&directory.join("entry")), None);
        assert!(collect_entries(directory.to_str().unwrap()).is_none());

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn huge_sizes_are_left_to_node() {
        assert_eq!(format_bytes(FORMAT_BYTES_LIMIT), None);
        assert!(format_bytes(FORMAT_BYTES_LIMIT - 1).is_some());
    }

    #[test]
    fn dates_are_iso() {
        assert_eq!(iso(0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(iso(1_763_593_200_123.9).as_deref(), Some("2025-11-19T23:00:00.123Z"));
        assert_eq!(iso(951_782_400_000.0).as_deref(), Some("2000-02-29T00:00:00.000Z"));
        assert_eq!(iso(-1.0), None);
    }

    #[test]
    fn ages_clamp_and_step() {
        assert_eq!(format_age(10_000.0, 0.0), "0s");
        assert_eq!(format_age(0.0, 59_999.0), "59s");
        assert_eq!(format_age(0.0, 60_000.0), "1m");
        assert_eq!(format_age(0.0, 7_200_000.0), "2h");
        assert_eq!(format_age(0.0, 259_200_000.0), "3d");
    }

    #[test]
    fn paths_resolve_like_visulima_path() {
        assert_eq!(resolve("/a/b", &["../c//d/./e/"]), "/a/c/d/e");
        assert_eq!(resolve("/a", &["../../../../z"]), "/z");
        assert_eq!(resolve("/x/../y", &["branches", "s"]), "/y/branches/s");
        assert_eq!(normalize("/a", "/x/../y").as_deref(), Some("/x/../y"));
        assert_eq!(normalize("/a", "x/./y").as_deref(), Some("/a/x/y"));
        assert_eq!(normalize("/a", "C:/x"), None);
        assert_eq!(normalize("/a", "//srv/x"), None);
        assert_eq!(normalize("/a", "x\\y"), None);
    }

    #[test]
    fn branch_names_become_slugs() {
        assert_eq!(branch_slug("feat/native cache"), "feat-native-cache");
        assert_eq!(branch_slug("--x--"), "x");
        assert_eq!(branch_slug("v1.2_rc"), "v1.2_rc");
        assert_eq!(branch_slug(&"a".repeat(80)).len(), 64);
        assert_eq!(branch_slug("ü"), "");
    }

    #[test]
    fn only_the_plain_shapes_parse() {
        assert!(parse(&argv(&["cache", "list"])).is_some());
        assert!(parse(&argv(&["cache", "list", "--format", "json", "--scope=all", "--cache-dir", "x"])).is_some());
        assert!(parse(&argv(&["cache", "size", "--type=deps-dev"])).is_some());

        for shape in [
            &["cache", "list", "--type", "ai"][..],
            &["cache", "list", "--format", "yaml"],
            &["cache", "list", "--format=JSON"],
            &["cache", "list", "--scope", "bogus"],
            &["cache", "size", "--type=nope"],
            &["cache", "list", "--format"],
            &["cache", "list", "--format", "json", "--format", "table"],
            &["cache", "list", "--cache-dir="],
            &["cache", "list", "extra"],
            &["cache", "list", "--cwd", "."],
            &["cache", "clean"],
        ] {
            assert!(parse(&argv(shape)).is_none(), "{shape:?}");
        }
    }
}
