//! `vis dlx <package> [args...]` — the native fast path for the runs where Node's first-run gate stays out.
//!
//! The Node handler (`src/commands/dlx/handler.ts`, run by the lean entry `cli-exec.ts`: no config, no
//! workspace root, no plugins) shows a first-run info panel for a registry package before it runs the
//! package manager's `dlx`. The gate (`src/dlx/first-run.ts`) skips itself, with no network work, in CI, when
//! stdin or stdout is not a terminal and with `--yes` (or a truthy `VIS_DLX_YES`); on a terminal it fetches the
//! package's packument and shows the panel and a prompt for a version it has not seen. So this module answers
//! the runs where the gate does nothing and hands everything else to Node before any output:
//!
//! - the gate is off: `--no-info` or a truthy `VIS_DLX_NO_INFO`, or none of the packages it would vet is a
//!   registry spec (shell mode vets only the `-p` packages; paths, URLs and aliases are skipped);
//! - the gate skips itself: `--yes`, a truthy `VIS_DLX_YES`, CI, or a stream that is not a terminal;
//! - on a terminal, outside CI and without `--yes`, the gate resolves each vetted package against the registry
//!   (the packument, through [`Packuments`], with Node's cache) and finds the version in `~/.vis/state/dlx-seen.json`:
//!   an approved version with no Socket token makes the gate silent, so the run is native. A version it has not
//!   seen (the panel and the prompt), a Socket token, `--offline` and every packument or spec this binary does
//!   not read as Node does stay in Node. The panel itself is not ported: it renders a changelog fetched from
//!   other services and colours of its own;
//! - flags: `--no-info`, `-y`/`--yes`, `--offline`, `-s`/`--silent`, `-c`/`--shell-mode`, each at most once, and
//!   `-p`/`--package <word>` directly followed by another flag (the option takes every word up to the next
//!   flag, so a package or argument after it would be swallowed). The other words are the package and its
//!   arguments, none starting with a dash: Node drops an unknown flag and has a `--` of its own;
//! - installer: what the project's lockfiles say, with nothing in the environment or a `packageManager` pin
//!   that Node reads (`VIS_INSTALLER`, `VIS_RUNTIME`, `aube` on `PATH`, Corepack).
//!
//! Every reason to delegate is decided before the package manager starts. A manager that is not on `PATH`,
//! or that warns (yarn berry with shell mode or `--offline`, bun with `--offline`), is Node's to report.

use std::env;
use std::ffi::OsString;
use std::io::{stdin, stdout, IsTerminal};
use std::path::{Path, PathBuf};
use std::time::Duration;

use vis_core::detect::{detect_package_manager, DetectPackageManagerOptions};
use vis_core::lockfiles::LOCKFILES;
use vis_core::resolve::{resolve_dlx, DlxOptions, ResolvedCommand};

use crate::inspect::{commit, parse_package, CacheAction, Packuments};
use crate::pm_run::{on_path, ManagerRun};

/// `GATHER_BUDGET_MS`: the time the gate gives the registry before it proceeds without a panel.
const GATHER_BUDGET: Duration = Duration::from_secs(6);

/// What the command line asked for.
#[derive(Debug, Default, PartialEq, Eq)]
struct Flags {
    no_info: bool,
    offline: bool,
    yes: bool,
    /// The `-p` packages, in order.
    packages: Vec<String>,
    shell_mode: bool,
    silent: bool,
    /// The package (or, in shell mode, the command), then its arguments.
    words: Vec<String>,
}

/// Answer `vis dlx` natively, or delegate to Node. Never returns.
///
/// `raw` is the untouched argv, handed to Node as it arrived; `args` is the lossy view used for parsing.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let Some(plan) = plan(args, raw) else {
        crate::process::delegate(raw);
    };

    // The registry is asked last, after every reason to delegate that needs no request, and its cache is written
    // only once every package is known to be approved: a hand-off writes nothing.
    if !plan.vetted.is_empty() {
        match approved(&plan.vetted, &plan.run.cwd) {
            Ok(cache) => {
                if let Err(reason) = commit(&cache) {
                    crate::process::delegate_because(&reason, raw);
                }
            }
            Err(reason) => crate::process::delegate_because(&reason, raw),
        }
    }

    plan.run.run_inherited(raw, |code| code)
}

