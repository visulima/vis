//! The pnpm branch of `syncAllowBuildsToNativeConfig` (`native-config-sync.ts`) and of
//! `syncMinimumReleaseAgeToNativeConfig` (`min-release-age.ts`): the text of `pnpm-workspace.yaml` and `package.json` after
//! the run, and the actions it prints. Nothing is written here; the caller writes [`Plan::files`] once everything is known.
//!
//! The yaml is edited as text, with the regular expressions of the Node code (see [`text`]), and read through the
//! grammar of [`yaml`], so the plan is `None` (a hand-off to Node) for every file the two would read differently:
//! anything but printable ASCII with `\n` line ends, a `$` or `__proto__` in a name (`String.prototype.replace` reads `$&`
//! in its replacement), a `localeCompare` order the root collation does not give, and `package.json` content that does not
//! round-trip through [`crate::json`].

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::collation::{collate, root_collation};
use crate::json::{self, stringify, Json};
use crate::security_list::yaml;

use super::stage::File;
use super::text::{block, entry_line, render_key, replace_or_append};

/// What `vis.config` asks for.
pub(super) struct Settings {
    /// The truthy `installScripts.allow` keys, in order; their values are all `true`.
    pub(super) allow: Vec<String>,
    pub(super) minutes: Option<i64>,
    pub(super) exclude: Vec<String>,
}

#[derive(Clone, Copy)]
pub(super) struct Skips {
    pub(super) allow_builds: bool,
    pub(super) min_release_age: bool,
}

/// The outcome of the run, before anything is written.
pub(crate) struct Plan {
    pub(crate) actions: Vec<String>,
    /// The files to write, in the order to write them.
    pub(crate) files: Vec<File>,
}

/// A name the edits write into text: printable ASCII, and neither `$` nor `__proto__`.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty() && name != "__proto__" && name.bytes().all(|byte| (b' '..=b'~').contains(&byte) && byte != b'$')
}

/// The text of `path`: `Some(None)` when it does not exist, `None` when it is not plain text this module edits.
fn read_text(path: &Path) -> Option<Option<String>> {
    match fs::metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Some(None),
        Err(_) => return None,
        Ok(metadata) if !metadata.is_file() => return None,
        Ok(_) => {}
    }

    let bytes = fs::read(path).ok()?;

    bytes
        .iter()
        .all(|byte| matches!(byte, b'\n' | b'\t') || (b' '..=b'~').contains(byte))
        .then(|| String::from_utf8(bytes).ok())
        .flatten()
        .map(Some)
}

fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|a, b| collate(a, b));

    names
}

fn distinct(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = Vec::new();

    for name in names {
        if !seen.contains(&name) {
            seen.push(name);
        }
    }

    seen
}

/// `pkg.pnpm.onlyBuiltDependencies` of the parsed `package.json`; `None` when `pnpm` or the list holds something this module does not merge.
fn only_built(pkg: &[(String, Json)]) -> Option<Vec<String>> {
    match pkg.iter().find(|(name, _)| name == "pnpm").map(|(_, value)| value) {
        None => Some(Vec::new()),
        Some(Json::Object(pnpm)) => match pnpm.iter().find(|(name, _)| name == "onlyBuiltDependencies") {
            Some((_, Json::Array(items))) => items.iter().map(|item| item.as_str().map(str::to_owned)).collect(),
            _ => Some(Vec::new()),
        },
        Some(_) => None,
    }
}

/// `target[key] = value`: an existing key keeps its place, a new one comes last.
fn set(entries: &mut Vec<(String, Json)>, key: &str, value: Json) {
    match entries.iter_mut().find(|(name, _)| name == key) {
        Some((_, slot)) => *slot = value,
        None => entries.push((key.to_owned(), value)),
    }
}

/// The `package.json` step of the pnpm branch: `pnpm.onlyBuiltDependencies` merged with `approved`. `Some(None)` when
/// the file is already up to date or absent.
fn package_json(root: &Path, approved: &[String], actions: &mut Vec<String>) -> Option<Option<File>> {
    let path = root.join("package.json");

    match fs::metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Some(None),
        Err(_) => return None,
        Ok(metadata) if !metadata.is_file() => return None,
        Ok(_) => {}
    }

    let Json::Object(mut pkg) = json::parse(&fs::read_to_string(&path).ok()?)? else {
        return None;
    };

    let existing = only_built(&pkg)?;

    if !existing.iter().all(|name| is_plain_name(name)) {
        return None;
    }

    let merged = sorted(distinct(existing.iter().cloned().chain(approved.iter().cloned())));
    let added = approved.iter().filter(|name| !existing.contains(name)).count();

    if added == 0 {
        return Some(None);
    }

    let mut pnpm = match pkg.iter().find(|(name, _)| name == "pnpm") {
        Some((_, Json::Object(entries))) => entries.clone(),
        _ => Vec::new(),
    };

    set(&mut pnpm, "onlyBuiltDependencies", Json::Array(merged.iter().cloned().map(Json::Str).collect()));
    set(&mut pkg, "pnpm", Json::Object(pnpm));

    actions.push(format!("Updated package.json pnpm.onlyBuiltDependencies ({added} new, {} total)", merged.len()));

    Some(Some(File { path, contents: format!("{}\n", stringify(&Json::Object(pkg), "  ")) }))
}

