//! Native `vis run <target>` for a run in which every task is a local cache hit.
//!
//! Everything else is Node's. The native attempt reads the workspace, keys every task and looks every
//! key up in the cache **before it prints or writes anything**; the first thing that is not a clean hit
//! (a miss, a key it cannot reproduce, an entry that holds outputs, an expired entry, a stale install, a
//! toolchain pin, ...) hands the whole invocation to the Node CLI untouched. Only when every task hits
//! does it write `.vis/last-summary.json` and print what the Node static renderer prints for such a run.
//!
//! What the answer covers:
//!
//! * the invocation `run <target>` and nothing else: no flag, no further argument;
//! * a CI context (`CI` set, stderr and stdout not terminals), with the colour codes and the log grouping
//!   (GitHub Actions, GitLab CI, Buildkite, Azure Pipelines) the Node renderer prints for that environment,
//!   started by the JS launcher, which passes `process.version` in `VIS_NODE_VERSION`;
//! * a pnpm workspace of script-only JS projects (`targets::script_targets`), no `vis.config`, no
//!   `dependsOn`, default inputs, no outputs, no `cache: false`;
//! * a workspace whose startup preflights print nothing: no toolchain pin, a lockfile that is fresh
//!   against `node_modules`, no legacy task-runner directory, no run history.
//!
//! Output order: Node prints the lines of tasks that run side by side in the order they happen to finish.
//! This module prints them in a fixed order (project order, three tasks in flight like the default
//! `--parallel`). The set of lines is the same; the order of the interleaved lines may differ.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use task_runner_core::{compute_task_keys, lookup_entry, CacheLookup, DependsOn, RunProject, TaskKey};

use crate::advisories::{in_ci, native_context};
use crate::targets::{script_targets, Targets};
use crate::term;
use crate::toolchain::{self, Pins, Versions};

/// `DEFAULT_MAX_CACHE_AGE` of the task-runner cache: an entry older than this is swept by Node.
const SWEEP_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// An entry this close to the window is treated as expired: the native answer never depends on the
/// edge of a race with the sweep.
const SWEEP_MARGIN: Duration = Duration::from_secs(60 * 60);

/// Tasks in flight at once under the default `--parallel`; only the order of the printed lines uses it.
const DEFAULT_PARALLEL: usize = 3;

/// Variables that change what Node does for `run`: remote cache, cache location, selection, runtime
/// choice, concurrency, logging. Any of them set sends the run to Node.
const NODE_ONLY_VARIABLES: [&str; 14] = [
    "CACHE_TOKEN",
    "DEBUG",
    "PAIL_LOG_LEVEL",
    "TURBO_API",
    "TURBO_TEAM",
    "TURBO_TOKEN",
    "VIS_AFFECTED_FILES",
    "VIS_CACHE_DIRECTORY",
    "VIS_CLI_TEST",
    "VIS_PARTITION",
    "VIS_POLYFILL",
    "VIS_RUNNER_TAGS",
    "VIS_RUNTIME",
    "VIS_RUN_CONCURRENCY_LIMIT",
];

/// Lockfiles of the other package managers; the lockfile preflight looks at the first one it finds.
const OTHER_LOCKFILES: [&str; 6] =
    ["aube-lock.yaml", "bun.lock", "bun.lockb", "npm-shrinkwrap.json", "package-lock.json", "yarn.lock"];

/// `MTIME_SKEW_MS` of the lockfile preflight.
const MTIME_SKEW_MS: f64 = 1000.0;

/// The longest title the static header renders on one line (the rest wraps in Node).
const MAX_TITLE_WIDTH: usize = 60;

/// Rendered width the task lines must stay under: `✓  <id> [cache] (<n> ms)`.
const MAX_ID_WIDTH: usize = 50;

/// The separator under and over the output of a task: 80 columns, the width Node uses off a terminal.
const SEPARATOR_WIDTH: usize = 80;

