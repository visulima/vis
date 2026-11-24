//! Package-manager command resolution. Each `resolve_*` maps a vis verb + the
//! detected PM/version + options to the concrete `{bin, args}` to spawn.
//!
//! This is the single implementation: the `vis` CLI binary calls it directly and
//! the napi addon's `pm_resolve.rs` wraps it (converting its JS option objects
//! into these types), so a fix to a flag mapping, warning, or PM version branch
//! lands in one place.

/// The resolved command to spawn, plus any non-fatal warnings to surface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedCommand {
    pub bin: String,
    pub args: Vec<String>,
    pub warnings: Vec<String>,
}

/// Validates that the PM name is one of the supported values.
fn validate_pm(pm: &str) -> Result<(), String> {
    match pm {
        "pnpm" | "npm" | "yarn" | "bun" => Ok(()),
        _ => Err(format!("Unsupported package manager: '{pm}'. Supported: pnpm, npm, yarn, bun")),
    }
}

/// Options for `resolve_exec`.
#[derive(Clone, Debug, Default)]
pub struct ExecOptions {
    pub command: String,
    pub args: Vec<String>,
    pub shell_mode: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub parallel: bool,
    pub reverse: bool,
    pub filter: Vec<String>,
}

/// Refuse the selection flags of `vis exec` for a manager that runs one binary once in the current directory
/// (`bunx`, the `npx` stand-in for yarn classic): each would be dropped and the command would still exit 0.
fn refuse_exec_flags(pm: &str, runner: &str, opts: &ExecOptions, shell_mode: bool) -> Result<(), String> {
    let flags: Vec<&str> = [
        (opts.recursive, "--recursive"),
        (!opts.filter.is_empty(), "--filter"),
        (opts.workspace_root, "--workspace-root"),
        (opts.parallel, "--parallel"),
        (opts.reverse, "--reverse"),
        (shell_mode && opts.shell_mode, "--shell-mode"),
    ]
    .into_iter()
    .filter_map(|(set, flag)| set.then_some(flag))
    .collect();

    if flags.is_empty() {
        return Ok(());
    }

    Err(format!(
        "{pm} cannot honour {} for `vis exec`: it runs {runner} once in the current directory.",
        flags.join(", ")
    ))
}

/// `--reverse` only reorders a recursive run, and only pnpm (and aube) can; elsewhere it would be dropped.
fn reject_reverse(pm: &str, opts: &ExecOptions) -> Result<(), String> {
    if opts.reverse {
        return Err(format!("{pm} has no --reverse for `vis exec`; only pnpm can run workspaces in reverse order."));
    }

    Ok(())
}

/// Resolve `vis exec <command>` to the PM-specific invocation.
pub fn resolve_exec(pm: &str, version: &str, opts: ExecOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();
    let mut bin = pm.to_owned();

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            args.push("exec".into());

            if opts.recursive {
                args.push("--recursive".into());
            }

            if opts.workspace_root {
                args.push("-w".into());
            }

            if opts.parallel {
                args.push("--parallel".into());
            }

            if opts.reverse {
                args.push("--reverse".into());
            }

            if opts.shell_mode {
                args.push("-c".into());
            }

            args.push(opts.command);
            args.extend(opts.args);
        }
        "npm" => {
            reject_reverse(pm, &opts)?;
            args.push("exec".into());

            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }

            if opts.recursive {
                args.push("--workspaces".into());
            }

            if opts.workspace_root {
                args.push("--include-workspace-root".into());
            }

            // npm's `-c` is `--call <String>` and takes the next token, so the command has to ride in
            // the same argument; `npm exec` refuses extra arguments next to `--call`, which stays loud.
            if opts.shell_mode {
                args.push(format!("--call={}", opts.command));

                if !opts.args.is_empty() {
                    args.push("--".into());
                }
            } else {
                args.push("--".into());
                args.push(opts.command);
            }

            args.extend(opts.args);
        }
        "yarn" => {
            reject_reverse(pm, &opts)?;

            if version.starts_with("1.") {
                refuse_exec_flags("yarn v1", "`npx <command>`", &opts, false)?;
                warnings.push("yarn v1 does not support exec. Falling back to npx.".into());
                bin = "npx".into();

                if opts.shell_mode {
                    args.push("-c".into());
                }

                args.push(opts.command);
                args.extend(opts.args);
            } else {
                if opts.recursive || !opts.filter.is_empty() {
                    yarn_foreach_prefix(&opts.filter, &mut args);

                    if opts.parallel {
                        args.push("--parallel".into());
                    }
                }

                args.push("exec".into());
                args.push(opts.command);
                args.extend(opts.args);
            }
        }
        "bun" => {
            refuse_exec_flags("bun", "`bunx <command>`", &opts, true)?;

            bin = "bunx".into();
            args.push(opts.command);
            args.extend(opts.args);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { bin, args, warnings })
}

/// Resolve `vis pm <subcommand> [args]` to the PM-specific invocation (per-PM
/// mapping for cache/list/pack/view + npm-only verbs, with a default pass-through).
pub fn resolve_pm_command(
    pm: &str,
    version: &str,
    subcommand: &str,
    mut extra_args: Vec<String>,
) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    // Commands that always delegate to npm.
    let npm_only = ["deprecate", "fund", "ping", "search", "token"];

    if npm_only.contains(&subcommand) {
        if pm != "npm" {
            warnings.push(format!("'{subcommand}' is not natively supported by {pm}. Delegating to npm."));
        }

        args.push(subcommand.to_owned());
        args.extend(extra_args);

        return Ok(ResolvedCommand { args, bin: "npm".into(), warnings });
    }

    match (subcommand, pm) {
        ("cache", "pnpm") => {
            args.push("store".into());

            match extra_args.first().map(String::as_str) {
                Some("dir") => {
                    args.push("path".into());
                    extra_args.clear();
                }
                Some("clean") => {
                    args.push("prune".into());
                    extra_args.remove(0);
                }
                _ => {}
            }
        }
        ("cache", "bun") => args.extend(["pm".into(), "cache".into()]),
        ("list" | "ls", "bun") => args.extend(["pm".into(), "ls".into()]),
        ("list" | "ls", _) => args.push("list".into()),
        ("pack", "bun") => args.extend(["pm".into(), "pack".into()]),
        ("view" | "info", "yarn") if version.starts_with("1.") => args.push("info".into()),
        ("view" | "info", "yarn") => args.extend(["npm".into(), "info".into()]),
        ("view" | "info", "bun") => args.extend(["pm".into(), "view".into()]),
        ("view" | "info", _) => args.push("view".into()),
        _ => {
            if subcommand == "prune" && (pm == "yarn" || pm == "bun") {
                warnings.push(format!("{pm} does not support 'prune'. It prunes automatically on install."));
            }

            if subcommand == "rebuild" && (pm == "yarn" || pm == "bun") {
                warnings.push(format!("{pm} does not support 'rebuild'."));
            }

            args.push(subcommand.to_owned());
        }
    }

    args.extend(extra_args);

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

