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
mod audit;
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
mod fs_write;
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
mod json;
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
mod pnpm_lock;
mod process;
#[cfg(unix)]
mod removal;
mod replay;
mod route;
mod run;
mod run_summary;
mod sbom;
mod secrets;
mod security_list;
mod security_sync;
mod self_update;
mod shim_status;
mod sort_package_json;
mod summary;
mod surface;
mod table;
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
use route::Dispatch;

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

    match route::route(&args) {
        Dispatch::NativeInfo => native_info(),
        Dispatch::Version => println!("{}", node_contract::version()),
        Dispatch::Complete => exit(complete::run(&args)),
        Dispatch::CachedRun => run::run(&args, &raw_args),
        Dispatch::PmShim => {
            let invoked = args.get(1).map(String::as_str).unwrap_or("");
            let rest = if args.len() > 2 { &args[2..] } else { &[] };

            pm_shim::dispatch(invoked, rest);
        }
        Dispatch::Command(route) => (route.entry)(&args, &raw_args),
        // Not a native command: bare `vis`, `--help`, `<command> --help` and `help <command>` are
        // rendered from the generated manifest, a word that is no command at all is rejected (with
        // a did-you-mean), and everything else is delegated unchanged to the Node CLI.
        Dispatch::Surface => {
            if let Some(code) = surface::answer(&args).or_else(|| surface::reject_unknown(&args)) {
                exit(code);
            }

            delegate(&raw_args)
        }
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
