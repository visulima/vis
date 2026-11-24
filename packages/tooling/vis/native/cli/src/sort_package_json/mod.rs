//! `vis sort-package-json` — the native port of `src/commands/sort-package-json/handler.ts`.
//!
//! Node sorts each file with the `sort-package-json` crate (through the addon), re-reads the result with
//! `JSON.parse`, applies the sort order, the unsorted sections and the cosmetic field rewrites, and writes it
//! back with `JSON.stringify`. This module calls the same crate, then does the rest on the ordered tree of
//! [`json`], whose reader declines every document JavaScript would read differently (see its docs).
//!
//! The command answers only the context it can prove, like `clean` and `secrets`: CI, no terminal, no
//! `vis.config.*`, a pnpm workspace whose root is the working directory, and pail output the binary can
//! reproduce. Every flag of the command is native except where its value leaves the subset below.
//! Everything else goes to Node through [`crate::process::delegate`], and so do:
//!
//! - an error of any kind (an unreadable or invalid file, a failing sorter, a bad flag value), because the
//!   messages and source excerpts come from Node's parsers;
//! - workspace patterns, `.gitignore` lines and `--ignore` globs outside the subsets of
//!   [`crate::workspace::expand_patterns`], [`gitignore`] and [`glob_matches`];
//! - a path pail would print differently (anything but ASCII without spaces).
//!
//! Every file is read, sorted and checked, and every target opened for writing, before the first write, so a
//! delegation never follows a change to a file.

mod fields;
mod gitignore;
pub(crate) mod json;

use std::env;
use std::ffi::OsString;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::exit;

use sort_package_json::{sort_package_json_with_options, SortOptions};

use crate::node_context::{ci_root_context, quiet_context};
use crate::output::write_streams;
use crate::pail::{Layout, Level};
use crate::vis_config::{self, ConfigState};
use crate::workspace::{expand_patterns, yaml_packages, WORKSPACE_YAML_NAMES};

use fields::Format;
use json::Json;

#[derive(Clone, Copy, PartialEq, Eq)]
enum LineEnding {
    Auto,
    Lf,
    Crlf,
}

/// The flags of the invocation, after the defaults Node gives them.
struct Options {
    check: bool,
    editorconfig: bool,
    final_newline: bool,
    format: Format,
    ignore: Vec<String>,
    /// The `--indent` override, resolved to the string `JSON.stringify` takes.
    indent: Option<String>,
    line_ending: LineEnding,
    sort_order: Vec<String>,
    sort_scripts: bool,
    unsorted: Vec<String>,
}

/// What a file turned out to need.
enum Verdict {
    Sorted,
    /// The file's new text.
    Rewrite(String),
}

struct Entry {
    path: PathBuf,
    verdict: Verdict,
}

/// What one run prints, split the way pail splits it: error blocks go to stderr, the rest to stdout.
#[derive(Default)]
struct Output {
    stdout: String,
    stderr: String,
}

/// Answer `vis sort-package-json` natively, or delegate to Node. `args` is the lossy view used for
/// matching, `raw_args` the untouched argv handed to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some((options, layout, cwd)) = parse(args).and_then(|options| {
        let (layout, cwd) = context(args)?;

        Some((options, layout, cwd))
    }) else {
        crate::process::delegate(raw_args);
    };

    let Some(discovery) = discover(&cwd, &options) else {
        crate::process::delegate(raw_args);
    };

    let Some(entries) = discovery.files.iter().map(|path| inspect(path, &options)).collect::<Option<Vec<_>>>() else {
        crate::process::delegate(raw_args);
    };

    if entries.iter().any(|entry| !is_plain(&entry.path)) {
        crate::process::delegate(raw_args);
    }

    let mut out = Output::default();

    if entries.is_empty() {
        pail(layout, &mut out, Level::Info, discovery.empty_message());

        finish(&out, 0);
    }

    let exit_code = report(layout, &options, entries, raw_args, &mut out);

    finish(&out, exit_code)
}

