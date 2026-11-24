//! `vis hook list` — the native fast path.
//!
//! The Node handler (`src/commands/hook/list.ts`) reads every standard stage script of the hooks directory, splits
//! it into the `# id: name` blocks `vis hook migrate` writes and prints one line per block. It reads files and
//! prints text, so the whole answer comes from the directory. This module prints the same text, and hands to
//! Node, before anything is printed, whatever it cannot reproduce byte for byte:
//!
//! - an argument other than `--hooks-dir <dir>` / `--hooks-dir=<dir>` (at most once), or a directory the argument
//!   parser could read as something other than a string, or that is not a plain relative path;
//! - a context other than the one the other read-only commands answer (`native_context`: a CI context off a
//!   terminal at the root of a pnpm workspace, no `vis.config`, no Deno file) or any output setting that changes
//!   what Node prints;
//! - a hooks directory that is not a directory, an entry that cannot be read, and a stage script that is not plain
//!   ASCII text: the header pattern and the length checks of the handler work on UTF-16 text and JavaScript's
//!   notion of white space, which this module reproduces for printable ASCII, tab and line feed only.

use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::Path;
use std::process::exit;

use crate::node_context::{native_context, output_settings_are_default};
use crate::output::write_stdout;

pub(super) const DEFAULT_HOOKS_DIRECTORY: &str = ".vis/hooks";

/// The standard git hooks, `HOOKS` in `src/commands/hook/constants.ts`. Sorted by byte order, which is also the
/// order `localeCompare` gives these names (the parity suite lists all of them).
pub(super) const STAGES: [&str; 14] = [
    "applypatch-msg",
    "commit-msg",
    "post-applypatch",
    "post-checkout",
    "post-commit",
    "post-merge",
    "post-rewrite",
    "pre-applypatch",
    "pre-auto-gc",
    "pre-commit",
    "pre-merge-commit",
    "pre-push",
    "pre-rebase",
    "prepare-commit-msg",
];

/// The handler cuts a first command line of more than this many characters to `DISPLAY_KEPT` of them and `...`.
const DISPLAY_LIMIT: usize = 120;
const DISPLAY_KEPT: usize = 117;

#[derive(Debug, PartialEq)]
struct Block {
    command: String,
    id: String,
    name: Option<String>,
}

struct Stage {
    blocks: Vec<Block>,
    raw_line_count: usize,
    stage: &'static str,
}

/// The hooks directory the arguments of `hook <subcommand>` ask for, or `None` when the invocation is not a shape this
/// module (or `validate`, which takes the same option) answers.
pub(super) fn parse(args: &[String], subcommand: &str) -> Option<String> {
    match args {
        [command, name] if command == "hook" && name == subcommand => Some(DEFAULT_HOOKS_DIRECTORY.to_owned()),
        [command, name, flag, value] if command == "hook" && name == subcommand && flag == "--hooks-dir" => {
            is_plain_directory(value).then(|| value.clone())
        }
        [command, name, flag] if command == "hook" && name == subcommand => {
            let value = flag.strip_prefix("--hooks-dir=")?;

            is_plain_directory(value).then(|| value.to_owned())
        }
        _ => None,
    }
}