/// Whether the arguments are `run <target>` with a plain target.
fn parse(args: &[String]) -> Option<&str> {
    let [command, target] = args else { return None };

    (command == "run" && plain(target)).then_some(target.as_str())
}

/// A name that renders on one line and needs no escaping: printable ASCII, no space.
fn plain(text: &str) -> bool {
    !text.is_empty() && !text.starts_with('-') && text.bytes().all(|byte| byte.is_ascii_graphic())
}

/// `CI` itself is set to something other than `0`, `false` or nothing. Parts of the Node run read
/// `process.env.CI` directly while the CI check (`is-in-ci`) also accepts `CONTINUOUS_INTEGRATION`, so
/// only the case where both agree is answered here.
fn ci_variable() -> bool {
    env::var("CI").is_ok_and(|value| !value.is_empty() && value != "0" && value != "false")
}

fn variable_set(name: &str) -> bool {
    env::var_os(name).is_some()
}

/// How Node's static renderer groups the output of a task in the log: the first of these that applies
/// (`resolveCiGroupingMode`, which compares the value exactly, `TF_BUILD` ignoring case).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Grouping {
    /// Separator lines above and below the output.
    Separators,
    Github,
    Gitlab,
    Buildkite,
    Azure,
}

impl Grouping {
    fn detect() -> Self {
        let is = |name: &str, expected: &str| env::var_os(name).is_some_and(|value| value == expected);

        if is("GITHUB_ACTIONS", "true") {
            Self::Github
        } else if is("GITLAB_CI", "true") {
            Self::Gitlab
        } else if is("BUILDKITE", "true") {
            Self::Buildkite
        } else if env::var_os("TF_BUILD").is_some_and(|value| value.eq_ignore_ascii_case("true")) {
            Self::Azure
        } else {
            Self::Separators
        }
    }
}

/// What the static renderer prints around the plain text: the colour codes and the grouping directives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Look {
    colour: bool,
    grouping: Grouping,
}

/// The part of the context only the process knows: where the output goes, which variables are set,
/// who started the binary. The workspace is looked at later. `None` means "Node answers".
fn environment_look(args: &[String]) -> Option<Look> {
    if !in_ci() || !ci_variable() || std::io::stdout().is_terminal() || std::io::stderr().is_terminal() {
        return None;
    }

    if NODE_ONLY_VARIABLES.iter().any(|name| variable_set(name)) {
        return None;
    }

    if env::vars_os().any(|(key, _)| key.to_str().is_some_and(|key| key.starts_with("CEREBRO_"))) {
        return None;
    }

    if matches!(env::var("NODE_ENV").as_deref(), Ok("debug" | "test")) {
        return None;
    }

    // The renderer's colour follows the same detection as pail's: any level above 0 prints the same
    // sixteen-colour codes, `None` is a case only Node can decide.
    let colour = term::piped_colour_level(args)? > 0;

    Some(Look { colour, grouping: Grouping::detect() })
}

/// `process.arch` and `process.platform` as Node names them; anything else is Node's.
fn node_environment() -> Option<(&'static str, &'static str)> {
    let arch = match env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return None,
    };
    let platform = match env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        _ => return None,
    };

    Some((arch, platform))
}

/// `process.version` as a recorded value: `v22.1.0` style, nothing that would need escaping.
fn node_version_text(version: &str) -> Option<String> {
    let digits = version.strip_prefix('v')?;

    (!digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+')))
    .then(|| version.to_owned())
}

/// `process.version` of the Node that runs the launcher, `v22.1.0` style. The launcher hand-off sets it
/// (`node_contract::init` drops it for any other start), so a binary started on its own has none and asks the
/// Node it would delegate to (see [`attempt`]).
fn launcher_node_version() -> Option<String> {
    node_version_text(&env::var("VIS_NODE_VERSION").ok()?)
}

fn exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

fn modified_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;

    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0)
}

