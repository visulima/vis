//! Native port of the `vis __pm-shim <pm> [args...]` dispatcher.
//!
//! The `.vis/shims/<pm>` wrappers call `vis __pm-shim <pm> [args]`; this enforces
//! the project's pinned package manager (a "PM guard") and then execs the real
//! tool. The JS implementation lives in `src/commands/shim/dispatch.ts`; this is a
//! behaviourally identical, zero-Node reimplementation. The pure decision logic
//! (`decide`) mirrors `decideShim` and is covered by the same cases as the JS
//! unit tests. The pinned manager comes from the sources of that file's `pinnedPm`
//! and no others (`pinned_pm`), not from `vis_core::detect`, which reads more.

use std::env;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

use crate::error::WrapperError;

/// A recognised shim: the canonical package-manager name it maps to, and whether
/// it is a one-off runner (npx/pnpx) that should always pass through the guard.
struct ShimEntry {
    pm: &'static str,
    runner: bool,
}

fn shim_entry(invoked: &str) -> Option<ShimEntry> {
    let (pm, runner) = match invoked {
        "npm" => ("npm", false),
        "npx" => ("npm", true),
        "pnpm" => ("pnpm", false),
        "pnpx" => ("pnpm", true),
        "yarn" | "yarnpkg" => ("yarn", false),
        _ => return None,
    };

    Some(ShimEntry { pm, runner })
}

/// Verbs that are transparent to the guard even on a PM mismatch (they scaffold
/// or run arbitrary tooling rather than mutate this project's deps).
const TRANSPARENT_VERBS: [&str; 4] = ["create", "dlx", "exec", "init"];

#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Dispatch,
    Refuse,
}

/// Pure guard decision — mirrors `decideShim`. Unknown shims always dispatch (the
/// caller surfaces the error). A top-level mismatch against the pinned PM is
/// refused unless the invocation is a runner, a transparent verb, or nested
/// inside another PM.
fn decide(invoked: &str, pinned: Option<&str>, first_verb: Option<&str>, nested: bool) -> Decision {
    let entry = match shim_entry(invoked) {
        Some(entry) => entry,
        None => return Decision::Dispatch,
    };

    let transparent = entry.runner || first_verb.is_some_and(|verb| TRANSPARENT_VERBS.contains(&verb));
    let mismatch = matches!(pinned, Some(pinned) if pinned != entry.pm);

    if mismatch && !transparent && !nested {
        Decision::Refuse
    } else {
        Decision::Dispatch
    }
}

/// True when a package manager is already running (it sets these env vars),
/// meaning this invocation is nested and the guard should stand down.
fn is_nested() -> bool {
    env::var_os("npm_config_user_agent").is_some() || env::var_os("npm_execpath").is_some()
}

/// The package manager a `package.json` pins through `packageManager`, when it is one of the three
/// shimmed managers. Anything else (`bun@1`, an unparsable file, no field) is no pin.
fn manifest_pin(directory: &Path) -> Option<&'static str> {
    let manifest = directory.join("package.json");

    if !manifest.is_file() {
        return None;
    }

    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(manifest).ok()?).ok()?;
    let spec = value.get("packageManager")?.as_str()?;

    match spec.split('@').next()? {
        "npm" => Some("npm"),
        "pnpm" => Some("pnpm"),
        "yarn" => Some("yarn"),
        _ => None,
    }
}

/// The project's pinned manager, as `pinnedPm` in `src/commands/shim/dispatch.ts` finds it: walking up
/// from `cwd`, in each directory the `packageManager` field first, then the lockfiles `pnpm-lock.yaml`,
/// `yarn.lock`, `package-lock.json` and `npm-shrinkwrap.json`. No pin means no opinion.
fn pinned_pm(cwd: &Path) -> Option<&'static str> {
    const LOCKFILES: [(&str, &str); 4] = [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
        ("npm-shrinkwrap.json", "npm"),
    ];

    cwd.ancestors().find_map(|directory| {
        manifest_pin(directory)
            .or_else(|| LOCKFILES.iter().find(|(file, _)| directory.join(file).is_file()).map(|(_, pm)| *pm))
    })
}

/// Find the real package-manager executable on PATH, skipping the `.vis/shims`
/// directory so the wrapper never re-invokes itself.
fn find_real_pm(invoked: &str) -> Option<PathBuf> {
    let candidates: Vec<String> = if cfg!(windows) {
        vec![format!("{invoked}.cmd"), format!("{invoked}.exe"), invoked.to_owned()]
    } else {
        vec![invoked.to_owned()]
    };

    for directory in env::split_paths(&env::var_os("PATH")?) {
        if directory.as_os_str().is_empty() {
            continue;
        }

        let trimmed = directory.to_string_lossy().trim_end_matches(['/', '\\']).to_owned();

        if trimmed.ends_with(".vis/shims") || trimmed.ends_with(".vis\\shims") {
            continue;
        }

        for candidate in &candidates {
            let full = directory.join(candidate);

            if full.is_file() {
                return Some(full);
            }
        }
    }

    None
}

