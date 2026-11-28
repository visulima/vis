//! Running the commands of a `staged` config (`src/staged/tasks/exec.ts`).
//!
//! A command is split into words the way `splitCommandString` splits it (quotes and backslashes, no shell), run once
//! per chunk of files that fits the argument budget, with the files after the words, in the working directory of the
//! run, and with the output of both streams captured. Node starts it through `tinyexec`, which looks the program up
//! on a `PATH` it extends: every `node_modules/.bin` from the working directory up, then the directory of the Node
//! executable, then the same `node_modules/.bin` chain again and the inherited `PATH` ([`search_path`]).

use std::env;
use std::ffi::{OsStr, OsString};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::js::is_js_whitespace;

/// The argument budget of one invocation (`DEFAULT_MAX_ARG_LENGTH` for a unix platform).
const MAX_ARG_LENGTH: usize = 131_072;

/// `collectNodeModulesBinDirs` stops after this many parents; a deeper working directory is Node's.
const MAX_ANCESTOR_WALK: usize = 64;

/// `splitCommandString`: quote-aware, with the backslash rules of a POSIX shell, and no variable or glob expansion.
/// `None` for an unterminated quote, which Node reports as a configuration error.
pub(super) fn split_command(input: &str) -> Option<Vec<String>> {
    let characters: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut buffer = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut index = 0;

    while index < characters.len() {
        let character = characters[index];

        if character == '\\' && !in_single && index + 1 < characters.len() {
            let next = characters[index + 1];

            if in_double && next != '"' && next != '\\' {
                buffer.push(character);
            }

            buffer.push(next);
            index += 2;

            continue;
        }

        if character == '"' && !in_single {
            in_double = !in_double;
        } else if character == '\'' && !in_double {
            in_single = !in_single;
        } else if !in_single && !in_double && is_js_whitespace(character) {
            if !buffer.is_empty() {
                tokens.push(std::mem::take(&mut buffer));
            }
        } else {
            buffer.push(character);
        }

        index += 1;
    }

    if in_single || in_double {
        return None;
    }

    if !buffer.is_empty() {
        tokens.push(buffer);
    }

    Some(tokens)
}

/// `chunkFiles`: the files in order, a new chunk whenever one more would push the byte length (each file counts its
/// bytes and one separator, on top of `prefix`) past the budget; a chunk always holds at least one file.
pub(super) fn chunk_files(files: &[String], prefix: usize) -> Vec<Vec<String>> {
    let mut chunks = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut length = prefix;

    for file in files {
        let cost = file.len() + 1;

        if !current.is_empty() && length + cost > MAX_ARG_LENGTH {
            chunks.push(std::mem::take(&mut current));
            length = prefix;
        }

        current.push(file.clone());
        length += cost;
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

/// The `PATH` a task and every `git` call of the run gets, or `None` where the binary cannot tell what Node adds: no
/// `PATH`, an empty one, a working directory deeper than Node walks, or a Node executable the launcher did not name
/// (`VIS_NODE`, the `process.execPath` of the process it started).
pub(super) fn search_path(cwd: &Path) -> Option<OsString> {
    let inherited = env::var_os("PATH").filter(|path| !path.is_empty())?;
    let node = PathBuf::from(env::var_os("VIS_NODE").filter(|node| Path::new(node).is_absolute())?);
    // `process.execPath` is the resolved path of the executable.
    let node_directory = node.canonicalize().ok()?.parent()?.to_path_buf();
    let chain: Vec<PathBuf> = cwd.ancestors().map(|directory| directory.join("node_modules").join(".bin")).collect();

    if chain.len() > MAX_ANCESTOR_WALK + 1 {
        return None;
    }

    let mut directories: Vec<PathBuf> = chain.clone();

    directories.push(node_directory);
    directories.extend(chain);
    directories.extend(env::split_paths(&inherited));

    env::join_paths(directories).ok()
}

/// Whether the file at `path` is one `execve` runs by itself: executable, and an ELF or Mach-O binary or a script with
/// a `#!` line. A file with no such start is run by a shell that `execvp` falls back to, which Node's spawn may not.
fn is_runnable(path: &Path) -> bool {
    use std::io::Read;

    let Ok(metadata) = path.metadata() else { return false };

    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return false;
    }

    let mut magic = [0u8; 4];

    if std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut magic)).is_err() {
        return false;
    }

    magic.starts_with(b"#!")
        || magic == [0x7f, b'E', b'L', b'F']
        || matches!(
            u32::from_be_bytes(magic),
            0xfeed_face | 0xfeed_facf | 0xcefa_edfe | 0xcffa_edfe | 0xcafe_babe | 0xbebafeca
        )
}

/// The file `program` names: a path with a `/` as it is (relative to `cwd`), a bare name in the first directory of
/// `search` that holds a runnable file of that name. `None` when there is none, or when the search would reach an
/// empty entry (the working directory) or a file `execve` would not run on its own.
pub(super) fn resolve(program: &str, search: &OsStr, cwd: &Path) -> Option<PathBuf> {
    if program.is_empty() {
        return None;
    }

    if program.contains('/') {
        let path = cwd.join(program);

        return is_runnable(&path).then_some(path);
    }

    for directory in env::split_paths(search) {
        if directory.as_os_str().is_empty() {
            return None;
        }

        let candidate = directory.join(program);

        if candidate.exists() {
            return is_runnable(&candidate).then_some(candidate);
        }
    }

    None
}

