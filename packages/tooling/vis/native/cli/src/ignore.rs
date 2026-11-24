//! `vis ignore` — the native port of `src/commands/ignore/handler.ts` and `src/util/ignore-file.ts`.
//!
//! The pattern lists and the merge are copied from `ignore-file.ts`. The output also depends on
//! the workspace root, which Node finds with `@visulima/package`'s search. This crate only
//! answers when the working directory is that root by the rule in [`native_root_is_cwd`]
//! ([`native_context`]). Only the `--target`, `--json` and `--write` shapes are native.
//! Anything else (positionals, `--cwd`, unknown or invalid targets, non-UTF-8 files), a config or
//! Deno file, a terminal, a colour flag, and a run outside CI all go to Node via [`crate::delegate`]. The
//! dimmed hint of the preview is coloured when Node's colour detection says so ([`crate::term::piped_colour_level`]).

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use crate::error::WrapperError;
use crate::js::trim;
use crate::node_context::{any_ancestor_has, in_ci, native_root_is_cwd, DENO_FILES};
use crate::output::write_stdout;
use crate::vis_config::has_vis_config;

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

/// Whether Node would reach the same answer without a root search or any config or Deno file:
/// `Some(colour)` when it would, where `colour` is whether Node's colour detection puts the dimmed
/// hint in escape codes, and `None` for everything else. See the module docs for the list.
fn native_context(cwd: &Path, args: &[String]) -> Option<bool> {
    // Node's colour detection and path handling differ on Windows; the help route stays there too.
    if cfg!(windows) {
        return None;
    }

    let env_root = env::var_os("VIS_MONOREPO_ROOT");

    if !native_root_is_cwd(cwd, env_root.as_deref()) {
        return None;
    }

    let colour = crate::term::piped_colour_level(args)? > 0;

    (in_ci() && !has_vis_config(cwd) && !any_ancestor_has(cwd, &DENO_FILES)).then_some(colour)
}

/// Answer the invocation, or delegate to Node. `args` is the lossy view used for parsing;
/// `raw_args` is the untouched argv handed to Node, so non-UTF-8 bytes arrive unchanged. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(cwd) = env::current_dir().ok() else {
        crate::delegate(raw_args);
    };

    let (Some(options), Some(colour)) = (parse(args), native_context(&cwd, args)) else {
        crate::delegate(raw_args);
    };

    let Some(text) = execute(&options, &cwd, colour) else {
        crate::delegate(raw_args);
    };

    write_stdout("ignore", "the output", &text);

    exit(0)
}

/// The stdout text for the invocation, or `None` to hand the command to Node. Nothing is written
/// to disk before a `None` is returned, so the delegated run starts from the same state. Once the
/// ignore file is open for writing the file is truncated, so a failure from then on is reported
/// here and exits with 1: running Node on a damaged file would merge into it and report success.
fn execute(options: &Options, cwd: &Path, colour: bool) -> Option<String> {
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

        let mut file = open_for_write(&write_target(&path)?).ok()?;

        if let Err(error) = overwrite(&mut file, &merged.content) {
            WrapperError::write("ignore", options.filename, error).exit();
        }

        return Some(format!("Added {} pattern(s) to {}.\n", merged.added.len(), options.filename));
    }

    let mut text =
        if merged.content.ends_with('\n') { merged.content.clone() } else { format!("{}\n", merged.content) };

    let hint = format!("({} new pattern(s); re-run with --write to save {})", merged.added.len(), options.filename);

    // `dim` of the colour library: the hint inside its own escape pair when colour is on.
    if colour {
        text.push_str(&format!("\x1b[2m{hint}\x1b[22m\n"));
    } else {
        text.push_str(&format!("{hint}\n"));
    }

    Some(text)
}

/// The file a write to `path` lands in. Opening a symlink writes its target, as `fs::write` does. A
/// dangling link is `None`: Node would create the target, so the command is left to it.
fn write_target(path: &Path) -> Option<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(_) => fs::canonicalize(path).ok(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Some(path.to_owned()),
        Err(_) => None,
    }
}

/// Opens `path` for the way Node's `fs.writeFile` writes it: an existing file is rewritten in place,
/// so its inode, owner, hard links, ACLs and xattrs stay as they were, and a new file gets the default
/// mode. It does not truncate, so a refused open (read-only file, a directory) leaves the file as it
/// was and the caller can still hand the command to Node.
pub(crate) fn open_for_write(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create(true).truncate(false).open(path)
}

/// Replaces the contents of the file opened by `open_for_write`. Nothing is staged in a sibling, so
/// no copy of the contents exists with a looser mode than the destination's. A failure here can
/// leave the file truncated, as it can under Node.
pub(crate) fn overwrite(file: &mut File, contents: &str) -> io::Result<()> {
    file.set_len(0)?;
    file.write_all(contents.as_bytes())
}

#[cfg(test)]
fn write_in_place(path: &Path, contents: &str) -> io::Result<()> {
    overwrite(&mut open_for_write(path)?, contents)
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

struct Merged<'a> {
    added: Vec<&'a str>,
    content: String,
}

/// `mergeIgnore`: appends the patterns not already present (compared trimmed, case-sensitive,
/// comments skipped), under one header. Existing content is kept as it is.
fn merge<'a>(existing: &str, patterns: &[&'a str]) -> Merged<'a> {
    let mut present: HashSet<&str> = HashSet::new();

    for line in existing.split('\n') {
        let normalized = trim(line);

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

    let content = if trim(existing).is_empty() {
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
        assert_eq!(trim("\u{FEFF}x\u{85}"), "x\u{85}");
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
    fn a_read_only_destination_is_refused_and_left_untouched() {
        let directory = scratch("read-only");
        let target = directory.join(".dockerignore");

        fs::write(&target, "original\n").unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&target, permissions).unwrap();

        assert!(write_in_place(&target, "replacement\n").is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "original\n");

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_directory_destination_is_refused() {
        let directory = scratch("directory");
        let target = directory.join(".dockerignore");

        fs::create_dir(&target).unwrap();

        assert!(write_in_place(&target, "replacement\n").is_err());
        assert!(target.is_dir());

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_new_file_is_created_with_the_contents() {
        let directory = scratch("write-new");
        let target = directory.join(".dockerignore");

        write_in_place(&target, "new\n").unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "new\n");

        fs::remove_dir_all(&directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_write_keeps_the_inode_so_hard_links_receive_the_update() {
        use std::os::unix::fs::MetadataExt;

        let directory = scratch("hard-link");
        let target = directory.join(".dockerignore");
        let link = directory.join("linked");

        fs::write(&target, "old\n").unwrap();
        fs::hard_link(&target, &link).unwrap();
        let inode = fs::metadata(&target).unwrap().ino();

        write_in_place(&target, "new\n").unwrap();

        assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
        assert_eq!(fs::read_to_string(&link).unwrap(), "new\n");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);

        fs::remove_dir_all(&directory).unwrap();
    }
}
