//! Which module answers an invocation: the table `main` dispatches through.
//!
//! [`route`] is pure: it looks at the arguments and names the entry that takes the run, without
//! running anything, so a test can pin every route (see `tests::routes_match_the_snapshot`).
//!
//! Every row of [`ROUTES`] is a command path, what it does with `--help`, and the entry function.
//! The longest row that is a prefix of the arguments wins. An invocation no row takes is the
//! manifest's: bare `vis`, `--help`, `<command> --help`, `help <command>`, a rejected unknown
//! word, and a hand-off of everything else to Node (`surface`, then `process::delegate`).
//!
//! A row's entry decides, before anything is printed, whether the shape is one it can answer
//! exactly; the shapes it cannot are delegated from inside it. The rows below only decide who gets
//! the call first.

use std::ffi::OsString;

use crate::surface;

/// An entry takes the full argv (as text for matching, as raw bytes for a hand-off to Node) and
/// never returns: it prints and exits, or delegates.
pub(crate) type Entry = fn(&[String], &[OsString]) -> !;

/// What a row does when the invocation asks for `--help` (`--help` / `-h` before any `--`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Help {
    /// The manifest answers it: the row is skipped, and the invocation falls to the surface.
    Manifest,
    /// The entry gets the flag as one of its own arguments.
    ///
    /// Only `x` uses this: Node takes `--help` after `x` for a file name, so the entry has always seen it
    /// as one of its own arguments, and the launcher routes `x` to the binary
    /// (`NATIVE_COMMANDS` in `bin/route.mjs`) whatever follows.
    Entry,
}

pub(crate) struct Route {
    pub(crate) path: &'static [&'static str],
    pub(crate) help: Help,
    pub(crate) entry: Entry,
}

const fn answers(path: &'static [&'static str], entry: Entry) -> Route {
    Route { path, help: Help::Manifest, entry }
}

const fn takes_help(path: &'static [&'static str], entry: Entry) -> Route {
    Route { path, help: Help::Entry, entry }
}

fn clean(_args: &[String], raw_args: &[OsString]) -> ! {
    crate::clean::run(raw_args)
}

static ROUTES: &[Route] = &[
    answers(&["hook", "run"], crate::hook::run),
    answers(&["hook", "list"], crate::hook::list::run),
    #[cfg(unix)]
    answers(&["hook", "validate"], crate::hook::validate::run),
    answers(&["advisories", "bloom", "status"], crate::advisories::run),
    answers(&["ignore"], crate::ignore::run),
    answers(&["clean"], clean),
    #[cfg(unix)]
    answers(&["implode"], crate::implode::run),
    answers(&["cache", "list"], crate::cache::run),
    answers(&["cache", "size"], crate::cache::run),
    #[cfg(unix)]
    answers(&["cache", "clean"], crate::cache_clean::run),
    #[cfg(unix)]
    answers(&["cache", "prune"], crate::cache_prune::run),
    answers(&["cache", "hash"], crate::cache_hash::run),
    answers(&["cache", "why"], crate::cache_why::run),
    answers(&["list"], crate::list::run),
    answers(&["replay"], crate::replay::run),
    answers(&["task-why"], crate::task_why::run),
    answers(&["graph"], crate::graph_view::run),
    answers(&["affected"], crate::affected::run),
    answers(&["audit"], crate::audit::run),
    answers(&["sbom"], crate::sbom::run),
    answers(&["secrets"], crate::secrets::run),
    answers(&["status"], crate::status::run),
    answers(&["sort-package-json"], crate::sort_package_json::run),
    answers(&["optimize"], crate::optimize::run),
    answers(&["sync", "ci-workflow"], crate::ci_workflow::run),
    answers(&["security", "list"], crate::security_list::run),
    answers(&["security", "keys-refresh"], crate::keys_refresh::run),
    answers(&["security", "sync"], crate::security_sync::run),
    answers(&["security", "tripwire"], crate::security_tripwire::run),
    answers(&["shim", "status"], crate::shim_status::run),
    answers(&["deps"], crate::deps::run),
    answers(&["self-update"], crate::self_update::run),
    answers(&["attest", "verify"], crate::attest::verify::run),
    answers(&["attest"], crate::attest::emit::run),
    answers(&["add"], crate::add::run),
    answers(&["install"], crate::install::run),
    answers(&["i"], crate::install::run),
    answers(&["dlx"], crate::dlx::run),
    answers(&["info"], crate::info::run),
    answers(&["inspect"], crate::inspect::run),
    answers(&["view"], crate::info::run),
    // The package-manager and runner commands. `--help` before a `--` is the manifest's, as in the Node CLI,
    // so it never reaches the package manager (`vis dedupe --help` used to run `<pm> dedupe`); `x` is the
    // exception (see `Help::Entry`).
    answers(&["exec"], crate::exec::run),
    answers(&["pm"], crate::pm::run),
    takes_help(&["x"], crate::x::run),
    answers(&["remove"], crate::pm_family::run),
    answers(&["dedupe"], crate::pm_family::run),
    answers(&["link"], crate::pm_family::run),
    answers(&["unlink"], crate::pm_family::run),
    answers(&["outdated"], crate::pm_family::run),
    answers(&["why"], crate::pm_family::run),
];