/// `checkLockfileFreshness` for a pnpm workspace, answering only "passes": every other outcome (an
/// uninitialised install, a lockfile newer than the install) is an error Node reports with a stack
/// trace, and goes to Node.
fn lockfile_is_fresh(root: &Path) -> bool {
    if OTHER_LOCKFILES.iter().any(|name| exists(&root.join(name))) {
        return false;
    }

    let lockfile = root.join("pnpm-lock.yaml");
    let copy = root.join("node_modules/.pnpm/lock.yaml");
    let markers = [root.join("node_modules/.modules.yaml"), copy.clone()];
    let freshest =
        markers.iter().filter(|marker| marker.exists()).filter_map(|marker| modified_ms(marker)).reduce(f64::max);

    let Some(freshest) = freshest else { return false };

    // Byte equality with the copy pnpm keeps proves the install matches, whatever the times say.
    if let (Ok(lock), Ok(installed)) = (fs::read(&lockfile), fs::read(&copy)) {
        if lock == installed {
            return true;
        }
    }

    let Some(lockfile_ms) = modified_ms(&lockfile) else { return false };

    // One millisecond of margin towards Node, which compares floating point times.
    lockfile_ms <= freshest + MTIME_SKEW_MS - 1.0
}

/// The default task cache directory: `<main worktree root>/node_modules/.cache/vis`, which is what
/// `vis run` resolves without a config, a flag or `VIS_CACHE_DIRECTORY` (gated above).
fn cache_directory(root: &Path) -> Option<PathBuf> {
    let anchor = match task_runner_core::get_main_worktree_root(root.to_str()?) {
        Ok(Some(main)) => PathBuf::from(main),
        Ok(None) => root.to_path_buf(),
        Err(_) => return None,
    };

    Some(anchor.join("node_modules").join(".cache").join("vis"))
}

/// Whether Node's background sweep (`Cache.removeOldEntries`) would delete anything: a top-level entry
/// other than a dot file or the `v2` store whose modification time is older than the window. Node removes
/// them while it runs, so a run that skipped that would leave a different cache behind, and an expired
/// entry it looks up is a hit or a miss depending on a race.
fn nothing_to_sweep(cache: &Path) -> bool {
    let Ok(entries) = fs::read_dir(cache) else { return false };
    let limit = SWEEP_WINDOW.saturating_sub(SWEEP_MARGIN);

    for entry in entries {
        let Ok(entry) = entry else { return false };
        let name = entry.file_name();

        if name.as_encoded_bytes().starts_with(b".") || name == "v2" {
            continue;
        }

        // `stat` follows links, as Node's does; an entry that cannot be read is skipped by Node.
        let Ok(modified) = fs::metadata(entry.path()).and_then(|metadata| metadata.modified()) else { continue };

        if SystemTime::now().duration_since(modified).is_ok_and(|age| age > limit) {
            return false;
        }
    }

    true
}

/// What JavaScript's `String.prototype.trim` removes.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `(durationMs / 1000).toFixed(1)` for a duration below one second: JavaScript rounds an exact tie up,
/// Rust rounds it to even.
fn seconds_text(milliseconds: u64) -> String {
    if milliseconds % 500 == 250 {
        return format!("{:.1}", (milliseconds + 50) as f64 / 1000.0);
    }

    format!("{:.1}", milliseconds as f64 / 1000.0)
}

/// `formatMs` for a duration below one second.
fn duration_text(milliseconds: u64) -> String {
    format!("{milliseconds} ms")
}

/// An ISO 8601 UTC time with milliseconds, `Date.prototype.toISOString`.
fn iso(time: SystemTime) -> String {
    let milliseconds = time.duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64);
    let days = milliseconds.div_euclid(86_400_000);
    let of_day = milliseconds.rem_euclid(86_400_000);

    // Civil date from the day count (Howard Hinnant's algorithm).
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

