//! Script targets for JS-only projects, read natively.
//!
//! Mirrors `createTargetsFromScripts` in `packages/tooling/vis/src/config/workspace.ts` for the
//! project directories `workspace::project_directories` accepts, when a project's targets come
//! from its `package.json` `scripts` alone. Each target is `{ command }` with the script text
//! verbatim. Any inference detector that could apply, a non-JS marker, or a field shape this
//! module does not reproduce returns `Targets::Delegate`, and the Node CLI answers it.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use crate::workspace::{self, Membership};

/// The config-file names and dependency names of the JS inference detectors, read from the same
/// registry the Node side uses. `packages/tooling/vis/__tests__/native/` checks it for drift.
const MARKERS_JSON: &str = include_str!("inference-markers.json");

/// Dependency fields `hasDependency` consults.
const DEPENDENCY_FIELDS: [&str; 4] = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/// Script names that `defaults[name]` would resolve through `Object.prototype` in the Node path.
pub(crate) const PROTOTYPE_NAMES: [&str; 12] = [
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

#[derive(Debug, PartialEq)]
pub struct ProjectTargets {
    pub directory: String,
    pub name: String,
    pub targets: BTreeMap<String, String>,
}

/// Outcome for a root. Projects come back in discovery order and targets in name order; the Node
/// path keeps `package.json` key order, so comparisons across the two must ignore order.
#[derive(Debug, PartialEq)]
pub enum Targets {
    Native(Vec<ProjectTargets>),
    Delegate,
}

/// Script targets for every project of the JS-only workspace at `root`, or delegate.
///
/// `root` must be absolute with no `.` or `..` components, as `workspace::project_directories` requires.
pub fn script_targets(root: &Path) -> Targets {
    targets_of(root, workspace::project_directories(root))
}

/// Like [`script_targets`], for a root whose `vis.config.*` the caller has read and found free of keys that
/// change the project set or the targets (see `workspace::project_directories_vetted`).
pub fn script_targets_vetted(root: &Path) -> Targets {
    targets_of(root, workspace::project_directories_vetted(root))
}

fn targets_of(root: &Path, membership: Membership) -> Targets {
    match membership {
        Membership::Native(directories) => native_targets(root, directories).map_or(Targets::Delegate, Targets::Native),
        Membership::Delegate => Targets::Delegate,
    }
}

fn native_targets(root: &Path, directories: Vec<String>) -> Option<Vec<ProjectTargets>> {
    let mut projects = Vec::with_capacity(directories.len());
    let mut names = BTreeSet::new();

    for directory in directories {
        let project = project_targets(&root.join(&directory), directory)?;

        // Node keeps the last of two projects that share a name, so both cannot be answered here.
        if !names.insert(project.name.clone()) {
            return None;
        }

        projects.push(project);
    }

    Some(projects)
}

fn project_targets(absolute: &Path, directory: String) -> Option<ProjectTargets> {
    let text = fs::read_to_string(absolute.join("package.json")).ok()?;
    let manifest: Value = serde_json::from_str(&text).ok()?;
    let manifest = manifest.as_object()?;
    let name = manifest.get("name")?.as_str().filter(|name| !name.is_empty())?.to_string();

    if inference_applies(absolute, manifest)? || workspace::has_non_js_marker(absolute)? {
        return None;
    }

    let mut targets = BTreeMap::new();

    if let Some(scripts) = manifest.get("scripts") {
        for (script, value) in scripts.as_object()? {
            if PROTOTYPE_NAMES.contains(&script.as_str()) {
                return None;
            }

            // `mergeTarget` sets `command` only for a truthy script; an empty one is a target with no command.
            let command = value.as_str().filter(|command| !command.is_empty())?;

            targets.insert(script.clone(), command.to_string());
        }
    }

    Some(ProjectTargets { directory, name, targets })
}

/// Whether any JS detector could match this project: a config file exists in it, or a detector's
/// fallback dependency is declared. A matched detector can add or enrich targets, which the native
/// path does not reproduce. A dependency field that is present but not an object throws in Node.
fn inference_applies(absolute: &Path, manifest: &Map<String, Value>) -> Option<bool> {
    let markers: Value = serde_json::from_str(MARKERS_JSON).ok()?;
    let config_files = markers.get("configFiles")?.as_array()?;
    let dependencies = markers.get("dependencies")?.as_array()?;

    if config_files.iter().filter_map(Value::as_str).any(|file| absolute.join(file).exists()) {
        return Some(true);
    }

    for field in DEPENDENCY_FIELDS {
        let Some(value) = manifest.get(field) else {
            continue;
        };

        let declared = value.as_object()?;

        if dependencies.iter().filter_map(Value::as_str).any(|name| declared.contains_key(name)) {
            return Some(true);
        }
    }

    Some(false)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::Value;

    use super::*;

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/targets")
    }

    #[test]
    fn markers_file_lists_inert_names_only() {
        let markers: Value = serde_json::from_str(MARKERS_JSON).expect("valid marker json");
        let config_files = markers["configFiles"].as_array().expect("configFiles");
        let dependencies = markers["dependencies"].as_array().expect("dependencies");

        assert!(!config_files.is_empty() && !dependencies.is_empty());
        assert!(config_files.iter().all(|file| !file.as_str().expect("string").starts_with("*.")));
    }

    #[test]
    fn fixtures_match_expected_targets() {
        let mut checked = 0;

        for entry in fs::read_dir(fixture_root()).expect("fixture root") {
            let case = entry.expect("fixture entry").path();
            let expected: Value =
                serde_json::from_str(&fs::read_to_string(case.join("expected.json")).expect("expected.json"))
                    .expect("valid expected.json");
            let actual = script_targets(&case);

            match expected.get("native") {
                Some(native) => {
                    let mut want: Vec<(String, String, BTreeMap<String, String>)> = native
                        .as_array()
                        .expect("native list")
                        .iter()
                        .map(|project| {
                            let targets = project["targets"]
                                .as_object()
                                .expect("targets object")
                                .iter()
                                .map(|(name, command)| (name.clone(), command.as_str().expect("command").to_string()))
                                .collect();

                            (
                                project["directory"].as_str().expect("directory").to_string(),
                                project["name"].as_str().expect("name").to_string(),
                                targets,
                            )
                        })
                        .collect();
                    want.sort_by(|a, b| a.0.cmp(&b.0));

                    let Targets::Native(projects) = actual else {
                        panic!("{}: expected native, got delegate", case.display());
                    };
                    let mut got: Vec<(String, String, BTreeMap<String, String>)> = projects
                        .into_iter()
                        .map(|project| (project.directory, project.name, project.targets))
                        .collect();
                    got.sort_by(|a, b| a.0.cmp(&b.0));

                    assert_eq!(got, want, "{}", case.display());
                }
                None => assert_eq!(actual, Targets::Delegate, "{}", case.display()),
            }

            checked += 1;
        }

        assert!(checked >= 15, "fixtures went missing: {checked}");
    }
}
