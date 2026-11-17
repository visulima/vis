//! The command surface the native binary answers on its own: bare `vis`,
//! `--help`, `<command> --help` and `help [command]`, rendered from the
//! manifest so they never wait on Node and never differ by which engine answers.
//!
//! Anything this module is not certain about is left to the Node CLI by
//! returning `None`.

use std::env;
use std::io::{self, Write};

use crate::help::{Help, Style};
use crate::manifest::{Command, Manifest};
use crate::term;

/// Commands whose flags after the command belong to the tool they run, so
/// `--help` is not vis's to answer.
///
/// `remove`, `dedupe`, `link`, `unlink`, `outdated` and `why` are included because the
/// native front-end already forwards their flags (`--help` too) to the package manager.
const PASSTHROUGH: &[&str] = &["exec", "x", "pm", "remove", "dedupe", "link", "unlink", "outdated", "why"];

/// Global flags that take no value and may precede the command.
fn is_valueless_global(argument: &str) -> bool {
    matches!(argument, "--no-color" | "--color" | "-v" | "--verbose" | "--debug" | "-q" | "--quiet")
}

fn is_help_flag(argument: &str) -> bool {
    matches!(argument, "--help" | "-h")
}

/// What an invocation asks for, once leading global flags are set aside.
struct Request<'a> {
    /// Leading non-flag words: the command path, then any positionals.
    words: Vec<&'a str>,
    /// Everything from the first flag on.
    flags: &'a [String],
}

impl<'a> Request<'a> {
    fn parse(args: &'a [String]) -> Self {
        let start = args.iter().take_while(|argument| is_valueless_global(argument)).count();
        let rest = &args[start..];
        let words: Vec<&str> =
            rest.iter().take_while(|argument| !argument.starts_with('-')).map(String::as_str).collect();

        Self { flags: &rest[words.len()..], words }
    }

    fn wants_help(&self) -> bool {
        self.flags.iter().take_while(|flag| *flag != "--").any(|flag| is_help_flag(flag))
    }

    /// Only help and valueless globals follow the command, so nothing else needs the Node CLI's parser.
    fn flags_are_plain(&self) -> bool {
        self.flags.iter().all(|flag| is_help_flag(flag) || is_valueless_global(flag))
    }
}

/// Resolve a command the way the Node CLI does: the longest full path among the
/// leading words, else the first word as a key (name or alias).
fn resolve<'m>(manifest: &'m Manifest, words: &[&str]) -> Option<&'m Command> {
    (1..=words.len()).rev().find_map(|length| {
        let candidate = words[..length].join(" ");

        manifest.commands.iter().find(|command| command.path_string() == candidate).or_else(|| {
            if length == 1 {
                manifest.by_key(&candidate)
            } else {
                None
            }
        })
    })
}

fn emit(text: &str) {
    let mut stdout = io::stdout().lock();

    // A closed pipe (`vis --help | head`) is not an error worth reporting.
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

/// Answer the invocation natively, returning the exit code, or `None` to let the
/// caller delegate it.
pub fn answer(args: &[String]) -> Option<i32> {
    let request = Request::parse(args);

    if request.words.first().is_some_and(|word| PASSTHROUGH.contains(word)) {
        return None;
    }

    let bare = args.is_empty();
    let root_help = request.words.is_empty() && request.flags_are_plain() && (bare || request.wants_help());
    let help_command = request.words.first() == Some(&"help");

    if !root_help && !help_command && !(request.wants_help() && !request.words.is_empty()) {
        return None;
    }

    let manifest = Manifest::load();
    let version = env::var("VIS_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned());
    let help = Help {
        manifest: &manifest,
        style: Style { color: term::color_enabled(args) },
        width: term::terminal_width(),
        version: &version,
    };

    if root_help {
        emit(&help.root(None));

        return Some(0);
    }

    if help_command {
        return answer_help_command(&manifest, &help, &request);
    }

    let command = resolve(&manifest, &request.words)?;

    // The lean entry only serves `dlx`/`exec` when they are the first argument.
    emit(&help.command(command, command.lean && args.first().map(String::as_str) == request.words.first().copied()));

    Some(0)
}

/// Levenshtein distance between two short words.
fn distance(left: &str, right: &str) -> usize {
    let right: Vec<char> = right.chars().collect();
    let mut row: Vec<usize> = (0..=right.len()).collect();

    for (index, left_char) in left.chars().enumerate() {
        let mut diagonal = row[0];

        row[0] = index + 1;

        for (column, right_char) in right.iter().enumerate() {
            let above = row[column + 1];

            row[column + 1] = (row[column] + 1).min(above + 1).min(diagonal + usize::from(left_char != *right_char));
            diagonal = above;
        }
    }

    row[right.len()]
}

/// The candidate closest to `word`, if it is close enough to be a plausible typo.
fn closest<'a>(word: &str, candidates: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let limit = 2.max(word.chars().count() / 3);

    candidates
        .map(|candidate| (distance(word, candidate), candidate))
        .filter(|(distance, _)| *distance <= limit)
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, candidate)| candidate)
}