/// `randomUUID()`: a version 4 UUID from the process's own randomness.
fn uuid() -> String {
    use std::hash::{BuildHasher, Hasher};

    let mut bytes = [0u8; 16];

    for chunk in bytes.chunks_mut(8) {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();

        hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos()));
        hasher.write_u32(std::process::id());
        chunk.copy_from_slice(&hasher.finish().to_le_bytes());
    }

    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;

    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();

    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// A JSON value that keeps the order its object keys were added in, as a JavaScript object does.
enum Json {
    Array(Vec<Json>),
    Number(u64),
    Object(Vec<(&'static str, Json)>),
    /// An object whose keys are data (task ids, file paths).
    Record(Vec<(String, Json)>),
    Text(String),
    Bool(bool),
}

fn escape(text: &str, out: &mut String) {
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
}

impl Json {
    /// `JSON.stringify(value, undefined, 2)`.
    fn pretty(&self, depth: usize, out: &mut String) {
        let indent = |depth: usize| "  ".repeat(depth);

        match self {
            Self::Text(text) => escape(text, out),
            Self::Number(number) => out.push_str(&number.to_string()),
            Self::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
            Self::Array(items) if items.is_empty() => out.push_str("[]"),
            Self::Array(items) => {
                out.push_str("[\n");

                for (index, item) in items.iter().enumerate() {
                    out.push_str(&indent(depth + 1));
                    item.pretty(depth + 1, out);
                    out.push_str(if index + 1 < items.len() { ",\n" } else { "\n" });
                }

                out.push_str(&indent(depth));
                out.push(']');
            }
            Self::Object(fields) => Self::fields(fields.iter().map(|(key, value)| (*key, value)), depth, out),
            Self::Record(fields) => Self::fields(fields.iter().map(|(key, value)| (key.as_str(), value)), depth, out),
        }
    }

    fn fields<'a>(fields: impl ExactSizeIterator<Item = (&'a str, &'a Json)>, depth: usize, out: &mut String) {
        let indent = |depth: usize| "  ".repeat(depth);
        let count = fields.len();

        if count == 0 {
            out.push_str("{}");

            return;
        }

        out.push_str("{\n");

        for (index, (key, value)) in fields.enumerate() {
            out.push_str(&indent(depth + 1));
            escape(key, out);
            out.push_str(": ");
            value.pretty(depth + 1, out);
            out.push_str(if index + 1 < count { ",\n" } else { "\n" });
        }

        out.push_str(&indent(depth));
        out.push('}');
    }
}

fn text(value: &str) -> Json {
    Json::Text(value.to_owned())
}

impl Look {
    /// `plain` as it is, or `coloured` when the renderer prints colour codes.
    fn paint(&self, plain: &str, coloured: &str) -> String {
        if self.colour { coloured } else { plain }.to_owned()
    }

    /// ` VIS  \u{2022}` with the bullet in `bullet` (37 white, 32 green).
    fn banner(&self, bullet: &str) -> String {
        self.paint(
            " VIS  \u{2022}",
            &format!(
                "\u{1b}[1m\u{1b}[7m VIS \u{1b}[22m\u{1b}[27m \u{1b}[1m\u{1b}[{bullet}m\u{2022}\u{1b}[22m\u{1b}[39m"
            ),
        )
    }

    /// The success tick, green off a plain log.
    fn tick(&self) -> String {
        self.paint("\u{2713}", "\u{1b}[32m\u{2713}\u{1b}[39m")
    }