/// The flags this path understands, or `None` when the invocation needs Node. `args` is the full argv, so the
/// first word is `sort-package-json`. A value follows its flag as `--name value` or `--name=value`.
fn parse(args: &[String]) -> Option<Options> {
    let mut options = Options {
        check: false,
        editorconfig: true,
        final_newline: true,
        format: Format { bugs: true, repository: true, exports: true },
        ignore: Vec::new(),
        indent: None,
        line_ending: LineEnding::Auto,
        sort_order: Vec::new(),
        sort_scripts: false,
        unsorted: Vec::new(),
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut index = 1;

    // A lossy argv conversion turns invalid UTF-8 into U+FFFD. Node would see the raw bytes.
    if args.iter().any(|argument| argument.contains('\u{FFFD}')) {
        return None;
    }

    while index < args.len() {
        let token = args[index].as_str();
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (token, None),
        };

        let flag = match (name, inline) {
            ("--check" | "-c", None) => {
                options.check = true;
                "--check"
            }
            ("--sort-scripts", None) => {
                options.sort_scripts = true;
                name
            }
            ("--no-editorconfig", None) => {
                options.editorconfig = false;
                name
            }
            ("--no-final-newline", None) => {
                options.final_newline = false;
                name
            }
            ("--no-format-bugs", None) => {
                options.format.bugs = false;
                name
            }
            ("--no-format-repository", None) => {
                options.format.repository = false;
                name
            }
            ("--no-sort-exports", None) => {
                options.format.exports = false;
                name
            }
            ("--ignore" | "--indent" | "--line-ending" | "--sort-order" | "--unsorted", _) => {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        index += 1;

                        args.get(index)?.as_str()
                    }
                };

                if value.is_empty() || value.starts_with('-') {
                    return None;
                }

                match name {
                    "--ignore" => options.ignore.extend(split_list(value)),
                    "--sort-order" => options.sort_order.extend(split_list(value)),
                    "--unsorted" => options.unsorted.extend(split_list(value)),
                    "--indent" if !seen.contains(&name) => options.indent = Some(indent_override(value)?),
                    "--line-ending" if !seen.contains(&name) => {
                        options.line_ending = match value {
                            "auto" => LineEnding::Auto,
                            "lf" => LineEnding::Lf,
                            "crlf" => LineEnding::Crlf,
                            _ => return None,
                        };
                    }
                    _ => return None,
                }

                name
            }
            _ => return None,
        };

        // A repeated boolean or single-valued flag is Node's to interpret; the list flags may repeat.
        if seen.contains(&flag) && !matches!(flag, "--ignore" | "--sort-order" | "--unsorted") {
            return None;
        }

        seen.push(flag);
        index += 1;
    }

    options.ignore.iter().all(|pattern| glob_is_supported(pattern)).then_some(options)
}

/// `splitList`: comma-separated, trimmed, empty items dropped.
fn split_list(value: &str) -> impl Iterator<Item = String> + '_ {
    value.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_owned)
}

/// `resolveIndentOverride` for the values whose result `JSON.stringify` uses as written: a number of spaces,
/// `tab` or `\t`, or a string of spaces and tabs. Other strings are Node's.
fn indent_override(raw: &str) -> Option<String> {
    if raw == "tab" || raw == "\\t" {
        return Some("\t".to_owned());
    }

    if raw.bytes().all(|byte| byte.is_ascii_digit()) {
        // `JSON.stringify` uses at most ten characters, so a larger count only has to be a valid one.
        return raw.parse::<usize>().ok().filter(|_| raw.len() <= 9).map(|count| " ".repeat(count.min(10)));
    }

    raw.bytes().all(|byte| byte == b' ' || byte == b'\t').then(|| raw.to_owned())
}

