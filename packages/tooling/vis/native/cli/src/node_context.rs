//! What Node would see around a command, as the native commands must reproduce it: whether the run is in CI, whether the
//! working directory is the workspace root Node's search would find, and whether Node would print anything extra
//! (config and Deno notices, tips on a terminal, log levels set from the environment).

use std::env;
use std::ffi::OsStr;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};

use crate::root_search::{lockfile_managers, read_json, Manager};
use crate::vis_config::has_vis_config;

/// Markers that Node's root search (`findMonorepoRootSync` in `@visulima/package`) reads in a
/// directory. Node stops at the nearest one, so any of them above the working directory means the
/// root may not be the working directory.
pub(crate) const ROOT_MARKERS: [&str; 10] = [
    "lerna.json",
    "turbo.json",
    "pnpm-workspace.yaml",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
];

/// Whether an inherited `VIS_MONOREPO_ROOT` leaves `cwd` as the root: it is unset, empty or names `cwd`. Node reads it
/// as `process.env.VIS_MONOREPO_ROOT || process.cwd()`, so an empty value is no value.
pub(crate) fn inherited_root_allows(cwd: &Path, env_root: Option<&OsStr>) -> bool {
    env_root.is_none_or(|root| root.is_empty() || Path::new(root) == cwd)
}

/// Why Node would not reach the same answer from the working directory for a read-only command, or `None` when it
/// would: a unix CI run off a terminal at the root of a pnpm workspace, with none of the settings that change what
/// Node prints. Windows is Node's here; the commands whose output was compared with Node's on Windows ask
/// [`portable_context_decline`] instead.
pub(crate) fn context_decline() -> Option<&'static str> {
    if !cfg!(unix) {
        return Some("not a unix platform");
    }

    portable_context_decline()
}

/// [`context_decline`] without the platform: the CI context a command needs on every platform. A command asks this
/// one only once its output has been compared with the Node CLI's on Windows too (`tests/windows_node_parity.rs`),
/// where Node paints colour, prints paths with `/` and a capital drive letter ([`printed_path`]) and has no pail clock
/// this crate reads.
pub(crate) fn portable_context_decline() -> Option<&'static str> {
    [
        (!output_settings_are_default(), "an output setting (NODE_ENV, DEBUG, PAIL_LOG_LEVEL, CEREBRO_*) is set"),
        (io::stdout().is_terminal(), "stdout is a terminal"),
        (!native_context(), "not a CI run at the root of a pnpm workspace with a quiet stderr"),
    ]
    .into_iter()
    .find_map(|(declined, reason)| declined.then_some(reason))
}

/// Whether [`context_decline`] has nothing to say.
pub(crate) fn context_is_native() -> bool {
    context_decline().is_none()
}

/// Whether [`portable_context_decline`] has nothing to say.
pub(crate) fn portable_context_is_native() -> bool {
    portable_context_decline().is_none()
}

/// `path` as Node prints it. On unix the path itself. On Windows `@visulima/path` has made it `/`-separated with a
/// capital drive letter (`c:\Users\a` is `C:/Users/a`) and nothing else about it changes, which this reproduces for a
/// drive path; a UNC or device path is `None`, because only Node can say what it prints.
pub(crate) fn printed_path(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();

    if cfg!(windows) {
        printed_windows_path(&text)
    } else {
        Some(text.into_owned())
    }
}

fn printed_windows_path(text: &str) -> Option<String> {
    let bytes = text.as_bytes();

    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || !matches!(bytes[2], b'\\' | b'/') {
        return None;
    }

    let rest = text[2..].replace('\\', "/");

    // Repeated separators and a trailing one are normalised away by Node; a path from the OS has neither.
    (!rest[1..].contains("//") && (rest.len() == 1 || !rest.ends_with('/')))
        .then(|| format!("{}:{rest}", char::from(bytes[0].to_ascii_uppercase())))
}

/// Whether Node would reach the same answer from the workspace root `cwd`: a unix CI run with no terminal on either
/// stream, none of the settings that change what Node prints ([`output_settings_are_default`]), `cwd` as the root of a
/// pnpm workspace and no inherited root for another directory. What a command still has to check for itself is its
/// config and Deno files, which differ between commands.
pub(crate) fn ci_root_context(cwd: &Path) -> bool {
    cfg!(unix)
        && in_ci()
        && !io::stdout().is_terminal()
        && !io::stderr().is_terminal()
        && !crate::term::node_warns_about_colour()
        && output_settings_are_default()
        && monorepo_root(cwd).as_deref() == Some(cwd)
        && inherited_root_allows(cwd, env::var_os("VIS_MONOREPO_ROOT").as_deref())
}