    /// The stored output of a task, set off from the rest of the log the way the environment's grouping does it
    /// (`logCommandOutputCI`, for a task that succeeded).
    fn output_block(&self, id: &str, trimmed: &str, out: &mut String) {
        let tick = self.tick();

        match self.grouping {
            Grouping::Separators => {
                let dashes = "\u{2014}".repeat(SEPARATOR_WIDTH);
                let separator = self.paint(&dashes, &format!("\u{1b}[2m{dashes}\u{1b}[22m"));
                let label = self.paint(
                    &format!("\u{2713} [cache] {id}"),
                    &format!("{tick} \u{1b}[36m[cache]\u{1b}[39m \u{1b}[1m{id}\u{1b}[22m"),
                );

                out.push_str(&format!("{separator}\n{label}\n{trimmed}\n{separator}\n"));
            }
            Grouping::Github => out.push_str(&format!("::group::{tick} {id}\n{trimmed}\n::endgroup::\n")),
            Grouping::Gitlab => {
                let key = gitlab_section_key(id);
                let erase = "\u{1b}[0K";

                out.push_str(&format!(
                    "{erase}section_start:{}:{key}[collapsed=true]\r{erase}{tick} {id}\n{trimmed}\n",
                    unix_seconds()
                ));
                out.push_str(&format!("{erase}section_end:{}:{key}\r{erase}\n", unix_seconds()));
            }
            Grouping::Buildkite => out.push_str(&format!("--- {tick} {id}\n{trimmed}\n")),
            Grouping::Azure => out.push_str(&format!("##[group]{tick} {id}\n{trimmed}\n##[endgroup]\n")),
        }
    }
}

/// `Math.floor(Date.now() / 1000)`.
fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}

/// `toGitLabSectionKey`: the task id with every run of non-word characters turned into one `_`, then `_`
/// and the first six hex digits of the SHA-256 of the id. (Task ids are printable ASCII here.)
fn gitlab_section_key(id: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut slug = String::new();
    let mut in_run = false;

    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('_');
            in_run = true;
        }
    }

    let digest = Sha256::digest(id.as_bytes());

    format!("{slug}_{:02x}{:02x}{:02x}", digest[0], digest[1], digest[2])
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

impl Answer {
    fn description(&self) -> String {
        let count = self.hits.len();

        match self.hits.as_slice() {
            [only] => format!(
                "target {} for project {}",
                self.target,
                only.key.id.trim_end_matches(&format!(":{}", self.target))
            ),
            _ => format!("target {} for {count} projects", self.target),
        }
    }

    /// Every line this module prints has to fit the 80 columns Node renders them in.
    fn fits(&self) -> bool {
        self.hits.len() < 1000
            && self.milliseconds < 1000
            && self.hits.iter().all(|hit| hit.milliseconds < 1000 && hit.key.id.len() <= MAX_ID_WIDTH)
            && format!("Successfully ran {}", self.description()).len() <= MAX_TITLE_WIDTH
    }

    /// What the static renderer prints for a run whose tasks all hit, off a terminal, in the colour and
    /// grouping of the environment.
    fn stdout(&self) -> String {
        let look = self.look;
        let mut out = String::new();
        let description = self.description();

        out.push_str(&format!(
            "{}  Running {description}\n  With additional flags:\n    --visOptions={{}}\n\n",
            look.banner("37")
        ));

        let finish = |index: usize, out: &mut String| {
            let hit = &self.hits[index];

            out.push_str(&format!(
                "{}  {}{}\n",
                look.tick(),
                hit.key.id,
                look.paint(
                    &format!(" [cache] ({})", duration_text(hit.milliseconds)),
                    &format!("\u{1b}[36m [cache]\u{1b}[2m\u{1b}[39m ({})\u{1b}[22m", duration_text(hit.milliseconds))
                )
            ));

            let trimmed = hit.terminal_output.trim_matches(is_js_whitespace);

            if !trimmed.is_empty() {
                look.output_block(&hit.key.id, trimmed, out);
            }
        };

        // Three tasks start, then each one that ends is followed by the start of the next.
        let start =
            |id: &str, out: &mut String| out.push_str(&format!("{} {id}\n", look.paint(">", "\u{1b}[2m>\u{1b}[22m")));

        for hit in self.hits.iter().take(DEFAULT_PARALLEL) {
            start(&hit.key.id, &mut out);
        }

        for index in 0..self.hits.len() {
            finish(index, &mut out);

            if let Some(next) = self.hits.get(index + DEFAULT_PARALLEL) {
                start(&next.key.id, &mut out);
            }
        }

        let count = self.hits.len();

        out.push_str(&format!(
            "\n{}  Successfully ran {description}\n\n   {}  {count} tasks completed{}\n\n",
            look.banner("32"),
            look.tick(),
            look.paint(
                &format!(" ({count} read from cache)  \u{b7}  Took {}", duration_text(self.milliseconds)),
                &format!(
                    "\u{1b}[2m ({count} read from cache)  \u{b7}  Took {}\u{1b}[22m",
                    duration_text(self.milliseconds)
                )
            )
        ));
        out.push_str(&format!("  {count} cached \u{b7} {}s\n", seconds_text(self.milliseconds)));

        out
    }