/// Leading integer of a version string (`"11.0.0-rc.0"` -> `Some(11)`), or None
/// when it doesn't start with a digit (`"latest"`).
fn parse_major(version: &str) -> Option<u32> {
    let end = version.find(|c: char| !c.is_ascii_digit()).unwrap_or(version.len());

    version[..end].parse::<u32>().ok()
}

/// `Some(true)` for pnpm >= 11, `Some(false)` below, `None` if unparseable.
fn is_pnpm_v11_plus(version: &str) -> Option<bool> {
    parse_major(version).map(|major| major >= 11)
}

/// True when the target looks like a filesystem path rather than a bare name.
fn is_path_like(target: &str) -> bool {
    target.starts_with('/')
        || target.starts_with('\\')
        || target.starts_with("./")
        || target.starts_with(".\\")
        || target.starts_with("../")
        || target.starts_with("..\\")
        || target == "."
        || target == ".."
        || (target.len() >= 3
            && target.as_bytes()[1] == b':'
            && (target.as_bytes()[2] == b'/' || target.as_bytes()[2] == b'\\'))
}

/// Options for `resolve_remove`.
#[derive(Clone, Debug, Default)]
pub struct RemoveOptions {
    pub packages: Vec<String>,
    pub save_dev: bool,
    pub global: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

/// Scope a Yarn command to one workspace: `yarn workspace <name> <cmd>`. `yarn
/// workspace` targets a single workspace, so more than one filter is refused
/// instead of silently running against only the first.
fn yarn_workspace_prefix(filter: &[String], args: &mut Vec<String>) -> Result<(), String> {
    match filter {
        [] => {}
        [workspace] => {
            args.push("workspace".into());
            args.push(workspace.clone());
        }
        _ => return Err("yarn `workspace` supports a single --filter workspace".into()),
    }

    Ok(())
}

/// Scope a Yarn Berry command to several workspaces: `yarn workspaces foreach
/// --all [--include <name>]... <cmd>`. With no filter it runs in every workspace.
fn yarn_foreach_prefix(filter: &[String], args: &mut Vec<String>) {
    args.push("workspaces".into());
    args.push("foreach".into());
    args.push("--all".into());

    for f in filter {
        args.push("--include".into());
        args.push(f.clone());
    }
}

/// Resolve `vis remove <packages>`.
pub fn resolve_remove(pm: &str, version: &str, opts: RemoveOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let warnings = Vec::new();

    if opts.global && pm != "bun" {
        let mut global = vec!["uninstall".to_owned(), "--global".to_owned()];
        global.extend(opts.packages);

        return Ok(ResolvedCommand { args: global, bin: "npm".into(), warnings });
    }

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            if opts.workspace_root {
                args.push("-w".into());
            }

            args.push("remove".into());

            if opts.save_dev {
                args.push("-D".into());
            }

            if opts.recursive {
                args.push("--recursive".into());
            }

            args.extend(opts.packages);
        }
        "npm" => {
            args.push("uninstall".into());

            if opts.save_dev {
                args.push("--save-dev".into());
            }

            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }

            if opts.recursive {
                args.push("--workspaces".into());
            }

            if opts.workspace_root {
                // npm's `-w` is `--workspace` and consumes the next argument, so it cannot select the
                // root. Pin the root explicitly instead.
                args.push(
                    if opts.filter.is_empty() { "--workspaces=false" } else { "--include-workspace-root" }.into(),
                );
            }