/// Whether Node would reach the same answer, and the layout pail prints in. `None` is a delegation.
fn context(args: &[String]) -> Option<(Layout, PathBuf)> {
    let layout = Layout::detect(args)?;
    let cwd = env::current_dir().ok()?;

    // Node works from the workspace root, which this crate finds for a pnpm workspace; the file paths it
    // prints are the same only when that root is the working directory.
    if !ci_root_context(&cwd) || !quiet_context(&cwd, &cwd) || vis_config::read(&cwd) != ConfigState::Absent {
        return None;
    }

    Some((layout, cwd))
}

/// What the file search found, at each stage Node reports on.
struct Discovery {
    /// Every `package.json` of the workspace.
    found: usize,
    /// Those left after the `.gitignore` and the workspace exclusions.
    after_gitignore: usize,
    /// Those left after `--ignore`, in Node's order.
    files: Vec<PathBuf>,
}

impl Discovery {
    /// The notice of a run with nothing to sort.
    fn empty_message(&self) -> &'static str {
        if self.found == 0 {
            "No package.json files found."
        } else if self.after_gitignore == 0 {
            "All package.json files were excluded by .gitignore or workspace exclusions."
        } else {
            "All package.json files were excluded by --ignore."
        }
    }
}

/// The `package.json` files Node processes, in its order: the root's, then each workspace project's, minus
/// the ignored ones. `None` when anything on the way is outside what this module reproduces.
fn discover(root: &Path, options: &Options) -> Option<Discovery> {
    let patterns = workspace_patterns(root)?;
    let mut positives = Vec::new();
    let mut negatives = Vec::new();

    for pattern in &patterns {
        let clean = pattern.trim_end_matches('/');

        match clean.strip_prefix('!') {
            Some("") => {}
            Some(stripped) => negatives.push(stripped),
            None => positives.push(clean.to_owned()),
        }
    }

    let mut rules = root_rules(root)?;

    rules.extend(negatives.iter().copied())?;

    let mut directories: Vec<String> = Vec::new();

    for directory in expand_patterns(root, &positives, &|directory| directory.join("package.json").exists())? {
        if !directory.is_ascii() {
            return None;
        }

        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }

    let mut files = vec!["package.json".to_owned()];

    files.extend(
        directories
            .iter()
            .filter(|directory| !rules.ignores(directory, true))
            .map(|directory| format!("{directory}/package.json")),
    );

    let found: Vec<String> = files.into_iter().filter(|file| root.join(file).exists()).collect();
    let kept: Vec<&String> = found.iter().filter(|file| !rules.ignores(file, false)).collect();

    // `--ignore`: a pattern without a `/` is matched against the file name, one with it against the path from the root.
    let selected = kept
        .iter()
        .filter(|file| {
            !options.ignore.iter().any(|pattern| {
                glob_matches(pattern, if pattern.contains('/') { file.as_str() } else { "package.json" })
            })
        })
        .map(|file| root.join(file))
        .collect();

    Some(Discovery { found: found.len(), after_gitignore: kept.len(), files: selected })
}

/// The workspace patterns, as `findPackageJsonFiles` and `readWorkspacePatterns` read them: the `packages:`
/// list of the workspace YAML, else the `workspaces` array of the root `package.json` (none when it has none).
fn workspace_patterns(root: &Path) -> Option<Vec<String>> {
    for name in WORKSPACE_YAML_NAMES {
        let path = root.join(name);

        if path.exists() {
            let text = fs::read_to_string(&path).ok()?;

            if !text.is_ascii() {
                return None;
            }

            let patterns = yaml_packages(&text);

            if !patterns.is_empty() {
                return Some(patterns);
            }
        }
    }

    let text = fs::read_to_string(root.join("package.json")).ok()?;

    if text.starts_with('\u{feff}') {
        return None;
    }

    let manifest = json::parse(&text)?;

    match manifest.get("workspaces") {
        None => Some(Vec::new()),
        Some(Json::Array(entries)) if !entries.is_empty() => entries
            .iter()
            .map(|entry| entry.as_str().filter(|pattern| !pattern.trim().is_empty()).map(str::to_owned))
            .collect(),
        Some(_) => None,
    }
}