    /// `.vis/last-summary.json`, as `generateRunSummary` builds it for a run of cache hits.
    fn summary(&self) -> String {
        let count = self.hits.len() as u64;
        let id = format!("{}_{}", iso(self.started).replace([':', '.'], "-"), uuid());
        let tasks = self
            .hits
            .iter()
            .map(|hit| {
                let details = &hit.key.details;
                let mut hash_details = vec![("command", text(&details.command))];

                if let Some(implicit) = &details.implicit_deps {
                    hash_details.push((
                        "implicitDeps",
                        Json::Record(implicit.iter().map(|pair| (pair[0].clone(), text(&pair[1]))).collect()),
                    ));
                }

                hash_details.push(("layout", Json::Number(2)));
                hash_details.push((
                    "nodes",
                    Json::Record(details.nodes.iter().map(|pair| (pair[0].clone(), text(&pair[1]))).collect()),
                ));

                let (project, _) = hit.key.id.rsplit_once(':').unwrap_or((&hit.key.id, ""));

                Json::Object(vec![
                    ("cacheable", Json::Bool(true)),
                    ("cacheStatus", text("HIT")),
                    ("dependencies", Json::Array(Vec::new())),
                    ("duration", Json::Number(hit.milliseconds)),
                    ("endTime", Json::Text(iso(hit.ended))),
                    ("exitCode", Json::Number(0)),
                    ("hash", text(&hit.key.hash)),
                    ("hashDetails", Json::Object(hash_details)),
                    ("outputs", Json::Array(Vec::new())),
                    ("startTime", Json::Text(iso(hit.started))),
                    ("target", Json::Object(vec![("project", text(project)), ("target", text(&self.target))])),
                    ("taskId", Json::Text(hit.key.id.clone())),
                ])
            })
            .collect();
        // `tasks` is listed by start time (the order of the lookups); `taskGraph` by project order.
        let graph_order = {
            let mut sorted: Vec<&Hit> = self.hits.iter().collect();

            sorted.sort_by_key(|hit| hit.graph_index);

            sorted.into_iter().map(|hit| hit.key.id.clone()).collect::<Vec<_>>()
        };

        let summary = Json::Object(vec![
            ("duration", Json::Number(self.milliseconds)),
            ("endTime", Json::Text(iso(self.ended))),
            (
                "environment",
                Json::Object(vec![
                    ("arch", text(self.arch)),
                    ("nodeVersion", Json::Text(self.node_version.clone())),
                    ("platform", text(self.platform)),
                ]),
            ),
            ("id", Json::Text(id)),
            ("startTime", Json::Text(iso(self.started))),
            (
                "stats",
                Json::Object(vec![
                    ("cached", Json::Number(count)),
                    ("failed", Json::Number(0)),
                    ("skipped", Json::Number(0)),
                    ("succeeded", Json::Number(0)),
                    ("total", Json::Number(count)),
                ]),
            ),
            (
                "taskGraph",
                Json::Object(vec![
                    (
                        "dependencies",
                        Json::Record(graph_order.iter().map(|id| (id.clone(), Json::Array(Vec::new()))).collect()),
                    ),
                    ("roots", Json::Array(graph_order.iter().map(|id| Json::Text(id.clone())).collect())),
                ]),
            ),
            ("tasks", Json::Array(tasks)),
        ]);
        let mut out = String::new();

        summary.pretty(0, &mut out);

        out
    }
}

