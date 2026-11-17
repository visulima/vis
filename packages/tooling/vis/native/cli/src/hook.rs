//! `vis hook run` — the native fast path.
//!
//! A git hook fires on every commit, so its wall-clock is paid constantly. The
//! Node runner spends ~130 ms just booting before it looks at the config; this
//! module does the same job (`src/commands/hook/{run,config,discover,filter,
//! dispatch}.ts`) in a few milliseconds.
//!
//! ## Contract: native or Node, decided up front
//!
//! The native path must be byte-for-byte equivalent to the Node runner for every
//! config it accepts, so it is deliberately conservative. Before ANY hook runs
//! (a fixer may rewrite files, so there is no switching halfway) the whole run
//! is planned, and anything the planner is not certain about hands the original
//! argv to the Node CLI via [`crate::delegate`]:
//!
//! - an argv shape other than `hook run [stage] [extra…] [known flags]`;
//! - a missing, unparsable or schema-violating config (Node owns the error text);
//! - a `check-json` / unknown builtin (messages come from V8's `JSON.parse`);
//! - a `files` / `exclude` pattern outside the subset where the JS and Rust regex
//!   engines provably agree, or any non-printable-ASCII path when a pattern is set;
//! - a `types` filter naming a tag outside the upstream `prek-identify` universe
//!   (the vis overlay tags live on the JS side);
//! - any `git` failure while discovering files.
//!
//! Two intentional differences: failures print `Error: Hook stage exited with
//! code N` without a Node stack trace, and `vis.config.ts` / plugins are not
//! loaded (the Node runner never consulted them for `hook run` either).

use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::process::{exit, Command};

use regex::bytes::{Regex, RegexBuilder};
use serde_json::Value;

use crate::hook_builtins::{self, Log};

const DEFAULT_HOOKS_DIRECTORY: &str = ".vis/hooks";

/// Stages where git supplies its own positional args instead of a file set.
const STAGES_WITH_GIT_ARGS: [&str; 6] =
    ["commit-msg", "post-checkout", "post-merge", "post-rewrite", "pre-rebase", "prepare-commit-msg"];

/// Conservative per-call argv budget (see `ARG_BUDGET` in dispatch.ts).
const ARG_BUDGET: usize = 32 * 1024;

#[derive(Default)]
struct RunArgs {
    all_files: bool,
    extra_args: Vec<String>,
    from_ref: Option<String>,
    hooks_dir: Option<String>,
    last_commit: bool,
    stage: Option<String>,
    to_ref: Option<String>,
}

/// Parse `hook run …`. `None` ⇒ some shape we do not handle exactly.
fn parse_args(args: &[String]) -> Option<RunArgs> {
    let mut out = RunArgs::default();
    let mut positionals: Vec<String> = Vec::new();
    let mut i = 2; // skip `hook run`

    while i < args.len() {
        let arg = &args[i];

        if let Some(rest) = arg.strip_prefix("--") {
            let (name, inline) = match rest.split_once('=') {
                Some((n, v)) => (n, Some(v.to_owned())),
                None => (rest, None),
            };
            let value = |i: &mut usize| -> Option<String> {
                if inline.is_some() {
                    return inline.clone();
                }

                *i += 1;

                args.get(*i).cloned()
            };

            match name {
                "all-files" if inline.is_none() => out.all_files = true,
                "last-commit" if inline.is_none() => out.last_commit = true,
                "from-ref" => out.from_ref = Some(value(&mut i)?),
                "to-ref" => out.to_ref = Some(value(&mut i)?),
                "hooks-dir" => out.hooks_dir = Some(value(&mut i)?),
                _ => return None,
            }
        } else if arg.starts_with('-') && arg.len() > 1 {
            return None;
        } else {
            positionals.push(arg.clone());
        }

        i += 1;
    }

    let mut positionals = positionals.into_iter();

    out.stage = positionals.next();
    out.extra_args = positionals.collect();

    Some(out)
}

/// A parsed `HookEntry`. Mirrors `parseEntry` in config.ts, including its
/// "wrong type ⇒ silently ignored" behaviour.
#[derive(Default)]
struct Entry {
    always_run: bool,
    args: Vec<String>,
    builtin: Option<String>,
    command: Option<String>,
    exclude: Option<String>,
    exclude_types: Vec<String>,
    fail: Option<String>,
    files: Option<String>,
    id: String,
    name: Option<String>,
    pass_filenames: bool,
    types: Vec<String>,
    types_or: Vec<String>,
    verbose: bool,
}

