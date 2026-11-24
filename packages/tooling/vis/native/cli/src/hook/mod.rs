//! `vis hook run` — the native fast path. (`vis hook list` has its own module, [`list`].)
//!
//! A git hook fires on every commit, so its wall-clock is paid constantly. The
//! Node runner spends ~130 ms just booting before it looks at the config; this
//! module does the same job (`src/commands/hook/{run,config,discover,filter,
//! dispatch}.ts`, one submodule each) in a few milliseconds.
//!
//! ## Contract: native or Node, decided up front
//!
//! The native path must be byte-for-byte equivalent to the Node runner for every
//! config it accepts, so it is deliberately conservative. [`prepare`] builds the
//! whole plan before ANY hook runs (a fixer may rewrite files, so there is no
//! switching halfway); anything it is not certain about makes [`run`] hand the
//! original argv to the Node CLI via [`crate::delegate`]:
//!
//! - an argv shape other than `hook run [stage] [extra…] [known flags]`, or an
//!   absolute `--hooks-dir`;
//! - a missing, unparsable or schema-violating config (Node owns the error text);
//! - a `check-json` / unknown builtin (messages come from V8's `JSON.parse`);
//! - a `files` / `exclude` pattern outside the subset where the JS and Rust regex
//!   engines provably agree, or any non-printable-ASCII path when a pattern is set;
//! - a `types` filter naming a tag outside the upstream `prek-identify` universe
//!   (the vis overlay tags live on the JS side);
//! - any `git` failure while discovering files.
//!
//! Intentional differences: failures print `Error: Hook stage exited with code N`
//! without a Node stack trace; an I/O error inside a builtin is worded by Rust
//! rather than Node; `vis.config.ts` / plugins are not loaded (the Node runner
//! never consulted them for `hook run` either).
//!
//! Parity is pinned by `__tests__/native/hook-run-parity.test.ts`, which runs one
//! table of scenarios through both runners and compares them.

mod builtins;
mod config;
mod exec;
mod filter;
pub mod list;
#[cfg(unix)]
pub mod validate;

use std::env;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

use config::{Entry, Target};
use serde_json::Value;

const DEFAULT_HOOKS_DIRECTORY: &str = ".vis/hooks";

/// Stages where git supplies its own positional args instead of a file set.
const STAGES_WITH_GIT_ARGS: [&str; 6] =
    ["commit-msg", "post-checkout", "post-merge", "post-rewrite", "pre-rebase", "prepare-commit-msg"];

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

/// A hook with its path filters applied and its builtin resolved. Tag filters run
/// later, right before the hook does.
struct Step {
    builtin: Option<builtins::Builtin>,
    entry: Entry,
    files: Vec<String>,
}

/// What every step needs besides itself.
struct Context {
    extra_args: Vec<String>,
    forces_always_run: bool,
    root: PathBuf,
}

/// Everything decided before the first hook runs.
struct Plan {
    context: Context,
    description: String,
    fail_fast: bool,
    stage: String,
    steps: Vec<Step>,
}

enum Prepared {
    NoHooks(String),
    Run(Plan),
}

/// Build the plan, or `None` when the run must go to Node.
fn prepare(args: &[String]) -> Option<Prepared> {
    let parsed = parse_args(args)?;
    let root = env::current_dir().ok()?;
    let hooks_dir = parsed.hooks_dir.as_deref().unwrap_or(DEFAULT_HOOKS_DIRECTORY);

    // Node appends an absolute directory to the root instead of replacing it.
    if Path::new(hooks_dir).is_absolute() {
        return None;
    }

    let stage = parsed.stage.clone().unwrap_or_else(|| "pre-commit".to_owned());
    let text = std::fs::read_to_string(root.join(hooks_dir).join("config.json")).ok()?;
    let config = config::parse(&serde_json::from_str::<Value>(&text).ok()?)?;
    let fail_fast = config.fail_fast;
    let entries = config.into_stage(&stage);

    if entries.is_empty() {
        return Some(Prepared::NoHooks(stage));
    }

    let forces_always_run = STAGES_WITH_GIT_ARGS.contains(&stage.as_str());
    let mut description = String::new();
    let mut candidates = Vec::new();

    if !forces_always_run {
        if parsed.last_commit && (parsed.from_ref.is_some() || parsed.to_ref.is_some()) {
            return None;
        }

        let (from, to) = if parsed.last_commit {
            (Some("HEAD~1".to_owned()), Some("HEAD".to_owned()))
        } else {
            (parsed.from_ref.clone(), parsed.to_ref.clone())
        };
        let mode = match (from, to) {
            (Some(from), Some(to)) => Discover::Range(from, to),
            (None, None) if parsed.all_files => Discover::All,
            (None, None) => Discover::Staged,
            _ => return None,
        };

        description = match &mode {
            Discover::All => " (--all-files)".to_owned(),
            Discover::Range(from, to) => format!(" ({from}..{to})"),
            Discover::Staged => String::new(),
        };
        candidates = discover(&mode)?;
    }

    let mut steps = Vec::with_capacity(entries.len());

    for entry in entries {
        let builtin = match &entry.target {
            Target::Builtin(name) => Some(builtins::resolve(name)?),
            _ => None,
        };

        if !filter::tags_are_known(&entry) {
            return None;
        }

        let files = filter::select_paths(&entry, &candidates)?;

        steps.push(Step { builtin, entry, files });
    }

    Some(Prepared::Run(Plan {
        context: Context { extra_args: parsed.extra_args, forces_always_run, root },
        description,
        fail_fast,
        stage,
        steps,
    }))
}

/// Run one hook; its exit code.
fn run_step(step: Step, context: &Context) -> i32 {
    let entry = &step.entry;

    if let Target::Fail(message) = &entry.target {
        println!("{message}");

        return 1;
    }

    let files = if entry.has_tag_filter() { filter::by_tags(step.files, entry) } else { step.files };

    if files.is_empty() && !entry.always_run && !context.forces_always_run {
        return 0;
    }

    if entry.verbose {
        println!("+ {}", entry.name.as_deref().unwrap_or(&entry.id));
    }

    match (&entry.target, step.builtin) {
        (Target::Builtin(name), Some(builtin)) => match builtin(&files, &entry.args, &context.root) {
            Ok(code) => code,
            Err(error) => {
                eprintln!("builtin \"{name}\" crashed: {error}");

                1
            }
        },
        (Target::Command(command), _) => {
            let extra: &[String] = if context.forces_always_run { &context.extra_args } else { &[] };

            exec::run(command, &entry.args, &files, entry.pass_filenames, extra)
        }
        _ => unreachable!("a builtin target always resolves while preparing"),
    }
}

/// Run the plan; never returns.
fn execute(plan: Plan) -> ! {
    if env::var_os("VIS_HOOK_TRACE").is_some() {
        eprintln!("vis[native]: hook run {}", plan.stage);
    }

    println!("Running {}{}", plan.stage, plan.description);

    let mut rc = 0;

    for step in plan.steps {
        let code = run_step(step, &plan.context);

        if code != 0 {
            rc |= code;

            if plan.fail_fast {
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

/// Entry point for `vis hook run …`; `raw_args` is the same argv as the OS gave it, for the hand-off to Node.
/// Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match prepare(args) {
        None => crate::delegate(raw_args),
        Some(Prepared::NoHooks(stage)) => {
            println!("No hooks configured for stage \"{stage}\".");
            exit(0);
        }
        Some(Prepared::Run(plan)) => execute(plan),
    }
}
