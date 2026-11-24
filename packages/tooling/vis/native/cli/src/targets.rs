//! Script targets for JS-only projects, read natively.
//!
//! Mirrors `createTargetsFromScripts` in `packages/tooling/vis/src/config/workspace.ts` for the
//! project directories `workspace::project_directories` accepts, when a project's targets come
//! from its `package.json` `scripts` alone. Each target is `{ command }` with the script text
//! verbatim. Any inference detector that could apply, a non-JS marker, or a field shape this
//! module does not reproduce returns `Targets::Delegate`, and the Node CLI answers it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use rayon::prelude::*;
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

/// Like [`script_targets`], but a workspace with `limit` project directories or more is Node's, without a manifest
/// read (see `workspace::project_directories_below`).
pub fn script_targets_below(root: &Path, limit: usize) -> Targets {
    targets_of(root, workspace::project_directories_below(root, limit))
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
    // Every project is read on every core; the order of the directories is kept.
    let projects: Vec<ProjectTargets> = directories
        .into_par_iter()
        .map(|directory| project_targets(&root.join(&directory), directory))
        .collect::<Option<Vec<_>>>()?;
    let mut names = BTreeSet::new();

    for project in &projects {
        // Node keeps the last of two projects that share a name, so both cannot be answered here.
        if !names.insert(project.name.as_str()) {
            return None;
        }
    }

    Some(projects)
}

