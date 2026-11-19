//! `vis ignore` — the native port of `src/commands/ignore/handler.ts` and `src/util/ignore-file.ts`.
//!
//! The pattern lists and the merge are copied from `ignore-file.ts`. The output also depends on
//! the workspace root, which Node finds with `@visulima/package`'s search. This crate only
//! answers when `VIS_MONOREPO_ROOT` is the working directory and no ancestor holds a marker that
//! the search could stop at ([`native_context`]). Only the `--target`, `--json` and `--write`
//! shapes are native. Anything else (positionals, `--cwd`, unknown or invalid targets, non-UTF-8
//! files), a config or Deno file, a terminal, colour support, and a run outside CI all go to Node
//! via [`crate::delegate`].

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use crate::advisories::{any_ancestor_has, in_ci, DENO_FILES};
use crate::pm_family::has_vis_config;

/// Shared by every target. Order matters: it is the output order.
const BASE_PATTERNS: [&str; 39] = [
    ".git",
    ".gitattributes",
    ".gitignore",
    ".editorconfig",
    ".vscode/",
    ".idea/",
    ".DS_Store",
    "*.md",
    "LICENSE*",
    "LICENCE*",
    "CHANGELOG*",
    "CONTRIBUTING*",
    "AUTHORS*",
    "docs/",
    "doc/",
    "examples/",
    "example/",
    ".github/",
    ".gitlab-ci.yml",
    ".circleci/",
    "appveyor.yml",
    ".eslintrc*",
    "eslint.config.*",
    ".prettierrc*",
    "prettier.config.*",
    "*.log",
    "npm-debug.log*",
    "*.d.ts",
    "*.map",
    "*.flow",
    "tsconfig*.json",
    "__tests__/",
    "__mocks__/",
    "test/",
    "tests/",
    "*.test.*",
    "*.spec.*",
    "coverage/",
    ".nyc_output/",
];

const DOCKER_EXTRAS: [&str; 4] = ["node_modules", ".vis/", "Dockerfile*", ".dockerignore"];
const NPM_EXTRAS: [&str; 0] = [];
const SLUG_EXTRAS: [&str; 1] = ["node_modules"];
const VERCEL_EXTRAS: [&str; 2] = ["node_modules", ".vercel/"];

const VIS_SECTION_HEADER: &str = "# Added by vis ignore";

/// Markers that Node's root search (`findMonorepoRootSync`) reads in an ancestor. Finding one
/// strictly above the working directory means the root may not be the working directory.
const ROOT_MARKERS: [&str; 10] = [
    "lerna.json",
    "turbo.json",
    "pnpm-workspace.yaml",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
];

/// Environment variables that make Node's colour detection turn colour on for the stdout log
/// lines (the dimmed hint is printed there). Any of them sends the command to Node.
const COLOUR_ENVIRONMENT: [&str; 17] = [
    "FORCE_COLOR",
    "COLORTERM",
    "TERM_PROGRAM",
    "TERMINAL_EMULATOR",
    "TEAMCITY_VERSION",
    "TF_BUILD",
    "PM2_HOME",
    "GITEA_ACTIONS",
    "CIRCLECI",
    "GITHUB_WORKFLOW",
    "GITHUB_ACTIONS",
    "TRAVIS",
    "APPVEYOR",
    "GITLAB_CI",
    "BUILDKITE",
    "DRONE",
    "CI_NAME",
];

struct Options {
    target: &'static str,
    filename: &'static str,
    extras: &'static [&'static str],
    json: bool,
    write: bool,
}

/// Target name to its ignore file and target-only patterns, or `None` for an invalid target.
fn target_for(name: &str) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    match name {
        "docker" => Some(("docker", ".dockerignore", &DOCKER_EXTRAS)),
        "npm" => Some(("npm", ".npmignore", &NPM_EXTRAS)),
        "slug" => Some(("slug", ".slugignore", &SLUG_EXTRAS)),
        "vercel" => Some(("vercel", ".vercelignore", &VERCEL_EXTRAS)),
        _ => None,
    }
}

