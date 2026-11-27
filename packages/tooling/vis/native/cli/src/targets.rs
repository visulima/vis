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

use crate::js::PROTOTYPE_NAMES;
use crate::workspace::{self, Membership};

/// The config-file names and dependency names of the JS inference detectors, read from the same
/// registry the Node side uses. `packages/tooling/vis/__tests__/native/` checks it for drift. The non-JS detectors
/// are `workspace::NON_JS_MARKERS` and `workspace::NON_JS_SUFFIXES`.
const MARKERS_JSON: &str = include_str!("inference-markers.json");

/// Dependency fields `hasDependency` consults.
const DEPENDENCY_FIELDS: [&str; 4] = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

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

    let names = directory_names(absolute)?;

    if inference_applies(absolute, &names, &|name| declares_dependency(manifest, name))? {
        return None;
    }

    // A dependency field that is present but not an object throws in Node.
    for field in DEPENDENCY_FIELDS {
        if manifest.get(field).is_some_and(|value| !value.is_object()) {
            return None;
        }
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
            // The non-JS manifests are exact names too, and `exists` matches them up to case on a case-insensitive
            // volume, as the JS detectors' files are.
            let mut config_files = strings("configFiles")?;

            config_files.extend(workspace::NON_JS_MARKERS.iter().map(|name| (*name).to_owned()));
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

/// The entry names of a project directory, or `None` when it cannot be listed or a name is not UTF-8, which is a
/// project Node answers.
pub(crate) fn directory_names(absolute: &Path) -> Option<Vec<String>> {
    let mut names = Vec::new();

    for entry in fs::read_dir(absolute).ok()? {
        names.push(entry.ok()?.file_name().into_string().ok()?);
    }

    Some(names)
}

/// Whether any inference detector could match this project, given the names of its directory entries and whether
/// a dependency is declared: a non-JS manifest (by exact entry name, or as a file `exists` finds up to case), a JS
/// detector's config file, or a detector's fallback dependency. A matched detector can add or enrich targets, which
/// the native path does not reproduce. `None` when the marker registry cannot be read.
///
/// This is the only check `list`, `affected`, `status` and `script_targets` share, so a project one of them hands to
/// Node, all of them do.
pub(crate) fn inference_applies(absolute: &Path, names: &[String], declares: &dyn Fn(&str) -> bool) -> Option<bool> {
    let markers = markers()?;

    Some(
        workspace::names_hold_non_js_marker(names)
            || config_file_exists(absolute, names, markers)
            || markers.dependencies.iter().any(|name| declares(name)),
    )
}

/// Whether a manifest declares a dependency under any of the fields `hasDependency` consults.
fn declares_dependency(manifest: &Map<String, Value>, name: &str) -> bool {
    DEPENDENCY_FIELDS.iter().any(|field| {
        manifest.get(*field).and_then(Value::as_object).is_some_and(|declared| declared.contains_key(name))
    })
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
            .chain(workspace::NON_JS_MARKERS.iter().copied())
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
                    #[cfg(not(unix))]
                    let _ = (link, target);
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

    /// Whether `inference_applies` sends a project holding these entries (`->` a link to nowhere) to Node, with no
    /// dependency declared.
    fn applies(name: &str, entries: &[&str]) -> bool {
        let directory = scratch(name);

        for entry in entries {
            if let Some((link, target)) = entry.split_once("->") {
                #[cfg(unix)]
                std::os::unix::fs::symlink(target, directory.join(link)).expect("link");
                #[cfg(not(unix))]
                let _ = (link, target);
            } else {
                fs::write(directory.join(entry), "").expect("entry");
            }
        }

        inference_applies(&directory, &directory_names(&directory).expect("listing"), &|_| false).expect("registry")
    }

    #[test]
    fn the_one_registry_is_the_union_of_what_list_and_script_targets_checked() {
        // Seen by `list` (its trigger file `inference-triggers.json`) and by `script_targets` alike.
        for (index, entry) in
            ["vite.config.ts", "Cargo.toml", "pyproject.toml", "go.mod", "x.csproj", "x.fsproj", "x.gemspec"]
                .into_iter()
                .enumerate()
        {
            assert!(applies(&format!("both-{index}"), &[entry]), "{entry}");
        }

        // Only the non-JS list of `workspace.rs` knew these five, so `list` answered a project that holds one.
        for (index, entry) in
            ["project.json", "go.work", "settings.gradle", "settings.gradle.kts", "build.zig"].into_iter().enumerate()
        {
            assert!(applies(&format!("workspace-only-{index}"), &[entry]), "{entry}");
        }

        // `script_targets` matched a non-JS name by its listing alone, so a link to nowhere counted. `list` asked `exists`.
        #[cfg(unix)]
        {
            assert!(applies("dangling-non-js", &["go.mod->nowhere"]));
            assert!(applies("dangling-non-js-file", &["Cargo.toml->nowhere"]));
        }

        // `list` asked `exists` for a non-JS manifest too, which finds `CARGO.TOML` where the volume ignores case.
        let directory = scratch("case-fold");

        fs::write(directory.join("CARGO.TOML"), "").expect("entry");

        assert_eq!(
            inference_applies(&directory, &directory_names(&directory).expect("listing"), &|_| false),
            Some(directory.join("Cargo.toml").exists())
        );

        assert!(!applies("none", &["package.json", "index.ts", "README.md"]));
    }

    #[test]
    fn a_declared_fallback_dependency_applies() {
        let directory = scratch("dependency");

        assert_eq!(inference_applies(&directory, &[], &|name| name == "vitest"), Some(true));
        assert_eq!(inference_applies(&directory, &[], &|name| name == "left-pad"), Some(false));
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
