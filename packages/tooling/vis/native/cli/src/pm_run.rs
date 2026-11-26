//! What the commands that run a package manager share. `install`, `add`, `info` and `dlx` share the gates that decide
//! whether the native path may run the manager, the notices Node prints first, and the start-up environment Node gives
//! the manager ([`ManagerRun`]); `exec`, `pm` and the pm family share [`run_resolved`].

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};

use vis_core::detect::{detect_package_manager, DetectPackageManagerOptions};
use vis_core::lockfiles::LOCKFILES;

use vis_core::resolve::ResolvedCommand;

use crate::error::WrapperError;
use crate::pail::Layout;
use crate::vis_config::{self, read_json, ConfigState};

/// Where Node finds the workspace root, as far as the native path needs to know.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Root {
    /// Node finds no monorepo root: it loads no config, runs no plugin, and installs in the working directory.
    None,
    /// The working directory is the monorepo root: Node loads the config there and its plugins run.
    Here,
}

/// What the gates settle for a native run, before the command's own flags and arguments come in.
pub(crate) struct Setup {
    pub(crate) cwd: PathBuf,
    /// The manager Node would pick for `cwd`, and its version (`latest` when unknown, `1.x` for a classic `yarn.lock`).
    pub(crate) manager: String,
    pub(crate) version: String,
    pub(crate) root: Root,
    pub(crate) layout: Layout,
}

/// The gates `install` and `add` share: a unix platform, valid UTF-8 arguments, a CI context, a working
/// directory that is no root or the only root, a config the native path can read, and a manager Node would
/// pick the same way. `None` delegates.
pub(crate) fn setup(args: &[String], raw: &[OsString]) -> Option<Setup> {
    setup_allowing(args, raw, &[])
}

/// [`setup`], with the `MARSHALL_*` variables named in `allowed` left to the command to read (they change nothing
/// the gates decide).
pub(crate) fn setup_allowing(args: &[String], raw: &[OsString], allowed: &[String]) -> Option<Setup> {
    // Windows keeps the Node path: it runs the package manager through a shell there.
    if !cfg!(unix) || raw.iter().any(|argument| argument.to_str().is_none()) {
        return None;
    }

    if !context_allows_native(allowed) {
        return None;
    }

    let layout = Layout::detect(args)?;
    let cwd = env::current_dir().ok()?;

    // A marker above the working directory could be the root Node installs in, or change what it
    // reads. Deno files and lerna or turbo roots change the workspace logic beyond what is ported.
    if cwd
        .ancestors()
        .skip(1)
        .any(|directory| crate::node_context::ROOT_MARKERS.iter().any(|name| directory.join(name).exists()))
        || ["lerna.json", "turbo.json"].iter().any(|name| cwd.join(name).exists())
        || crate::node_context::any_ancestor_has(&cwd, &crate::node_context::DENO_FILES)
        || crate::pm_detect::ancestor_pins_package_manager(&cwd)
    {
        return None;
    }

    let root = root_here(&cwd)?;

    if root == Root::Here && !config_allows_native(&cwd) {
        return None;
    }

    let detected = detect_package_manager(&cwd.to_string_lossy(), Some(DetectPackageManagerOptions::default()));
    let manager = detected.name;

    // Node runs bun when the nearest lockfile is bun's, whatever else names the manager.
    if has_bun_lockfile(&cwd) && manager != "bun" {
        return None;
    }

    let version = detected.version.filter(|version| !version.is_empty()).unwrap_or_else(|| "latest".to_owned());

    Some(Setup { cwd, manager, version, root, layout })
}

/// A `--filter` value: a non-empty word that is no flag.
pub(crate) fn filter_value(value: &str) -> Option<String> {
    (!value.is_empty() && !value.starts_with('-')).then(|| value.to_owned())
}

/// Whether the environment leaves Node's output and installer choice to what the native path knows.
fn context_allows_native(allowed: &[String]) -> bool {
    // The peer hint is pail output, coloured by `Layout::detect`. The package manager itself gets a
    // forced colour on a terminal, which the native path does not reproduce.
    if !crate::node_context::in_ci() || io::stdout().is_terminal() || io::stderr().is_terminal() {
        return false;
    }

    if !crate::node_context::output_settings_are_default() {
        return false;
    }

    // `MARSHALL_*` switches off the typosquat scan and the security notice, `VIS_SECURITY_WARNINGS` turns
    // on a summary line in CI, and an inherited `VIS_MONOREPO_ROOT` replaces Node's own root search.
    let changes_node = env::vars_os().any(|(name, _)| {
        let name = name.to_string_lossy();

        name.starts_with("MARSHALL_") && !allowed.iter().any(|known| *known == name)
    }) || env::var_os("VIS_SECURITY_WARNINGS").is_some()
        || env::var_os("VIS_MONOREPO_ROOT").is_some();

    !changes_node && !crate::pm_detect::installer_selected_by_environment()
}