/// `syncAllowBuildsToNativeConfig` for pnpm. `yaml_text` is the text of `pnpm-workspace.yaml` and is `None` when the file
/// does not exist; the function returns whether it changed it.
fn allow_builds(
    root: &Path,
    allow: &[String],
    yaml_text: &mut Option<String>,
    actions: &mut Vec<String>,
) -> Option<(bool, Option<File>)> {
    let Some(text) = yaml_text.as_deref() else {
        actions.push("pnpm-workspace.yaml not found. Cannot sync allowBuilds.".to_owned());

        return Some((false, None));
    };

    let workspace = yaml::workspace(text)?;

    if !root_collation()
        || !allow.iter().all(|name| is_plain_name(name))
        || !workspace.allow_builds.iter().all(|(name, _)| is_plain_name(name))
        || !workspace.only_built.iter().all(|name| is_plain_name(name))
    {
        return None;
    }

    let existing: BTreeMap<&str, bool> =
        workspace.allow_builds.iter().map(|(name, value)| (name.as_str(), *value)).collect();
    let added = allow.iter().filter(|name| existing.get(name.as_str()) != Some(&true)).count();
    let approved = sorted(allow.to_vec());
    let merged_list = sorted(distinct(workspace.only_built.iter().cloned().chain(approved.iter().cloned())));
    let list_added = approved.iter().filter(|name| !workspace.only_built.contains(name)).count();
    let mut changed = false;

    if added == 0 && list_added == 0 {
        actions.push(format!("All {} allowBuilds entries already present in pnpm-workspace.yaml.", allow.len()));
    } else {
        let mut merged: BTreeMap<&str, bool> = existing;

        for name in allow {
            merged.insert(name, true);
        }

        let lines: Vec<String> =
            merged.iter().map(|(name, value)| format!("  {}: {value}", render_key(name))).collect();
        let allow_block = format!("allowBuilds:\n{}\n", lines.join("\n"));
        let mut content = text.to_owned();

        if !content.ends_with('\n') {
            content.push('\n');
        }

        content = replace_or_append(&content, block(&content, "allowBuilds"), &allow_block, &allow_block);

        if !merged_list.is_empty() {
            let items: Vec<String> = merged_list.iter().map(|name| format!("  - {}", render_key(name))).collect();
            let list_block = format!("onlyBuiltDependencies:\n{}\n", items.join("\n"));

            content = replace_or_append(&content, block(&content, "onlyBuiltDependencies"), &list_block, &list_block);
        }

        actions.push(format!("Updated pnpm-workspace.yaml allowBuilds ({added} new, {} total)", merged.len()));

        if list_added > 0 {
            actions.push(format!(
                "Updated pnpm-workspace.yaml onlyBuiltDependencies ({list_added} new, {} total)",
                merged_list.len()
            ));
        }

        *yaml_text = Some(content);
        changed = true;
    }

    Some((changed, package_json(root, &approved, actions)?))
}

/// `syncMinimumReleaseAgeToNativeConfig` for pnpm. Returns whether it writes `pnpm-workspace.yaml`.
fn min_release_age(settings: &Settings, yaml_text: &mut Option<String>, actions: &mut Vec<String>) -> Option<bool> {
    let Some(minutes) = settings.minutes else {
        actions.push("minimumReleaseAge not set in vis.config; skipping native sync.".to_owned());

        return Some(false);
    };

    let Some(text) = yaml_text.as_deref() else {
        actions.push("pnpm-workspace.yaml not found. Cannot sync minimumReleaseAge.".to_owned());

        return Some(false);
    };

    if !settings.exclude.iter().all(|name| is_plain_name(name)) {
        return None;
    }

    let whole = minutes.max(0);
    let age_line = format!("minimumReleaseAge: {whole}");
    let mut content = text.to_owned();

    if !content.ends_with('\n') {
        content.push('\n');
    }

    content =
        replace_or_append(&content, entry_line(&content, "minimumReleaseAge"), &age_line, &format!("{age_line}\n"));

    if !settings.exclude.is_empty() {
        let items: Vec<String> = settings.exclude.iter().map(|name| format!("  - {}", render_key(name))).collect();
        let exclude_block = format!("minimumReleaseAgeExclude:\n{}\n", items.join("\n"));

        content =
            replace_or_append(&content, block(&content, "minimumReleaseAgeExclude"), &exclude_block, &exclude_block);
    }

    actions.push(format!("Updated pnpm-workspace.yaml minimumReleaseAge: {whole} minutes"));

    if !settings.exclude.is_empty() {
        actions
            .push(format!("Updated pnpm-workspace.yaml minimumReleaseAgeExclude ({} entries)", settings.exclude.len()));
    }

    *yaml_text = Some(content);

    Some(true)
}