/// What the command line and the environment decided: the manager to run, and the packages the gate would vet on a
/// terminal that this run must find approved first.
struct Plan {
    run: ManagerRun,
    vetted: Vec<String>,
}

/// The command to run and where, or `None` to delegate.
fn plan(args: &[String], raw: &[OsString]) -> Option<Plan> {
    // Windows keeps the Node path: it runs the package manager through a shell there.
    if !cfg!(unix) || raw.iter().any(|argument| argument.to_str().is_none()) {
        return None;
    }

    let flags = parse(args)?;
    let vetted = match gate(&flags, &|name| env::var_os(name), interactive())? {
        Gate::Out => Vec::new(),
        // `--offline` reads the packument cache only, which this module does not.
        Gate::Panel if flags.offline || env::var_os("VIS_SOCKET_TOKEN").is_some() => return None,
        Gate::Panel => vetted_packages(&flags),
    };

    // The Node runtime warns on stderr about conflicting colour variables, with its process id in the text, and
    // `DEBUG` and `CEREBRO_*` change cerebro's output (a debug trace on stdout) and the environment the manager gets.
    if crate::term::node_warns_about_colour()
        || env::var_os("DEBUG").is_some()
        || env::vars_os().any(|(name, _)| name.to_string_lossy().starts_with("CEREBRO_"))
        || crate::pm_detect::installer_selected_by_environment()
    {
        return None;
    }

    let cwd = env::current_dir().ok()?;

    // Node runs the installer a `packageManager` pin names through Corepack, which it reads from any ancestor.
    if crate::pm_detect::ancestor_pins_package_manager(&cwd) {
        return None;
    }

    let (manager, version) = installer(&cwd);
    let (package, rest) = flags.words.split_first()?;
    let mut resolved = resolve_dlx(
        &manager,
        &version,
        DlxOptions {
            additional_packages: flags.packages.clone(),
            args: rest.to_vec(),
            package: package.clone(),
            shell_mode: flags.shell_mode,
            silent: flags.silent,
        },
    )
    .ok()?;

    if flags.offline {
        apply_offline(&mut resolved, &manager);
    }

    // A warning is worded and coloured by Node's logger.
    if !resolved.warnings.is_empty() {
        return None;
    }

    // A manager that is not on `PATH` fails in Node with its own report.
    on_path(&resolved.bin).then(|| Plan {
        run: ManagerRun { bin: resolved.bin, args: resolved.args, cwd, root: None, notices: Vec::new() },
        vetted,
    })
}

/// The manager Node's `resolveInstaller` picks for the lean entry, which reads no config: a bun lockfile
/// as the nearest one makes the runtime bun and so the manager bun; otherwise the detection of the
/// lockfiles. The version is unknown (`latest`) wherever no `packageManager` pin or classic `yarn.lock` names one.
fn installer(cwd: &Path) -> (String, String) {
    if nearest_lockfile_is_bun(cwd) {
        return ("bun".to_owned(), "latest".to_owned());
    }

    let detected = detect_package_manager(&cwd.to_string_lossy(), Some(DetectPackageManagerOptions::default()));

    (detected.name, detected.version.filter(|version| !version.is_empty()).unwrap_or_else(|| "latest".to_owned()))
}

/// `detectFromLockfile` of `resolveRuntime`: the nearest directory with a lockfile of either runtime decides,
/// and a bun lockfile there wins.
fn nearest_lockfile_is_bun(cwd: &Path) -> bool {
    cwd.ancestors().find(|directory| LOCKFILES.iter().any(|(name, _)| directory.join(name).exists())).is_some_and(
        |directory| LOCKFILES.iter().any(|(name, manager)| *manager == "bun" && directory.join(name).exists()),
    )
}