fn as_string_array(value: Option<&Value>) -> Option<Vec<String>> {
    let array = value?.as_array()?;
    let mut out = Vec::with_capacity(array.len());

    for item in array {
        out.push(item.as_str()?.to_owned());
    }

    Some(out)
}

fn as_non_empty_string(value: Option<&Value>) -> Option<String> {
    value?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn parse_entry(raw: &Value) -> Option<Entry> {
    let object = raw.as_object()?;
    let id = object.get("id")?.as_str().filter(|s| !s.is_empty())?.to_owned();
    let entry = Entry {
        always_run: object.get("alwaysRun").and_then(Value::as_bool).unwrap_or(false),
        args: as_string_array(object.get("args")).unwrap_or_default(),
        builtin: as_non_empty_string(object.get("builtin")),
        command: as_non_empty_string(object.get("entry")),
        exclude: as_non_empty_string(object.get("exclude")),
        exclude_types: as_string_array(object.get("excludeTypes")).unwrap_or_default(),
        fail: as_non_empty_string(object.get("fail")),
        files: as_non_empty_string(object.get("files")),
        id,
        name: as_non_empty_string(object.get("name")),
        pass_filenames: object.get("passFilenames").and_then(Value::as_bool).unwrap_or(true),
        types: as_string_array(object.get("types")).unwrap_or_default(),
        types_or: as_string_array(object.get("typesOr")).unwrap_or_default(),
        verbose: object.get("verbose").and_then(Value::as_bool).unwrap_or(false),
    };

    let targets =
        [entry.builtin.is_some(), entry.command.is_some(), entry.fail.is_some()].iter().filter(|b| **b).count();

    if targets != 1 {
        return None;
    }

    if entry.fail.is_some() {
        // `fail` hooks reject filter keys outright; let Node produce that error.
        let has_filter = ["args", "exclude", "excludeTypes", "files", "passFilenames", "types", "typesOr"]
            .iter()
            .any(|key| key_is_defined(object.get(*key), key));

        if has_filter {
            return None;
        }
    }

    Some(entry)
}

/// `entry[key] !== undefined` after `parseEntry`'s type coercion.
fn key_is_defined(value: Option<&Value>, key: &str) -> bool {
    match key {
        "exclude" | "files" => as_non_empty_string(value).is_some(),
        "passFilenames" => value.and_then(Value::as_bool).is_some(),
        _ => as_string_array(value).is_some(),
    }
}

struct Config {
    fail_fast: bool,
    stages: Vec<(String, Vec<Entry>)>,
}

fn parse_config(raw: &Value) -> Option<Config> {
    let object = raw.as_object()?;

    if object.get("version")?.as_f64()? != 1.0 {
        return None;
    }

    let stages_raw = object.get("stages")?.as_object()?;
    let mut stages = Vec::with_capacity(stages_raw.len());

    for (stage, list) in stages_raw {
        let mut entries = Vec::new();

        for item in list.as_array()? {
            entries.push(parse_entry(item)?);
        }

        stages.push((stage.clone(), entries));
    }

    Some(Config { fail_fast: object.get("failFast").and_then(Value::as_bool).unwrap_or(false), stages })
}

enum Discover {
    All,
    Range(String, String),
    Staged,
}

fn git_list(args: &[&str]) -> Option<Vec<String>> {
    let output = Command::new("git").args(args).output().ok()?;

    if !output.status.success() {
        return None;
    }

    Some(
        output
            .stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
    )
}

fn discover(mode: &Discover) -> Option<Vec<String>> {
    match mode {
        Discover::All => git_list(&["ls-files", "-z"]),
        Discover::Range(from, to) => git_list(&["diff", "--name-only", "--diff-filter=ACM", "-z", from, to]),
        Discover::Staged => git_list(&["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"]),
    }
}

/// Compile `pattern` only when JS `RegExp` and Rust `regex` provably agree on
/// it. Everything else returns `None` and the run goes to Node.
///
/// The accepted subset is printable ASCII where:
/// - the only `(?` form is `(?:`;
/// - backslash escapes are one of `\\ \. \/ \- \^ \$ \* \+ \? \( \) \[ \] \{ \} \|` or the ASCII
///   classes `\d \D \w \W \s \S`, plus `\b` / `\B` outside a bracket class and not
///   followed by `{` (Rust reads `\b{start}`);
/// - bracket classes hold no nested `[`, no `&&` / `--` / `~~` set operators
///   (Rust-only) and are not empty (`[]` is "nothing" in JS, `[]a]` in Rust);
/// - no `{,n}` (a literal in JS, a quantifier in Rust).
///
/// Compiled with Unicode off so `\d \w \s \b` are ASCII-only like JS; callers also
/// require every candidate path to be printable ASCII.
fn compile_js_regex(pattern: &str) -> Option<Regex> {
    let bytes = pattern.as_bytes();

    if !bytes.iter().all(|b| (0x20..0x7f).contains(b)) || pattern.contains("{,") {
        return None;
    }

    let mut in_class = false;
    let mut i = 0;

    while i < bytes.len() {
        let c = bytes[i];

        if c == b'\\' {
            let next = *bytes.get(i + 1)?;
            let class_escape = b"dDwWsS".contains(&next);
            let boundary = (next == b'b' || next == b'B') && !in_class && bytes.get(i + 2) != Some(&b'{');

            if !(class_escape || boundary || b"\\./-^$*+?()[]{}|".contains(&next)) {
                return None;
            }

            i += 2;

            continue;
        }

        if in_class {
            if c == b'[' || (i + 1 < bytes.len() && bytes[i + 1] == c && matches!(c, b'&' | b'-' | b'~')) {
                return None;
            }

            if c == b']' {
                in_class = false;
            }
        } else if c == b'[' {
            in_class = true;

            let after = if bytes.get(i + 1) == Some(&b'^') { i + 2 } else { i + 1 };

            if bytes.get(after) == Some(&b']') {
                return None;
            }
        } else if c == b'(' && bytes.get(i + 1) == Some(&b'?') {
            if bytes.get(i + 2) != Some(&b':') {
                return None;
            }

            i += 3;

            continue;
        }

        i += 1;
    }

    if in_class {
        return None;
    }

    RegexBuilder::new(pattern).unicode(false).build().ok()
}

fn is_printable_ascii(file: &str) -> bool {
    file.bytes().all(|b| (0x20..0x7f).contains(&b))
}

/// One hook, ready to execute.
struct Planned<'a> {
    entry: &'a Entry,
    files: Vec<String>,
    skip: bool,
}