/// The plan of `vis security sync` for the pnpm workspace at `root`, or `None` when Node has to answer.
pub(super) fn plan(root: &Path, settings: &Settings, skips: Skips) -> Option<Plan> {
    let mut yaml_text = read_text(&root.join("pnpm-workspace.yaml"))?;
    let mut actions = Vec::new();
    let mut files = Vec::new();
    let mut yaml_written = false;

    if !settings.allow.is_empty() && !skips.allow_builds {
        let (changed, package) = allow_builds(root, &settings.allow, &mut yaml_text, &mut actions)?;

        yaml_written |= changed;
        files.extend(package);
    }

    if !skips.min_release_age {
        yaml_written |= min_release_age(settings, &mut yaml_text, &mut actions)?;
    }

    if yaml_written {
        files.push(File { path: root.join("pnpm-workspace.yaml"), contents: yaml_text? });
    }

    Some(Plan { actions, files })
}

/// The plan of `vis init --sync-native` for the pnpm workspace at `root`: `syncAllowBuildsToNativeConfig(pnpm, root, {})`
/// then `syncMinimumReleaseAgeToNativeConfig(pnpm, root, minutes)`, or `None` when Node has to answer.
///
/// An empty allow list changes nothing in either file, and its only action says whether the workspace file exists, so this
/// is not [`plan`]: that one prints no action for an empty list and reads `package.json`, which an empty list never does.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn init_plan(root: &Path, minutes: i64) -> Option<Plan> {
    let mut yaml_text = read_text(&root.join("pnpm-workspace.yaml"))?;
    let mut actions = vec![if yaml_text.is_some() {
        "All 0 allowBuilds entries already present in pnpm-workspace.yaml.".to_owned()
    } else {
        "pnpm-workspace.yaml not found. Cannot sync allowBuilds.".to_owned()
    }];
    let settings = Settings { allow: Vec::new(), minutes: Some(minutes), exclude: Vec::new() };
    let written = min_release_age(&settings, &mut yaml_text, &mut actions)?;
    let files =
        if written { vec![File { path: root.join("pnpm-workspace.yaml"), contents: yaml_text? }] } else { Vec::new() };

    Some(Plan { actions, files })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str, yaml: Option<&str>, manifest: Option<&str>) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("vis-sync-plan-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        fs::create_dir_all(&root).unwrap();

        if let Some(yaml) = yaml {
            fs::write(root.join("pnpm-workspace.yaml"), yaml).unwrap();
        }

        if let Some(manifest) = manifest {
            fs::write(root.join("package.json"), manifest).unwrap();
        }

        root
    }

    fn settings(allow: &[&str], minutes: Option<i64>, exclude: &[&str]) -> Settings {
        Settings {
            allow: allow.iter().map(|name| (*name).to_owned()).collect(),
            minutes,
            exclude: exclude.iter().map(|name| (*name).to_owned()).collect(),
        }
    }

    const ALL: Skips = Skips { allow_builds: false, min_release_age: false };

    fn contents<'a>(plan: &'a Plan, name: &str) -> &'a str {
        &plan.files.iter().find(|file| file.path.ends_with(name)).unwrap().contents
    }

    #[test]
    fn a_fresh_workspace_gets_every_block_in_sorted_order() {
        let root = workspace("fresh", Some("packages:\n  - 'packages/*'\n"), Some("{\n  \"name\": \"root\"\n}\n"));
        let plan = plan(&root, &settings(&["sharp", "@scope/x", "esbuild"], Some(60), &["webpack"]), ALL).unwrap();

        assert_eq!(
            contents(&plan, "pnpm-workspace.yaml"),
            "packages:\n  - 'packages/*'\n\nallowBuilds:\n  '@scope/x': true\n  esbuild: true\n  sharp: true\n\nonlyBuiltDependencies:\n  - '@scope/x'\n  - esbuild\n  - sharp\n\nminimumReleaseAge: 60\n\nminimumReleaseAgeExclude:\n  - webpack\n"
        );
        assert_eq!(
            contents(&plan, "package.json"),
            "{\n  \"name\": \"root\",\n  \"pnpm\": {\n    \"onlyBuiltDependencies\": [\n      \"@scope/x\",\n      \"esbuild\",\n      \"sharp\"\n    ]\n  }\n}\n"
        );
        assert_eq!(plan.actions.len(), 5);
        assert_eq!(plan.actions[0], "Updated pnpm-workspace.yaml allowBuilds (3 new, 3 total)");
        assert_eq!(plan.files.last().unwrap().path.file_name().unwrap(), "pnpm-workspace.yaml");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_block_stops_at_a_blank_line_and_the_rest_is_kept_beside_the_merged_entries() {
        let root = workspace("blank", Some("allowBuilds:\n  old: true\n\n  more: true\n"), None);
        let plan = plan(&root, &settings(&["a"], None, &[]), ALL).unwrap();

        assert_eq!(
            contents(&plan, "pnpm-workspace.yaml"),
            "allowBuilds:\n  a: true\n  more: true\n  old: true\n\n  more: true\n\nonlyBuiltDependencies:\n  - a\n"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn what_is_already_there_is_reported_and_still_rewritten_by_the_age_step() {
        let root = workspace(
            "aligned",
            Some("allowBuilds:\n  a: true\nonlyBuiltDependencies:\n  - a\nminimumReleaseAge: 5\n"),
            Some("{\"pnpm\":{\"onlyBuiltDependencies\":[\"a\"]}}"),
        );
        let plan = plan(&root, &settings(&["a"], Some(5), &[]), ALL).unwrap();

        assert_eq!(plan.actions[0], "All 1 allowBuilds entries already present in pnpm-workspace.yaml.");
        assert_eq!(plan.files.len(), 1, "package.json is up to date");
        assert_eq!(
            contents(&plan, "pnpm-workspace.yaml"),
            "allowBuilds:\n  a: true\nonlyBuiltDependencies:\n  - a\nminimumReleaseAge: 5\n"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_workspace_file_is_reported_and_skips_package_json() {
        let root = workspace("missing", None, Some("{}\n"));
        let plan = plan(&root, &settings(&["a"], Some(1), &[]), ALL).unwrap();

        assert_eq!(
            plan.actions,
            [
                "pnpm-workspace.yaml not found. Cannot sync allowBuilds.",
                "pnpm-workspace.yaml not found. Cannot sync minimumReleaseAge."
            ]
        );
        assert!(plan.files.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skipped_steps_and_unset_minutes_read_nothing() {
        let root = workspace("skips", Some("not: [valid"), None);

        let plan =
            plan(&root, &settings(&["a"], None, &[]), Skips { allow_builds: true, min_release_age: false }).unwrap();

        assert_eq!(plan.actions, ["minimumReleaseAge not set in vis.config; skipping native sync."]);
        assert!(plan.files.is_empty());

        let nothing = Skips { allow_builds: true, min_release_age: true };

        assert!(super::plan(&root, &settings(&["a"], Some(1), &[]), nothing).unwrap().actions.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn negative_minutes_write_zero() {
        let root = workspace("negative", Some("a: 1"), None);
        let plan = plan(&root, &settings(&[], Some(-5), &[]), ALL).unwrap();

        assert_eq!(contents(&plan, "pnpm-workspace.yaml"), "a: 1\n\nminimumReleaseAge: 0\n");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn what_the_text_edits_cannot_reproduce_is_declined() {
        let declined = |name: &str, yaml: &str, manifest: Option<&str>, settings: Settings| {
            let root = workspace(name, Some(yaml), manifest);
            let result = plan(&root, &settings, ALL).is_none();
            let _ = fs::remove_dir_all(&root);

            result
        };

        assert!(declined("dollar", "a: 1\n", None, settings(&["a$&"], None, &[])));
        assert!(declined("proto", "a: 1\n", None, settings(&["__proto__"], None, &[])));
        assert!(declined("exclude", "a: 1\n", None, settings(&[], Some(1), &["x$1"])));
        assert!(declined("crlf", "a: 1\r\n", None, settings(&[], Some(1), &[])));
        assert!(declined("nested", "a:\n  b:\n    c: 1\n", None, settings(&["a"], None, &[])));
        assert!(declined("fraction", "a: 1\n", Some("{\"n\":1.5}"), settings(&["a"], None, &[])));
        assert!(declined(
            "list",
            "a: 1\n",
            Some("{\"pnpm\":{\"onlyBuiltDependencies\":[1]}}"),
            settings(&["a"], None, &[])
        ));
        assert!(declined("pnpm", "a: 1\n", Some("{\"pnpm\":\"x\"}"), settings(&["a"], None, &[])));
    }
}