/// The flags this path understands, or `None` when the invocation needs Node. `args` is the full
/// argv, so the first word is `ignore`. Both `--name value` and `--name=value` are accepted for
/// `--target`, and each flag may appear once.
fn parse(args: &[String]) -> Option<Options> {
    let mut target: Option<&str> = None;
    let mut json = false;
    let mut write = false;
    let mut index = 1;

    while index < args.len() {
        let token = args[index].as_str();
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (token, None),
        };

        match (name, inline) {
            ("--json", None) if !json => json = true,
            ("--write", None) if !write => write = true,
            ("--target", _) if target.is_none() => {
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

                target = Some(value);
            }
            _ => return None,
        }

        index += 1;
    }

    // A lossy argv conversion turns invalid UTF-8 into U+FFFD. Node would see the raw bytes.
    if args.iter().any(|argument| argument.contains('\u{FFFD}')) {
        return None;
    }

    let (target, filename, extras) = target_for(target.unwrap_or("docker"))?;

    Some(Options { target, filename, extras, json, write })
}

/// Whether Node would reach the same answer without a root search or any config, Deno or
/// colour notice. See the module docs for the list.
fn native_context(cwd: &Path) -> bool {
    // Node's colour detection and path handling differ on Windows; the help route stays there too.
    if cfg!(windows) {
        return false;
    }

    let root = env::var_os("VIS_MONOREPO_ROOT").filter(|root| !root.is_empty()).map(PathBuf::from);

    if root.as_deref() != Some(cwd) {
        return false;
    }

    if cwd.ancestors().skip(1).any(|ancestor| ROOT_MARKERS.iter().any(|name| ancestor.join(name).exists())) {
        return false;
    }

    in_ci()
        && !io::stdout().is_terminal()
        && !io::stderr().is_terminal()
        && !colour_may_be_forced()
        && !has_vis_config(cwd)
        && !any_ancestor_has(cwd, &DENO_FILES)
}

/// Whether Node could colour the stdout log lines. A `TERM` other than a dumb or mono one also
/// counts, since Node reads it for the colour level.
fn colour_may_be_forced() -> bool {
    if COLOUR_ENVIRONMENT.iter().any(|key| env::var_os(key).is_some()) {
        return true;
    }

    env::var_os("TERM").is_some_and(|term| {
        let term = term.to_string_lossy().to_ascii_lowercase();

        !(term.contains("dumb") || term.contains("mono"))
    })
}

/// Answer the invocation, or delegate to Node. `args` is the lossy view used for parsing;
/// `raw_args` is the untouched argv handed to Node, so non-UTF-8 bytes arrive unchanged. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(cwd) = env::current_dir().ok() else {
        crate::delegate(raw_args);
    };

    let Some(options) = parse(args).filter(|_| native_context(&cwd)) else {
        crate::delegate(raw_args);
    };

    let Some(text) = execute(&options, &cwd) else {
        crate::delegate(raw_args);
    };

    let mut stdout = io::stdout().lock();

    match stdout.write_all(text.as_bytes()).and_then(|()| stdout.flush()) {
        Ok(()) => exit(0),
        // A closed pipe is not an error worth reporting.
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => exit(0),
        Err(error) => {
            eprintln!("vis ignore: failed to write the output: {error}");
            exit(1);
        }
    }
}

/// The stdout text for the invocation, or `None` to hand the command to Node. Nothing is
/// written to disk before a `None` is returned, so the delegated run starts from the same state.
fn execute(options: &Options, cwd: &Path) -> Option<String> {
    let path = cwd.join(options.filename);
    let existing = match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes).ok()?,
        // Node treats any read error as an empty file.
        Err(_) => String::new(),
    };

    let patterns = build_patterns(options.extras);
    let merged = merge(&existing, &patterns);

    if options.json {
        return Some(json_output(options, &merged.added));
    }

    if options.write {
        if merged.added.is_empty() {
            return Some(format!("{} is already up to date (no new patterns).\n", options.filename));
        }

        write_atomically(&write_target(&path)?, &merged.content).ok()?;

        return Some(format!("Added {} pattern(s) to {}.\n", merged.added.len(), options.filename));
    }

    let mut text =
        if merged.content.ends_with('\n') { merged.content.clone() } else { format!("{}\n", merged.content) };

    text.push_str(&format!(
        "({} new pattern(s); re-run with --write to save {})\n",
        merged.added.len(),
        options.filename
    ));

    Some(text)
}