/// Who takes an invocation.
pub(crate) enum Dispatch {
    /// `__native-info`, the launcher diagnostic.
    NativeInfo,
    /// `--version` / `-V` without a help flag.
    Version,
    /// `complete -- <words…>`, the endpoint of the generated completion scripts.
    Complete,
    /// `run <target>` and nothing else: answered only when every task is a local cache hit.
    CachedRun,
    /// `__pm-shim <pm> [args…]`, whose entry has its own signature.
    PmShim,
    Command(&'static Route),
    /// No row takes it: the help surface, the unknown-command rejection, or a hand-off to Node.
    Surface,
}

fn is_prefix(path: &[&str], args: &[String]) -> bool {
    path.len() <= args.len() && path.iter().zip(args).all(|(word, argument)| word == argument)
}

pub(crate) fn route(args: &[String]) -> Dispatch {
    let first = args.first().map(String::as_str).unwrap_or("");
    let help = surface::asks_for_help(args);

    match first {
        "__native-info" => return Dispatch::NativeInfo,
        // `-v` is cerebro's verbose flag, not version, so it is not here. Help wins over the version
        // (cerebro checks it first), so `--version --help` is the help surface's.
        "--version" | "-V" if !help => return Dispatch::Version,
        "complete" if args.get(1).map(String::as_str) == Some("--") => return Dispatch::Complete,
        "__pm-shim" => return Dispatch::PmShim,
        "run" if args.len() == 2 && !help => return Dispatch::CachedRun,
        _ => {}
    }

    ROUTES
        .iter()
        .filter(|route| is_prefix(route.path, args))
        .max_by_key(|route| route.path.len())
        .filter(|route| route.help == Help::Entry || !help)
        .map_or(Dispatch::Surface, Dispatch::Command)
}

#[cfg(test)]
mod tests {
    /// Every command path the routes name. A new route is a new line here, and in the snapshot.
    #[cfg(unix)]
    const COMMAND_PATHS: &[&[&str]] = &[
        &["hook", "run"],
        &["hook", "list"],
        &["hook", "validate"],
        &["advisories", "bloom", "status"],
        &["ignore"],
        &["clean"],
        &["implode"],
        &["cache", "list"],
        &["cache", "size"],
        &["cache", "clean"],
        &["cache", "prune"],
        &["cache", "hash"],
        &["cache", "why"],
        &["list"],
        &["replay"],
        &["task-why"],
        &["graph"],
        &["affected"],
        &["audit"],
        &["sbom"],
        &["secrets"],
        &["status"],
        &["sort-package-json"],
        &["optimize"],
        &["sync", "ci-workflow"],
        &["security", "list"],
        &["security", "keys-refresh"],
        &["security", "sync"],
        &["security", "tripwire"],
        &["shim", "status"],
        &["deps"],
        &["self-update"],
        &["attest", "verify"],
        &["attest"],
        &["add"],
        &["install"],
        &["i"],
        &["dlx"],
        &["info"],
        &["inspect"],
        &["view"],
        &["exec"],
        &["pm"],
        &["x"],
        &["remove"],
        &["dedupe"],
        &["link"],
        &["unlink"],
        &["outdated"],
        &["why"],
    ];

    #[cfg(unix)]
    use std::collections::BTreeSet;

    use super::*;
    #[cfg(unix)]
    use crate::manifest::Manifest;

    fn label(dispatch: &Dispatch) -> String {
        match dispatch {
            Dispatch::NativeInfo => "native-info".to_owned(),
            Dispatch::Version => "version".to_owned(),
            Dispatch::Complete => "complete".to_owned(),
            Dispatch::CachedRun => "run".to_owned(),
            Dispatch::PmShim => "pm-shim".to_owned(),
            Dispatch::Command(route) => route.path.join(" "),
            Dispatch::Surface => "surface".to_owned(),
        }
    }

    /// Every argument list the snapshot covers: the shared fixture's, each manifest command and its
    /// aliases, and every command word of the table, each alone and with a subcommand, a positional,
    /// a help flag and a leading global flag.
    #[cfg(unix)]
    fn invocations() -> BTreeSet<Vec<String>> {
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            args: Vec<String>,
        }

        let fixture: Fixture =
            serde_json::from_str(include_str!("../tests/fixtures/routing.json")).expect("routing fixture parses");
        let mut found: BTreeSet<Vec<String>> = fixture.cases.into_iter().map(|case| case.args).collect();
        let mut words: BTreeSet<Vec<String>> = BTreeSet::new();
        let manifest = Manifest::load();

        for command in &manifest.commands {
            words.insert(command.command_path.clone());
            words.insert(command.name.split(' ').map(str::to_owned).collect());

            for alias in &command.alias {
                words.insert(vec![alias.clone()]);
            }
        }

