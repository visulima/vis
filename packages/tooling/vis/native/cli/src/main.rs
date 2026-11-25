//! `vis` native CLI front-end — the startup + dispatch shell.
//!
//! This binary is the fast entry point for the `vis` CLI during the incremental
//! Rust migration. It answers the commands that are implemented natively and
//! delegates everything else, verbatim, to the existing Node CLI (`dist/bin.js`)
//! so behaviour is byte-identical to the pure-JS tool while commands are ported
//! over one at a time.
//!
//! ## Delegation contract
//!
//! The JS launcher (`bin/vis.mjs`) resolves the platform binary and the Node
//! environment, then sets:
//!
//! | env var              | meaning                                            |
//! | -------------------- | -------------------------------------------------- |
//! | `VIS_NODE`           | absolute path to the Node executable to spawn      |
//! | `VIS_FALLBACK_ENTRY` | absolute path to the JS entry (`dist/bin.js`)      |
//! | `VIS_VERSION`        | the `@visulima/vis` package version string         |
//!
//! When the binary is run directly (no launcher), `VIS_NODE` falls back to
//! `node` from `PATH`; `VIS_FALLBACK_ENTRY` has no safe default and delegation
//! fails loudly if it is unset.

use std::env;
use std::ffi::OsString;
use std::process::exit;

mod add;
mod advisories;
mod affected;
mod cache;
#[cfg(unix)]
mod cache_clean;
mod cache_hash;
#[cfg(unix)]
mod cache_prune;
mod cache_why;
mod ci_workflow;
mod clean;
mod collation;
mod complete;
mod config_cache;
mod deps;
mod dlx;
mod error;
mod exec;
mod graph;
mod help;
mod hook;
mod http;
mod ignore;
#[cfg(unix)]
mod implode;
mod info;
mod install;
mod js;
mod keys_refresh;
mod list;
mod manifest;
mod node_context;
mod node_contract;
mod optimize;
mod output;
mod pail;
mod pm;
mod pm_detect;
mod pm_family;
mod pm_run;
mod pm_shim;
mod process;
#[cfg(unix)]
mod removal;
mod replay;
mod run;
mod run_summary;
mod sbom;
mod secrets;
mod security_list;
mod self_update;
mod shim_status;
mod sort_package_json;
mod summary;
mod surface;
mod table;
// Not routed to any command yet; the command ports call it.
#[cfg_attr(not(test), allow(dead_code))]
mod targets;
mod task_why;
mod term;
mod text;
mod toolchain;
mod typosquat;
mod vis_config;
mod width_tables;
mod workspace;
mod x;

use process::delegate;

/// Internal, additive diagnostic command. Used to validate the
/// launcher → binary → native-output path without touching any existing
/// command surface.
const NATIVE_INFO: &str = "__native-info";