/// Where Node's root search lands for `cwd`, which holds the only root marker on the way up (the caller
/// has ruled out markers above it). `None` when the search ends in a state the native path does not read:
/// several lockfile managers, or a `package.json` it cannot parse.
fn root_here(cwd: &Path) -> Option<Root> {
    let mut managers: Vec<&str> =
        LOCKFILES.iter().filter(|(file, _)| cwd.join(file).exists()).map(|(_, manager)| *manager).collect();

    managers.dedup();

    let manifest = cwd.join("package.json");

    // Node reads `package.json` for a `packageManager` pin when no lockfile names the manager.
    if managers.is_empty() && manifest.exists() && read_json(&manifest).is_none() {
        return None;
    }

    // The search stops at the nearest directory that names a manager, so no lockfile here means no
    // root anywhere (nothing above holds a marker).
    let [manager] = managers.as_slice() else {
        return if managers.is_empty() { Some(Root::None) } else { None };
    };

    let is_root = match *manager {
        "pnpm" => cwd.join("pnpm-workspace.yaml").exists(),
        "npm" | "yarn" => match read_json(&manifest) {
            Some(manifest) => {
                manifest.get("workspaces").is_some_and(|workspaces| workspaces.is_object() || workspaces.is_array())
            }
            // Node reads an unparsable `package.json` as no root; the native path leaves it alone.
            None if manifest.exists() => return None,
            None => false,
        },
        _ => false,
    };

    Some(if is_root { Root::Here } else { Root::None })
}

fn has_bun_lockfile(cwd: &Path) -> bool {
    cwd.ancestors().any(|directory| directory.join("bun.lock").exists() || directory.join("bun.lockb").exists())
}

/// Whether the config Node loads from the root leaves the run to the native path: none, or a literal
/// without a key whose evaluation Node owns (`requires_node`) and without any `install` key.
fn config_allows_native(cwd: &Path) -> bool {
    match vis_config::read(cwd) {
        ConfigState::Absent => true,
        ConfigState::Static(value) => {
            !vis_config::requires_node(&ConfigState::Static(value.clone())) && value.get("install").is_none()
        }
        ConfigState::Dynamic => false,
    }
}

/// The lines Node's security-enforcement plugin prints before an install in a monorepo root
/// (`enforceScriptSecurity` in `src/security/enforcement.ts`, with no allow list: the config has no
/// `security` key). `None` for the cases whose text depends on a regex over a file the native path
/// does not read.
pub(crate) fn security_notices(manager: &str, root: &Path) -> Option<Vec<String>> {
    let message = match manager {
        "pnpm" => {
            "pnpm blocks build scripts by default. Run 'vis approve-builds' to review packages that need scripts."
        }
        "npm" => {
            let npmrc = root.join(".npmrc");

            if npmrc.exists() {
                // `ignore-scripts=true` silences the notice, and the regex that finds it can span lines.
                if fs::read_to_string(&npmrc).ok()?.contains("ignore-scripts") {
                    return None;
                }
            }

            "npm does not block lifecycle scripts. Add 'ignore-scripts=true' to .npmrc and configure security.policies.installScripts.allow."
        }
        "yarn" => {
            let yarnrc = root.join(".yarnrc.yml");

            if !yarnrc.exists() {
                "yarn classic does not support blocking lifecycle scripts. Consider upgrading to yarn berry."
            } else if fs::read_to_string(&yarnrc).ok()?.contains("enableScripts") {
                return None;
            } else {
                "yarn berry supports enableScripts. Add 'enableScripts: false' to .yarnrc.yml."
            }
        }
        // bun blocks scripts by default and only warns about an allow list.
        _ => return Some(Vec::new()),
    };

    Some(vec![format!("security: {message}")])
}

/// Whether `bin` is an executable file in a directory of `PATH`, as `execvp` looks it up.
pub(crate) fn on_path(bin: &str) -> bool {
    #[cfg(unix)]
    fn executable(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;

        path.metadata().is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    }

    #[cfg(not(unix))]
    fn executable(path: &Path) -> bool {
        path.is_file()
    }

    env::var_os("PATH").is_some_and(|path| env::split_paths(&path).any(|directory| executable(&directory.join(bin))))
}