/// Exec the real PM with inherited stdio and end with its exit status. Never returns. The status is Node's
/// `shimExit` (`src/commands/shim/dispatch.ts`): the manager's own, and 1, not `128 + signal`, for one a signal
/// killed. A manager that cannot be started ends with 1 and `vis shim: could not start <name>: <reason>` on stderr,
/// the line Node prints.
fn exec_real(invoked: &str, real: &Path, args: &[String]) -> ! {
    match Command::new(real).args(args).status() {
        Ok(status) => exit(crate::process::node_exit_code(status)),
        Err(source) => WrapperError::usage("shim", format!("could not start {invoked}: {source}")).exit(),
    }
}

/// Entry point for `vis __pm-shim <pm> [args...]`. Never returns.
pub fn dispatch(invoked: &str, args: &[String]) -> ! {
    if shim_entry(invoked).is_none() {
        eprintln!("vis: {invoked} is not a known package-manager shim.");
        exit(1);
    }

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let pinned = pinned_pm(&cwd);

    if decide(invoked, pinned, args.first().map(String::as_str), is_nested()) == Decision::Refuse {
        let pinned = pinned.unwrap_or("");

        eprintln!(
            "vis: this project uses {pinned}, but `{invoked}` was run. Use `{pinned}` instead, or run `vis shim uninstall` to disable the PM guard."
        );
        exit(1);
    }

    match find_real_pm(invoked) {
        Some(real) => exec_real(invoked, &real, args),
        None => {
            eprintln!("vis: `{invoked}` was not found on PATH (outside the shim dir).");
            exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, pinned_pm, Decision};

    /// A scratch directory holding `files`, with `app` below it as the working directory.
    fn project(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("vis-pm-shim-{}-{tag}", std::process::id()));

        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("app")).unwrap();

        for (name, content) in files {
            std::fs::write(root.join(name), content).unwrap();
        }

        root
    }

    #[test]
    fn the_pin_comes_from_the_manifest_then_the_lockfiles_of_one_directory() {
        let root = project("pin", &[("package.json", r#"{"packageManager":"yarn@4.1.0"}"#), ("pnpm-lock.yaml", "")]);

        assert_eq!(pinned_pm(&root.join("app")), Some("yarn"));
        let _ = std::fs::remove_dir_all(&root);

        let root = project("lock", &[("package.json", "{}"), ("yarn.lock", ""), ("package-lock.json", "")]);

        assert_eq!(pinned_pm(&root.join("app")), Some("yarn"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_npm_pnpm_and_yarn_pins_and_their_four_lockfiles_count() {
        for (tag, files) in [
            ("bun", vec![("package.json", r#"{"packageManager":"bun@1.1.0"}"#)]),
            ("workspace", vec![("pnpm-workspace.yaml", "packages: []\n")]),
            ("yarnrc", vec![(".yarnrc.yml", "")]),
            ("bun-lock", vec![("bun.lock", ""), ("bun.lockb", "")]),
            ("broken", vec![("package.json", "{ not json")]),
            ("scope", vec![("package.json", r#"{"packageManager":"@scope/x@1"}"#)]),
        ] {
            let root = project(tag, &files);

            assert_eq!(pinned_pm(&root.join("app")), None, "{tag}");
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn a_manifest_without_a_pin_falls_through_to_its_own_lockfile_before_the_parent() {
        let root = project("fall", &[("pnpm-lock.yaml", "")]);

        std::fs::write(root.join("app").join("package.json"), "{}").unwrap();
        std::fs::write(root.join("app").join("package-lock.json"), "{}").unwrap();

        assert_eq!(pinned_pm(&root.join("app")), Some("npm"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dispatches_on_agreement() {
        assert_eq!(decide("pnpm", Some("pnpm"), Some("install"), false), Decision::Dispatch);
    }

    #[test]
    fn refuses_top_level_mismatch() {
        assert_eq!(decide("npm", Some("pnpm"), Some("install"), false), Decision::Refuse);
    }

    #[test]
    fn falls_through_on_nested_mismatch() {
        assert_eq!(decide("npm", Some("pnpm"), Some("install"), true), Decision::Dispatch);
    }

    #[test]
    fn transparent_verbs_pass_despite_mismatch() {
        assert_eq!(decide("npm", Some("pnpm"), Some("create"), false), Decision::Dispatch);
    }

    #[test]
    fn runner_shims_always_dispatch() {
        assert_eq!(decide("npx", Some("pnpm"), Some("anything"), false), Decision::Dispatch);
    }

    #[test]
    fn dispatches_when_no_pin() {
        assert_eq!(decide("yarn", None, Some("install"), false), Decision::Dispatch);
    }

    #[test]
    fn unknown_shim_dispatches() {
        assert_eq!(decide("bun", Some("pnpm"), Some("install"), false), Decision::Dispatch);
    }
}