/// The built-in excludes and the root `.gitignore`, compiled; `None` for a line outside the subset.
fn root_rules(root: &Path) -> Option<gitignore::Rules> {
    let path = root.join(".gitignore");

    // Like Node, a `.gitignore` that is not a readable file counts as absent.
    if !path.is_file() {
        return gitignore::Rules::from_lines([]);
    }

    let text = String::from_utf8(fs::read(&path).ok()?).ok()?;

    gitignore::Rules::from_lines(text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)))
}

/// Whether `glob_matches` reproduces the matcher of Node (`zeptomatch`) for this `--ignore` pattern: names,
/// `*` and `?` that stay in one path segment.
fn glob_is_supported(pattern: &str) -> bool {
    !pattern.is_empty()
        && !pattern.starts_with('/')
        && !pattern.contains("**")
        && pattern.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && pattern.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"@._-*?/".contains(&byte))
}

/// `zeptomatch(pattern, target)` for the patterns `glob_is_supported` accepts: case-sensitive, anchored, `*`
/// any run of characters and `?` one character, neither crossing a `/`.
fn glob_matches(pattern: &str, target: &str) -> bool {
    let pattern_segments: Vec<&str> = pattern.split('/').collect();
    let target_segments: Vec<&str> = target.split('/').collect();

    pattern_segments.len() == target_segments.len()
        && pattern_segments
            .iter()
            .zip(&target_segments)
            .all(|(pattern, target)| segment_matches(pattern.as_bytes(), target.as_bytes()))
}

fn segment_matches(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;

    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if let Some((star_at, matched)) = star {
            p = star_at + 1;
            t = matched + 1;
            star = Some((star_at, matched + 1));
        } else {
            return false;
        }
    }

    pattern[p..].iter().all(|&byte| byte == b'*')
}

/// Sorts one file the way `sortContents` does and compares it with what is on disk. `None` is a delegation,
/// for every failure and for every file whose JSON JavaScript might read differently.
fn inspect(path: &Path, options: &Options) -> Option<Entry> {
    let contents = String::from_utf8(fs::read(path).ok()?).ok()?;

    if contents.starts_with('\u{feff}') {
        return None;
    }

    let Json::Object(original) = json::parse(&contents)? else {
        return None;
    };

    let sort_options = SortOptions::new().with_pretty(false).with_sort_scripts(options.sort_scripts);
    let compact = sort_package_json_with_options(&contents, &sort_options).ok()?;
    let Json::Object(mut object) = json::parse(&compact)? else {
        return None;
    };

    let defaults = if options.editorconfig {
        vis_core::editorconfig::resolve(path.to_str()?)
    } else {
        vis_core::editorconfig::Defaults::default()
    };
    let indent = options.indent.clone().or(defaults.indent).unwrap_or_else(|| detect_indent(&contents));
    let crlf = match options.line_ending {
        LineEnding::Crlf => true,
        LineEnding::Lf => false,
        LineEnding::Auto => defaults.line_ending.map_or_else(|| contents.contains("\r\n"), |ending| ending == "crlf"),
    };

    if !options.unsorted.is_empty() {
        object = fields::restore_unsorted(object, &original, &options.unsorted);
    }

    object = fields::apply_sort_order(object, &options.sort_order);
    fields::format_fields(&mut object, options.format);

    let mut sorted = json::stringify(&Json::Object(object), &indent);

    if options.final_newline {
        sorted.push('\n');
    }

    if crlf {
        sorted = sorted.replace('\n', "\r\n");
    }

    let verdict = if sorted == contents { Verdict::Sorted } else { Verdict::Rewrite(sorted) };

    Some(Entry { path: path.to_owned(), verdict })
}