/// `applyDlxOffline`: the manager's own offline flag right after the `dlx` word. A manager with no such flag
/// gets a warning in Node, which the caller leaves to it.
fn apply_offline(resolved: &mut ResolvedCommand, manager: &str) {
    if resolved.args.iter().any(|argument| argument == "--offline" || argument == "--cached-only") {
        return;
    }

    match manager {
        "pnpm" | "npm" => resolved.args.insert(1, "--offline".to_owned()),
        // bun and yarn berry (the version is never a v1 here): no flag, only a warning.
        _ => resolved.warnings.push("no offline mode".to_owned()),
    }
}

/// What Node's first-run gate does for a run.
#[derive(Debug, PartialEq, Eq)]
enum Gate {
    /// Nothing: it is switched off, no package is a registry spec, or it skips itself (`--yes`, CI, no terminal).
    Out,
    /// It resolves the packages and shows a panel for a version it has not seen.
    Panel,
}

/// `isInteractive`: stdin and stdout are terminals and the run is not in CI.
fn interactive() -> bool {
    stdin().is_terminal() && stdout().is_terminal() && !crate::node_context::in_ci()
}

/// The gate for these flags, `lookup` as the environment and `interactive` as the terminal. `None` when an
/// environment variable is not plain ASCII, where JavaScript's `trim` and Rust's differ.
fn gate(flags: &Flags, lookup: &dyn Fn(&str) -> Option<OsString>, interactive: bool) -> Option<Gate> {
    let truthy = |name: &str| -> Option<bool> {
        match lookup(name) {
            None => Some(false),
            Some(value) => Some(is_truthy(value.to_str().filter(|text| text.is_ascii())?)),
        }
    };
    let no_info = flags.no_info || truthy("VIS_DLX_NO_INFO")?;
    let yes = flags.yes || truthy("VIS_DLX_YES")?;

    Some(if no_info || yes || !interactive || vetted_packages(flags).is_empty() { Gate::Out } else { Gate::Panel })
}

/// The packages the gate would vet: shell mode vets the `-p` packages only, otherwise the positional comes first;
/// of those, the registry specs.
fn vetted_packages(flags: &Flags) -> Vec<String> {
    flags
        .words
        .first()
        .filter(|_| !flags.shell_mode)
        .into_iter()
        .chain(&flags.packages)
        .filter(|target| is_registry_spec(target))
        .cloned()
        .collect()
}

/// The cache changes of resolving every package of a gate that would show its panel, or the reason the run is
/// Node's: a package that is not approved (a version it has not seen is a panel and a prompt), or any answer
/// from the registry this module does not read the way the gate does.
fn approved(targets: &[String], cwd: &Path) -> Result<Vec<CacheAction>, String> {
    let home = env::var("HOME").map_err(|_| "HOME is not text".to_owned())?;

    approved_in(targets, &Packuments::new(cwd.to_path_buf(), GATHER_BUDGET)?, &state_file(&home))
}

/// [`approved`] with the packuments and the state file given.
fn approved_in(targets: &[String], registry: &Packuments, state: &Path) -> Result<Vec<CacheAction>, String> {
    let mut cache = Vec::new();

    for target in targets {
        let (name, spec) = parse_package(target).ok_or_else(|| format!("{target:?} is not a plain package spec"))?;
        let (version, changes) = registry
            .resolve_version(&name, spec.as_deref())?
            .ok_or_else(|| format!("the registry names no version for {target:?}"))?;

        if !is_approved(state, &name, &version) {
            return Err(format!("{name}@{version} has not been approved: the gate shows its panel"));
        }

        cache.extend(changes);
    }

    Ok(cache)
}

fn state_file(home: &str) -> PathBuf {
    Path::new(home).join(".vis").join("state").join("dlx-seen.json")
}