fn plan<'a>(hooks: &'a [Entry], candidates: &[String], forces_always_run: bool) -> Option<Vec<Planned<'a>>> {
    let all_ascii = candidates.iter().all(|f| is_printable_ascii(f));
    let mut planned = Vec::with_capacity(hooks.len());

    for entry in hooks {
        if entry.fail.is_some() {
            planned.push(Planned { entry, files: Vec::new(), skip: false });

            continue;
        }

        if let Some(builtin) = &entry.builtin {
            if !hook_builtins::is_supported(builtin) {
                return None;
            }
        }

        let mut files: Vec<String> = candidates.to_vec();

        if entry.files.is_some() || entry.exclude.is_some() {
            if !all_ascii {
                return None;
            }

            if let Some(pattern) = &entry.files {
                let rx = compile_js_regex(pattern)?;

                files.retain(|f| rx.is_match(f.as_bytes()));
            }

            if let Some(pattern) = &entry.exclude {
                let rx = compile_js_regex(pattern)?;

                files.retain(|f| !rx.is_match(f.as_bytes()));
            }
        }

        if !entry.types.is_empty() || !entry.types_or.is_empty() || !entry.exclude_types.is_empty() {
            files = filter_by_tags(files, entry)?;
        }

        let skip = files.is_empty() && !entry.always_run && !forces_always_run;

        planned.push(Planned { entry, files, skip });
    }

    Some(planned)
}