fn project_targets(absolute: &Path, directory: String) -> Option<ProjectTargets> {
    let text = fs::read_to_string(absolute.join("package.json")).ok()?;
    let manifest: Value = serde_json::from_str(&text).ok()?;
    let manifest = manifest.as_object()?;
    let name = manifest.get("name")?.as_str().filter(|name| !name.is_empty())?.to_string();

    // One listing of the directory serves both checks. A name that is not UTF-8 is a project Node answers
    // (`has_non_js_marker` delegates on it), whatever the detectors say.
    let mut names = Vec::new();

    for entry in fs::read_dir(absolute).ok()? {
        names.push(entry.ok()?.file_name().into_string().ok()?);
    }

    if inference_applies(absolute, &names, manifest)? || workspace::names_hold_non_js_marker(&names) {
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

/// The registry parsed once: the dependency names, and the config files grouped by the first segment of their path
/// (`vite.config.ts` under `vite.config.ts`, `.storybook/main.ts` under `.storybook`), compared ASCII lowercase.
struct Markers {
    dependencies: Vec<String>,
    /// Every config file, for a directory whose listing cannot be compared by ASCII case alone.
    config_files: Vec<String>,
    by_first_segment: HashMap<String, Vec<String>>,
}

fn markers() -> Option<&'static Markers> {
    static MARKERS: OnceLock<Option<Markers>> = OnceLock::new();

    MARKERS
        .get_or_init(|| {
            let markers: Value = serde_json::from_str(MARKERS_JSON).ok()?;
            let strings = |key: &str| -> Option<Vec<String>> {
                Some(markers.get(key)?.as_array()?.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            };
            let config_files = strings("configFiles")?;
            let mut by_first_segment: HashMap<String, Vec<String>> = HashMap::new();

            for file in &config_files {
                let first = file.split('/').next().unwrap_or(file).to_ascii_lowercase();

                by_first_segment.entry(first).or_default().push(file.clone());
            }

            Some(Markers { dependencies: strings("dependencies")?, config_files, by_first_segment })
        })
        .as_ref()
}

/// Whether a config file of a detector exists in the project directory, given the names of its entries. A file
/// that `exists` finds follows the directory entries up to case on a case-insensitive file system, so the listing
/// is compared ASCII case-insensitively and every candidate is then confirmed with `exists`, which keeps the answer
/// of one `exists` call per marker. A listing with a name that is not ASCII (where a file system may fold more than
/// ASCII) is checked marker by marker.
fn config_file_exists(absolute: &Path, names: &[String], markers: &Markers) -> bool {
    if names.iter().any(|name| !name.is_ascii()) {
        return markers.config_files.iter().any(|file| absolute.join(file).exists());
    }

    names
        .iter()
        .filter_map(|name| markers.by_first_segment.get(&name.to_ascii_lowercase()))
        .flatten()
        .any(|file| absolute.join(file).exists())
}

/// Whether any JS detector could match this project: a config file exists in it, or a detector's
/// fallback dependency is declared. A matched detector can add or enrich targets, which the native
/// path does not reproduce. A dependency field that is present but not an object throws in Node.
fn inference_applies(absolute: &Path, names: &[String], manifest: &Map<String, Value>) -> Option<bool> {
    let markers = markers()?;

    if config_file_exists(absolute, names, markers) {
        return Some(true);
    }

    for field in DEPENDENCY_FIELDS {
        let Some(value) = manifest.get(field) else {
            continue;
        };

        let declared = value.as_object()?;

        if markers.dependencies.iter().any(|name| declared.contains_key(name)) {
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

    /// What `inference_applies` looked for before the directory listing: one `exists` per marker.
    fn reference_config_exists(absolute: &Path) -> bool {
        let markers: Value = serde_json::from_str(MARKERS_JSON).expect("valid marker json");

        markers["configFiles"]
            .as_array()
            .expect("configFiles")
            .iter()
            .filter_map(Value::as_str)
            .any(|file| absolute.join(file).exists())
    }

    fn config_exists(absolute: &Path) -> bool {
        let names: Vec<String> = fs::read_dir(absolute)
            .expect("project directory")
            .map(|entry| entry.expect("entry").file_name().into_string().expect("utf-8"))
            .collect();

        config_file_exists(absolute, &names, markers().expect("markers"))
    }

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("vis-targets-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");

        directory
    }

    #[test]
    fn the_listing_finds_the_config_files_the_stats_found() {
        // Each case is a directory holding these entries (`/` makes a directory, `->` a link to nowhere).
        let cases: [&[&str]; 14] = [
            &[],
            &["package.json", "index.ts"],
            &["vite.config.ts"],
            &["vite.config.ts", "package.json"],
            &["VITE.CONFIG.TS"],
            &["Vite.Config.Ts", "src/index.ts"],
            &[".storybook/main.ts"],
            &[".storybook/other.ts"],
            &[".STORYBOOK/main.ts"],
            &["docs/.vitepress/config.mjs"],
            &["docs/readme.md", "prisma/not-the-schema.prisma"],
            &["prisma/schema.prisma"],
            &["vite.config.ts->nowhere"],
            &["\u{fc}n\u{ef}.ts", "tsup.config.ts"],
        ];

        for (index, entries) in cases.iter().enumerate() {
            let directory = scratch(&format!("listing-{index}"));

            for entry in *entries {
                if let Some((link, target)) = entry.split_once("->") {
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(target, directory.join(link)).expect("link");
                } else {
                    let path = directory.join(entry);

                    fs::create_dir_all(path.parent().expect("parent")).expect("parent directory");
                    fs::write(&path, "").expect("entry");
                }
            }

            assert_eq!(config_exists(&directory), reference_config_exists(&directory), "{entries:?}");
        }
    }

    #[test]
    fn a_name_that_only_a_unicode_fold_matches_is_checked_marker_by_marker() {
        let directory = scratch("fold");

        // The Kelvin sign folds to `k` on a file system that folds Unicode; the other names cannot match.
        fs::write(directory.join("vite.config.ts"), "").expect("file");
        fs::write(directory.join("\u{212a}.txt"), "").expect("file");

        assert!(config_exists(&directory));
        assert_eq!(config_exists(&directory), reference_config_exists(&directory));

        fs::remove_file(directory.join("vite.config.ts")).expect("remove");

        assert_eq!(config_exists(&directory), reference_config_exists(&directory));
    }

    #[test]
    fn a_config_file_still_sends_the_project_to_node() {
        let root = scratch("project");
        let project = root.join("packages/a");

        fs::create_dir_all(&project).expect("project");
        fs::write(project.join("package.json"), r#"{"name":"a","scripts":{"build":"true"}}"#).expect("manifest");

        assert!(project_targets(&project, "packages/a".to_owned()).is_some());

        fs::write(project.join("vitest.config.ts"), "").expect("config");

        assert!(project_targets(&project, "packages/a".to_owned()).is_none());
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
