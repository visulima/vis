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
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::advisories::{any_ancestor_has, in_ci, js_number, monorepo_root, DENO_FILES};
use crate::vis_config::{self, ConfigState};

/// `DEFAULT_WORKSPACE_CACHE_DIRECTORY` in `src/util/vis-paths.ts`.
const DEFAULT_CACHE_DIRECTORY: &str = "node_modules/.cache/vis";

/// `BRANCH_SCOPE_DIRECTORY` in `src/commands/cache/entries.ts`.
const BRANCH_SCOPE_DIRECTORY: &str = "branches";

/// Config files Node loads from the workspace root, in `findVisConfigFile`'s priority order.
const CONFIG_NAMES: [&str; 7] = [
    "vis.config.ts",
    "vis.config.mts",
    "vis.config.cts",
    "vis.config.js",
    "vis.config.mjs",
    "vis.config.cjs",
    "vis.config.json",
];

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Table,
    Json,
}

#[derive(Clone, Copy, PartialEq)]
enum Scope {
    Shared,
    Worktree,
    All,
}

/// `CacheTarget` in `context.ts`.
#[derive(Clone, Copy, PartialEq)]
enum Target {
    All,
    Task,
    Ai,
    Socket,
    DepsDev,
    Snyk,
}

impl Target {
    fn includes(self, kind: Target) -> bool {
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
struct Settings {
    branch_scoped: bool,
    /// `sharedWorktreeCache !== false`.
    shared_worktree: bool,
    cache_directory: Option<String>,
}

/// The settings of the workspace root, or `None` when Node must answer.
///
/// Node reads `vis.config.*` from the workspace root only, so a config anywhere else on the way up is
/// one this path cannot tell Node's treatment of. At the root the config must be a literal, and free of the
/// keys that change what Node does before the command runs.
fn read_settings(cwd: &Path, root: &Path) -> Option<Settings> {
    let others = cwd.ancestors().chain(root.ancestors()).filter(|directory| *directory != root).any(has_config_file);

    if others || root.join("vis.config.json").exists() {
        return None;
    }

    // A config that has to be evaluated is Node's: evaluating it would cost the Node start this path avoids.
    let state = if has_config_file(root) { vis_config::read(root) } else { ConfigState::Absent };

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

fn has_config_file(directory: &Path) -> bool {
    CONFIG_NAMES.iter().any(|name| directory.join(name).exists())
}

// ---------------------------------------------------------------------------------------------
// Paths: `@visulima/path` semantics for the plain POSIX paths this module accepts.
// ---------------------------------------------------------------------------------------------

/// Whether `@visulima/path` treats `path` like a plain POSIX path: no separators it rewrites, no drive
/// letter, no UNC form. Anything else is Node's.
fn is_plain(path: &str) -> bool {
    let drive = path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && path.as_bytes().get(1) == Some(&b':');

    !path.contains(['\\', '\0']) && !path.starts_with("//") && !drive
}

/// `resolve(base, ...)` on POSIX for an absolute `base`: joins, then drops `.`, empty and resolved `..`.
fn resolve(base: &str, relative: &[&str]) -> String {
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

/// `getMainWorktreeRoot` (`task-runner/native/core/src/worktree.rs`): the main checkout's root when
/// `root` is a linked worktree, else `None`.
fn main_worktree_root(root: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let metadata = fs::metadata(canonical.join(".git")).ok()?;

    if metadata.is_dir() || !metadata.is_file() {
        return None;
    }

    let output = Command::new("git").args(["rev-parse", "--git-common-dir"]).current_dir(&canonical).output().ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    let common_dir = stdout.trim();

    if common_dir.is_empty() {
        return None;
    }

    let common =
        if Path::new(common_dir).is_absolute() { PathBuf::from(common_dir) } else { canonical.join(common_dir) };
    let main = fs::canonicalize(common.parent()?).ok()?;

    (main != canonical).then_some(main)
}

/// `resolveSharedCacheDirectory`.
fn resolve_cache_directory(root: &Path, option: Option<&str>, config: Option<&str>, shared: bool) -> Option<String> {
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

    let anchor = if shared { main_worktree_root(root) } else { None };
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

/// `directoriesFor("read")` of `resolveCacheDirectoryFromContext`.
fn read_directories(root: &Path, options: &Options, settings: &Settings) -> Option<Vec<String>> {
    let config = settings.cache_directory.as_deref();
    let option = options.cache_dir.as_deref();

    let worktree_base = resolve_cache_directory(root, option, config, false)?;
    let shared_base = resolve_cache_directory(root, option, config, settings.shared_worktree)?;
    let worktree_scoped = apply_branch_scope(worktree_base.clone(), root, settings.branch_scoped);
    let shared_scoped = apply_branch_scope(shared_base.clone(), root, settings.branch_scoped);

    let selected: Vec<(String, String)> = match options.scope {
        Scope::All if shared_scoped == worktree_scoped => vec![(shared_base, shared_scoped)],
        Scope::All => vec![(shared_base, shared_scoped), (worktree_base, worktree_scoped)],
        Scope::Worktree => vec![(worktree_base, worktree_scoped)],
        Scope::Shared => vec![(shared_base, shared_scoped)],
    };

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

struct Entry {
    hash: String,
    mtime_ms: f64,
    size: u64,
}

/// `Stats.mtimeMs`: seconds and nanoseconds combined in floating point.
#[cfg(unix)]
fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;

    metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1e6
}

#[cfg(not(unix))]
fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

/// Directory entries in the order `fs.readdir` returns them (libuv sorts by name, bytewise).
fn sorted_entries(directory: &Path) -> Option<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(directory).ok()?.collect::<Result<Vec<_>, _>>().ok()?;

    entries.sort_by(|a, b| a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes()));

    Some(entries)
}

/// `sumDirectorySize`: files counted by `stat`, symlinks skipped, and a failure ends that directory's
/// loop while keeping what it already added.
fn sum_directory_size(directory: &Path) -> u64 {
    let Some(entries) = sorted_entries(directory) else {
        return 0;
    };

    let mut total = 0;

    for entry in entries {
        let Ok(kind) = entry.file_type() else {
            break;
        };

        // Node reads the name as UTF-8 with replacement characters, so a path it builds from a name
        // that is not UTF-8 names nothing: the directory below it reads as empty and a file fails.
        let utf8 = entry.file_name().to_str().is_some();

        if kind.is_dir() {
            if utf8 {
                total += sum_directory_size(&entry.path());
            }
        } else if kind.is_file() {
            match fs::metadata(entry.path()) {
                Ok(metadata) if utf8 => total += metadata.len(),
                _ => break,
            }
        }
    }

    total
}

/// `collectCacheEntries`, newest first. `None` when a name needs Node's decoding.
fn collect_entries(directory: &str) -> Option<Vec<Entry>> {
    let Some(names) = sorted_entries(Path::new(directory)) else {
        return Some(Vec::new());
    };

    let mut entries = Vec::new();

    for entry in names {
        let name = entry.file_name();

        if name.as_encoded_bytes().starts_with(b".") || name == BRANCH_SCOPE_DIRECTORY {
            continue;
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
            size: sum_directory_size(&entry.path()),
        });
    }

    // `entries.sort((a, b) => b.mtimeMs - a.mtimeMs)`: stable, so equal times keep name order.
    entries.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(Ordering::Equal));

    Some(entries)
}

/// `AuxStats` without the directory.
#[derive(Default)]
struct Stats {
    entries: u64,
    newest: Option<f64>,
    oldest: Option<f64>,
    total: u64,
}

/// The `getCacheStats` shared by the AI, Socket.dev, deps.dev and Snyk stores: the `.json` files of
/// each directory. `None` when Node would throw (an unreadable directory, a file that cannot be stat-ed).
fn store_stats(directories: &[PathBuf]) -> Option<Stats> {
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

            let metadata = fs::metadata(directory.join(&name)).ok()?;
            let modified = mtime_ms(&metadata);

            stats.entries += 1;
            stats.total += metadata.len();
            stats.oldest = Some(stats.oldest.map_or(modified, |oldest| oldest.min(modified)));
            stats.newest = Some(stats.newest.map_or(modified, |newest| newest.max(modified)));
        }
    }

    Some(stats)
}