            args.extend(opts.packages);
        }
        "yarn" => {
            if version.starts_with("1.") {
                yarn_workspace_prefix(&opts.filter, &mut args)?;
                args.push("remove".into());
                args.extend(opts.packages);
            } else {
                if opts.recursive || opts.filter.len() > 1 {
                    yarn_foreach_prefix(&opts.filter, &mut args);
                } else {
                    yarn_workspace_prefix(&opts.filter, &mut args)?;
                }

                args.push("remove".into());
                args.extend(opts.packages);
            }
        }
        "bun" => {
            args.push("remove".into());

            if opts.global {
                args.push("--global".into());
            }

            args.extend(opts.packages);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

/// Resolve `vis dedupe`.
pub fn resolve_dedupe(pm: &str, version: &str, check: bool) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            args.push("dedupe".into());

            if check {
                args.push("--check".into());
            }
        }
        "npm" => {
            args.push("dedupe".into());

            if check {
                args.push("--dry-run".into());
            }
        }
        "yarn" => {
            if version.starts_with("1.") {
                warnings.push("yarn v1 does not support dedupe. Upgrade to yarn berry (v2+).".into());

                return Ok(ResolvedCommand { args: vec!["install".into()], bin: "yarn".into(), warnings });
            }

            args.push("dedupe".into());

            if check {
                args.push("--check".into());
            }
        }
        "bun" => {
            warnings.push("bun does not support dedupe operations.".into());

            return Ok(ResolvedCommand { args: vec!["install".into()], bin: "bun".into(), warnings });
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

/// Resolve `vis link [target]`.
pub fn resolve_link(pm: &str, version: &str, target: Option<String>) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = vec!["link".to_owned()];
    let mut warnings = Vec::new();

    if pm == "pnpm" {
        match is_pnpm_v11_plus(version) {
            Some(true) => match &target {
                None => warnings.push(
                    "pnpm v11 removed arg-less `pnpm link`. Pass an explicit path, e.g. `vis link ./packages/my-pkg`."
                        .into(),
                ),
                Some(t) if !is_path_like(t) => {
                    warnings.push(format!("pnpm v11 removed global-store name resolution for `pnpm link {t}`. Use a relative or absolute path instead."));
                }
                _ => {}
            },
            None => match &target {
                None => warnings.push(
                    "pnpm version unknown. Arg-less `pnpm link` was removed in v11; pass an explicit path to be safe."
                        .into(),
                ),
                Some(t) if !is_path_like(t) => {
                    warnings.push(format!("pnpm version unknown. Global-store name resolution for `pnpm link {t}` was removed in v11; use a path to be safe."));
                }
                _ => {}
            },
            Some(false) => {}
        }
    }

    if let Some(t) = target {
        args.push(t);
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

/// Resolve `vis unlink <packages>`.
pub fn resolve_unlink(
    pm: &str,
    version: &str,
    packages: Vec<String>,
    recursive: bool,
) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            args.push("unlink".into());

            if recursive {
                args.push("--recursive".into());
            }

            args.extend(packages);
        }
        "npm" => {
            args.push("unlink".into());

            if recursive {
                warnings.push("npm does not support --recursive for unlink.".into());
            }

            args.extend(packages);
        }
        "yarn" => {
            args.push("unlink".into());

            if recursive && !version.starts_with("1.") {
                args.push("--all".into());
            } else if recursive {
                warnings.push("yarn v1 does not support recursive unlink.".into());
            }

            args.extend(packages);
        }
        "bun" => {
            args.push("unlink".into());

            if recursive {
                warnings.push("bun does not support --recursive for unlink.".into());
            }

            args.extend(packages);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

/// Options for `resolve_outdated`.
#[derive(Clone, Debug, Default)]
pub struct OutdatedOptions {
    pub packages: Vec<String>,
    pub long: bool,
    pub format: String,
    pub recursive: bool,
    pub filter: Vec<String>,
    pub workspace_root: bool,
    pub prod: bool,
    pub dev: bool,
    pub no_optional: bool,
    pub compatible: bool,
    pub global: bool,
}

/// Resolve `vis outdated`.
pub fn resolve_outdated(pm: &str, version: &str, opts: OutdatedOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            args.push("outdated".into());

            if opts.long {
                args.push("--long".into());
            }

            if opts.recursive {
                args.push("--recursive".into());
            }

            if opts.workspace_root {
                args.push("--include-workspace-root".into());
            }

            if opts.prod {
                args.push("--prod".into());
            }

            if opts.dev {
                args.push("--dev".into());
            }

            if opts.no_optional {
                args.push("--no-optional".into());
            }

            if opts.compatible {
                args.push("--compatible".into());
            }

            match opts.format.as_str() {
                "json" => {
                    args.push("--format".into());
                    args.push("json".into());
                }
                "list" => {
                    args.push("--format".into());
                    args.push("list".into());
                }
                _ => {}
            }

            args.extend(opts.packages);
        }
        "npm" => {
            args.push("outdated".into());

            if opts.long {
                args.push("--long".into());
            }

            match opts.format.as_str() {
                "json" => args.push("--json".into()),
                "list" => args.push("--parseable".into()),
                _ => {}
            }

            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }

            if opts.recursive {
                args.push("--all".into());
            }

            if opts.global {
                args.push("--global".into());
            }

            args.extend(opts.packages);
        }
        "yarn" => {
            if version.starts_with("1.") {
                args.push("outdated".into());
                args.extend(opts.packages);
            } else {
                warnings.push("yarn berry uses 'yarn upgrade-interactive' instead of outdated.".into());
                args.push("upgrade-interactive".into());
            }
        }
        "bun" => {
            args.push("outdated".into());

            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            args.extend(opts.packages);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

/// Options for `resolve_why`.
#[derive(Clone, Debug, Default)]
pub struct WhyOptions {
    pub packages: Vec<String>,
    pub json: bool,
    pub long: bool,
    pub parseable: bool,
    pub recursive: bool,
    pub dev: bool,
    pub prod: bool,
    pub no_optional: bool,
    pub global: bool,
    pub depth: Option<i32>,
    pub filter: Vec<String>,
}

/// Resolve `vis why <packages>`.
pub fn resolve_why(pm: &str, version: &str, opts: WhyOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            args.push("why".into());

            if opts.json {
                args.push("--json".into());
            }

            if opts.long {
                args.push("--long".into());
            }

            if opts.parseable {
                args.push("--parseable".into());
            }

            if opts.recursive {
                args.push("--recursive".into());
            }

            if opts.dev {
                args.push("--dev".into());
            }

            if opts.prod {
                args.push("--prod".into());
            }

            if opts.no_optional {
                args.push("--no-optional".into());
            }

            if opts.global {
                args.push("--global".into());
            }

            if let Some(d) = opts.depth {
                args.push("--depth".into());
                args.push(d.to_string());
            }

            args.extend(opts.packages);
        }
        "npm" => {
            args.push("explain".into());

            if opts.json {
                args.push("--json".into());
            }

            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }

            if opts.long {
                warnings.push("npm does not support --long for explain.".into());
            }

            args.extend(opts.packages);
        }
        "yarn" => {
            args.push("why".into());

            if version.starts_with("1.") {
                if opts.packages.len() > 1 {
                    warnings.push("yarn v1 only supports querying one package at a time.".into());
                }

                if let Some(p) = opts.packages.first() {
                    args.push(p.clone());
                }
            } else {
                if opts.recursive {
                    args.push("-R".into());
                }

                args.extend(opts.packages);
            }

            if opts.json {
                args.push("--json".into());
            }
        }
        "bun" => {
            args.push("why".into());

            if let Some(d) = opts.depth {
                args.push("--depth".into());
                args.push(d.to_string());
            }

            args.extend(opts.packages);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

/// Options for `resolve_install`.
#[derive(Clone, Debug, Default)]
pub struct InstallOptions {
    pub frozen_lockfile: bool,
    pub prod: bool,
    pub dev: bool,
    pub no_optional: bool,
    pub force: bool,
    pub ignore_scripts: bool,
    pub lockfile_only: bool,
    pub offline: bool,
    pub silent: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

/// Resolve `vis install`.
pub fn resolve_install(pm: &str, version: &str, opts: InstallOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;
    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }
            if opts.workspace_root {
                args.push("-w".into());
            }
            args.push("install".into());
            if opts.frozen_lockfile {
                args.push("--frozen-lockfile".into());
            }
            if opts.prod {
                args.push("--prod".into());
            }
            if opts.dev {
                args.push("--dev".into());
            }
            if opts.no_optional {
                args.push("--no-optional".into());
            }
            if opts.force {
                args.push("--force".into());
            }
            if opts.ignore_scripts {
                args.push("--ignore-scripts".into());
            }
            if opts.lockfile_only {
                args.push("--lockfile-only".into());
            }
            if opts.offline {
                args.push("--offline".into());
            }
            if opts.silent {
                args.push("--silent".into());
            }
        }
        "npm" => {
            if opts.frozen_lockfile && opts.lockfile_only {
                warnings.push("npm ci and --package-lock-only are contradictory. Using ci.".into());
            }
            args.push(if opts.frozen_lockfile { "ci".into() } else { "install".into() });
            if opts.prod {
                args.push("--omit=dev".into());
            }
            if opts.no_optional {
                args.push("--omit=optional".into());
            }
            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }
            if opts.recursive {
                args.push("--workspaces".into());
            }
            if opts.workspace_root {
                args.push("--include-workspace-root".into());
            }
            if opts.ignore_scripts {
                args.push("--ignore-scripts".into());
            }
            if opts.force {
                args.push("--force".into());
            }
            if !opts.frozen_lockfile && opts.lockfile_only {
                args.push("--package-lock-only".into());
            }
            if opts.offline {
                args.push("--offline".into());
            }
            if opts.silent {
                args.push("--loglevel".into());
                args.push("silent".into());
            }
        }
        "yarn" => {
            if version.starts_with("1.") {
                args.push("install".into());
                if opts.frozen_lockfile {
                    args.push("--frozen-lockfile".into());
                }
                if opts.prod {
                    args.push("--production".into());
                }
                if opts.ignore_scripts {
                    args.push("--ignore-scripts".into());
                }
                if opts.force {
                    args.push("--force".into());
                }
                if opts.offline {
                    args.push("--offline".into());
                }
                if opts.silent {
                    args.push("--silent".into());
                }
            } else {
                args.push("install".into());
                if opts.frozen_lockfile {
                    args.push("--immutable".into());
                }
                if opts.ignore_scripts {
                    args.push("--mode".into());
                    args.push("skip-build".into());
                }
                if opts.lockfile_only {
                    args.push("--mode".into());
                    args.push("update-lockfile".into());
                }
                if opts.prod {
                    warnings.push("yarn berry --prod requires .yarnrc.yml configuration.".into());
                }
                if opts.offline {
                    args.push("--cached".into());
                }
            }
        }
        "bun" => {
            args.push("install".into());
            if opts.frozen_lockfile {
                args.push("--frozen-lockfile".into());
            }
            if opts.prod {
                args.push("--production".into());
            }
            if opts.force {
                args.push("--force".into());
            }
            if opts.ignore_scripts {
                args.push("--ignore-scripts".into());
            }
            if opts.no_optional {
                args.push("--no-optional".into());
            }
        }
        _ => unreachable!(), // validate_pm already checked
    }

    Ok(ResolvedCommand { bin: pm.to_owned(), args, warnings })
}

