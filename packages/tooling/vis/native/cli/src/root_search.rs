//! The pieces of Node's monorepo-root search (`findMonorepoRootSync` in `@visulima/package`) that the native commands
//! reproduce, in one place: the lockfile table read as a [`Manager`], the manifest read, the workspace marker of a
//! manager, and the two whole searches built on them ([`config_root`] for where Node loads `vis.config`,
//! [`node_ignores_config`] for when it finds no root at all). `node_context::monorepo_root` (the stricter search the
//! read-only commands use) and `pm_run`'s root-here check build on the same pieces.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use vis_core::lockfiles::LOCKFILES;

use crate::js::is_truthy;

/// A package manager that Node's root search tells apart by a lockfile or the `packageManager` field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Manager {
    Npm,
    Yarn,
    Pnpm,
    Bun,
}

impl Manager {
    /// The manager a `LOCKFILES` row names.
    fn from_lockfile_name(name: &str) -> Option<Self> {
        match name {
            "npm" => Some(Self::Npm),
            "yarn" => Some(Self::Yarn),
            "pnpm" => Some(Self::Pnpm),
            "bun" => Some(Self::Bun),
            _ => None,
        }
    }

    /// The manager a `packageManager` field (`pnpm@9.0.0`) starts with, tried in Node's order.
    fn from_package_manager_field(field: &str) -> Option<Self> {
        [Self::Npm, Self::Yarn, Self::Pnpm, Self::Bun].into_iter().find(|manager| field.starts_with(manager.name()))
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Yarn => "yarn",
            Self::Pnpm => "pnpm",
            Self::Bun => "bun",
        }
    }
}

/// The nearest directory that names a package manager.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Nearest<'a> {
    pub(crate) directory: &'a Path,
    /// `None` when the nearest marker names one Node cannot resolve a workspace from.
    pub(crate) manager: Option<Manager>,
}

pub(crate) fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// The managers whose lockfiles `directory` holds, one entry per manager, in `LOCKFILES` order.
pub(crate) fn lockfile_managers(directory: &Path) -> Vec<Manager> {
    let mut managers: Vec<Manager> = LOCKFILES
        .iter()
        .filter(|(file, _)| directory.join(file).exists())
        .filter_map(|(_, name)| Manager::from_lockfile_name(name))
        .collect();

    managers.dedup();

    managers
}

/// Whether `directory` holds any lockfile.
fn has_lockfile(directory: &Path) -> bool {
    LOCKFILES.iter().any(|(file, _)| directory.join(file).exists())
}

/// Whether `directory` is the workspace root of `manager`: the `workspaces` key of an npm or yarn manifest, the
/// `pnpm-workspace.yaml` of pnpm. `None` when the manifest exists and does not parse, which Node reports as no root
/// and the native path leaves alone.
pub(crate) fn is_workspace_root(directory: &Path, manager: Option<Manager>) -> Option<bool> {
    match manager {
        Some(Manager::Npm | Manager::Yarn) => {
            let manifest = directory.join("package.json");

            match read_json(&manifest) {
                Some(manifest) => Some(
                    manifest
                        .get("workspaces")
                        .is_some_and(|workspaces| workspaces.is_object() || workspaces.is_array()),
                ),
                None if manifest.exists() => None,
                None => Some(false),
            }
        }
        Some(Manager::Pnpm) => Some(directory.join("pnpm-workspace.yaml").exists()),
        Some(Manager::Bun) | None => Some(false),
    }
}

/// The nearest directory that names a package manager, by a lockfile or a `packageManager` field. `None` when there
/// is none, or when a `package.json` on the way cannot be parsed (Node fails the same lookup).
pub(crate) fn nearest_manager(cwd: &Path) -> Option<Nearest<'_>> {
    for directory in cwd.ancestors() {
        if let Some(&manager) = lockfile_managers(directory).first() {
            return Some(Nearest { directory, manager: Some(manager) });
        }

        let manifest_path = directory.join("package.json");

        if !manifest_path.is_file() {
            continue;
        }

        let manifest = read_json(&manifest_path)?;

        if let Some(field) = manifest.get("packageManager").and_then(Value::as_str) {
            return Some(Nearest { directory, manager: Manager::from_package_manager_field(field) });
        }
    }

    None
}

/// The monorepo root Node's config loader reads `vis.config` from for `cwd`, or `None` when Node finds none and
/// ignores the config. Mirrors `findMonorepoRoot`: a lerna root, else the workspace marker of the package manager the
/// nearest lockfile or `packageManager` field names. A file that cannot be read or parsed makes Node fail the same
/// lookup, so it counts as no root.
pub(crate) fn config_root(cwd: &Path) -> Option<PathBuf> {
    for directory in cwd.ancestors() {
        if directory.join("lerna.json").is_file() {
            let lerna = read_json(&directory.join("lerna.json"))?;

            if lerna.is_object()
                && (lerna.get("useWorkspaces").is_some_and(is_truthy) || lerna.get("packages").is_some_and(is_truthy))
            {
                return Some(directory.to_path_buf());
            }

            break;
        }

        if directory.join("turbo.json").is_file() {
            break;
        }
    }

    let Nearest { directory, manager } = nearest_manager(cwd)?;

    is_workspace_root(directory, manager).unwrap_or(false).then(|| directory.to_path_buf())
}