/// `vis frobnicate` printed nothing and exited 1. When the first word is not a command,
/// an alias, or the start of any command path, say so (with the closest command when
/// one is a plausible typo) and exit 1. Everything else, including bare parents of
/// subcommands, flags-first invocations and internal `__` entry points, returns `None`
/// and is delegated untouched.
pub fn reject_unknown(args: &[String]) -> Option<i32> {
    let request = Request::parse(args);
    let word = *request.words.first()?;

    if word.starts_with("__") {
        return None;
    }

    let manifest = Manifest::load();

    if resolve(&manifest, &request.words).is_some() || !manifest.subcommands_of(&[word]).is_empty() {
        return None;
    }

    let visible = manifest.commands.iter().filter(|command| !command.hidden);
    // First path words, plus the aliases of top-level commands (`vis i`).
    let names = visible.flat_map(|command| {
        let aliases = if command.command_path.is_empty() { command.alias.as_slice() } else { &[] };

        command.path().into_iter().take(1).chain(aliases.iter().map(String::as_str))
    });

    match closest(word, names) {
        Some(candidate) => eprintln!("Error: Unknown command \"{word}\". Did you mean \"{candidate}\"?"),
        None => eprintln!("Error: Unknown command \"{word}\"."),
    }

    eprintln!("Run \"vis --help\" to see the available commands.");

    Some(1)
}

/// `vis help [<command path>…] [--group <name>]`.
fn answer_help_command(manifest: &Manifest, help: &Help, request: &Request) -> Option<i32> {
    let path = &request.words[1..];

    if let [flag, group] = request.flags {
        if path.is_empty() && flag == "--group" {
            emit(&help.root(Some(group)));

            return Some(0);
        }
    }

    if !request.flags_are_plain() {
        return None;
    }

    if path.is_empty() {
        emit(&help.root(None));

        return Some(0);
    }

    let joined = path.join(" ");

    if let Some(command) = manifest.find_for_help(&joined) {
        emit(&help.command(command, false));

        return Some(0);
    }

    let subcommands = manifest.subcommands_of(path);

    if !subcommands.is_empty() {
        emit(&help.subcommands(path, &subcommands));

        return Some(0);
    }

    // The Node CLI prints the banner, reports the miss on stderr, and still exits 0.
    emit(&format!("vis v{}\n", help.version));
    eprintln!("Command \"{joined}\" not found");

    Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_counts_edits() {
        assert_eq!(distance("instal", "install"), 1);
        assert_eq!(distance("abc", "abc"), 0);
        assert_eq!(distance("kitten", "sitting"), 3);
    }

    #[test]
    fn closest_ignores_far_words() {
        assert_eq!(closest("instal", ["run", "install"].into_iter()), Some("install"));
        assert_eq!(closest("frobnicate", ["run", "install"].into_iter()), None);
    }
}