/// Whether Node's root search would return `cwd` itself. Node walks up from `cwd` and stops at the
/// first marker, so `cwd` is the root only when it holds one and no ancestor does. `env_root` is the
/// inherited `VIS_MONOREPO_ROOT`: it is never trusted to name the root, only to delegate when it
/// names another directory, since a parent process may have computed it for its own working directory.
pub(crate) fn native_root_is_cwd(cwd: &Path, env_root: Option<&OsStr>) -> bool {
    if !inherited_root_allows(cwd, env_root) {
        return false;
    }

    let holds_marker = |directory: &Path| ROOT_MARKERS.iter().any(|name| directory.join(name).exists());

    holds_marker(cwd) && !cwd.ancestors().skip(1).any(holds_marker)
}

/// The workspace root Node picks for `cwd`: `findMonorepoRootSync` in `@visulima/package`, which
/// takes the nearest lockfile (or `packageManager` manifest) and, for pnpm, the directory holding
/// `pnpm-workspace.yaml`. Anything else, including a lerna or turbo marker, another lockfile or a
/// `packageManager` field, delegates, because the outcome then depends on details this path skips.
pub(crate) fn monorepo_root(cwd: &Path) -> Option<PathBuf> {
    if cwd.ancestors().any(|dir| dir.join("lerna.json").exists() || dir.join("turbo.json").exists()) {
        return None;
    }

    for dir in cwd.ancestors() {
        if dir.join("pnpm-lock.yaml").is_file() {
            return dir.join("pnpm-workspace.yaml").is_file().then(|| dir.to_path_buf());
        }

        if lockfile_managers(dir).iter().any(|manager| *manager != Manager::Pnpm) {
            return None;
        }

        let manifest = dir.join("package.json");

        if manifest.exists() && read_json(&manifest)?.get("packageManager").is_some() {
            return None;
        }
    }

    None
}

/// Whether Node would reach the same answer without a workspace search or any config notice.
///
/// Node resolves the workspace root with `@visulima/package`'s search. This crate reproduces it
/// only for the working directory being the root ([`native_root_is_cwd`]); any other root delegates.
/// Node also warns about a missing `vis.config` and about Deno files, but only outside CI, and it
/// prints tips and notices on a terminal. So the native path needs CI, a non-terminal stderr, and no
/// config or Deno file at or above the working directory.
pub(crate) fn native_context() -> bool {
    let Some(cwd) = env::current_dir().ok() else {
        return false;
    };

    let env_root = env::var_os("VIS_MONOREPO_ROOT");

    // Node fails here when its search finds no root ("Could not determine workspace root"), so the
    // root must resolve to the working directory, not merely hold a marker.
    native_root_is_cwd(&cwd, env_root.as_deref())
        && monorepo_root(&cwd).as_deref() == Some(cwd.as_path())
        && quiet_context(&cwd, &cwd)
}

/// Whether Node would print nothing to stderr for a command run from `cwd` under the workspace
/// root `root`: CI, a non-terminal stderr, no runtime warning about the colour variables, and no config or
/// Deno file at or above either one.
pub(crate) fn quiet_context(cwd: &Path, root: &Path) -> bool {
    if !in_ci() || io::stderr().is_terminal() || crate::term::node_warns_about_colour() {
        return false;
    }

    [cwd, root].iter().all(|directory| !has_vis_config(directory) && !any_ancestor_has(directory, &DENO_FILES))
}

/// `is-in-ci`: `CI` or `CONTINUOUS_INTEGRATION` set to anything but `0` or `false`.
pub(crate) fn in_ci() -> bool {
    ["CI", "CONTINUOUS_INTEGRATION"]
        .iter()
        .any(|key| env::var_os(key).is_some_and(|value| value != "0" && value != "false"))
}

/// Whether none of the settings that change what Node prints for a run are in the environment: pail's level
/// (`NODE_ENV` of `test` or `debug`, `DEBUG`, `PAIL_LOG_LEVEL`) and cerebro's output level (`CEREBRO_*`). A run with
/// any of them goes to Node. The launcher keeps the same list in `outputSettingsAreDefault` (`bin/route.mjs`);
/// the shared cases of `native/cli/tests/fixtures/routing.json` run both halves for each variable and fail when
/// the two differ.
pub(crate) fn output_settings_are_default() -> bool {
    debug_output_is_default()
        && !env::var_os("NODE_ENV").is_some_and(|value| value == "test" || value == "debug")
        && env::var_os("PAIL_LOG_LEVEL").is_none()
}