/// A relative path of plain segments that the argument parser keeps as the string it is: no segment is empty, `.`
/// or `..` (the handler normalises the path it reads and prints the one it was given), and the value could not be
/// read as a number, a boolean or a flag.
fn is_plain_directory(value: &str) -> bool {
    let first = value.chars().next();
    let starts_plain = first.is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        || (first == Some('.')
            && value.chars().nth(1).is_some_and(|character| character.is_ascii_alphabetic() || character == '_'));
    let reserved = ["true", "false", "null", "undefined", "nan", "infinity"];

    starts_plain
        && !reserved.iter().any(|word| value.eq_ignore_ascii_case(word))
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

/// Whether the text is one this module reads like JavaScript does: printable ASCII, tab and line feed.
fn is_plain_text(bytes: &[u8]) -> bool {
    bytes.iter().all(|byte| matches!(byte, b'\t' | b'\n' | 0x20..=0x7e))
}

/// White space as `\s` and `trim` see it in plain text.
const fn is_space(byte: u8) -> bool {
    byte == b' ' || byte == b'\t'
}

/// `HOOK_HEADER_RE` (`^# ([^:\s]\S*)(?::\s+(.+))?$`) on one line of plain text: the id and the name.
///
/// The id is the longest run of non-space characters that leaves either nothing or `:`, white space and at least one
/// more character, which is the name. So the id of `# a:b: c` is `a:b`, and a line of `# id:` and white space
/// takes the last white-space character as its name.
fn header(line: &str) -> Option<(&str, Option<&str>)> {
    let rest = line.strip_prefix("# ")?;
    let bytes = rest.as_bytes();

    if bytes.first().is_none_or(|&byte| byte == b':' || is_space(byte)) {
        return None;
    }

    let token_end = bytes.iter().position(|&byte| is_space(byte)).unwrap_or(bytes.len());

    if token_end == bytes.len() {
        return Some((rest, None));
    }

    if bytes[token_end - 1] != b':' {
        return None;
    }

    let after = &bytes[token_end..];
    let spaces = after.iter().take_while(|&&byte| is_space(byte)).count();
    let name_start = if spaces == after.len() {
        // `\s+` gives one character back to `.+`.
        if spaces < 2 {
            return None;
        }

        token_end + spaces - 1
    } else {
        token_end + spaces
    };

    Some((&rest[..token_end - 1], Some(&rest[name_start..])))
}

/// `parseStageScript`: the blocks of one stage script.
fn parse_stage_script(content: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut current: Option<Block> = None;

    for line in content.split('\n') {
        if line.starts_with("#!")
            || line.starts_with("# Generated by")
            || line.starts_with("# NOTE:")
            || line == "set -e"
            || line.is_empty()
        {
            continue;
        }

        if let Some((id, name)) = header(line) {
            blocks.extend(current.take());
            current = Some(Block { command: String::new(), id: id.to_owned(), name: name.map(str::to_owned) });

            continue;
        }

        match current.as_mut() {
            Some(block) if !block.command.is_empty() => {
                block.command.push('\n');
                block.command.push_str(line);
            }
            Some(block) => block.command = line.to_owned(),
            None => current = Some(Block { command: line.to_owned(), id: "(custom)".to_owned(), name: None }),
        }
    }

    blocks.extend(current);

    blocks
}

/// The stage scripts of `directory`, sorted. `None` when reading any of it fails or yields text this module does not
/// reproduce: the handler then throws or prints something this module cannot match.
fn read_stages(directory: &Path) -> Option<Vec<Stage>> {
    match fs::metadata(directory) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return None,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    }

    let mut stages = Vec::new();

    for entry in fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };

        // Anything that is not a standard stage is skipped without a look, as the handler does.
        let Some(stage) = STAGES.iter().find(|stage| **stage == name) else { continue };

        if !fs::metadata(entry.path()).ok()?.is_file() {
            continue;
        }

        let bytes = fs::read(entry.path()).ok()?;

        if !is_plain_text(&bytes) {
            return None;
        }

        let content = String::from_utf8(bytes).ok()?;

        stages.push(Stage { blocks: parse_stage_script(&content), raw_line_count: content.split('\n').count(), stage });
    }

    stages.sort_by_key(|stage| stage.stage);

    Some(stages)
}

/// `formatListResult`, one string per line the handler logs.
fn lines(hooks_directory: &str, stages: &[Stage]) -> Vec<String> {
    if stages.is_empty() {
        return vec![format!("No hooks installed in {hooks_directory}/.")];
    }

    let mut lines = vec![format!("Hooks in {hooks_directory}/:")];

    for entry in stages {
        lines.push(String::new());
        lines.push(format!("{} ({} lines)", entry.stage, entry.raw_line_count));

        if entry.blocks.is_empty() {
            lines.push("  (empty)".to_owned());

            continue;
        }

        for block in &entry.blocks {
            match &block.name {
                Some(name) => lines.push(format!("  - {} \u{2014} {name}", block.id)),
                None => lines.push(format!("  - {}", block.id)),
            }

            if let Some(first) =
                block.command.split('\n').find(|line| !line.trim_matches(|c| c == ' ' || c == '\t').is_empty())
            {
                if first.len() > DISPLAY_LIMIT {
                    lines.push(format!("      {}...", &first[..DISPLAY_KEPT]));
                } else {
                    lines.push(format!("      {first}"));
                }
            }
        }
    }

    lines
}