/// Reads the workspace, keys every task, and looks every key up. `None` means "Node answers".
fn attempt(args: &[String]) -> Option<Answer> {
    let started = SystemTime::now();
    let clock = Instant::now();
    let target = parse(args)?.to_owned();

    let look = environment_look(args)?;

    let (arch, platform) = node_environment()?;
    // `Some` with the launcher's hand-off; a start without it asks the Node it would delegate to, after the hits.
    let launcher_version = match env::var_os("VIS_NODE_VERSION") {
        Some(_) => Some(launcher_node_version()?),
        None => None,
    };

    // The root is the working directory, with no config and no Deno file at or above it, in a CI context.
    if !native_context() {
        return None;
    }

    let root = env::current_dir().ok()?;

    if ![".task-runner", ".task-runner-cache", ".vis/runs"].iter().all(|name| !exists(&root.join(name)))
        || !lockfile_is_fresh(&root)
    {
        return None;
    }

    // The pins Node's toolchain preflight reads; the ones this module cannot decide send the run to Node.
    let pins = Pins::read(&root)?;

    let cache = cache_directory(&root)?;

    // No cache directory means no hit; Node creates it.
    if !cache.is_dir() {
        return None;
    }

    let Targets::Native(workspace) = script_targets(&root) else { return None };
    let mut projects = Vec::new();

    for project in workspace {
        if !plain(&project.name) {
            return None;
        }

        projects.push(RunProject {
            name: project.name,
            root: project.directory,
            script: project.targets.get(&target).cloned(),
            ..Default::default()
        });
    }

    let keys = compute_task_keys(root.to_str()?, &target, &projects, DependsOn::Nothing).ok()?;
    let hashes: Vec<String> = keys.keys.iter().map(|key| key.hash.clone()).collect();
    let mut hits = Vec::with_capacity(keys.keys.len());

    for (graph_index, key) in keys.keys.into_iter().enumerate() {
        let lookup_started = SystemTime::now();
        let lookup_clock = Instant::now();

        if !key.keyed || !plain(&key.id) {
            return None;
        }

        let CacheLookup::Hit(entry) = lookup_entry(&cache, &key.hash).ok()? else { return None };

        // A stored failure is a hit with exit 0 in Node; that is not reproduced.
        if entry.code != 0 {
            return None;
        }

        hits.push(Hit {
            key,
            graph_index,
            terminal_output: entry.terminal_output,
            started: lookup_started,
            ended: SystemTime::now(),
            milliseconds: lookup_clock.elapsed().as_millis() as u64,
        });
    }

    if !nothing_to_sweep(&cache) {
        return None;
    }

    // Asking the pinned tools (and Node, for the summary) for their versions costs a process each, so it
    // waits until every task has hit; they are asked at the same time.
    let pin_binaries = pins.binaries()?;
    let node_command = match launcher_version {
        Some(_) => None,
        None => Some(toolchain::resolve_command(&env::var("VIS_NODE").unwrap_or_else(|_| "node".to_owned()))?),
    };
    let mut versions = Versions::with_launcher_node(env::var("VIS_NODE").ok().as_deref(), launcher_version.as_deref());
    let wanted: Vec<PathBuf> = pin_binaries.iter().cloned().chain(node_command.clone()).collect();

    versions.fetch(&wanted);

    if !pins.are_met(&pin_binaries, &mut versions) {
        return None;
    }

    // Node asks the pinned tools before it reads the lockfile and keys the tasks, and a tool may change files while
    // it answers (a pnpm that manages its own version records the pin in the lockfile the first time). The same
    // question here comes after the lookups, so the lockfile and the keys are checked again, and a run whose
    // answer moved them is Node's.
    if !pins.is_empty() {
        let again = compute_task_keys(root.to_str()?, &target, &projects, DependsOn::Nothing).ok()?;

        if !lockfile_is_fresh(&root) || again.keys.iter().map(|key| &key.hash).ne(hashes.iter()) {
            return None;
        }
    }

    let node_version = match (launcher_version, node_command) {
        (Some(version), _) => version,
        (None, Some(command)) => node_version_text(versions.output(&command)?.strip_suffix('\n')?)?,
        (None, None) => return None,
    };

    let answer = Answer {
        look,
        hits,
        target,
        started,
        ended: SystemTime::now(),
        milliseconds: clock.elapsed().as_millis() as u64,
        arch,
        platform,
        node_version,
    };

    answer.fits().then_some(answer)
}