/// Whether neither `DEBUG` nor a `CEREBRO_*` variable is in the environment: the part of
/// [`output_settings_are_default`] that makes Node trace the command (`DEBUG`, cerebro's debug output level) around the
/// output it prints. A command whose own output goes through no logger, such as `exec`, `hook run` or the package-manager
/// commands, needs only this part: `NODE_ENV` and `PAIL_LOG_LEVEL` change what pail prints, and these print none of it.
pub(crate) fn debug_output_is_default() -> bool {
    env::var_os("DEBUG").is_none() && !env::vars_os().any(|(name, _)| name.to_string_lossy().starts_with("CEREBRO_"))
}

pub(crate) const DENO_FILES: [&str; 3] = ["deno.json", "deno.jsonc", "deno.lock"];

/// Whether `directory` or one of its ancestors holds a file named in `names`.
pub(crate) fn any_ancestor_has(directory: &Path, names: &[&str]) -> bool {
    directory.ancestors().any(|ancestor| names.iter().any(|name| ancestor.join(name).exists()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// `<temp>/vis-root-gate-<name>/app`, with a `package.json` in `app` and, when asked, in its parent.
    fn root_fixture(name: &str, marker_above: bool) -> PathBuf {
        let base = env::temp_dir().join(format!("vis-root-gate-{name}-{}", std::process::id()));
        let app = base.join("app");

        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("package.json"), "{}").unwrap();

        if marker_above {
            fs::write(base.join("package.json"), "{}").unwrap();
        }

        app
    }

    #[test]
    fn a_windows_drive_path_prints_with_slashes_and_a_capital_drive_letter() {
        // What the Node CLI printed for each of these working directories on Windows (`deps --format json`).
        for (given, shown) in [
            ("C:\\Users\\vis\\ws\\empty", "C:/Users/vis/ws/empty"),
            ("c:\\Users\\vis\\ws\\empty", "C:/Users/vis/ws/empty"),
            ("C:\\users\\VIS\\Vis-Gates\\ws\\EMPTY", "C:/users/VIS/Vis-Gates/ws/EMPTY"),
            ("c:/Users/vis/ws/empty", "C:/Users/vis/ws/empty"),
            ("C:\\", "C:/"),
        ] {
            assert_eq!(printed_windows_path(given).as_deref(), Some(shown), "{given}");
        }

        for other in ["\\\\server\\share\\a", "\\\\?\\C:\\a", "relative\\a", "C:a", "C:\\a\\\\b", "C:\\a\\", ""] {
            assert_eq!(printed_windows_path(other), None, "{other}");
        }
    }

    #[test]
    fn an_inherited_root_is_only_a_reason_to_delegate_when_it_names_another_directory() {
        let cwd = Path::new("/work/app");

        assert!(inherited_root_allows(cwd, None));
        assert!(inherited_root_allows(cwd, Some(OsStr::new(""))), "Node reads `VIS_MONOREPO_ROOT || cwd`");
        assert!(inherited_root_allows(cwd, Some(OsStr::new("/work/app"))));
        assert!(!inherited_root_allows(cwd, Some(OsStr::new("/work"))));
    }

    #[test]
    fn root_gate_answers_when_the_working_directory_is_the_only_marked_directory() {
        let app = root_fixture("alone", false);

        assert!(native_root_is_cwd(&app, None));
        assert!(native_root_is_cwd(&app, Some(OsStr::new(""))));
        assert!(native_root_is_cwd(&app, Some(app.as_os_str())));
    }

    #[test]
    fn root_gate_delegates_when_an_ancestor_holds_a_marker() {
        let app = root_fixture("ancestor", true);

        assert!(!native_root_is_cwd(&app, None));
        assert!(!native_root_is_cwd(&app, Some(app.as_os_str())));
    }

    #[test]
    fn root_gate_delegates_when_the_inherited_root_is_another_directory() {
        let app = root_fixture("stale", false);
        let parent = app.parent().unwrap();

        assert!(!native_root_is_cwd(&app, Some(parent.as_os_str())));
    }

    #[test]
    fn workspace_root_resolves_to_cwd_only_for_a_pnpm_workspace() {
        let app = root_fixture("resolves", false);

        // A bare package.json is a marker but not a workspace: Node's search finds no root there.
        assert_eq!(monorepo_root(&app), None);

        fs::write(app.join("pnpm-lock.yaml"), "").unwrap();
        fs::write(app.join("pnpm-workspace.yaml"), "").unwrap();

        assert_eq!(monorepo_root(&app), Some(app.clone()));
    }

    #[test]
    fn root_gate_delegates_when_the_working_directory_holds_no_marker() {
        let base = env::temp_dir().join(format!("vis-root-gate-unmarked-{}", std::process::id()));

        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        assert!(!native_root_is_cwd(&base, Some(base.as_os_str())));
        assert!(!native_root_is_cwd(&base, None));
    }
}