/// `NodeJS.Signals` name of a signal number, for the ones a task commonly dies of.
fn signal_name(signal: i32) -> Option<&'static str> {
    [
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGINT, "SIGINT"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGTRAP, "SIGTRAP"),
        (libc::SIGABRT, "SIGABRT"),
        (libc::SIGBUS, "SIGBUS"),
        (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGTERM, "SIGTERM"),
    ]
    .iter()
    .find_map(|(number, name)| (*number == signal).then_some(*name))
}

/// How a command ended.
pub(super) struct Outcome {
    pub duration_ms: u128,
    /// The merged output of a command that succeeded, or the message of the error of one that failed.
    pub text: String,
    pub failed: bool,
    /// Whether a failure is a `TaskError` (the command ran and ended badly), whose message Node also shows as the output,
    /// rather than an error of starting it.
    pub task_error: bool,
}

/// Runs `words` (program and leading arguments) once per chunk of `files` in `cwd`, as `execCommand` does, and stops
/// at the first chunk that fails. A failure's `text` is the message `TaskError` carries.
pub(super) fn run(words: &[String], files: &[String], cwd: &Path, search: &OsStr) -> Outcome {
    let started = Instant::now();
    let program = &words[0];
    let prefix = program.len() + words[1..].iter().map(|word| word.len() + 1).sum::<usize>();
    let mut outputs: Vec<String> = Vec::new();

    for chunk in chunk_files(files, prefix) {
        let failure = |text: String, task_error: bool| Outcome {
            duration_ms: started.elapsed().as_millis(),
            text,
            failed: true,
            task_error,
        };
        let Some(path) = resolve(program, search, cwd) else {
            return failure(format!("spawn {program} ENOENT"), false);
        };

        let result = Command::new(&path)
            .arg0(program)
            .args(&words[1..])
            .args(&chunk)
            .current_dir(cwd)
            .env("PATH", search)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        let output = match result {
            Ok(output) => output,
            Err(error) => {
                let code = match error.raw_os_error() {
                    Some(libc::EACCES) => "EACCES",
                    Some(libc::ENOEXEC) => "ENOEXEC",
                    Some(libc::EMFILE) => "EMFILE",
                    Some(libc::E2BIG) => "E2BIG",
                    _ => "ENOENT",
                };

                return failure(format!("spawn {program} {code}"), false);
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let merged = [stdout.as_ref(), stderr.as_ref()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("\n");

        if !merged.is_empty() {
            outputs.push(merged.clone());
        }

        match (output.status.code(), output.status.signal()) {
            (Some(0), _) => {}
            (Some(code), _) => {
                let trimmed = crate::js::trim(&merged);
                let text =
                    if trimmed.is_empty() { format!("Exit code {code} from {program}") } else { trimmed.to_owned() };

                return failure(text, true);
            }
            (None, Some(signal)) => {
                return failure(
                    match signal_name(signal) {
                        Some(name) => format!("Task killed by signal {name}."),
                        None => format!("Task killed by signal {signal}."),
                    },
                    true,
                );
            }
            (None, None) => return failure("Task exited without a numeric status code.".to_owned(), true),
        }
    }

    Outcome { duration_ms: started.elapsed().as_millis(), text: outputs.join("\n"), failed: false, task_error: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(input: &str) -> Vec<String> {
        split_command(input).unwrap()
    }

    #[test]
    fn quotes_and_backslashes_follow_the_posix_rules_of_the_splitter() {
        assert_eq!(words("eslint --fix"), ["eslint", "--fix"]);
        assert_eq!(words("  a \t b  "), ["a", "b"]);
        assert_eq!(words("sh -c 'echo \"hi there\"; exit 3' sh"), ["sh", "-c", "echo \"hi there\"; exit 3", "sh"]);
        assert_eq!(words(r#"a "b c" 'd e' f\ g"#), ["a", "b c", "d e", "f g"]);
        assert_eq!(words(r#"a "b\"c" "d\ne" "f\\g""#), ["a", "b\"c", "d\\ne", "f\\g"]);
        assert_eq!(words(r"a 'b\c'"), ["a", r"b\c"]);
        assert_eq!(words("a \"\" b"), ["a", "b"]);
        assert_eq!(words("trailing\\"), ["trailing\\"]);
        assert!(words("").is_empty());
        assert!(words("   ").is_empty());
    }

    #[test]
    fn an_unterminated_quote_is_nodes() {
        assert_eq!(split_command("a 'b"), None);
        assert_eq!(split_command("a \"b"), None);
    }

    #[test]
    fn files_are_chunked_by_their_byte_length() {
        let files: Vec<String> = (0..3).map(|index| format!("{index}{}", "x".repeat(60_000))).collect();

        assert_eq!(chunk_files(&files, 10).iter().map(Vec::len).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(chunk_files(&files[..1], 10).len(), 1);
        assert!(chunk_files(&[], 10).is_empty());
        // A file longer than the budget still gets a chunk of its own.
        assert_eq!(chunk_files(&["y".repeat(200_000), "z".to_owned()], 0).len(), 2);
    }
}
