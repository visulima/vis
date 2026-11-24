//! The workspace the lints read: the package manifests and the dependency instances of every package.
//!
//! This is `collectWorkspaceDirectories` and `iterateWorkspaceDeps` (`src/util/workspace-deps.ts`) for a pnpm
//! workspace whose patterns [`crate::workspace`] resolves. Every input whose reading JavaScript could do differently
//! (a manifest that is not strict JSON, a dependency block that is an array, a `workspaces` field next to the YAML,
//! `overrides` in the workspace YAML) is `None`, and the command goes to Node.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::json::{parse, Json};
use crate::workspace::{directories_for_patterns, yaml_workspace_patterns};

/// A dependency block, in the order `iterateWorkspaceDeps` reads them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DepType {
    Dependencies,
    DevDependencies,
    PeerDependencies,
    OptionalDependencies,
    Overrides,
    Resolutions,
    PnpmOverrides,
}

impl DepType {
    const ALL: [Self; 7] = [
        Self::Dependencies,
        Self::DevDependencies,
        Self::PeerDependencies,
        Self::OptionalDependencies,
        Self::Overrides,
        Self::Resolutions,
        Self::PnpmOverrides,
    ];

    pub(super) const fn name(self) -> &'static str {
        match self {
            Self::Dependencies => "dependencies",
            Self::DevDependencies => "devDependencies",
            Self::PeerDependencies => "peerDependencies",
            Self::OptionalDependencies => "optionalDependencies",
            Self::Overrides => "overrides",
            Self::Resolutions => "resolutions",
            Self::PnpmOverrides => "pnpm.overrides",
        }
    }
}

/// One `package.json` of the workspace.
pub(super) struct Package {
    /// `.` for the root, else the directory relative to it.
    pub(super) dir: String,
    pub(super) json: Json,
    /// The `name` field when it is a string.
    pub(super) name: Option<String>,
    /// The absolute path of the file.
    pub(super) path: String,
}

impl Package {
    /// The path relative to the workspace root, as the printers show it.
    pub(super) fn relative_path(&self) -> String {
        if self.dir == "." {
            "package.json".to_owned()
        } else {
            format!("{}/package.json", self.dir)
        }
    }

    /// `packageName ?? packageJsonPath`, the key the printers group by.
    pub(super) fn group_key(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.path)
    }

    /// `packageName ?? relative path`.
    pub(super) fn display_name(&self) -> String {
        self.name.clone().unwrap_or_else(|| self.relative_path())
    }

    pub(super) fn is_private(&self) -> bool {
        matches!(self.json.get("private"), Some(Json::Bool(true)))
    }
}

/// A dependency as one package declares it.
pub(super) struct Instance {
    pub(super) dep_name: String,
    pub(super) dep_type: DepType,
    pub(super) is_internal: bool,
    /// Index into [`Workspace::packages`].
    pub(super) package: usize,
    pub(super) specifier: String,
}

pub(super) struct Workspace {
    pub(super) instances: Vec<Instance>,
    pub(super) packages: Vec<Package>,
    /// The patterns of the workspace YAML.
    pub(super) patterns: Vec<String>,
    pub(super) root: PathBuf,
}

/// Reads the workspace rooted at `root`, or `None` when the command must go to Node.
pub(super) fn read(root: &Path) -> Option<Workspace> {
    // Node reads the packages of `package.json#workspaces` first and would add the YAML's only when that finds none.
    if root.join("aube-workspace.yaml").exists() || yaml_declares_overrides(root)? {
        return None;
    }

    let patterns = yaml_workspace_patterns(root)?;
    let mut directories = vec![".".to_owned()];

    directories.extend(directories_for_patterns(root, &patterns)?);

    let mut packages = Vec::with_capacity(directories.len());

    for dir in directories {
        let path = root.join(&dir).join("package.json");
        let json = parse(&fs::read_to_string(&path).ok()?)?;

        if !matches!(json, Json::Object(_)) || (dir == "." && json.get("workspaces").is_some()) {
            return None;
        }

        let name = json.get("name").and_then(Json::as_str).map(str::to_owned);

        packages.push(Package { dir, json, name, path: path.to_str()?.to_owned() });
    }

    let instances = instances(&packages)?;

    Some(Workspace { instances, packages, patterns, root: root.to_path_buf() })
}

/// Whether the workspace YAML mentions `overrides` at all. Node reads the key into `pnpm.overrides` instances with a
/// full YAML parser (quoted keys, flow mappings and spaces before the colon included); the word is enough to tell that
/// there are none. `None` when it is unreadable.
fn yaml_declares_overrides(root: &Path) -> Option<bool> {
    let path = root.join("pnpm-workspace.yaml");

    if !path.exists() {
        return Some(false);
    }

    Some(fs::read_to_string(path).ok()?.contains("overrides"))
}

/// The string-valued entries of the block `dep_type` of `package`. `None` when JavaScript would read the block as
/// something this module does not (an array, whose entries are its indices).
fn entries(package: &Json, dep_type: DepType) -> Option<Vec<(&str, &str)>> {
    let block = if dep_type == DepType::PnpmOverrides {
        match package.get("pnpm") {
            Some(pnpm @ Json::Object(_)) => pnpm.get("overrides"),
            _ => None,
        }
    } else {
        package.get(dep_type.name())
    };

    match block {
        Some(Json::Object(fields)) => {
            Some(fields.iter().filter_map(|(name, value)| value.as_str().map(|text| (name.as_str(), text))).collect())
        }
        Some(Json::Array(_)) => None,
        _ => Some(Vec::new()),
    }
}

/// `iterateWorkspaceDeps`: every dependency of every package.
fn instances(packages: &[Package]) -> Option<Vec<Instance>> {
    let internal: HashSet<&str> = packages.iter().filter_map(|package| package.name.as_deref()).collect();
    let mut found = Vec::new();

    for (index, package) in packages.iter().enumerate() {
        // `colorize` closes and re-opens its style around a line feed, which the printers do not do.
        if package.name.as_deref().is_some_and(has_control_character) {
            return None;
        }

        for dep_type in DepType::ALL {
            for (name, specifier) in entries(&package.json, dep_type)? {
                if has_control_character(name) || has_control_character(specifier) {
                    return None;
                }

                found.push(Instance {
                    dep_name: name.to_owned(),
                    dep_type,
                    is_internal: internal.contains(&name),
                    package: index,
                    specifier: specifier.to_owned(),
                });
            }
        }
    }

    Some(found)
}

fn has_control_character(text: &str) -> bool {
    text.chars().any(char::is_control)
}