        for path in COMMAND_PATHS {
            words.insert(path.iter().map(|word| (*word).to_owned()).collect());
            words.insert(vec![path[0].to_owned()]);
        }

        for word in [
            "__native-info",
            "__pm-shim",
            "--version",
            "-V",
            "complete",
            "run",
            "frobnicate",
            "help",
            "--no-color",
            "-v",
            "cache",
            "hook",
            "advisories",
            "security",
            "sync",
            "shim",
        ] {
            words.insert(vec![word.to_owned()]);
        }

        for path in words {
            let owned =
                |extra: &[&str]| path.iter().cloned().chain(extra.iter().map(|word| (*word).to_owned())).collect();

            for extra in [
                &[][..],
                &["--help"],
                &["-h"],
                &["--"],
                &["--", "--help"],
                &["target"],
                &["target", "--help"],
                &["target", "other"],
                &["bloom", "status"],
                &["bloom", "status", "--help"],
                &["list"],
                &["status", "--help"],
                &["--format", "json"],
                &["--no-color", "-h"],
                &["--version"],
                &["--version", "--help"],
            ] {
                found.insert(owned(extra));
            }

            for lead in ["--no-color", "--color", "--quiet"] {
                found.insert(std::iter::once(lead.to_owned()).chain(path.iter().cloned()).collect());
            }
        }

        for extra in
            [&["--version", "--help"][..], &["-V", "-h"], &["-V", "x"], &["--version", "x"], &["--help", "--version"]]
        {
            found.insert(extra.iter().map(|word| (*word).to_owned()).collect());
        }

        found
    }

    /// One line per invocation, `["args"] => entry`: where the dispatch takes it. The file was written from the
    /// `match` that `main` held before the table (`b6ba86dc`), so a difference here is a route that moved.
    #[cfg(unix)]
    const SNAPSHOT: &str = include_str!("../tests/fixtures/native-routes.snap");

    #[cfg(unix)]
    fn render() -> String {
        invocations()
            .into_iter()
            .map(|args| {
                format!("{} => {}\n", serde_json::to_string(&args).expect("args serialise"), label(&route(&args)))
            })
            .collect()
    }

    // The snapshot was written for the Unix routes: `hook validate`, `implode`, `cache clean` and `cache prune` have no
    // row on Windows, where they reach the surface instead, so the pinned entries and the row count only hold on Unix.
    #[cfg(unix)]
    #[test]
    fn routes_match_the_snapshot() {
        let rendered = render();

        let changed: Vec<String> = rendered
            .lines()
            .zip(SNAPSHOT.lines())
            .filter(|(now, before)| now != before)
            .map(|(now, before)| format!("was {before}\n now {now}"))
            .collect();

        assert!(
            rendered.lines().count() == SNAPSHOT.lines().count() && changed.is_empty(),
            "routing changed:\n{}",
            changed.join("\n")
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_rows_are_the_paths_the_snapshot_covers() {
        let rows: Vec<&[&str]> = ROUTES.iter().map(|route| route.path).collect();
        let covered: BTreeSet<&[&str]> = COMMAND_PATHS.iter().copied().collect();

        assert_eq!(rows.len(), covered.len(), "a row appears twice or is missing from COMMAND_PATHS");
        assert!(rows.iter().all(|path| covered.contains(path)));
    }

    /// `--help` / `-h` before a `--` is the manifest's for the package-manager commands too, as it is in the Node
    /// CLI: the entry never sees it, so the manager is neither asked for its own help nor run with no arguments.
    /// After a `--` it is the tool's, so the row keeps it.
    #[test]
    fn package_manager_commands_leave_help_to_the_manifest() {
        let dispatch = |words: &[&str]| label(&route(&words.iter().map(|word| (*word).to_owned()).collect::<Vec<_>>()));

        for command in ["exec", "pm", "remove", "dedupe", "link", "unlink", "outdated", "why"] {
            for shape in [&["--help"][..], &["-h"], &["tool", "--help"], &["--json", "-h"], &["--help", "--"]] {
                let words: Vec<&str> = std::iter::once(command).chain(shape.iter().copied()).collect();

                assert_eq!(dispatch(&words), "surface", "{words:?}");
            }

            assert_eq!(dispatch(&[command, "--", "--help"]), command);
            assert_eq!(dispatch(&[command, "tool"]), command);
        }
    }

    #[test]
    fn the_longest_row_wins() {
        let dispatch = |words: &[&str]| label(&route(&words.iter().map(|word| (*word).to_owned()).collect::<Vec<_>>()));

        assert_eq!(dispatch(&["cache", "list", "x"]), "cache list");
        assert_eq!(dispatch(&["cache"]), "surface");
        assert_eq!(dispatch(&["advisories", "bloom"]), "surface");
        assert_eq!(dispatch(&["pm", "--help"]), "surface");
        assert_eq!(dispatch(&["x", "--help"]), "x");
        assert_eq!(dispatch(&["x", "-h"]), "x");
        assert_eq!(dispatch(&["list", "--help"]), "surface");
    }
}
