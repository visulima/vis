//! Running a hook's `entry`: `sh -c "<entry> \"$@\"" sh <files…>` as in `dispatch.ts`,
//! except that a plain program invocation is exec'd directly, which saves a whole
//! process spawn (~2 ms) per hook.

use std::io::Write;
use std::process::{Command, ExitStatus};

/// Conservative per-call argv budget (see `ARG_BUDGET` in dispatch.ts).
const ARG_BUDGET: usize = 32 * 1024;

#[cfg(unix)]
const SIGNALS: [(i32, &str); 9] = [
    (1, "SIGHUP"),
    (2, "SIGINT"),
    (3, "SIGQUIT"),
    (6, "SIGABRT"),
    (9, "SIGKILL"),
    (11, "SIGSEGV"),
    (13, "SIGPIPE"),
    (14, "SIGALRM"),
    (15, "SIGTERM"),
];

/// Commands a shell runs itself (POSIX special + regular builtins, plus the common
/// bash/dash extras). Their behaviour differs from any same-named binary, so they
/// always go through `sh`.
const SHELL_OWN: &[&str] = &[
    ".", ":", "[", "[[", "alias", "bg", "break", "builtin", "cd", "command", "continue", "declare", "dirs", "echo",
    "enable", "eval", "exec", "exit", "export", "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs",
    "kill", "let", "local", "newgrp", "popd", "printf", "pushd", "pwd", "read", "readonly", "return", "set", "shift",
    "source", "test", "time", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset",
    "wait", "coproc", "function", "if", "for", "while", "until", "case", "select",
];

/// A child's command line. The launcher's internal delegation variables are removed:
/// they describe this install (its JS entry, possibly relative, its version and how it
/// was started), and a `vis` run from inside a hook must resolve its own.
fn command(program: &str) -> Command {
    let mut command = Command::new(program);

    command
        .env_remove("VIS_FALLBACK_ENTRY")
        .env_remove("VIS_FALLBACK_ENTRY_OVERRIDE")
        .env_remove("VIS_LAUNCHER")
        .env_remove("VIS_NODE")
        .env_remove("VIS_VERSION");

    command
}

/// Report how a child ended, as the Node runner does: its exit code, or `1` plus a
/// notice when it died to a signal or never started.
fn exit_code(result: std::io::Result<ExitStatus>) -> i32 {
    match result {
        Ok(status) => {
            if let Some(code) = status.code() {
                return code;
            }

            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;

                if let Some(signal) = status.signal() {
                    let name = SIGNALS
                        .iter()
                        .find(|(n, _)| *n == signal)
                        .map_or_else(|| signal.to_string(), |(_, name)| (*name).to_owned());

                    eprintln!("hook command failed: terminated by signal {name}");

                    return 1;
                }
            }

            eprintln!("hook command failed: exited with status null");

            1
        }
        Err(error) => {
            eprintln!("hook command failed: {error}");

            1
        }
    }
}

/// Words a POSIX shell would never treat specially, so `sh -c "<cmd> $@"` and a direct
/// `exec` agree on them.
fn is_plain_word(word: &str) -> bool {
    !word.is_empty() && word.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./:@%+,-".contains(&b))
}

/// Split an `entry` into argv when it is a plain program invocation: only plain words,
/// the first not a shell builtin / keyword and not a `VAR=value` assignment. Anything
/// else — quoting, `$`, pipes, globs, redirections — needs the shell.
fn direct_argv(command: &str) -> Option<Vec<&str>> {
    // Only space and tab separate words; a newline (or any other control character) ends a
    // shell command, so it leaves `is_plain_word` false and the entry goes to `sh`.
    let words: Vec<&str> = command.split([' ', '\t']).filter(|w| !w.is_empty()).collect();
    let first = *words.first()?;

    if !words.iter().all(|w| is_plain_word(w))
        || SHELL_OWN.contains(&first)
        || first.contains('=')
        || first.starts_with('-')
    {
        return None;
    }

    Some(words)
}

/// One invocation. `forward_args` says whether `args` are `"$@"` of the command (shell form
/// `sh -c "<command> \"$@\"" sh <args…>`, plain trailing argv for the direct form) or only
/// fill the shell's positional parameters without reaching it. A direct spawn that fails
/// (ENOEXEC script, not found, …) is retried through `sh`, so the shell stays the authority
/// on every error message.
fn spawn(command_line: &str, forward_args: bool, args: &[&str]) -> i32 {
    let _ = std::io::stdout().flush();

    if let Some(words) = direct_argv(command_line) {
        let trailing: &[&str] = if forward_args { args } else { &[] };

        if let Ok(status) = command(words[0]).args(&words[1..]).args(trailing).status() {
            return exit_code(Ok(status));
        }
    }

    let script = if forward_args { format!("{command_line} \"$@\"") } else { command_line.to_owned() };

    exit_code(command("sh").arg("-c").arg(script).arg("sh").args(args).status())
}

fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn chunk_files(files: &[String], overhead: usize) -> Vec<Vec<String>> {
    let budget = ARG_BUDGET.saturating_sub(overhead).max(1024);
    let mut chunks: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut size = 0;

    for file in files {
        let cost = file.len() + 8;

        if size + cost > budget && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            size = 0;
        }

        current.push(file.clone());
        size += cost;
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

/// Run a hook `entry` (plus its quoted `args`) over `files`. Exit codes of the chunks are
/// OR-folded, like upstream pre-commit.
pub fn run(entry: &str, args: &[String], files: &[String], pass_filenames: bool, extra: &[String]) -> i32 {
    let command_line = if args.is_empty() {
        entry.to_owned()
    } else {
        format!("{entry} {}", args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "))
    };

    if !pass_filenames || files.is_empty() {
        // No `"$@"` in the command: the extra args only fill the shell's `$1…` and never reach it.
        let extra: Vec<&str> = extra.iter().map(String::as_str).collect();

        return spawn(&command_line, false, &extra);
    }

    let overhead = command_line.len() + "sh".len() + "-c".len() + extra.iter().map(|a| a.len() + 8).sum::<usize>() + 64;
    let mut rc = 0;

    for chunk in chunk_files(files, overhead) {
        let argv: Vec<&str> = extra.iter().map(String::as_str).chain(chunk.iter().map(String::as_str)).collect();

        rc |= spawn(&command_line, true, &argv);
    }

    rc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_argv_only_accepts_plain_programs() {
        assert_eq!(direct_argv("./payload.sh"), Some(vec!["./payload.sh"]));
        assert_eq!(direct_argv("eslint --fix"), Some(vec!["eslint", "--fix"]));

        for command in [
            "echo hi",
            "exit 3",
            "true",
            "FOO=1 env",
            "a | b",
            "a && b",
            "a 'b c'",
            "a $HOME",
            "a *.ts",
            "a > out",
            "cd x",
            "",
            "-x",
            "./first\n./second",
            "./first\r\n./second",
            "./first\x0b./second",
        ] {
            assert!(direct_argv(command).is_none(), "{command:?} needs the shell");
        }
    }

    #[test]
    fn chunking_respects_the_argv_budget_and_keeps_order() {
        let files: Vec<String> = (0..2000).map(|i| format!("some/long/path/to/file-{i}.ts")).collect();
        let chunks = chunk_files(&files, 100);

        assert!(chunks.len() > 1);
        assert_eq!(chunks.concat(), files);
        assert!(chunks.iter().all(|c| c.iter().map(|f| f.len() + 8).sum::<usize>() <= ARG_BUDGET));
    }
}