/// Whether Node finds no monorepo root for `cwd` and so ignores every `vis.config` on the way up.
/// `findMonorepoRoot` fails without an error only when no lerna or turbo marker, no lockfile and no
/// `packageManager` pin is found, and every `package.json` parses. Any other failure is reported by Node,
/// so it returns `false` and the command stays with Node.
pub(crate) fn node_ignores_config(cwd: &Path) -> bool {
    for directory in cwd.ancestors() {
        let marked =
            directory.join("lerna.json").exists() || directory.join("turbo.json").exists() || has_lockfile(directory);

        if marked {
            return false;
        }

        let manifest_path = directory.join("package.json");

        if manifest_path.exists() {
            let Some(manifest) = read_json(&manifest_path) else {
                return false;
            };

            if manifest.get("packageManager").and_then(Value::as_str).is_some() {
                return false;
            }
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vis-root-search-{}-{name}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        dir
    }

    fn files(name: &str, entries: &[(&str, &str)]) -> PathBuf {
        let dir = scratch(name);

        for (file, text) in entries {
            fs::write(dir.join(file), text).unwrap();
        }

        dir
    }

    #[test]
    fn a_single_package_is_not_a_monorepo_root_for_node() {
        let dir = files("single", &[("package.json", "{}"), ("pnpm-lock.yaml", "lockfileVersion: 9\n")]);

        assert_eq!(config_root(&dir), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bare_pnpm_workspace_has_no_node_root_and_node_ignores_its_config() {
        let dir = files(
            "bare-pnpm-workspace",
            &[("pnpm-workspace.yaml", "packages: []\n"), ("vis.config.ts", "export default {};\n")],
        );

        assert_eq!(config_root(&dir), None);
        assert!(node_ignores_config(&dir));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_manifest_that_does_not_parse_is_not_a_silent_node_failure() {
        let dir = files("broken-manifest", &[("package.json", "{"), ("pnpm-workspace.yaml", "packages: []\n")]);

        assert!(!node_ignores_config(&dir));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_workspace_marker_of_the_nearest_manager_is_a_monorepo_root() {
        let pnpm = files(
            "pnpm-root",
            &[("pnpm-workspace.yaml", "packages: []\n"), ("pnpm-lock.yaml", "lockfileVersion: 9\n")],
        );
        let npm = files("npm-root", &[("package.json", "{\"workspaces\":[]}"), ("package-lock.json", "{}")]);

        assert_eq!(config_root(&pnpm), Some(pnpm.clone()));
        assert_eq!(config_root(&npm), Some(npm.clone()));

        fs::remove_dir_all(&pnpm).ok();
        fs::remove_dir_all(&npm).ok();
    }

    #[test]
    fn lerna_packages_make_a_root_even_for_bun() {
        let dir = files("lerna-bun", &[("lerna.json", "{\"packages\":[]}"), ("bun.lock", "{}")]);

        assert_eq!(config_root(&dir), Some(dir.clone()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bun_workspaces_without_lerna_are_not_a_root_for_node() {
        let dir = files("bun-workspaces", &[("package.json", "{\"workspaces\":[\"p/*\"]}"), ("bun.lock", "{}")]);

        assert_eq!(config_root(&dir), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_nearest_package_manager_decides_the_root() {
        let root =
            files("nearest", &[("pnpm-workspace.yaml", "packages: []\n"), ("pnpm-lock.yaml", "lockfileVersion: 9\n")]);
        let child = root.join("child");

        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("package.json"), "{}").unwrap();
        fs::write(child.join("package-lock.json"), "{}").unwrap();

        assert_eq!(config_root(&child), None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unparsable_manifest_is_not_a_root_for_node() {
        let dir = files("bad-json", &[("package.json", "{"), ("pnpm-workspace.yaml", "packages: []\n")]);

        assert_eq!(config_root(&dir), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn every_lockfile_row_names_a_manager() {
        for (file, name) in LOCKFILES {
            assert!(Manager::from_lockfile_name(name).is_some(), "{file}");
        }
    }

    #[test]
    fn a_package_manager_field_is_matched_by_its_prefix() {
        assert_eq!(Manager::from_package_manager_field("pnpm@9.0.0"), Some(Manager::Pnpm));
        assert_eq!(Manager::from_package_manager_field("bun@1.2.0"), Some(Manager::Bun));
        assert_eq!(Manager::from_package_manager_field("deno@2"), None);
    }
}