/// `getSeenEntry` and `shouldReprompt` with no Socket alerts: whether `name@version` has an approval on file. The
/// file counts only in the shape `readDlxSeen` accepts (`version` 1, `packages` an object, the entry with a list of
/// text `alertKeys` and a numeric `seenAt`); anything else is an empty store, so a panel.
fn is_approved(file: &Path, name: &str, version: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let Ok(state) = serde_json::from_str::<serde_json::Value>(&text) else { return false };

    state.get("version").and_then(serde_json::Value::as_u64) == Some(1)
        && state.get("packages").and_then(|packages| packages.get(format!("{name}@{version}"))).is_some_and(|entry| {
            entry
                .get("alertKeys")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|keys| keys.iter().all(serde_json::Value::is_string))
                && entry.get("seenAt").is_some_and(serde_json::Value::is_number)
        })
}

/// `isTruthyEnv`: on unless empty, `0`, `false` or `no`, ignoring case and surrounding space.
pub(crate) fn is_truthy(value: &str) -> bool {
    !matches!(value.trim().to_lowercase().as_str(), "" | "0" | "false" | "no")
}

/// `isRegistrySpec`: a bare registry name, optionally scoped and versioned. A path, a URL and a protocol alias are not.
fn is_registry_spec(package: &str) -> bool {
    if package.is_empty() || package.starts_with(['.', '/', '~']) {
        return false;
    }

    !package.strip_prefix('@').unwrap_or(package).contains(':')
}

/// The flags and words after `dlx`: exact tokens, each flag at most once. Anything else is `None`.
fn parse(args: &[String]) -> Option<Flags> {
    if args.first().map(String::as_str) != Some("dlx") {
        return None;
    }

    let mut flags = Flags::default();
    let mut seen: Vec<&'static str> = Vec::new();
    let mut index = 1;

    while index < args.len() {
        let token = args[index].as_str();
        let key = match token {
            "--no-info" => {
                flags.no_info = true;
                "no-info"
            }
            "-y" | "--yes" => {
                flags.yes = true;
                "yes"
            }
            "--offline" => {
                flags.offline = true;
                "offline"
            }
            "-s" | "--silent" => {
                flags.silent = true;
                "silent"
            }
            "-c" | "--shell-mode" => {
                flags.shell_mode = true;
                "shell-mode"
            }
            "-p" | "--package" => {
                // The option takes every word up to the next flag: it must be exactly one, then a known flag.
                let value = args.get(index + 1)?;
                let after = args.get(index + 2)?;

                if value.is_empty() || value.starts_with('-') || !is_known_flag(after) {
                    return None;
                }

                flags.packages.push(value.clone());
                index += 2;

                continue;
            }
            // Any other flag, a bundle like `-sc`, a value like `--yes=false`, `--info`, and `--`.
            _ if token.starts_with('-') => return None,
            _ => {
                flags.words.push(token.to_owned());
                index += 1;

                continue;
            }
        };

        // A repeated boolean reaches Node's handler as a list.
        if seen.contains(&key) {
            return None;
        }

        seen.push(key);
        index += 1;
    }

    (!flags.words.is_empty()).then_some(flags)
}