/// Writes `.vis/last-summary.json` exactly where and how a hit run does.
fn write_summary(answer: &Answer) -> Option<()> {
    let directory = env::current_dir().ok()?.join(".vis");

    fs::create_dir_all(&directory).ok()?;
    fs::write(directory.join("last-summary.json"), answer.summary()).ok()
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

    crate::delegate(raw_args)
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

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(UNIX_EPOCH + Duration::from_millis(1_795_473_196_232)), "2026-11-23T22:33:16.232Z");
        assert_eq!(iso(UNIX_EPOCH + Duration::from_millis(951_782_400_000)), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn seconds_round_like_to_fixed() {
        assert_eq!(seconds_text(0), "0.0");
        assert_eq!(seconds_text(32), "0.0");
        assert_eq!(seconds_text(150), "0.1");
        assert_eq!(seconds_text(250), "0.3");
        assert_eq!(seconds_text(750), "0.8");
        assert_eq!(seconds_text(999), "1.0");
    }

    #[test]
    fn json_is_pretty_printed_like_js() {
        let value = Json::Object(vec![
            ("a", Json::Array(Vec::new())),
            ("b", Json::Record(vec![("z".to_owned(), Json::Number(1)), ("y".to_owned(), text("q\"\n"))])),
            ("c", Json::Object(Vec::new())),
        ]);
        let mut out = String::new();

        value.pretty(0, &mut out);

        assert_eq!(out, "{\n  \"a\": [],\n  \"b\": {\n    \"z\": 1,\n    \"y\": \"q\\\"\\n\"\n  },\n  \"c\": {}\n}");
    }

    #[test]
    fn gitlab_section_keys_match_the_node_slug_and_hash() {
        assert_eq!(gitlab_section_key("p2:build"), "p2_build_a9450b");
        assert_eq!(gitlab_section_key("@acme/p2:build"), "_acme_p2_build_e36233");
        assert_eq!(gitlab_section_key("a--b:x.y"), "a_b_x_y_200432");
    }

    #[test]
    fn the_look_wraps_the_codes_only_with_colour() {
        let plain = Look { colour: false, grouping: Grouping::Github };
        let colour = Look { colour: true, grouping: Grouping::Azure };
        let mut out = String::new();

        plain.output_block("p:build", "out", &mut out);
        colour.output_block("p:build", "out", &mut out);

        assert_eq!(out, "::group::\u{2713} p:build\nout\n::endgroup::\n##[group]\u{1b}[32m\u{2713}\u{1b}[39m p:build\nout\n##[endgroup]\n");
        assert_eq!(plain.banner("37"), " VIS  \u{2022}");
        assert!(colour.banner("32").starts_with("\u{1b}[1m\u{1b}[7m VIS "));
    }

    #[test]
    fn uuids_look_like_v4() {
        let id = uuid();

        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert_ne!(id, uuid());
    }
}