/// `detectIndent`: the run of spaces and tabs after the first newline that is followed by one, else two spaces.
fn detect_indent(contents: &str) -> String {
    let bytes = contents.as_bytes();

    for (position, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' && matches!(bytes.get(position + 1), Some(b' ' | b'\t')) {
            let run = bytes[position + 1..].iter().take_while(|byte| matches!(byte, b' ' | b'\t')).count();

            return contents[position + 1..position + 1 + run].to_owned();
        }
    }

    "  ".to_owned()
}

/// Writes what has to be written and builds the report. Returns the exit code. A target that cannot be
/// opened is a delegation, decided before the first write.
fn report(layout: Layout, options: &Options, entries: Vec<Entry>, raw_args: &[OsString], out: &mut Output) -> i32 {
    let mut writes: Vec<(File, &str)> = Vec::new();

    if !options.check {
        for entry in &entries {
            if let Verdict::Rewrite(text) = &entry.verdict {
                // Opened without truncating, so a refusal leaves the file as it was and Node can still take over.
                let Ok(file) = crate::ignore::open_for_write(&entry.path) else {
                    crate::process::delegate(raw_args);
                };

                writes.push((file, text));
            }
        }
    }

    let mut written = writes.into_iter();
    let (mut unsorted, mut sorted, mut errors) = (0_usize, 0_usize, 0_usize);

    for entry in &entries {
        let path = entry.path.display().to_string();

        match &entry.verdict {
            Verdict::Sorted => sorted += 1,
            Verdict::Rewrite(_) if options.check => {
                unsorted += 1;
                pail(layout, out, Level::Warning, &format!("{path} is not sorted"));
            }
            Verdict::Rewrite(_) => {
                let (mut file, text) = written.next().expect("one open file per rewrite");

                match crate::ignore::overwrite(&mut file, text) {
                    Ok(()) => {
                        unsorted += 1;
                        pail(layout, out, Level::Success, &format!("Sorted {path}"));
                    }
                    Err(error) => {
                        errors += 1;
                        pail(layout, out, Level::Error, &format!("{path}: {error}"));
                        pail(layout, out, Level::Info, "  step: write");
                    }
                }
            }
        }
    }

    let plural = |count: usize| if count == 1 { "" } else { "s" };

    if options.check {
        if unsorted > 0 {
            pail(
                layout,
                out,
                Level::Info,
                &format!("{unsorted} file{} not sorted, {sorted} already sorted", plural(unsorted)),
            );
        } else if errors == 0 {
            pail(
                layout,
                out,
                Level::Info,
                &format!("All {sorted} package.json file{} sorted", if sorted == 1 { " is" } else { "s are" }),
            );
        }
    } else {
        let mut parts = Vec::new();

        if unsorted > 0 {
            parts.push(format!("sorted {unsorted} file{}", plural(unsorted)));
        }

        if sorted > 0 {
            parts.push(format!("{sorted} already sorted"));
        }

        if errors > 0 {
            parts.push(format!("{errors} error{}", plural(errors)));
        }

        if !parts.is_empty() {
            pail(layout, out, Level::Info, &parts.join(", "));
        }
    }

    i32::from((options.check && unsorted > 0) || errors > 0)
}

/// One pail block (see [`Layout::block`]). pail sends the error level to stderr and every other level to stdout.
fn pail(layout: Layout, out: &mut Output, level: Level, message: &str) {
    let buffer = if level.to_stderr() { &mut out.stderr } else { &mut out.stdout };

    buffer.push_str(&layout.block(level, message));
}

/// A path pail can print exactly: ASCII, no spaces, no control characters.
fn is_plain(path: &Path) -> bool {
    path.to_str().is_some_and(|text| text.bytes().all(|byte| byte.is_ascii_graphic()))
}

/// Prints what the run produced and exits with `exit_code`.
fn finish(out: &Output, exit_code: i32) -> ! {
    write_streams("sort-package-json", &out.stdout, &out.stderr);

    exit(exit_code)
}