/// Whether Node would reach the same answer from the working directory: a unix CI run off a terminal at the root of a
/// pnpm workspace, with none of the settings that change what Node prints.
pub(crate) fn context_is_native() -> bool {
    cfg!(unix) && output_settings_are_default() && !io::stdout().is_terminal() && native_context()
}

/// The text Node prints, or `None` when Node has to answer.
fn answer(args: &[String]) -> Option<String> {
    let hooks_directory = parse(args, "list")?;

    if !context_is_native() {
        return None;
    }

    let root = std::env::current_dir().ok()?;
    let stages = read_stages(&root.join(&hooks_directory))?;

    Some(lines(&hooks_directory, &stages).iter().map(|line| format!("{line}\n")).collect())
}

/// Answers `vis hook list` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(text) = answer(args) else { crate::delegate(raw_args) };

    write_stdout("hook", "the hook list", &text);

    exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_hooks_directory_is_the_only_option() {
        assert_eq!(parse(&argv(&["hook", "list"]), "list").as_deref(), Some(".vis/hooks"));
        assert_eq!(parse(&argv(&["hook", "list", "--hooks-dir", ".githooks"]), "list").as_deref(), Some(".githooks"));
        assert_eq!(parse(&argv(&["hook", "list", "--hooks-dir=ci/hooks"]), "list").as_deref(), Some("ci/hooks"));
    }

    #[test]
    fn every_other_shape_is_left_to_node() {
        for shape in [
            &["hook", "list", "--json"][..],
            &["hook", "list", "extra"],
            &["hook", "list", "--hooks-dir"],
            &["hook", "list", "--hooks-dir="],
            &["hook", "list", "--hooks-dir", "/abs"],
            &["hook", "list", "--hooks-dir", "a/../b"],
            &["hook", "list", "--hooks-dir", "a//b"],
            &["hook", "list", "--hooks-dir", "dir/"],
            &["hook", "list", "--hooks-dir", "."],
            &["hook", "list", "--hooks-dir", "123"],
            &["hook", "list", "--hooks-dir", "true"],
            &["hook", "list", "--hooks-dir", "-x"],
            &["hook", "list", "--hooks-dir", "a b"],
            &["hook", "list", "--hooks-dir", "\u{e4}"],
            &["hook", "list", "--hooks-dir", "a", "--hooks-dir", "b"],
            &["hook", "validate"],
            &["hook"],
        ] {
            assert_eq!(parse(&argv(shape), "list"), None, "{shape:?}");
        }
    }

    #[test]
    fn a_header_takes_the_longest_id() {
        assert_eq!(header("# lint"), Some(("lint", None)));
        assert_eq!(header("# lint: Lint files"), Some(("lint", Some("Lint files"))));
        assert_eq!(header("# a:b: c"), Some(("a:b", Some("c"))));
        assert_eq!(header("# a:b"), Some(("a:b", None)));
        assert_eq!(header("# id:"), Some(("id:", None)));
        assert_eq!(header("# id:  name  x "), Some(("id", Some("name  x "))));
        assert_eq!(header("# id:  "), Some(("id", Some(" "))));
    }

    #[test]
    fn a_line_without_a_header_shape_is_a_command() {
        for line in ["#id", "# ", "#  x", "# :x", "# a b", "# id: ", "echo", "# a:b c"] {
            assert_eq!(header(line), None, "{line:?}");
        }
    }

    #[test]
    fn a_script_without_headers_is_one_custom_block() {
        let blocks = parse_stage_script("#!/bin/sh\nset -e\n\necho a\necho b\n");

        assert_eq!(blocks, vec![Block { command: "echo a\necho b".to_owned(), id: "(custom)".to_owned(), name: None }]);
    }

    #[test]
    fn long_commands_are_cut() {
        let stage = Stage {
            blocks: vec![Block { command: "x".repeat(121), id: "a".to_owned(), name: None }],
            raw_line_count: 3,
            stage: "pre-commit",
        };

        assert_eq!(lines(".vis/hooks", &[stage])[4], format!("      {}...", "x".repeat(117)));
    }

    #[test]
    fn the_stage_table_is_sorted() {
        let mut sorted = STAGES;

        sorted.sort_unstable();

        assert_eq!(sorted, STAGES);
    }
}