/// Options for `resolve_add`.
#[derive(Clone, Debug, Default)]
pub struct AddOptions {
    pub packages: Vec<String>,
    pub save_dev: bool,
    pub exact: bool,
    pub peer: bool,
    pub optional: bool,
    pub global: bool,
    pub workspace: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

/// Resolve `vis add`.
pub fn resolve_add(pm: &str, version: &str, opts: AddOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;
    let mut args = Vec::new();
    let warnings = Vec::new();

    // Global packages use npm exclusively (except bun, which ships a
    // native global-install path).
    if opts.global && pm != "bun" {
        args.push("install".into());
        args.push("--global".into());
        if opts.save_dev {
            args.push("--save-dev".into());
        }
        if opts.exact {
            args.push("--save-exact".into());
        }
        args.extend(opts.packages);
        return Ok(ResolvedCommand { bin: "npm".into(), args, warnings });
    }

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }
            if opts.workspace_root {
                args.push("-w".into());
            }
            args.push("add".into());
            if opts.save_dev {
                args.push("-D".into());
            }
            if opts.exact {
                args.push("-E".into());
            }
            if opts.peer {
                args.push("--save-peer".into());
            }
            if opts.optional {
                args.push("-O".into());
            }
            if opts.workspace {
                args.push("--workspace".into());
            }
            args.extend(opts.packages);
        }
        "npm" => {
            args.push("install".into());
            if opts.save_dev {
                args.push("--save-dev".into());
            }
            if opts.exact {
                args.push("--save-exact".into());
            }
            if opts.peer {
                args.push("--save-peer".into());
            }
            if opts.optional {
                args.push("--save-optional".into());
            }
            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }
            if opts.workspace_root {
                // npm's `-w` is `--workspace` and consumes the next argument, so it
                // cannot select the root. Pin the root explicitly instead.
                args.push(
                    if opts.filter.is_empty() { "--workspaces=false" } else { "--include-workspace-root" }.into(),
                );
            }
            args.extend(opts.packages);
        }
        "yarn" => {
            if version.starts_with("1.") {
                yarn_workspace_prefix(&opts.filter, &mut args)?;
                args.push("add".into());
                if opts.save_dev {
                    args.push("--dev".into());
                }
                if opts.exact {
                    args.push("--exact".into());
                }
                if opts.peer {
                    args.push("--peer".into());
                }
                if opts.optional {
                    args.push("--optional".into());
                }
                if opts.workspace_root {
                    args.push("-W".into());
                }
                args.extend(opts.packages);
            } else {
                if opts.filter.len() > 1 {
                    yarn_foreach_prefix(&opts.filter, &mut args);
                } else {
                    yarn_workspace_prefix(&opts.filter, &mut args)?;
                }
                args.push("add".into());
                if opts.save_dev {
                    args.push("--dev".into());
                }
                if opts.exact {
                    args.push("--exact".into());
                }
                if opts.peer {
                    args.push("--peer".into());
                }
                if opts.optional {
                    args.push("--optional".into());
                }
                args.extend(opts.packages);
            }
        }
        "bun" => {
            args.push("add".into());
            if opts.save_dev {
                args.push("--dev".into());
            }
            if opts.exact {
                args.push("--exact".into());
            }
            if opts.peer {
                args.push("--peer".into());
            }
            if opts.optional {
                args.push("--optional".into());
            }
            if opts.global {
                args.push("--global".into());
            }
            args.extend(opts.packages);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { bin: pm.to_owned(), args, warnings })
}