/// `types` / `typesOr` / `excludeTypes` against the upstream `prek-identify`
/// classifier. `None` when a tag is outside that universe (vis overlay tags).
fn filter_by_tags(files: Vec<String>, entry: &Entry) -> Option<Vec<String>> {
    let universe = prek_identify::tags::ALL_TAGS;

    if entry
        .types
        .iter()
        .chain(&entry.types_or)
        .chain(&entry.exclude_types)
        .any(|tag| !universe.contains(&tag.as_str()))
    {
        return None;
    }

    let mut kept = Vec::with_capacity(files.len());

    for file in files {
        // A classification error collapses to "no tags", like the addon.
        let tags: Vec<&str> = prek_identify::tags_from_path(std::path::Path::new(&file))
            .map(|set| set.iter().collect())
            .unwrap_or_default();
        let has = |tag: &String| tags.contains(&tag.as_str());

        if !entry.types.iter().all(has) {
            continue;
        }

        if !entry.types_or.is_empty() && !entry.types_or.iter().any(has) {
            continue;
        }

        if entry.exclude_types.iter().any(has) {
            continue;
        }

        kept.push(file);
    }

    Some(kept)
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

/// Report how a child ended, as the Node runner does: its exit code, or `1`
/// plus a notice when it died to a signal or never started.
fn exit_code(result: std::io::Result<std::process::ExitStatus>) -> i32 {
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
                        .map_or_else(|| format!("{signal}"), |(_, name)| (*name).to_owned());

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

/// Words a POSIX shell would never treat specially, so `sh -c "<cmd> $@"` and a
/// direct `exec` agree on them.
fn is_plain_word(word: &str) -> bool {
    !word.is_empty() && word.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./:@%+,-".contains(&b))
}

/// Commands a shell runs itself (POSIX special + regular builtins, plus the
/// common bash/dash extras). Their behaviour differs from any same-named binary,
/// so they always go through `sh`.
const SHELL_OWN: &[&str] = &[
    ".", ":", "[", "[[", "alias", "bg", "break", "builtin", "cd", "command", "continue", "declare", "dirs", "echo",
    "enable", "eval", "exec", "exit", "export", "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs",
    "kill", "let", "local", "newgrp", "popd", "printf", "pushd", "pwd", "read", "readonly", "return", "set", "shift",
    "source", "test", "time", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset",
    "wait", "coproc", "function", "if", "for", "while", "until", "case", "select",
];

/// Split a hook `entry` into argv when it is a plain program invocation: only
/// plain words, the first not a shell builtin / keyword and not a `VAR=value`
/// assignment. Anything else — quoting, `$`, pipes, globs, redirections — needs
/// the shell and returns `None`.
fn direct_argv(command: &str) -> Option<Vec<&str>> {
    let words: Vec<&str> = command.split_ascii_whitespace().collect();
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

/// Run one invocation of a hook command. `command_args` become `$@` for the
/// shell form (`sh -c "<command> \"$@\"" sh <args…>`) and plain trailing argv for
/// the direct form, which skips a whole process spawn (~2 ms) per hook. A direct
/// spawn that fails (ENOEXEC script, not found, …) is retried through `sh`, so
/// the shell stays the authority on every error message.
fn spawn_command(command: &str, forward_args: bool, args: &[&str]) -> i32 {
    let _ = std::io::stdout().flush();

    if let Some(words) = direct_argv(command) {
        let trailing: &[&str] = if forward_args { args } else { &[] };

        if let Ok(status) = Command::new(words[0]).args(&words[1..]).args(trailing).status() {
            return exit_code(Ok(status));
        }
    }

    let script = if forward_args { format!("{command} \"$@\"") } else { command.to_owned() };

    exit_code(Command::new("sh").arg("-c").arg(script).arg("sh").args(args).status())
}

fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn run_shell(command: &str, files: &[String], pass_filenames: bool, extra: &[String]) -> i32 {
    if !pass_filenames || files.is_empty() {
        // No `"$@"` in the command: the extra args only fill the shell's `$1…` and never reach it.
        let args: Vec<&str> = extra.iter().map(String::as_str).collect();

        return spawn_command(command, false, &args);
    }

    let overhead = command.len() + "sh".len() + "-c".len() + extra.iter().map(|a| a.len() + 8).sum::<usize>() + 64;
    let mut rc = 0;

    for chunk in chunk_files(files, overhead) {
        let args: Vec<&str> = extra.iter().map(String::as_str).chain(chunk.iter().map(String::as_str)).collect();

        rc |= spawn_command(command, true, &args);
    }

    rc
}

fn run_entry(planned: &Planned, forces_always_run: bool, extra_args: &[String], root: &std::path::Path) -> i32 {
    let entry = planned.entry;

    if let Some(message) = &entry.fail {
        println!("{message}");

        return 1;
    }

    if entry.verbose {
        println!("+ {}", entry.name.as_deref().unwrap_or(&entry.id));
    }

    if let Some(builtin) = &entry.builtin {
        return match hook_builtins::run(builtin, &planned.files, &entry.args, root, &Log) {
            Ok(code) => code,
            Err(hook_builtins::Crash(message)) => {
                eprintln!("builtin \"{builtin}\" crashed: {message}");

                1
            }
        };
    }

    let command = entry.command.as_deref().unwrap_or_default();
    let command = if entry.args.is_empty() {
        command.to_owned()
    } else {
        format!("{command} {}", entry.args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "))
    };
    let extra: &[String] = if forces_always_run { extra_args } else { &[] };

    run_shell(&command, &planned.files, entry.pass_filenames, extra)
}

/// Entry point for `vis hook run …`. Never returns.
pub fn run(args: &[String]) -> ! {
    let Some(parsed) = parse_args(args) else { crate::delegate(args) };
    let Some(root) = env::current_dir().ok() else { crate::delegate(args) };
    let hooks_dir = parsed.hooks_dir.as_deref().unwrap_or(DEFAULT_HOOKS_DIRECTORY);
    let stage = parsed.stage.as_deref().unwrap_or("pre-commit");

    // -- config ----------------------------------------------------------
    let config_path: PathBuf = root.join(hooks_dir).join("config.json");
    let Some(config) = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|raw| parse_config(&raw))
    else {
        crate::delegate(args)
    };

    let hooks: &[Entry] =
        config.stages.iter().find(|(name, _)| name == stage).map_or(&[], |(_, entries)| entries.as_slice());

    if hooks.is_empty() {
        println!("No hooks configured for stage \"{stage}\".");
        exit(0);
    }

    // -- discovery -------------------------------------------------------
    let uses_git_args = STAGES_WITH_GIT_ARGS.contains(&stage);
    let mode: Option<Discover> = if uses_git_args {
        None
    } else {
        if parsed.last_commit && (parsed.from_ref.is_some() || parsed.to_ref.is_some()) {
            crate::delegate(args);
        }

        let (from, to) = if parsed.last_commit {
            (Some("HEAD~1".to_owned()), Some("HEAD".to_owned()))
        } else {
            (parsed.from_ref.clone(), parsed.to_ref.clone())
        };

        match (from, to) {
            (Some(from), Some(to)) => Some(Discover::Range(from, to)),
            (None, None) if parsed.all_files => Some(Discover::All),
            (None, None) => Some(Discover::Staged),
            _ => crate::delegate(args),
        }
    };

    let candidates = match &mode {
        Some(mode) => match discover(mode) {
            Some(files) => files,
            None => crate::delegate(args),
        },
        None => Vec::new(),
    };

    // -- plan (may still hand off to Node; nothing has run yet) ----------
    let Some(planned) = plan(hooks, &candidates, uses_git_args) else { crate::delegate(args) };

    // -- execute ---------------------------------------------------------
    if env::var_os("VIS_HOOK_TRACE").is_some() {
        eprintln!("vis[native]: hook run {stage}");
    }

    let description = match &mode {
        Some(Discover::All) => " (--all-files)".to_owned(),
        Some(Discover::Range(from, to)) => format!(" ({from}..{to})"),
        _ => String::new(),
    };

    println!("Running {stage}{description}");

    let mut rc = 0;

    for item in &planned {
        if item.skip {
            continue;
        }

        let code = run_entry(item, uses_git_args, &parsed.extra_args, &root);

        if code != 0 {
            rc |= code;

            if config.fail_fast {
                break;
            }
        }
    }

    let _ = std::io::stdout().flush();

    if rc != 0 {
        eprintln!("Error: Hook stage exited with code {rc}");
        exit(1);
    }

    exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(pattern: &str, text: &str) -> Option<bool> {
        compile_js_regex(pattern).map(|rx| rx.is_match(text.as_bytes()))
    }

    #[test]
    fn regex_subset_matches_like_js_on_ascii_paths() {
        assert_eq!(matches(r"\.ts$", "src/a.ts"), Some(true));
        assert_eq!(matches(r"\.ts$", "src/a.tsx"), Some(false));
        assert_eq!(matches(r"^src/.*\.(ts|md)$", "src/x/y.md"), Some(true));
        assert_eq!(matches(r"\bok\b", "src/ok.txt"), Some(true));
        assert_eq!(matches(r"[a-z]+\.txt$", "a.txt"), Some(true));
        assert_eq!(matches(r"(?:ws|ok)\.", "ok.txt"), Some(true));
        // `\w` and `\d` are ASCII-only, as in JS
        assert_eq!(matches(r"^\w+$", "abc_1"), Some(true));
    }

    #[test]
    fn regex_outside_the_subset_is_refused() {
        for pattern in [
            "(?i)a",
            "(?=a)",
            "(?<n>a)",
            r"\p{L}",
            r"\1",
            r"\<a",
            r"\b{start}",
            "[[:alpha:]]",
            "[a&&b]",
            "[a--b]",
            "[a~~b]",
            "[[a]]",
            "[]a]",
            "[^]",
            "a{,3}",
            "(",
            "[a",
            "ü",
            r"\u0041",
            r"\cA",
        ] {
            assert!(compile_js_regex(pattern).is_none(), "{pattern} must fall back to Node");
        }
    }

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