fn main() {
    node_contract::init();
    // Before any output, so the styled help and `clean` text renders on a Windows console.
    term::enable_virtual_terminal();

    // argv[0] is the binary path; the remainder is the `vis` invocation,
    // forwarded verbatim by the JS launcher.
    // The raw argv is kept for delegation, so a non-UTF-8 argument reaches Node unchanged
    // instead of panicking; the `String` view is only for matching command names.
    let raw_args: Vec<OsString> = env::args_os().skip(1).collect();
    let args: Vec<String> = raw_args.iter().map(|argument| argument.to_string_lossy().into_owned()).collect();
    let first = args.first().map(String::as_str).unwrap_or("");

    match first {
        NATIVE_INFO => native_info(),
        // `--version` / `-V` print the bare semver (same as cerebro's version
        // command). NOTE: `-v` is cerebro's *verbose* flag, not version, so it is
        // intentionally NOT routed here and falls through to Node. Help wins over the
        // version (cerebro checks it first), so `--version --help` is answered by the
        // help surface below.
        "--version" | "-V" if !surface::asks_for_help(&args) => print_version(),
        // `vis complete -- <words…>` — dynamic shell completion, answered from the
        // command manifest (the endpoint the generated completion scripts call).
        "complete" if args.get(1).map(String::as_str) == Some("--") => exit(complete::run(&args)),
        // `vis __pm-shim <pm> [args...]` — the package-manager guard + exec,
        // ported fully native (no Node in the loop).
        "__pm-shim" => {
            let invoked = args.get(1).map(String::as_str).unwrap_or("");
            let rest = if args.len() > 2 { &args[2..] } else { &[] };

            pm_shim::dispatch(invoked, rest);
        }
        // `vis exec <command>` — run a local bin via the project PM. Matches the
        // Node lean exec path (runtime/lockfile detection, no config load).
        "exec" => exec::run(&args, &raw_args),
        // `vis hook run …` — native git-hook runner. Every other `hook`
        // subcommand (install, migrate, …), and any `run` shape the fast path
        // is not certain about, is delegated to Node by `hook::run` itself.
        // `hook run --help` is the manifest's to answer (the `_` arm below).
        "hook" if args.get(1).map(String::as_str) == Some("run") && !surface::asks_for_help(&args) => {
            hook::run(&args, &raw_args)
        }
        // `vis hook list` — the stage scripts of the hooks directory, native for a CI context at the root of
        // a pnpm workspace. Every other shape, and every directory it cannot read exactly, is delegated inside
        // `hook::list::run`, before anything is printed; help is left to the arm below.
        "hook" if args.get(1).map(String::as_str) == Some("list") && !surface::asks_for_help(&args) => {
            hook::list::run(&args, &raw_args)
        }
        // `vis hook validate` — answered natively only when it has nothing to report; any warning or error goes to
        // Node (see `hook::validate`), before anything is printed.
        #[cfg(unix)]
        "hook" if args.get(1).map(String::as_str) == Some("validate") && !surface::asks_for_help(&args) => {
            hook::validate::run(&args, &raw_args)
        }
        // `vis advisories bloom status --format json --cache-dir <dir>` — read-only osv-bloom
        // status. Every other shape (table output, `sync`, `prune`, help) goes to the arm below.
        "advisories"
            if args.get(1).map(String::as_str) == Some("bloom")
                && args.get(2).map(String::as_str) == Some("status")
                && !surface::asks_for_help(&args) =>
        {
            advisories::run(&args, &raw_args)
        }
        // `vis ignore` — the plain `--target` / `--json` / `--write` shapes in a CI context;
        // help and everything else falls through to the arm below.
        "ignore" if !surface::asks_for_help(&args) => ignore::run(&args, &raw_args),
        // `vis clean` — the default and `--dry-run`/`--lockfile` shapes are answered natively;
        // every other shape (and `--help`, left to the arm below) goes to Node.
        "clean" if !surface::asks_for_help(&args) => clean::run(&raw_args),
        // `vis implode [--yes]` — the self-uninstall in a CI context, with the same listing, profile edits and removal
        // as the Node handler. Every other shape, and every home, profile or environment it cannot reproduce, is
        // delegated inside `implode::run`, before anything is printed or changed; help is left to the arm below.
        #[cfg(unix)]
        "implode" if !surface::asks_for_help(&args) => implode::run(&args, &raw_args),
        // `vis cache list` / `vis cache size` — read-only cache inspection, native for the plain shapes in
        // a CI context. Every other shape is delegated inside `cache::run`.
        "cache"
            if matches!(args.get(1).map(String::as_str), Some("list" | "size")) && !surface::asks_for_help(&args) =>
        {
            cache::run(&args, &raw_args)
        }
        // `vis cache clean` — the task cache and the per-user stores in a CI context, with the same messages and
        // removals as the Node handler. Every other shape, and every directory, store or environment it cannot
        // reproduce, is delegated inside `cache_clean::run`, before anything is printed or removed.
        #[cfg(unix)]
        "cache" if args.get(1).map(String::as_str) == Some("clean") && !surface::asks_for_help(&args) => {
            cache_clean::run(&args, &raw_args)
        }
        // `vis cache prune` — retention by count, age and size in a CI context, with the same removals and message as
        // the Node handler. Every other shape, and every directory or environment it cannot reproduce, is delegated
        // inside `cache_prune::run`, before anything is printed or removed.
        #[cfg(unix)]
        "cache" if args.get(1).map(String::as_str) == Some("prune") && !surface::asks_for_help(&args) => {
            cache_prune::run(&args, &raw_args)
        }
        // `vis run <target>` — answered natively only when every task is a local cache hit (a CI context,
        // started by the launcher). Everything else is handed to Node before anything is printed, inside
        // `run::run`; help is left to the arm below.
        "run" if args.len() == 2 && !surface::asks_for_help(&args) => run::run(&args, &raw_args),
        // `vis list` — the plain project listing, native for a JS-only workspace in CI. Every
        // other shape, and every root the gates reject, is delegated inside `list::run`.
        "list" if !surface::asks_for_help(&args) => list::run(&args, &raw_args),
        // `vis cache hash <task>` — prints a recorded hash from the run summary; the shapes and
        // contexts it cannot reproduce exactly are delegated inside `cache_hash::run`.
        "cache" if args.get(1).map(String::as_str) == Some("hash") && !surface::asks_for_help(&args) => {
            cache_hash::run(&args, &raw_args)
        }
        // `vis cache why <task>` — diffs the recorded hash inputs against the previous run; the shapes and
        // contexts it cannot reproduce exactly are delegated inside `cache_why::run`.
        "cache" if args.get(1).map(String::as_str) == Some("why") && !surface::asks_for_help(&args) => {
            cache_why::run(&args, &raw_args)
        }
        // `vis replay` — shows a recorded run (or lists the recorded runs); delegated inside `replay::run` for
        // every shape and context it cannot reproduce exactly.
        "replay" if !surface::asks_for_help(&args) => replay::run(&args, &raw_args),
        // `vis task-why <project>:<target>` — the fixed answer for a task of a script-only JS workspace, in a CI
        // context; every error, every other shape and every workspace it cannot read is delegated inside
        // `task_why::run`, before anything is printed.
        "task-why" if !surface::asks_for_help(&args) => task_why::run(&args, &raw_args),
        // `vis affected <target> --sparse-checkout` — the affected project roots. Every other shape
        // forwards to `vis run --affected` and is delegated inside `affected::run`.
        "affected" if !surface::asks_for_help(&args) => affected::run(&args, &raw_args),
        // `vis sbom` — the CycloneDX JSON BOM of a pnpm workspace, native for the shapes `sbom::run` can prove
        // byte for byte; every other shape, and every root or input it cannot read exactly, is delegated inside it.
        "sbom" if !surface::asks_for_help(&args) => sbom::run(&args, &raw_args),
        // `vis secrets` — the working-tree scan with `--format json|sarif`, `--quiet` and `--baseline`.
        // Every other shape is delegated inside `secrets::run`; help is left to the arm below.
        "secrets" if !surface::asks_for_help(&args) => secrets::run(&args, &raw_args),
        // `vis sort-package-json` — every flag, native for a pnpm workspace in CI. Every shape and file it cannot
        // reproduce byte for byte (any error included) is delegated inside `sort_package_json::run`; help is left to
        // the arm below.
        "sort-package-json" if !surface::asks_for_help(&args) => sort_package_json::run(&args, &raw_args),
        // `vis optimize` — the non-interactive report (`--dry-run`, `--format`, `--pin`, `--prod`), native for a pnpm
        // workspace in CI. Every other shape and every input it cannot reproduce is delegated inside
        // `optimize::run`, before anything is printed; help is left to the arm below.
        "optimize" if !surface::asks_for_help(&args) => optimize::run(&args, &raw_args),
        // `vis sync ci-workflow` — the generator and its `--check`, native for a JS-only pnpm workspace in CI.
        // Every other shape, and every input it cannot reproduce byte for byte, is delegated inside
        // `ci_workflow::run`; help is left to the arm below.
        "sync" if args.get(1).map(String::as_str) == Some("ci-workflow") && !surface::asks_for_help(&args) => {
            ci_workflow::run(&args, &raw_args)
        }
        // `vis security list --json` — the read-only build-script triage, native for a pnpm workspace in CI. Every
        // other shape and every input it cannot reproduce is delegated inside `security_list::run`, before anything
        // is printed; help is left to the arm below.
        "security" if args.get(1).map(String::as_str) == Some("list") && !surface::asks_for_help(&args) => {
            security_list::run(&args, &raw_args)
        }
        // `vis security keys-refresh --json [--clear]` — the npm signing-key cache, refreshed over the native HTTP client in
        // a CI context at the root of a pnpm workspace. Every other shape and every input it cannot reproduce is
        // delegated inside `keys_refresh::run`, before anything is printed or written; help is left to the arm below.
        "security" if args.get(1).map(String::as_str) == Some("keys-refresh") && !surface::asks_for_help(&args) => {
            keys_refresh::run(&args, &raw_args)
        }
        // `vis shim status` — the shim directory and `PATH`, native in a CI context at the root of a pnpm workspace.
        // Every other shape and `shim install|uninstall` (Node's) are delegated inside `shim_status::run`; help is left
        // to the arm below.
        "shim" if args.get(1).map(String::as_str) == Some("status") && !surface::asks_for_help(&args) => {
            shim_status::run(&args, &raw_args)
        }
        // `vis deps` — the dependency-policy lints of a pnpm workspace, native for the lint selectors, `--quiet` and
        // `--format` in a CI context. Every other shape, and every workspace or input it cannot reproduce exactly, is
        // delegated inside `deps::run`, before anything is printed; help is left to the arm below.
        "deps" if !surface::asks_for_help(&args) => deps::run(&args, &raw_args),
        // `vis self-update [version] [--check] [--force] [--silent]` — the npm query and the verdicts that need
        // no install, native in a CI context; an install, every other shape and `--help` (left to the arm
        // below) go to Node.
        "self-update" if !surface::asks_for_help(&args) => self_update::run(&args, &raw_args),
        // `vis add <packages...> --no-marshall-check` — the add without the registry lookups, in a CI context.
        // Every other shape, and every root, config or environment the gates reject, is delegated inside
        // `add::run`; help is left to the arm below.
        "add" if !surface::asks_for_help(&args) => add::run(&args, &raw_args),
        // `vis install` (alias `i`) with no packages — the plain install in a CI context. Every other
        // shape, and every root, config or environment the gates reject, is delegated inside `install::run`.
        "install" | "i" if !surface::asks_for_help(&args) => install::run(&args, &raw_args),
        // `vis dlx <package> [args...]` — only the runs where the first-run gate does nothing (`--no-info`, shell mode
        // without `-p`, non-registry specs). Every other shape is delegated inside `dlx::run`, before any output.
        "dlx" if !surface::asks_for_help(&args) => dlx::run(&args, &raw_args),
        // `vis info <package> [field...] [--json]` (alias `view`) — the registry view in a CI context. Every
        // other shape, and every root, config or environment the gates reject, is delegated inside `info::run`.
        "info" | "view" if !surface::asks_for_help(&args) => info::run(&args, &raw_args),
        // `vis pm <subcommand>` — package-manager utility passthrough.
        "pm" => pm::run(&args, &raw_args),
        // `vis x <file>` — native file runner (spawn node-with-preload / bun),
        // delegating in-process/re-exec edge cases to Node. The full argv, raw bytes included,
        // goes along so the delegation path can replay it.
        "x" => x::run(&args, &raw_args),
        // pm translate-and-exec family: detect PM, map flags, exec. The full argv, raw bytes
        // included, goes along so the config-delegation path can replay it.
        "remove" | "dedupe" | "link" | "unlink" | "outdated" | "why" => pm_family::run(&args, &raw_args),
        // Native command routing is added here as commands are ported off Node.
        // Not a native command above: bare `vis`, `--help`, `<command> --help` and
        // `help <command>` are rendered from the generated manifest, a word that is no
        // command at all is rejected (with a did-you-mean), and everything else is
        // delegated unchanged to the Node CLI.
        _ => {
            if let Some(code) = surface::answer(&args).or_else(|| surface::reject_unknown(&args)) {
                exit(code);
            }

            delegate(&raw_args)
        }
    }
}

/// Print the bare package version (`<semver>\n`, matching cerebro). The launcher
/// injects VIS_VERSION from package.json; the crate version is a dev fallback for
/// direct invocation.
fn print_version() {
    match env::var("VIS_VERSION") {
        Ok(version) => println!("{version}"),
        Err(_) => println!("{}", env!("CARGO_PKG_VERSION")),
    }
}

/// Print front-end diagnostics. Purely additive — it has no Node counterpart, so
/// it cannot regress existing behaviour.
fn native_info() {
    let unset = || "<unset>".to_owned();

    println!("vis native front-end");
    println!("  binary-version : {}", env!("CARGO_PKG_VERSION"));
    println!("  os             : {}", env::consts::OS);
    println!("  arch           : {}", env::consts::ARCH);
    println!("  node           : {}", env::var("VIS_NODE").unwrap_or_else(|_| unset()));
    println!("  fallback-entry : {}", env::var("VIS_FALLBACK_ENTRY").unwrap_or_else(|_| unset()));
    println!("  pkg-version    : {}", env::var("VIS_VERSION").unwrap_or_else(|_| unset()));
}