fn is_known_flag(token: &str) -> bool {
    matches!(
        token,
        "--no-info" | "-y" | "--yes" | "--offline" | "-s" | "--silent" | "-c" | "--shell-mode" | "-p" | "--package"
    )
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{
        apply_offline, gate, is_approved, is_registry_spec, is_truthy, nearest_lockfile_is_bun, parse, vetted_packages,
        Flags, Gate,
    };
    use vis_core::resolve::ResolvedCommand;

    fn lockfiles_at(label: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("vis-dlx-lock-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        for (directory, file) in files {
            std::fs::create_dir_all(root.join(directory)).unwrap();
            std::fs::write(root.join(directory).join(file), "").unwrap();
        }

        root
    }

    #[test]
    fn a_bun_lockfile_in_the_nearest_directory_with_one_decides() {
        let both = lockfiles_at("both", &[("", "pnpm-lock.yaml"), ("", "bun.lockb")]);

        assert!(nearest_lockfile_is_bun(&both));

        let nearer = lockfiles_at("nearer", &[("", "bun.lock"), ("app", "pnpm-lock.yaml")]);

        assert!(!nearest_lockfile_is_bun(&nearer.join("app")));

        let farther = lockfiles_at("farther", &[("", "pnpm-lock.yaml"), ("app", "bun.lock")]);

        assert!(nearest_lockfile_is_bun(&farther.join("app")));

        let none = lockfiles_at("none", &[("app", "yarn.lock")]);

        assert!(!nearest_lockfile_is_bun(&none.join("app")));
    }

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn flags_words_and_packages_parse_and_everything_else_does_not() {
        let flags = parse(&tokens(&["dlx", "--no-info", "cowsay", "hi", "-s", "-p", "a", "-c"])).unwrap();

        assert_eq!(
            flags,
            Flags {
                no_info: true,
                packages: vec!["a".into()],
                shell_mode: true,
                silent: true,
                words: vec!["cowsay".into(), "hi".into()],
                ..Flags::default()
            }
        );
        assert!(parse(&tokens(&["dlx", "-p", "a", "-p", "b", "-c", "echo hi"])).is_some());
        assert!(parse(&tokens(&["dlx", "-p", "a", "b"])).is_none());
        assert!(parse(&tokens(&["dlx", "-p", "a"])).is_none());
        assert!(parse(&tokens(&["dlx", "-p", "a", "-p", "b"])).is_none());
        assert!(parse(&tokens(&["dlx", "-p", "-c", "x"])).is_none());
        assert!(parse(&tokens(&["dlx", "--package=a", "-c", "x"])).is_none());
        assert!(parse(&tokens(&["dlx"])).is_none());
        assert!(parse(&tokens(&["dlx", "--no-info"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--info"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--version"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "-x"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "-sc"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--yes=false"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "-s", "-s"])).is_none());
        assert!(parse(&tokens(&["dlx", "cowsay", "--silent", "-s"])).is_none());
        assert!(parse(&tokens(&["x", "cowsay"])).is_none());
    }

    #[test]
    fn registry_specs_are_the_names_the_gate_vets() {
        for spec in ["cowsay", "cowsay@1", "@scope/pkg", "@scope/pkg@^1.0.0", "echo hi"] {
            assert!(is_registry_spec(spec), "{spec}");
        }

        for spec in
            ["", "./x", "../x", "/abs", "~/x", "file:x", "npm:x@1", "github:a/b", "https://x.test/a.tgz", "@scope/x:y"]
        {
            assert!(!is_registry_spec(spec), "{spec}");
        }
    }

    #[test]
    fn truthy_follows_is_truthy_env() {
        for value in ["1", "true", "yes", "on", "anything", " 1 "] {
            assert!(is_truthy(value), "{value}");
        }

        for value in ["", "0", "false", "no", " NO ", "False"] {
            assert!(!is_truthy(value), "{value}");
        }
    }

    #[test]
    fn offline_goes_after_the_dlx_word_where_the_manager_has_it() {
        let resolved =
            || ResolvedCommand { args: vec!["dlx".into(), "cowsay".into()], bin: "pnpm".into(), warnings: Vec::new() };
        let mut pnpm = resolved();

        apply_offline(&mut pnpm, "pnpm");
        assert_eq!(pnpm.args, ["dlx", "--offline", "cowsay"]);

        let mut bun = resolved();

        apply_offline(&mut bun, "bun");
        assert_eq!(bun.args, ["dlx", "cowsay"]);
        assert_eq!(bun.warnings.len(), 1);
    }

    fn environment(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        let pairs = pairs.to_vec();

        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| OsString::from(*value))
    }

    #[test]
    fn the_gate_does_nothing_unless_a_terminal_is_asked_to_approve() {
        let flags = |words: &[&str]| parse(&tokens(words)).unwrap();
        let none = environment(&[]);

        // Not a terminal, or CI (which `interactive` folds in): the gate skips itself.
        assert_eq!(gate(&flags(&["dlx", "cowsay"]), &none, false), Some(Gate::Out));
        // A terminal: the panel, for a registry spec.
        assert_eq!(gate(&flags(&["dlx", "cowsay"]), &none, true), Some(Gate::Panel));
        assert_eq!(gate(&flags(&["dlx", "cowsay@1.5.0", "hi"]), &none, true), Some(Gate::Panel));
        assert_eq!(gate(&flags(&["dlx", "-p", "a", "-s", "cowsay"]), &none, true), Some(Gate::Panel));
        // Switched off, or approved in advance.
        assert_eq!(gate(&flags(&["dlx", "--no-info", "cowsay"]), &none, true), Some(Gate::Out));
        assert_eq!(gate(&flags(&["dlx", "--yes", "cowsay"]), &none, true), Some(Gate::Out));
        assert_eq!(gate(&flags(&["dlx", "cowsay", "-y"]), &none, true), Some(Gate::Out));
        assert_eq!(gate(&flags(&["dlx", "cowsay"]), &environment(&[("VIS_DLX_YES", "1")]), true), Some(Gate::Out));
        assert_eq!(gate(&flags(&["dlx", "cowsay"]), &environment(&[("VIS_DLX_YES", "no")]), true), Some(Gate::Panel));
        assert_eq!(
            gate(&flags(&["dlx", "cowsay"]), &environment(&[("VIS_DLX_NO_INFO", "yes")]), true),
            Some(Gate::Out)
        );
        // Nothing to vet: a path, or shell mode with no `-p` package.
        assert_eq!(gate(&flags(&["dlx", "./local.js"]), &none, true), Some(Gate::Out));
        assert_eq!(gate(&flags(&["dlx", "-c", "echo hi"]), &none, true), Some(Gate::Out));
        assert_eq!(gate(&flags(&["dlx", "-p", "a", "-c", "echo hi"]), &none, true), Some(Gate::Panel));
        // A value Rust and JavaScript could trim differently.
        assert_eq!(gate(&flags(&["dlx", "cowsay"]), &environment(&[("VIS_DLX_YES", "\u{a0}1")]), false), None);
        assert_eq!(gate(&flags(&["dlx", "cowsay"]), &environment(&[("VIS_DLX_NO_INFO", "\u{2003}")]), true), None);
    }

    #[test]
    fn the_vetted_packages_are_the_registry_specs_the_gate_looks_at() {
        let vetted = |words: &[&str]| vetted_packages(&parse(&tokens(words)).unwrap());

        assert_eq!(vetted(&["dlx", "cowsay", "hi"]), ["cowsay"]);
        assert_eq!(vetted(&["dlx", "cowsay", "-p", "a", "-p", "./b", "-s"]), ["cowsay", "a"]);
        assert_eq!(vetted(&["dlx", "-p", "a", "-c", "echo hi"]), ["a"]);
        assert!(vetted(&["dlx", "https://x.test/a.tgz"]).is_empty());
    }

    #[test]
    fn a_version_is_approved_only_by_an_entry_in_the_shape_the_gate_reads() {
        let directory = std::env::temp_dir().join(format!("vis-dlx-seen-{}", std::process::id()));

        std::fs::create_dir_all(&directory).unwrap();

        let file = directory.join("dlx-seen.json");
        let with = |text: &str| {
            std::fs::write(&file, text).unwrap();

            is_approved(&file, "cowsay", "1.6.0")
        };
        let entry = r#"{"alertKeys":["k"],"seenAt":1}"#;

        assert!(!is_approved(&directory.join("missing.json"), "cowsay", "1.6.0"));
        assert!(with(&format!(r#"{{"packages":{{"cowsay@1.6.0":{entry}}},"version":1}}"#)));
        assert!(with(r#"{"packages":{"cowsay@1.6.0":{"alertKeys":[],"seenAt":1700000000000}},"version":1}"#));
        assert!(!with(&format!(r#"{{"packages":{{"cowsay@1.5.0":{entry}}},"version":1}}"#)));
        assert!(!with(&format!(r#"{{"packages":{{"cowsay@1.6.0":{entry}}},"version":2}}"#)));
        assert!(!with(&format!(r#"{{"packages":{{"cowsay@1.6.0":{entry}}}}}"#)));
        assert!(!with(r#"{"packages":{"cowsay@1.6.0":{"alertKeys":[1],"seenAt":1}},"version":1}"#));
        assert!(!with(r#"{"packages":{"cowsay@1.6.0":{"alertKeys":[]}},"version":1}"#));
        assert!(!with(r#"{"packages":{"cowsay@1.6.0":{"alertKeys":"k","seenAt":1}},"version":1}"#));
        assert!(!with(r#"{"packages":[],"version":1}"#));
        assert!(!with("not json"));

        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_terminal_run_is_native_only_for_an_approved_version_of_every_package() {
        use std::collections::HashMap;

        use serde_json::json;

        use crate::inspect::tests::{ok, packuments_for, Registry};

        let packument = |name: &str| {
            ok(&json!({
                "name": name,
                "dist-tags": { "latest": "2.0.0", "next": "3.0.0-beta.1" },
                "versions": { "1.0.0": {}, "2.0.0": {}, "3.0.0-beta.1": {} },
            }))
        };
        let registry = Registry::start(HashMap::from([
            ("/cowsay".to_owned(), packument("cowsay")),
            ("/lolcatjs".to_owned(), packument("lolcatjs")),
        ]));
        let (packuments, home) = packuments_for(&registry);
        let state = super::state_file(&home.to_string_lossy());
        let targets = |list: &[&str]| list.iter().map(|item| (*item).to_owned()).collect::<Vec<_>>();
        let seen = |entries: &[&str]| {
            let packages: Vec<String> =
                entries.iter().map(|entry| format!(r#""{entry}":{{"alertKeys":[],"seenAt":1}}"#)).collect();

            std::fs::create_dir_all(state.parent().unwrap()).unwrap();
            std::fs::write(&state, format!(r#"{{"packages":{{{}}},"version":1}}"#, packages.join(","))).unwrap();
        };

        // No state file: the panel.
        assert!(super::approved_in(&targets(&["cowsay"]), &packuments, &state)
            .unwrap_err()
            .contains("not been approved"));

        // `latest` is 2.0.0, a tag is its version, an exact version is itself.
        seen(&["cowsay@2.0.0", "lolcatjs@2.0.0", "cowsay@3.0.0-beta.1", "cowsay@1.0.0"]);

        for list in [&["cowsay"][..], &["cowsay@latest"], &["cowsay@next"], &["cowsay@1.0.0"], &["cowsay", "lolcatjs"]]
        {
            let cache = super::approved_in(&targets(list), &packuments, &state).unwrap();

            assert_eq!(cache.len(), list.len(), "{list:?}");
        }

        // One package without an approval is enough for the panel.
        seen(&["cowsay@2.0.0"]);
        assert!(super::approved_in(&targets(&["cowsay", "lolcatjs"]), &packuments, &state).is_err());
        assert!(super::approved_in(&targets(&["cowsay@1.0.0"]), &packuments, &state).is_err());

        // A range needs node-semver, a package the registry does not know has no version to approve, and a name
        // outside the plain shape is not asked for.
        for odd in ["cowsay@^1", "ghost", "Cow.Say", "cowsay@x y"] {
            assert!(super::approved_in(&targets(&[odd]), &packuments, &state).is_err(), "{odd}");
        }
    }
}