/// A package-manager command the native path has decided to run, and what Node does around it.
pub(crate) struct ManagerRun {
    pub(crate) bin: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    /// Node puts the root it found into the environment of everything it runs.
    pub(crate) root: Option<PathBuf>,
    /// Lines for stderr, before the package manager starts: the security-enforcement notice and the resolver's warnings.
    pub(crate) notices: Vec<String>,
}

impl ManagerRun {
    /// The command, with the working directory, the inherited stdin and what Node's own startup adds to the
    /// environment of everything it runs: cerebro's default output level and the monorepo root it found, if any. (Any
    /// `CEREBRO_*` of the caller's has kept the command in Node.) The launcher's own variables (`VIS_NODE`,
    /// `VIS_FALLBACK_ENTRY`, `VIS_VERSION`, `VIS_LAUNCHER`) stay in the environment, as for every native command that
    /// runs a child. The caller chooses what stdout and stderr are.
    pub(crate) fn command(&self) -> Command {
        let mut command = Command::new(&self.bin);

        command.args(&self.args).current_dir(&self.cwd).stdin(Stdio::inherit()).env("CEREBRO_OUTPUT_LEVEL", "32");

        if let Some(root) = &self.root {
            command.env("VIS_MONOREPO_ROOT", root);
        }

        command
    }

    /// Runs the manager on the caller's own stdio and ends the process with `exit_code` of its status. The notices go
    /// out first, because the manager inherits the terminal. A manager that was found on `PATH` but cannot start is
    /// Node's to report while nothing has been printed; after a notice a second run in Node would print it twice.
    pub(crate) fn run_inherited(self, raw: &[OsString], exit_code: fn(i32) -> i32) -> ! {
        let mut stderr = io::stderr().lock();

        for notice in &self.notices {
            let _ = writeln!(stderr, "{notice}");
        }

        let _ = stderr.flush();

        drop(stderr);

        match self.command().stdout(Stdio::inherit()).stderr(Stdio::inherit()).status() {
            // Node reports a child without an exit code (a signal) as 1.
            Ok(status) => exit(exit_code(crate::process::node_exit_code(status))),
            Err(_) if self.notices.is_empty() => crate::process::delegate(raw),
            Err(error) => {
                eprintln!("Error: Failed to execute '{}': {error}", self.bin);

                exit(1)
            }
        }
    }
}

/// Surfaces the resolver's warnings as `vis <verb>: <warning>`, runs the resolved command in `cwd` on the caller's own
/// stdio and returns the exit status to adopt (Node's: 1 for a child killed by a signal).
pub(crate) fn run_resolved(verb: &str, resolved: &ResolvedCommand, cwd: &Path) -> Result<i32, WrapperError> {
    for warning in &resolved.warnings {
        eprintln!("vis {verb}: {warning}");
    }

    Command::new(&resolved.bin)
        .args(&resolved.args)
        .current_dir(cwd)
        .status()
        .map(crate::process::node_exit_code)
        .map_err(|source| WrapperError::spawn(verb, &resolved.bin, source))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    fn run(root: Option<&str>) -> ManagerRun {
        ManagerRun {
            bin: "pnpm".to_owned(),
            args: vec!["install".to_owned()],
            cwd: PathBuf::from("/work"),
            root: root.map(PathBuf::from),
            notices: Vec::new(),
        }
    }

    fn env_of(command: &Command, name: &str) -> Option<String> {
        command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new(name))
            .and_then(|(_, value)| value?.to_str().map(str::to_owned))
    }

    #[test]
    fn the_manager_gets_the_environment_node_gives_it() {
        let command = run(Some("/work")).command();

        assert_eq!(command.get_program(), "pnpm");
        assert_eq!(command.get_current_dir(), Some(Path::new("/work")));
        assert_eq!(env_of(&command, "CEREBRO_OUTPUT_LEVEL").as_deref(), Some("32"));
        assert_eq!(env_of(&command, "VIS_MONOREPO_ROOT").as_deref(), Some("/work"));
    }

    #[test]
    fn no_root_found_means_no_root_in_the_environment() {
        let command = run(None).command();

        assert_eq!(env_of(&command, "CEREBRO_OUTPUT_LEVEL").as_deref(), Some("32"));
        assert_eq!(env_of(&command, "VIS_MONOREPO_ROOT"), None);
    }
}