/// `~/.vis/cache`, from a plain absolute `HOME` (what `os.homedir()` returns on POSIX).
fn vis_cache_dir() -> Option<String> {
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
fn format_bytes(bytes: u64) -> Option<String> {
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
fn iso(ms: f64) -> Option<String> {
    let ms = ms.trunc();

    if !(0.0..=253_402_300_799_999.0).contains(&ms) {
        return None;
    }

    let ms = ms as i64;
    let (days, of_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));

    // Civil date from days since 1970-01-01.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    ))
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

fn json_string(text: &str) -> Option<String> {
    serde_json::to_string(text).ok()
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

// ---------------------------------------------------------------------------------------------
// The commands.
// ---------------------------------------------------------------------------------------------

/// `runList`. `None` for the pail-framed outcomes, which are Node's.
fn list_output(directory: &str, format: Format) -> Option<String> {
    let exists = fs::metadata(directory).is_ok();
    let entries = if exists { collect_entries(directory)? } else { Vec::new() };
    let total: u64 = entries.iter().map(|entry| entry.size).sum();
    let quoted = json_string(directory)?;

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
                json_string(&entry.hash)?,
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
fn store_directories(target: Target, home_cache: &str) -> Vec<PathBuf> {
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
                let total: u64 = entries.iter().map(|entry| entry.size).sum();

                rows.push(format!(
                    "    {{\n      \"directory\": {},\n      \"entries\": {},\n      \"exists\": {exists},\n      \"newestEntry\": {},\n      \"oldestEntry\": {},\n      \"totalBytes\": {total}\n    }}",
                    json_string(directory)?,
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
            total: entries.iter().map(|entry| entry.size).sum(),
        };

        out.push_str(&stats_block("Task cache", Some(directory), &stats)?);
    }

    for (_, label, stats) in &stores {
        out.push_str(&stats_block(label, None, stats)?);
    }

    Some(out)
}

/// The text to print, or `None` when Node must answer.
fn answer(args: &[String]) -> Option<String> {
    let options = parse(args)?;
    let cwd = env::current_dir().ok()?;
    let root = monorepo_root(&cwd)?;

    if !in_ci() || io::stderr().is_terminal() {
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

    if [cwd.as_path(), root.as_path()].iter().any(|directory| any_ancestor_has(directory, &DENO_FILES)) {
        return None;
    }

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
