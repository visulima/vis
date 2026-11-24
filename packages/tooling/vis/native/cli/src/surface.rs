//! The command surface the native binary answers on its own: bare `vis`,
//! `--help`, `<command> --help` and `help [command]`, rendered from the
//! manifest so they never wait on Node and never differ by which engine answers.
//!
//! Anything this module is not certain about is left to the Node CLI by
//! returning `None`.

use std::io::{self, Write};

use crate::help::{Help, Style};
use crate::manifest::{self, Manifest, Routed, Routes};
use crate::term;

/// Global flags that take no value and may precede the command.
fn is_valueless_global(argument: &str) -> bool {
    matches!(argument, "--no-color" | "--color" | "-v" | "--verbose" | "--debug" | "-q" | "--quiet")
}

fn is_help_flag(argument: &str) -> bool {
    matches!(argument, "--help" | "-h")
}

/// `args` without the valueless global flags that lead it.
pub fn without_leading_globals(args: &[String]) -> &[String] {
    let start = args.iter().take_while(|argument| is_valueless_global(argument)).count();

    &args[start..]
}

/// Command groups that have no command of their own. Their bare form and `--help` list the
/// subcommands, as `help <group>` does; the Node CLI prints the same (`bin/group-listing.mjs`, whose
/// list has to match this one).
const GROUP_LISTINGS: &[&str] = &["cache"];

/// What an invocation asks for, once leading global flags are set aside.
struct Request<'a> {
    /// Leading non-flag words: the command path, then any positionals.
    words: Vec<&'a str>,
    /// Everything from the first flag on.
    flags: &'a [String],
}

impl<'a> Request<'a> {
    fn parse(args: &'a [String]) -> Self {
        let rest = without_leading_globals(args);
        let words: Vec<&str> =
            rest.iter().take_while(|argument| !argument.starts_with('-')).map(String::as_str).collect();

        Self { flags: &rest[words.len()..], words }
    }

    /// A listed group with nothing but help and valueless global flags after it.
    fn is_group_listing(&self) -> bool {
        matches!(self.words.as_slice(), [group] if GROUP_LISTINGS.contains(group)) && self.flags_are_plain()
    }

    fn wants_help(&self) -> bool {
        self.flags.iter().take_while(|flag| *flag != "--").any(|flag| is_help_flag(flag))
    }

    /// Only help and valueless globals follow the command, so nothing else needs the Node CLI's parser.
    fn flags_are_plain(&self) -> bool {
        self.flags.iter().all(|flag| is_help_flag(flag) || is_valueless_global(flag))
    }
}

fn emit(text: &str) {
    let mut stdout = io::stdout().lock();

    // A closed pipe (`vis --help | head`) is not an error worth reporting.
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

/// As `emit`, on stderr, where a closed stream is no more worth a panic than on stdout.
fn emit_stderr(text: &str) {
    let mut stderr = io::stderr().lock();

    let _ = stderr.write_all(text.as_bytes());
    let _ = stderr.flush();
}

/// Whether the invocation asks for help (`--help` / `-h` before any `--`).
pub fn asks_for_help(args: &[String]) -> bool {
    Request::parse(args).wants_help()
}

/// Answer the invocation natively, returning the exit code, or `None` to let the
/// caller delegate it.
pub fn answer(args: &[String]) -> Option<i32> {
    // A leading `--version` / `-V` does not matter once help is asked for: cerebro checks help first.
    let invoked = args;
    let args = match args.first().map(String::as_str) {
        Some("--version" | "-V") if asks_for_help(args) => &args[1..],
        _ => args,
    };
    let request = Request::parse(args);

    let bare = args.is_empty();
    let root_help = request.words.is_empty() && request.flags_are_plain() && (bare || request.wants_help());
    let help_command = request.words.first() == Some(&"help");

    let group_listing = request.is_group_listing();

    if !root_help && !help_command && !group_listing && !(request.wants_help() && !request.words.is_empty()) {
        return None;
    }

    let manifest = Manifest::load();
    let version = crate::node_contract::version();
    // The bare group's listing goes to stderr but takes its colour from stdout, as in the Node CLI. A colour or
    // width only Node can decide (a width asked of a terminal) hands the run to it before any output.
    let destination = if group_listing && !request.wants_help() { term::Stream::Stderr } else { term::Stream::Stdout };
    let help = Help {
        manifest: &manifest,
        style: Style { color: term::help_colour(args, destination)? },
        width: term::terminal_width()?,
        version: &version,
    };

    if root_help {
        emit(&help.root(None));

        return Some(0);
    }

    if help_command {
        return answer_help_command(&manifest, &help, &request);
    }

    if group_listing {
        let listing = help_text(&manifest, &help, &request.words)?;

        if request.wants_help() {
            emit(&listing);

            return Some(0);
        }

        // The bare group is a usage error, like the other bare groups: nothing on stdout, exit 1.
        emit_stderr(&listing);

        return Some(1);
    }

    let command = manifest::resolve(&manifest.commands, &request.words)?;

    // The lean entry only serves `dlx`/`exec` when they are the first argument.
    emit(&help.command(command, command.lean && invoked.first().map(String::as_str) == request.words.first().copied()));

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

    // Runs for every invocation Node serves, so it reads only the routing fields.
    let routes = Routes::load();

    if manifest::resolve(&routes.commands, &request.words).is_some()
        || !manifest::subcommands_of(&routes.commands, &[word]).is_empty()
    {
        return None;
    }

    let visible = routes.commands.iter().filter(|command| !command.hidden());
    // First path words, plus the aliases of top-level commands (`vis i`).
    let names = visible.flat_map(|command| {
        let aliases = if command.command_path().is_empty() { command.alias() } else { &[] };

        command.path().into_iter().take(1).chain(aliases.iter().map(String::as_str))
    });

    match closest(word, names) {
        Some(candidate) => emit_stderr(&format!("Error: Unknown command \"{word}\". Did you mean \"{candidate}\"?\n")),
        None => emit_stderr(&format!("Error: Unknown command \"{word}\".\n")),
    }

    emit_stderr("Run \"vis --help\" to see the available commands.\n");

    Some(1)
}

/// What `vis help <path>` prints for a command, or for a group of subcommands; `None` when the path
/// names neither. The group listing of `vis <group>` goes through here too, so the two cannot differ.
fn help_text(manifest: &Manifest, help: &Help, path: &[&str]) -> Option<String> {
    if let Some(command) = manifest.find_for_help(&path.join(" ")) {
        return Some(help.command(command, false));
    }

    let subcommands = manifest.subcommands_of(path);

    (!subcommands.is_empty()).then(|| help.subcommands(path, &subcommands))
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

    if let Some(text) = help_text(manifest, help, path) {
        emit(&text);

        return Some(0);
    }

    // The Node CLI prints the banner, reports the miss on stderr, and still exits 0.
    emit(&format!("vis v{}\n", help.version));
    emit_stderr(&format!("Command \"{}\" not found\n", path.join(" ")));

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