/// Options for `resolve_dlx`.
#[derive(Clone, Debug, Default)]
pub struct DlxOptions {
    pub package: String,
    pub args: Vec<String>,
    pub additional_packages: Vec<String>,
    pub shell_mode: bool,
    pub silent: bool,
}

/// The executable `npm exec` runs for a package spec: the package name without its scope and
/// version (`@scope/pkg@1.0` -> `pkg`, `create-vite@6.0.0` -> `create-vite`). A spec with a `:`
/// is a git, URL or file location, where an `@` belongs to the location (`git@host`,
/// `user:token@host`) and is not a version separator, so only its last path segment is used.
fn npm_bin_name(spec: &str) -> String {
    let name = if spec.contains(':') {
        spec
    } else {
        let name_start = usize::from(spec.starts_with('@'));
        spec[name_start..].split('@').next().unwrap_or_default()
    };
    name.rsplit('/').next().unwrap_or_default().to_string()
}

/// The command to run for `spec` once `--package` names the packages to install: `--package` turns
/// the positional into a command, so the spec's bin has to be spelled out.
fn bin_of_spec(spec: &str) -> String {
    let bin = npm_bin_name(spec);

    if bin.is_empty() {
        spec.to_owned()
    } else {
        bin
    }
}

/// Resolve `vis dlx`.
pub fn resolve_dlx(pm: &str, version: &str, opts: DlxOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;
    let mut args = Vec::new();
    let mut warnings = Vec::new();
    let mut bin = pm.to_owned();
    // With `-p` extras the positional is a command and only the named packages are installed, so
    // the main package must be named as well. In shell mode the positional is the command line.
    let name_main = !opts.shell_mode && !opts.additional_packages.is_empty();
    let command = if name_main { bin_of_spec(&opts.package) } else { opts.package.clone() };

    match pm {
        "pnpm" => {
            args.push("dlx".into());
            for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                args.push("--package".into());
                args.push(pkg.clone());
            }
            if opts.shell_mode {
                args.push("-c".into());
            }
            if opts.silent {
                args.push("--silent".into());
            }
            args.push(command);
            args.extend(opts.args);
        }
        "npm" => {
            args.push("exec".into());
            args.push("--yes".into());
            for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                args.push(format!("--package={pkg}"));
            }
            if opts.silent {
                args.push("--loglevel".into());
                args.push("silent".into());
            }
            // npm's `-c` is `--call <String>` and takes the next token, so the command rides in the same
            // argument. Without `--package`, npm reads the bin out of the package manifest itself; with
            // it, the positional is the command.
            if opts.shell_mode {
                args.push(format!("--call={}", opts.package));

                if !opts.args.is_empty() {
                    args.push("--".into());
                }
            } else {
                args.push("--".into());
                args.push(command);
            }
            args.extend(opts.args);
        }
        "yarn" => {
            if version.starts_with("1.") {
                warnings.push("yarn v1 does not support dlx. Falling back to npx.".into());
                bin = "npx".into();
                args.push("--yes".into());
                for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                    args.push("--package".into());
                    args.push(pkg.clone());
                }
                if opts.silent {
                    args.push("--quiet".into());
                }
                args.push(command);
                args.extend(opts.args);
            } else {
                args.push("dlx".into());
                for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                    args.push("-p".into());
                    args.push(pkg.clone());
                }
                if opts.shell_mode {
                    warnings.push("yarn berry does not support shell mode for dlx.".into());
                }
                if opts.silent {
                    args.push("--quiet".into());
                }
                args.push(command);
                args.extend(opts.args);
            }
        }
        "bun" => {
            args.push("x".into());
            for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                args.push("--package".into());
                args.push(pkg.clone());
            }
            args.push(command);
            args.extend(opts.args);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { bin, args, warnings })
}

