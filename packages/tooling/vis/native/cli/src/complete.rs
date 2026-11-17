//! `vis complete -- <words…>`: the dynamic completion endpoint the generated
//! shell scripts call on every <TAB>, answered from the command manifest.
//!
//! Output is what those scripts parse: one `candidate<TAB>description` per line,
//! then `:<directive>` (a bit set; `4` means "no file completion") on the last line.

use std::io::{self, Write};

use crate::manifest::{Command, Manifest};

/// "Do not fall back to file completion."
const NO_FILE_COMPLETION: u32 = 4;

fn option_candidates<'a>(manifest: &'a Manifest, command: Option<&'a Command>, prefix: &str) -> Vec<(String, String)> {
    let command_options = command.and_then(|command| command.options.as_deref()).unwrap_or_default();
    let mut candidates = Vec::new();

    for option in command_options.iter().chain(manifest.global_options.iter()).filter(|option| !option.hidden) {
        let long = format!("--{}", option.name);

        if long.starts_with(prefix) {
            candidates.push((long, option.description.clone()));
        }

        if let Some(alias) = &option.alias {
            let short = format!("-{alias}");

            if short.starts_with(prefix) && prefix.len() <= 1 {
                candidates.push((short, option.description.clone()));
            }
        }
    }

    candidates
}

/// Words that can follow `typed` (the non-flag words so far) in a command path.
fn word_candidates(manifest: &Manifest, typed: &[&str], prefix: &str) -> Vec<(String, String)> {
    let mut candidates: Vec<(String, String)> = Vec::new();

    for command in manifest.commands.iter().filter(|command| !command.hidden) {
        let path = command.path();

        if path.len() <= typed.len() || path[..typed.len()] != *typed {
            continue;
        }

        let next = path[typed.len()];
        let is_leaf = path.len() == typed.len() + 1;

        if !next.starts_with(prefix) {
            continue;
        }

        let description = if is_leaf { command.description.clone() } else { String::new() };

        match candidates.iter_mut().find(|(word, _)| word == next) {
            Some((_, existing)) if existing.is_empty() => *existing = description,
            Some(_) => {}
            None => candidates.push((next.to_owned(), description)),
        }

        // Aliases are only for the top level, where `vis i` stands for `vis install`.
        if typed.is_empty() && is_leaf {
            for alias in command.alias.iter().filter(|alias| alias.starts_with(prefix)) {
                candidates.push((alias.clone(), command.description.clone()));
            }
        }
    }

    candidates
}

/// Completions for `words`, the argument words after `vis`, where the last one is
/// the (possibly empty) word being completed. Returns the protocol text.
pub fn complete(manifest: &Manifest, words: &[String]) -> String {
    let (current, before) = words.split_last().map_or(("", &[][..]), |(current, before)| (current.as_str(), before));
    let typed: Vec<&str> = before.iter().map(String::as_str).take_while(|word| !word.starts_with('-')).collect();

    let candidates = if current.starts_with('-') {
        let command = (1..=typed.len())
            .rev()
            .find_map(|length| manifest.commands.iter().find(|command| command.path() == typed[..length]));

        option_candidates(manifest, command, current)
    } else {
        word_candidates(manifest, &typed, current)
    };

    let directive = if candidates.is_empty() { 0 } else { NO_FILE_COMPLETION };
    let mut out = String::new();

    for (candidate, description) in &candidates {
        if description.is_empty() {
            out.push_str(&format!("{candidate}\n"));
        } else {
            out.push_str(&format!("{candidate}\t{}\n", description.replace(['\n', '\t'], " ")));
        }
    }

    out.push_str(&format!(":{directive}\n"));

    out
}

/// Entry for `vis complete -- <words…>`; `args` is the full argv after `vis`.
pub fn run(args: &[String]) -> i32 {
    let words =
        args.iter().skip(1).skip_while(|argument| argument.as_str() != "--").skip(1).cloned().collect::<Vec<_>>();
    let manifest = Manifest::load();
    let mut stdout = io::stdout().lock();

    let _ = stdout.write_all(complete(&manifest, &words).as_bytes());

    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn first_word_lists_every_visible_top_level_command() {
        let manifest = Manifest::load();
        let out = complete(&manifest, &words(&[""]));

        for command in manifest.commands.iter().filter(|command| !command.hidden) {
            assert!(
                out.lines().any(|line| line.split('\t').next() == Some(command.path()[0])),
                "missing {}",
                command.path()[0]
            );
        }

        assert!(out.ends_with(":4\n"));
    }

    #[test]
    fn a_prefix_narrows_the_candidates() {
        let manifest = Manifest::load();
        let out = complete(&manifest, &words(&["comp"]));

        assert!(out.starts_with("completion\t"), "{out}");
        assert_eq!(out.lines().count(), 2);
    }

    #[test]
    fn subcommands_follow_their_parent() {
        let manifest = Manifest::load();
        let out = complete(&manifest, &words(&["cache", ""]));

        assert!(out.lines().any(|line| line.starts_with("list\t")), "{out}");
        assert!(out.lines().any(|line| line.starts_with("prune\t")));
    }

    #[test]
    fn dashes_complete_the_commands_and_global_options() {
        let manifest = Manifest::load();
        let out = complete(&manifest, &words(&["cache", "list", "--"]));

        assert!(out.lines().any(|line| line.starts_with("--format\t")), "{out}");
        assert!(out.lines().any(|line| line.starts_with("--verbose\t")));
    }

    #[test]
    fn nothing_to_offer_falls_back_to_files() {
        let manifest = Manifest::load();

        assert_eq!(complete(&manifest, &words(&["run", "x"])), ":0\n");
    }
}