/// The file a write to `path` lands in. `fs::write` follows a symlink and writes its target, so the
/// rename must target the resolved path too, or the link would be replaced by a regular file.
/// A dangling link is `None`: Node would create the target, so the write goes there instead.
fn write_target(path: &Path) -> Option<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(_) => fs::canonicalize(path).ok(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Some(path.to_owned()),
        Err(_) => None,
    }
}

/// A sibling of `path` that only this process names, so a concurrent writer cannot pick it.
fn temp_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();

    path.with_file_name(format!(".{name}.vis-{}.tmp", std::process::id()))
}

/// Replaces `path` with `contents` through a temporary file in the same directory and a rename, so
/// a failed write never leaves a truncated ignore file. The temporary file is removed when a step
/// after its creation fails; the caller delegates to Node, which reports the error.
fn write_atomically(path: &Path, contents: &str) -> io::Result<()> {
    // The rename below would replace a read-only destination that a direct write refuses, so
    // check the destination can be written first. Opening without truncating leaves it intact.
    if path.exists() {
        OpenOptions::new().write(true).open(path)?;
    }

    let temp = temp_path(path);
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;

    let result = (|| {
        file.write_all(contents.as_bytes())?;

        // A rename brings in the temporary file's mode, so keep the mode the target had.
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }

        file.sync_all()?;

        fs::rename(&temp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }

    result
}

/// `JSON.stringify({ added, file, target }, null, 2)` plus a newline. Every string is a constant
/// with no characters that need escaping.
fn json_output(options: &Options, added: &[&str]) -> String {
    let list = if added.is_empty() {
        "[]".to_owned()
    } else {
        let items: Vec<String> = added.iter().map(|pattern| format!("    \"{pattern}\"")).collect();

        format!("[\n{}\n  ]", items.join(",\n"))
    };

    format!(
        "{{\n  \"added\": {list},\n  \"file\": \"{}\",\n  \"target\": \"{}\"\n}}\n",
        options.filename, options.target
    )
}

/// `buildIgnorePatterns`: the base list then the target extras, keeping the first occurrence.
fn build_patterns(extras: &[&'static str]) -> Vec<&'static str> {
    let mut result: Vec<&'static str> = Vec::new();

    for pattern in BASE_PATTERNS.iter().chain(extras) {
        if !result.contains(pattern) {
            result.push(pattern);
        }
    }

    result
}

/// JavaScript's `String.prototype.trim`. It strips U+FEFF but not U+0085, which Rust's
/// `char::is_whitespace` gets the other way round.
fn is_js_space(character: char) -> bool {
    character == '\u{FEFF}' || (character.is_whitespace() && character != '\u{85}')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

struct Merged<'a> {
    added: Vec<&'a str>,
    content: String,
}

/// `mergeIgnore`: appends the patterns not already present (compared trimmed, case-sensitive,
/// comments skipped), under one header. Existing content is kept as it is.
fn merge<'a>(existing: &str, patterns: &[&'a str]) -> Merged<'a> {
    let mut present: HashSet<&str> = HashSet::new();

    for line in existing.split('\n') {
        let normalized = js_trim(line);

        if !normalized.is_empty() && !normalized.starts_with('#') {
            present.insert(normalized);
        }
    }

    let mut added: Vec<&'a str> = Vec::new();

    for pattern in patterns {
        if present.insert(pattern) {
            added.push(pattern);
        }
    }

    if added.is_empty() {
        return Merged { added, content: existing.to_owned() };
    }

    let eol = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut block = String::from(VIS_SECTION_HEADER);

    for pattern in &added {
        block.push_str(eol);
        block.push_str(pattern);
    }

    let content = if js_trim(existing).is_empty() {
        format!("{block}{eol}")
    } else {
        let separator = if existing.ends_with('\n') { eol.to_owned() } else { format!("{eol}{eol}") };

        format!("{existing}{separator}{block}{eol}")
    };

    Merged { added, content }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn parse_accepts_the_plain_shapes() {
        let options = parse(&argv(&["ignore"])).expect("bare ignore is native");

        assert_eq!(
            (options.target, options.filename, options.json, options.write),
            ("docker", ".dockerignore", false, false)
        );

        let options = parse(&argv(&["ignore", "--target", "vercel", "--write"])).expect("space form is native");

        assert_eq!((options.target, options.filename, options.write), ("vercel", ".vercelignore", true));

        let options = parse(&argv(&["ignore", "--target=slug", "--json"])).expect("inline form is native");

        assert_eq!((options.target, options.filename, options.json), ("slug", ".slugignore", true));
    }

    #[test]
    fn parse_delegates_every_other_shape() {
        for words in [
            vec!["ignore", "extra"],
            vec!["ignore", "--target=bogus"],
            vec!["ignore", "--target="],
            vec!["ignore", "--target", "--write"],
            vec!["ignore", "--target"],
            vec!["ignore", "--json", "--json"],
            vec!["ignore", "--cwd", "."],
            vec!["ignore", "--write=true"],
        ] {
            assert!(parse(&argv(&words)).is_none(), "{words:?} must delegate");
        }
    }

    #[test]
    fn merge_on_an_empty_file_writes_only_the_block() {
        let merged = merge("", &["a", "b"]);

        assert_eq!(merged.added, vec!["a", "b"]);
        assert_eq!(merged.content, "# Added by vis ignore\na\nb\n");
    }

    #[test]
    fn merge_keeps_crlf_and_adds_a_separator_without_a_trailing_newline() {
        let merged = merge("a\r\n# note\r\nc", &["a", "b"]);

        assert_eq!(merged.added, vec!["b"]);
        assert_eq!(merged.content, "a\r\n# note\r\nc\r\n\r\n# Added by vis ignore\r\nb\r\n");
    }

    #[test]
    fn merge_treats_whitespace_only_content_as_empty() {
        assert_eq!(merge("  \n\n", &["a"]).content, "# Added by vis ignore\na\n");
    }

    #[test]
    fn js_trim_strips_bom_but_not_next_line() {
        assert_eq!(js_trim("\u{FEFF}x\u{85}"), "x\u{85}");
    }

    #[test]
    fn build_patterns_keeps_the_first_occurrence() {
        let patterns = build_patterns(&["node_modules", ".git"]);

        assert_eq!(patterns.iter().filter(|pattern| **pattern == ".git").count(), 1);
        assert_eq!(patterns.last(), Some(&"node_modules"));
    }

    fn scratch(name: &str) -> PathBuf {
        let directory = env::temp_dir().join(format!("vis-ignore-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();

        directory
    }

    #[test]
    fn a_failed_write_leaves_the_original_file_untouched() {
        let directory = scratch("write-failure");
        let target = directory.join(".dockerignore");

        fs::write(&target, "original\n").unwrap();
        // Another writer already holds the temporary name, so creating it fails before the target is touched.
        fs::write(temp_path(&target), "theirs\n").unwrap();

        assert!(write_atomically(&target, "replacement\n").is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "original\n");
        // The file was not created by this write, so the failed write must not remove it.
        assert_eq!(fs::read_to_string(temp_path(&target)).unwrap(), "theirs\n");

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_read_only_destination_is_refused_and_left_untouched() {
        let directory = scratch("read-only");
        let target = directory.join(".dockerignore");

        fs::write(&target, "original\n").unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&target, permissions).unwrap();

        assert!(write_atomically(&target, "replacement\n").is_err());
        assert!(!temp_path(&target).exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "original\n");

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_failed_rename_removes_the_temporary_file() {
        let directory = scratch("rename-failure");
        let target = directory.join(".dockerignore");

        // A file cannot be renamed over a directory, so the rename after the temporary write fails.
        fs::create_dir(&target).unwrap();

        assert!(write_atomically(&target, "replacement\n").is_err());
        assert!(!temp_path(&target).exists());
        assert!(target.is_dir());

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_successful_write_replaces_the_file_and_leaves_no_temporary_file() {
        let directory = scratch("write-success");
        let target = directory.join(".dockerignore");

        fs::write(&target, "old\n").unwrap();
        write_atomically(&target, "new\n").unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "new\n");
        assert!(!temp_path(&target).exists());

        fs::remove_dir_all(&directory).unwrap();
    }
}