#[cfg(test)]
mod tests {
    use super::{
        npm_bin_name, resolve_add, resolve_dedupe, resolve_dlx, resolve_exec, resolve_install, resolve_link,
        resolve_outdated, resolve_pm_command, resolve_remove, resolve_unlink, resolve_why, AddOptions, DlxOptions,
        ExecOptions, InstallOptions, OutdatedOptions, RemoveOptions, WhyOptions,
    };

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn pm_cache_dir_maps_to_pnpm_store_path() {
        let resolved = resolve_pm_command("pnpm", "9.0.0", "cache", argv(&["dir"])).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["store", "path"]);
    }

    #[test]
    fn pm_passthrough_forwards_flags() {
        let resolved = resolve_pm_command("pnpm", "9.0.0", "publish", argv(&["--dry-run"])).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["publish", "--dry-run"]);
    }

    #[test]
    fn pm_npm_only_verb_delegates_to_npm() {
        let resolved = resolve_pm_command("pnpm", "9.0.0", "ping", argv(&[])).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert!(!resolved.warnings.is_empty());
    }

    fn exec(command: &str) -> ExecOptions {
        ExecOptions { command: command.to_owned(), ..Default::default() }
    }

    #[test]
    fn pnpm_exec_basic() {
        let resolved = resolve_exec("pnpm", "9.0.0", exec("eslint")).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["exec", "eslint"]);
    }

    #[test]
    fn pnpm_exec_with_filter_and_recursive() {
        let opts = ExecOptions {
            command: "eslint".to_owned(),
            args: vec![".".to_owned()],
            filter: vec!["@scope/pkg".to_owned()],
            recursive: true,
            ..Default::default()
        };

        let resolved = resolve_exec("pnpm", "9.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["--filter", "@scope/pkg", "exec", "--recursive", "eslint", "."]);
    }

    #[test]
    fn npm_exec_inserts_separator() {
        let resolved = resolve_exec("npm", "10.0.0", exec("tsc")).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["exec", "--", "tsc"]);
    }

    #[test]
    fn yarn_v1_falls_back_to_npx() {
        let resolved = resolve_exec("yarn", "1.22.0", exec("eslint")).unwrap();

        assert_eq!(resolved.bin, "npx");
        assert_eq!(resolved.args, ["eslint"]);
        assert!(!resolved.warnings.is_empty());
    }

    #[test]
    fn bun_uses_bunx() {
        let resolved = resolve_exec("bun", "1.1.0", exec("eslint")).unwrap();

        assert_eq!(resolved.bin, "bunx");
        assert_eq!(resolved.args, ["eslint"]);
    }

    #[test]
    fn unsupported_pm_errors() {
        assert!(resolve_exec("cargo", "1.0.0", exec("x")).is_err());
    }

    #[test]
    fn remove_pnpm_with_dev_and_global_maps_to_npm() {
        let opts = RemoveOptions { packages: vec!["lodash".to_owned()], global: true, ..Default::default() };
        let resolved = resolve_remove("pnpm", "9.0.0", opts).unwrap();

        // Global removal goes to npm uninstall --global.
        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["uninstall", "--global", "lodash"]);

        let local = RemoveOptions { packages: vec!["lodash".to_owned()], save_dev: true, ..Default::default() };
        let resolved = resolve_remove("pnpm", "9.0.0", local).unwrap();

        assert_eq!(resolved.args, ["remove", "-D", "lodash"]);
    }

    #[test]
    fn dedupe_check_maps_per_pm() {
        assert_eq!(resolve_dedupe("pnpm", "9.0.0", true).unwrap().args, ["dedupe", "--check"]);
        assert_eq!(resolve_dedupe("npm", "10.0.0", true).unwrap().args, ["dedupe", "--dry-run"]);
        // bun has no dedupe -> install fallback with a warning.
        let bun = resolve_dedupe("bun", "1.1.0", false).unwrap();

        assert_eq!(bun.args, ["install"]);
        assert!(!bun.warnings.is_empty());
    }

    #[test]
    fn link_pnpm_v11_warns_on_bare_name() {
        let resolved = resolve_link("pnpm", "11.0.0", Some("my-pkg".to_owned())).unwrap();

        assert_eq!(resolved.args, ["link", "my-pkg"]);
        assert!(!resolved.warnings.is_empty(), "v11 bare-name link should warn");

        // A path target on v11 does not warn.
        assert!(resolve_link("pnpm", "11.0.0", Some("./packages/p".to_owned())).unwrap().warnings.is_empty());
    }

    #[test]
    fn unlink_recursive_per_pm() {
        assert_eq!(
            resolve_unlink("pnpm", "9.0.0", vec!["p".to_owned()], true).unwrap().args,
            ["unlink", "--recursive", "p"]
        );
        // npm has no recursive unlink -> warning, no flag.
        let npm = resolve_unlink("npm", "10.0.0", vec!["p".to_owned()], true).unwrap();

        assert_eq!(npm.args, ["unlink", "p"]);
        assert!(!npm.warnings.is_empty());
    }

    #[test]
    fn outdated_format_and_filter() {
        let opts =
            OutdatedOptions { filter: vec!["@scope/a".to_owned()], format: "json".to_owned(), ..Default::default() };
        let resolved = resolve_outdated("pnpm", "9.0.0", opts).unwrap();

        assert_eq!(resolved.args, ["--filter", "@scope/a", "outdated", "--format", "json"]);
    }

    #[test]
    fn why_npm_uses_explain() {
        let opts = WhyOptions { packages: vec!["lodash".to_owned()], json: true, ..Default::default() };
        let resolved = resolve_why("npm", "10.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["explain", "--json", "lodash"]);
    }

    #[test]
    fn install_rejects_an_unknown_package_manager() {
        let error = resolve_install("deno", "1.0.0", InstallOptions::default()).unwrap_err();

        assert_eq!(error, "Unsupported package manager: 'deno'. Supported: pnpm, npm, yarn, bun");
    }

    #[test]
    fn install_pnpm_frozen_lockfile() {
        let opts = InstallOptions { frozen_lockfile: true, ..Default::default() };
        let resolved = resolve_install("pnpm", "10.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["install", "--frozen-lockfile"]);
    }

    #[test]
    fn install_npm_frozen_lockfile_uses_ci() {
        let opts = InstallOptions { frozen_lockfile: true, ..Default::default() };
        let resolved = resolve_install("npm", "11.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args[0], "ci");
    }

    #[test]
    fn add_pnpm_dev_dependency_with_filter_before_add() {
        let opts =
            AddOptions { packages: argv(&["react"]), save_dev: true, filter: argv(&["app"]), ..Default::default() };
        let resolved = resolve_add("pnpm", "10.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["--filter", "app", "add", "-D", "react"]);
    }

    #[test]
    fn add_npm_workspace_root_keeps_package_as_argument() {
        let opts = AddOptions { packages: argv(&["react"]), workspace_root: true, ..Default::default() };
        let resolved = resolve_add("npm", "11.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["install", "--workspaces=false", "react"]);
    }

    #[test]
    fn add_npm_workspace_root_with_filter_includes_the_root() {
        let opts = AddOptions {
            packages: argv(&["react"]),
            workspace_root: true,
            filter: argv(&["app"]),
            ..Default::default()
        };
        let resolved = resolve_add("npm", "11.0.0", opts).unwrap();

        assert_eq!(resolved.args, ["install", "--workspace", "app", "--include-workspace-root", "react"]);
    }

    #[test]
    fn add_yarn_berry_routes_filter_to_the_workspace() {
        let opts =
            AddOptions { packages: argv(&["react"]), save_dev: true, filter: argv(&["app"]), ..Default::default() };
        let resolved = resolve_add("yarn", "4.5.0", opts).unwrap();

        assert_eq!(resolved.bin, "yarn");
        assert_eq!(resolved.args, ["workspace", "app", "add", "--dev", "react"]);
    }

    #[test]
    fn add_yarn_berry_fans_multiple_filters_out_with_foreach() {
        let opts = AddOptions { packages: argv(&["react"]), filter: argv(&["app", "web"]), ..Default::default() };
        let resolved = resolve_add("yarn", "4.5.0", opts).unwrap();

        assert_eq!(
            resolved.args,
            ["workspaces", "foreach", "--all", "--include", "app", "--include", "web", "add", "react"]
        );
    }

    #[test]
    fn add_yarn_classic_rejects_multiple_filters() {
        let opts = AddOptions { packages: argv(&["react"]), filter: argv(&["app", "web"]), ..Default::default() };

        assert!(resolve_add("yarn", "1.22.0", opts).is_err());
    }

    #[test]
    fn remove_yarn_classic_rejects_multiple_filters() {
        let opts = RemoveOptions { packages: argv(&["react"]), filter: argv(&["app", "web"]), ..Default::default() };

        assert!(resolve_remove("yarn", "1.22.0", opts).is_err());
    }

    #[test]
    fn remove_yarn_berry_applies_the_filter_without_recursive() {
        let one = RemoveOptions { packages: argv(&["react"]), filter: argv(&["app"]), ..Default::default() };
        let many = RemoveOptions { packages: argv(&["react"]), filter: argv(&["app", "web"]), ..Default::default() };
        let recursive = RemoveOptions { packages: argv(&["react"]), recursive: true, ..Default::default() };

        assert_eq!(resolve_remove("yarn", "4.5.0", one).unwrap().args, ["workspace", "app", "remove", "react"]);
        assert_eq!(
            resolve_remove("yarn", "4.5.0", many).unwrap().args,
            ["workspaces", "foreach", "--all", "--include", "app", "--include", "web", "remove", "react"]
        );
        assert_eq!(
            resolve_remove("yarn", "4.5.0", recursive).unwrap().args,
            ["workspaces", "foreach", "--all", "remove", "react"]
        );
    }

    #[test]
    fn add_global_uses_npm_except_on_bun() {
        let global = |pm: &str, version: &str| {
            let opts = AddOptions { packages: argv(&["typescript"]), global: true, ..Default::default() };

            resolve_add(pm, version, opts).unwrap()
        };

        let pnpm = global("pnpm", "10.0.0");

        assert_eq!(pnpm.bin, "npm");
        assert!(pnpm.args.contains(&"--global".to_owned()));
        assert_eq!(global("bun", "1.0.0").bin, "bun");
    }

    #[test]
    fn dlx_pnpm_and_bun() {
        let opts = || DlxOptions { package: "create-vite".to_owned(), args: argv(&["my-app"]), ..Default::default() };

        let pnpm = resolve_dlx("pnpm", "10.0.0", opts()).unwrap();
        let bun = resolve_dlx("bun", "1.0.0", opts()).unwrap();

        assert_eq!((pnpm.bin.as_str(), pnpm.args), ("pnpm", argv(&["dlx", "create-vite", "my-app"])));
        assert_eq!((bun.bin.as_str(), bun.args[0].as_str()), ("bun", "x"));
    }

    #[test]
    fn dlx_npm_with_extras_runs_the_bin_without_the_version() {
        let bin_for = |package: &str| {
            let opts = DlxOptions {
                package: package.to_owned(),
                additional_packages: argv(&["typescript"]),
                ..Default::default()
            };
            let resolved = resolve_dlx("npm", "11.0.0", opts).unwrap();

            (resolved.args[resolved.args.len() - 2..].to_vec(), resolved.args)
        };

        let (tail, args) = bin_for("create-vite@6.0.0");
        assert_eq!(tail, ["--", "create-vite"]);
        assert!(args.contains(&"--package=create-vite@6.0.0".to_owned()));

        assert_eq!(bin_for("create-vite").0, ["--", "create-vite"]);
        assert_eq!(bin_for("@scope/tool@1.2.3").0, ["--", "tool"]);
        assert_eq!(bin_for("@scope/tool").0, ["--", "tool"]);
    }

    #[test]
    fn npm_bin_name_keeps_the_location_of_a_git_or_url_spec_out_of_the_version_split() {
        for (spec, bin) in [
            ("git+ssh://git@github.com/org/tool.git", "tool.git"),
            ("git@github.com:org/tool.git", "tool.git"),
            ("https://user:token@host.example/pkg.tgz", "pkg.tgz"),
            ("create-vite@6.0.0", "create-vite"),
            ("@scope/tool@1.2.3", "tool"),
        ] {
            assert_eq!(npm_bin_name(spec), bin, "{spec}");
        }
    }

    #[test]
    fn dlx_yarn_v1_falls_back_to_npx() {
        let opts = DlxOptions { package: "create-vite".to_owned(), ..Default::default() };
        let resolved = resolve_dlx("yarn", "1.22.0", opts).unwrap();

        assert_eq!(resolved.bin, "npx");
    }

    #[test]
    fn dlx_npm_lets_npm_pick_the_bin_when_no_extra_packages_are_given() {
        let opts = |package: &str| DlxOptions {
            package: package.to_owned(),
            args: argv(&["new", "app"]),
            ..Default::default()
        };

        // `--package` stops npm from reading the bin out of the manifest, so `@angular/cli` would run `cli`.
        assert_eq!(
            resolve_dlx("npm", "11.0.0", opts("@angular/cli")).unwrap().args,
            ["exec", "--yes", "--", "@angular/cli", "new", "app"]
        );
        assert_eq!(
            resolve_dlx("npm", "11.0.0", opts("create-vite@6.0.0")).unwrap().args,
            ["exec", "--yes", "--", "create-vite@6.0.0", "new", "app"]
        );

        let silent = DlxOptions { silent: true, ..opts("@vue/cli") };

        assert_eq!(
            resolve_dlx("npm", "11.0.0", silent).unwrap().args,
            ["exec", "--yes", "--loglevel", "silent", "--", "@vue/cli", "new", "app"]
        );
    }

    #[test]
    fn dlx_npm_installs_every_package_and_names_the_bin_when_extras_are_given() {
        let opts = DlxOptions {
            package: "ts-node@10.9.2".to_owned(),
            args: argv(&["x.ts"]),
            additional_packages: argv(&["typescript"]),
            ..Default::default()
        };

        assert_eq!(
            resolve_dlx("npm", "11.0.0", opts).unwrap().args,
            ["exec", "--yes", "--package=typescript", "--package=ts-node@10.9.2", "--", "ts-node", "x.ts"]
        );
    }

    #[test]
    fn dlx_npm_shell_mode_passes_the_command_as_a_call_value() {
        let opts = DlxOptions {
            package: "cowsay hi | lolcatjs".to_owned(),
            additional_packages: argv(&["cowsay", "lolcatjs"]),
            shell_mode: true,
            silent: true,
            ..Default::default()
        };

        // npm's `-c` is `--call <String>`: it takes the next token, so `-c --` made `--` the command.
        assert_eq!(
            resolve_dlx("npm", "11.0.0", opts).unwrap().args,
            [
                "exec",
                "--yes",
                "--package=cowsay",
                "--package=lolcatjs",
                "--loglevel",
                "silent",
                "--call=cowsay hi | lolcatjs"
            ]
        );
    }

    #[test]
    fn exec_npm_shell_mode_passes_the_command_as_a_call_value() {
        let opts = ExecOptions {
            command: "eslint . && tsc".to_owned(),
            shell_mode: true,
            recursive: true,
            ..Default::default()
        };

        assert_eq!(
            resolve_exec("npm", "10.0.0", opts).unwrap().args,
            ["exec", "--workspaces", "--call=eslint . && tsc"]
        );
    }

    #[test]
    fn remove_npm_workspace_root_does_not_swallow_the_package_name() {
        let root = RemoveOptions { packages: argv(&["lodash"]), workspace_root: true, ..Default::default() };
        let with_filter = RemoveOptions {
            packages: argv(&["lodash"]),
            workspace_root: true,
            filter: argv(&["app"]),
            ..Default::default()
        };

        // npm's `-w` is `--workspace <name>`: it would take `lodash` as the workspace.
        assert_eq!(resolve_remove("npm", "10.0.0", root).unwrap().args, ["uninstall", "--workspaces=false", "lodash"]);
        assert_eq!(
            resolve_remove("npm", "10.0.0", with_filter).unwrap().args,
            ["uninstall", "--workspace", "app", "--include-workspace-root", "lodash"]
        );
    }

    #[test]
    fn dlx_with_extra_packages_installs_the_main_package_too() {
        let opts = || DlxOptions {
            package: "ts-node@10.9.2".to_owned(),
            args: argv(&["x.ts"]),
            additional_packages: argv(&["typescript"]),
            ..Default::default()
        };

        // Once a package is named explicitly the positional is a command and nothing else is installed.
        assert_eq!(
            resolve_dlx("pnpm", "10.0.0", opts()).unwrap().args,
            ["dlx", "--package", "typescript", "--package", "ts-node@10.9.2", "ts-node", "x.ts"]
        );
        assert_eq!(
            resolve_dlx("yarn", "4.5.0", opts()).unwrap().args,
            ["dlx", "-p", "typescript", "-p", "ts-node@10.9.2", "ts-node", "x.ts"]
        );
        assert_eq!(
            resolve_dlx("bun", "1.3.0", opts()).unwrap().args,
            ["x", "--package", "typescript", "--package", "ts-node@10.9.2", "ts-node", "x.ts"]
        );

        let classic = resolve_dlx("yarn", "1.22.0", opts()).unwrap();

        assert_eq!(classic.bin, "npx");
        assert_eq!(
            classic.args,
            ["--yes", "--package", "typescript", "--package", "ts-node@10.9.2", "ts-node", "x.ts"]
        );
    }

    #[test]
    fn dlx_shell_mode_keeps_the_command_out_of_the_package_list() {
        let opts = DlxOptions {
            package: "cowsay hi".to_owned(),
            additional_packages: argv(&["cowsay"]),
            shell_mode: true,
            ..Default::default()
        };

        assert_eq!(
            resolve_dlx("pnpm", "10.0.0", opts).unwrap().args,
            ["dlx", "--package", "cowsay", "-c", "cowsay hi"]
        );
    }

    #[test]
    fn exec_reverse_is_passed_to_pnpm_and_refused_where_it_has_no_effect() {
        let opts =
            || ExecOptions { command: "eslint".to_owned(), recursive: true, reverse: true, ..Default::default() };

        assert_eq!(
            resolve_exec("pnpm", "10.0.0", opts()).unwrap().args,
            ["exec", "--recursive", "--reverse", "eslint"]
        );

        for (pm, version) in [("npm", "10.0.0"), ("yarn", "4.5.0"), ("yarn", "1.22.0")] {
            let error = resolve_exec(pm, version, opts()).unwrap_err();

            assert!(error.contains("--reverse"), "{pm} {version}: {error}");
        }
    }

    #[test]
    fn exec_on_yarn_classic_refuses_the_flags_npx_cannot_honour() {
        let flagged = |tweak: fn(&mut ExecOptions)| {
            let mut opts = exec("eslint");

            tweak(&mut opts);

            resolve_exec("yarn", "1.22.0", opts)
        };

        assert!(flagged(|opts| opts.recursive = true).unwrap_err().contains("--recursive"));
        assert!(flagged(|opts| opts.filter = argv(&["app"])).unwrap_err().contains("--filter"));
        assert!(flagged(|opts| opts.workspace_root = true).unwrap_err().contains("--workspace-root"));
        assert!(flagged(|opts| opts.parallel = true).unwrap_err().contains("--parallel"));
        assert_eq!(flagged(|opts| opts.shell_mode = true).unwrap().args, ["-c", "eslint"]);
    }

    #[test]
    fn exec_on_bun_refuses_the_flags_bunx_cannot_honour() {
        let flagged = |tweak: fn(&mut ExecOptions)| {
            let mut opts = exec("eslint");

            tweak(&mut opts);

            resolve_exec("bun", "1.1.0", opts)
        };

        assert!(flagged(|opts| opts.recursive = true).unwrap_err().contains("--recursive"));
        assert!(flagged(|opts| opts.filter = argv(&["app"])).unwrap_err().contains("--filter"));
        assert!(flagged(|opts| opts.workspace_root = true).unwrap_err().contains("--workspace-root"));
        assert!(flagged(|opts| opts.parallel = true).unwrap_err().contains("--parallel"));
        assert!(flagged(|opts| opts.reverse = true).unwrap_err().contains("--reverse"));
        assert!(flagged(|opts| opts.shell_mode = true).unwrap_err().contains("--shell-mode"));
        assert!(flagged(|_| {}).is_ok());
    }
}
