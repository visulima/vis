//! Native `vis list`: the default project listing, as a table or JSON, for a JS-only workspace.
//!
//! Mirrors the no-filter path of `packages/tooling/vis/src/commands/list/handler.ts`. Every other
//! shape (`--deps`, `--targets`, `--inferred`, `--query`, `--tag`, ndjson, bad formats, globals) is
//! delegated to Node, as is any root the gates reject.
//!
//! The root is the one `findMonorepoRootSync` picks for the working directory (see
//! [`monorepo_root`]). The inherited `VIS_MONOREPO_ROOT` is not read, so it cannot change the answer. Target names
//! come from `package.json` scripts alone. That is exact only when no inference detector applies to
//! the project (`inference-triggers.json`, checked by `__tests__/native/list-inference-triggers.test.ts`)
//! and no config changes the target set. Node prints tips and first-run notices to stderr outside CI,
//! so the native path needs the same quiet context `advisories` uses.

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::Path;

use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::graph::{project_graph, GraphResult, ProjectGraph};
use crate::js::RESERVED_NAMES;
use crate::node_context::{monorepo_root, output_settings_are_default};
use crate::output::write_stdout;
use crate::vis_config;

/// Detector trigger files and dependency names, generated from `BUILT_IN_DETECTORS`.
const TRIGGERS_JSON: &str = include_str!("inference-triggers.json");

/// Targets listed before the table cell is shortened to `a, b, c, d… (n)`.
const TABLE_TARGET_LIMIT: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Format {
    Table,
    Json,
}

/// Parses `list` arguments the way cerebro does for this command. `args[0]` is `list`.
/// Returns `None` for any shape this module does not answer.
fn parse(args: &[String]) -> Option<Format> {
    let mut json_flag = false;
    let mut format: Option<&str> = None;
    let mut tokens = args.iter().skip(1);

    while let Some(token) = tokens.next() {
        match token.as_str() {
            "--json" if !json_flag => json_flag = true,
            "--format" if format.is_none() => format = Some(tokens.next()?.as_str()),
            other => match other.strip_prefix("--format=") {
                Some(value) if format.is_none() => format = Some(value),
                _ => return None,
            },
        }
    }

    let raw = match format {
        Some(value) => value,
        None if json_flag => "json",
        None => "table",
    };

    match raw.to_lowercase().as_str() {
        "table" => Some(Format::Table),
        "json" => Some(Format::Json),
        _ => None,
    }
}

/// Script targets of one project, in file order. Duplicate, integer-like and non-string
/// entries, empty commands and reserved names are left to Node, since JS key order, last-wins
/// parsing and prototype-sensitive assignment are not reproduced here.
#[derive(Default)]
struct Scripts(Vec<(String, String)>);

impl<'de> Deserialize<'de> for Scripts {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ScriptsVisitor)
    }
}

struct ScriptsVisitor;

impl<'de> Visitor<'de> for ScriptsVisitor {
    type Value = Scripts;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a scripts map")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Scripts, A::Error> {
        let mut scripts: Vec<(String, String)> = Vec::new();

        while let Some(key) = map.next_key::<String>()? {
            let value = map.next_value::<String>()?;

            // Node's mergeTarget sets `command` only for a truthy script, so an empty value has no
            // command there and the listing omits the property, which JsonTarget cannot reproduce.
            if key.is_empty() || key.bytes().all(|byte| byte.is_ascii_digit()) || !key.is_ascii() {
                return Err(de::Error::custom("script name left to Node"));
            }

            if value.is_empty() || RESERVED_NAMES.contains(&key.as_str()) {
                return Err(de::Error::custom("script left to Node"));
            }

            if scripts.iter().any(|(name, _)| *name == key) {
                return Err(de::Error::custom("duplicate script name"));
            }

            scripts.push((key, value));
        }

        Ok(Scripts(scripts))
    }
}

/// A dependency map, read for its keys only. `null` and any non-object delegate, because Node's
/// `Object.hasOwn` throws on them.
#[derive(Default)]
struct DepNames(Vec<String>);

impl<'de> Deserialize<'de> for DepNames {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(DepNamesVisitor)
    }
}

struct DepNamesVisitor;

impl<'de> Visitor<'de> for DepNamesVisitor {
    type Value = DepNames;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a dependency map")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<DepNames, A::Error> {
        let mut names = Vec::new();

        while let Some(key) = map.next_key::<String>()? {
            map.next_value::<IgnoredAny>()?;
            names.push(key);
        }

        Ok(DepNames(names))
    }
}

/// The `package.json` fields the listing reads.
#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    scripts: Scripts,
    #[serde(default)]
    dependencies: DepNames,
    #[serde(default, rename = "devDependencies")]
    dev_dependencies: DepNames,
    #[serde(default, rename = "optionalDependencies")]
    optional_dependencies: DepNames,
    #[serde(default, rename = "peerDependencies")]
    peer_dependencies: DepNames,
}

impl Manifest {
    fn declares(&self, name: &str) -> bool {
        [&self.dependencies, &self.dev_dependencies, &self.optional_dependencies, &self.peer_dependencies]
            .iter()
            .any(|block| block.0.iter().any(|key| key == name))
    }
}

#[derive(Deserialize)]
struct Triggers {
    #[serde(rename = "configFiles")]
    config_files: Vec<String>,
    #[serde(rename = "fallbackDependencies")]
    fallback_dependencies: Vec<String>,
}

/// The config-file triggers split by how a project directory is checked: one directory listing answers
/// every top-level name and suffix pattern, and only a pattern whose first path segment is present in the
/// listing is looked at on disk.
struct Detectors<'a> {
    /// `(pattern, lowercased first segment)` of each trigger without a wildcard.
    files: Vec<(&'a str, String)>,
    /// The lowercased first segments of `files`: the only entry names a listing has to remember.
    first_segments: HashSet<Vec<u8>>,
    /// The part after the `*` of each wildcard trigger.
    suffixes: Vec<&'a [u8]>,
    dependencies: &'a [String],
}

impl<'a> Detectors<'a> {
    fn new(triggers: &'a Triggers) -> Self {
        let mut files = Vec::new();
        let mut suffixes = Vec::new();

        for pattern in &triggers.config_files {
            match pattern.strip_prefix('*') {
                Some(suffix) => suffixes.push(suffix.as_bytes()),
                None => {
                    files.push((pattern.as_str(), pattern.split('/').next().unwrap_or_default().to_ascii_lowercase()))
                }
            }
        }

        let first_segments = files.iter().map(|(_, segment)| segment.as_bytes().to_vec()).collect();

        Self { files, first_segments, suffixes, dependencies: &triggers.fallback_dependencies }
    }
}

/// Whether any inference detector would run on this project directory. Node then may enrich
/// the script targets with a `type`, so the native path hands the project to Node.
fn detector_triggered(project: &Path, manifest: &Manifest, detectors: &Detectors) -> Option<bool> {
    let mut names: HashSet<Vec<u8>> = HashSet::new();
    let mut ascii = true;

    for entry in fs::read_dir(project).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let bytes = name.as_encoded_bytes();

        if detectors.suffixes.iter().any(|suffix| bytes.ends_with(suffix)) {
            return Some(true);
        }

        ascii &= bytes.is_ascii();

        let folded = bytes.to_ascii_lowercase();

        if detectors.first_segments.contains(&folded) {
            names.insert(folded);
        }
    }

    // `exists` follows links and, on a case-insensitive volume, ignores case, so a pattern is only ruled out
    // when no entry could be it under ASCII case folding. A name outside ASCII could fold onto one on such a
    // volume (the Kelvin sign onto `k`), so that directory takes every check.
    for (pattern, first_segment) in &detectors.files {
        if (!ascii || names.contains(first_segment.as_bytes())) && project.join(pattern).exists() {
            return Some(true);
        }
    }

    Some(detectors.dependencies.iter().any(|name| manifest.declares(name)))
}

/// Reads one project's script targets, or `None` when Node must answer for it.
fn project_scripts(root: &Path, directory: &str, detectors: &Detectors) -> Option<Vec<(String, String)>> {
    if directory == "." || !directory.is_ascii() {
        return None;
    }

    let project = root.join(directory);
    let manifest: Manifest = serde_json::from_str(&fs::read_to_string(project.join("package.json")).ok()?).ok()?;

    if detector_triggered(&project, &manifest, detectors)? {
        return None;
    }

    // A project without scripts can still get synthesized targets, so Node answers it.
    if manifest.scripts.0.is_empty() {
        return None;
    }

    Some(manifest.scripts.0)
}

#[derive(Serialize)]
struct JsonProject<'a> {
    name: &'a str,
    root: &'a str,
    tags: Vec<&'a str>,
    targets: Vec<JsonTarget<'a>>,
    #[serde(rename = "type")]
    kind: &'a str,
}

#[derive(Serialize)]
struct JsonTarget<'a> {
    aliases: Vec<&'a str>,
    command: &'a str,
    name: &'a str,
}

/// One listed project: name, directory, project type and script targets in file order.
struct Listed {
    name: String,
    directory: String,
    kind: &'static str,
    targets: Vec<(String, String)>,
}

fn collect(root: &Path, graph: &ProjectGraph) -> Option<Vec<Listed>> {
    let triggers: Triggers = serde_json::from_str(TRIGGERS_JSON).ok()?;
    let detectors = Detectors::new(&triggers);
    let mut listed = Vec::new();

    for (name, project) in &graph.projects {
        if !name.is_ascii() {
            return None;
        }

        let directory = &project.directory;
        let targets = project_scripts(root, directory, &detectors)?;

        listed.push(Listed {
            directory: directory.clone(),
            kind: project.project_type.as_str(),
            name: name.clone(),
            targets,
        });
    }

    Some(listed)
}

/// Whether no inference detector applies to any project and every project has script targets, so
/// that Node adds nothing (inputs, synthesized targets) beyond the `package.json` scripts.
/// `affected` uses it to know no project declares an external input.
pub(crate) fn inference_free(root: &Path, graph: &ProjectGraph) -> bool {
    collect(root, graph).is_some()
}

/// How many distinct target names the projects of `graph` hold, when [`inference_free`] holds: the script names
/// across every project, which is what `vis status` counts.
pub(crate) fn unique_target_count(root: &Path, graph: &ProjectGraph) -> Option<usize> {
    let listed = collect(root, graph)?;
    let names: HashSet<&str> =
        listed.iter().flat_map(|project| project.targets.iter().map(|(name, _)| name.as_str())).collect();

    Some(names.len())
}

/// Column width in UTF-16 units (`String.length`), which equals the char count for the
/// BMP characters this table uses.
fn units(text: &str) -> usize {
    text.chars().count()
}

fn pad(text: &str, width: usize) -> String {
    format!("{text}{}", " ".repeat(width.saturating_sub(units(text))))
}

fn render_table(out: &mut String, header: &[&str], rows: &[Vec<String>]) {
    let widths: Vec<usize> = header
        .iter()
        .enumerate()
        .map(|(index, heading)| rows.iter().map(|row| units(&row[index])).fold(units(heading), usize::max))
        .collect();

    let line = |cells: Vec<String>| -> String {
        cells.iter().enumerate().map(|(index, cell)| pad(cell, widths[index])).collect::<Vec<_>>().join("  ")
    };

    out.push_str(&line(header.iter().map(|heading| (*heading).to_owned()).collect()));
    out.push('\n');
    out.push_str(&widths.iter().map(|width| "─".repeat(*width)).collect::<Vec<_>>().join("──"));
    out.push('\n');

    for row in rows {
        out.push_str(&line(row.clone()));
        out.push('\n');
    }
}

fn targets_cell(targets: &[(String, String)]) -> String {
    let names: Vec<&str> = targets.iter().map(|(name, _)| name.as_str()).collect();

    if names.len() > TABLE_TARGET_LIMIT {
        format!("{}… ({})", names[..TABLE_TARGET_LIMIT].join(", "), names.len())
    } else if names.is_empty() {
        "—".to_owned()
    } else {
        names.join(", ")
    }
}

fn render(listed: &[Listed], format: Format) -> String {
    let mut out = String::new();

    if listed.is_empty() {
        return "No projects found.\n".to_owned();
    }

    match format {
        Format::Json => {
            let projects: Vec<JsonProject> = listed
                .iter()
                .map(|project| JsonProject {
                    kind: project.kind,
                    name: &project.name,
                    root: &project.directory,
                    tags: Vec::new(),
                    targets: project
                        .targets
                        .iter()
                        .map(|(name, command)| JsonTarget { aliases: Vec::new(), command, name })
                        .collect(),
                })
                .collect();

            out.push_str(&serde_json::to_string_pretty(&projects).unwrap_or_default());
            out.push('\n');
        }
        Format::Table => {
            let rows: Vec<Vec<String>> = listed
                .iter()
                .map(|project| {
                    vec![
                        project.name.clone(),
                        project.kind.to_owned(),
                        "—".to_owned(),
                        "—".to_owned(),
                        targets_cell(&project.targets),
                    ]
                })
                .collect();

            render_table(&mut out, &["Project", "Type", "Layer", "Tags", "Targets"], &rows);
            out.push('\n');
            out.push_str(&format!("{} project(s)\n", listed.len()));
        }
    }

    out
}

/// Answers `vis list` natively or hands the whole invocation to Node. `args` keeps the raw
/// argv for the delegation; the `String` view is only for matching.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let answer = || -> Option<String> {
        let format = parse(args)?;

        if !output_settings_are_default() {
            return None;
        }

        let cwd = env::current_dir().ok()?;
        let root = monorepo_root(&cwd)?;

        if !crate::node_context::quiet_context(&cwd, &root) || vis_config::requires_node(&vis_config::read(&root)) {
            return None;
        }

        let GraphResult::Native(graph) = project_graph(&root) else {
            return None;
        };

        let listed = collect(&root, &graph)?;

        Some(render(&listed, format))
    };

    match answer() {
        Some(text) => {
            write_stdout("list", "the listing", &text);

            std::process::exit(0);
        }
        None => crate::process::delegate(raw_args),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn parses_only_the_plain_listing_shapes() {
        assert_eq!(parse(&argv(&["list"])), Some(Format::Table));
        assert_eq!(parse(&argv(&["list", "--json"])), Some(Format::Json));
        assert_eq!(parse(&argv(&["list", "--format=JSON"])), Some(Format::Json));
        assert_eq!(parse(&argv(&["list", "--format", "table"])), Some(Format::Table));
        assert_eq!(parse(&argv(&["list", "--json", "--format=table"])), Some(Format::Table));
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["list", "--format=ndjson"][..],
            &["list", "--format=yaml"],
            &["list", "--format"],
            &["list", "--deps"],
            &["list", "--targets"],
            &["list", "--tag", "x"],
            &["list", "--help"],
            &["list", "--cwd", "."],
            &["list", "extra"],
            &["list", "--json", "--json"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    #[test]
    fn targets_cell_shortens_after_four_names() {
        let names = |list: &[&str]| -> Vec<(String, String)> {
            list.iter().map(|name| ((*name).to_owned(), String::new())).collect()
        };

        assert_eq!(targets_cell(&names(&[])), "—");
        assert_eq!(targets_cell(&names(&["a", "b"])), "a, b");
        assert_eq!(targets_cell(&names(&["a", "b", "c", "d", "e"])), "a, b, c, d… (5)");
    }

    #[test]
    fn scripts_with_empty_or_reserved_entries_are_left_to_node() {
        let parses = |json: &str| serde_json::from_str::<Scripts>(json).is_ok();

        assert!(parses(r#"{"build":"tsc","lint":"eslint ."}"#));
        assert!(!parses(r#"{"build":"tsc","lint":""}"#));

        for name in RESERVED_NAMES {
            assert!(!parses(&format!(r#"{{"{name}":"echo"}}"#)), "{name}");
        }
    }

    /// A project directory holding the given files (a `/` makes the parent directory), with no manifest fields.
    fn detector_project(label: &str, files: &[&str]) -> std::path::PathBuf {
        let project = env::temp_dir().join(format!("vis-list-detector-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&project);

        fs::create_dir_all(&project).unwrap();

        for file in files {
            let path = project.join(file);

            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "").unwrap();
        }

        project
    }

    fn triggered(label: &str, files: &[&str], manifest: &str) -> bool {
        let triggers: Triggers = serde_json::from_str(TRIGGERS_JSON).unwrap();
        let project = detector_project(label, files);
        let parsed: Manifest = serde_json::from_str(manifest).unwrap();
        let answer = detector_triggered(&project, &parsed, &Detectors::new(&triggers));

        let _ = fs::remove_dir_all(&project);

        answer.unwrap()
    }

    #[test]
    fn detectors_find_top_level_nested_and_suffix_triggers() {
        assert!(!triggered("none", &["package.json", "src/index.ts"], "{}"));
        assert!(triggered("top", &["package.json", "tsup.config.ts"], "{}"));
        assert!(triggered("nested", &["package.json", ".storybook/main.ts"], "{}"));
        assert!(triggered("deep", &["package.json", "docs/.vitepress/config.ts"], "{}"));
        assert!(triggered("suffix", &["package.json", "Thing.csproj"], "{}"));
        assert!(triggered("dependency", &["package.json"], r#"{"devDependencies":{"vitest":"1"}}"#));
    }

    #[test]
    fn detectors_ignore_a_directory_that_only_shares_a_first_segment() {
        assert!(!triggered("segment", &["package.json", ".storybook/other.ts", "docs/readme.md"], "{}"));
    }

    #[test]
    fn detectors_follow_the_volume_on_name_case() {
        let probe = env::temp_dir().join(format!("vis-list-case-{}", std::process::id()));
        let _ = fs::remove_file(&probe);

        fs::write(&probe, "").unwrap();

        let insensitive = env::temp_dir().join(format!("VIS-LIST-CASE-{}", std::process::id())).exists();

        let _ = fs::remove_file(&probe);

        // `exists` is the oracle: a differently cased trigger counts exactly where the volume treats it as the file.
        assert_eq!(triggered("case", &["package.json", "TSUP.config.ts"], "{}"), insensitive);
    }

    #[test]
    fn table_pads_every_cell_including_the_last() {
        let mut out = String::new();

        render_table(&mut out, &["Project", "Type"], &[vec!["a".to_owned(), "library".to_owned()]]);

        let rule = "─".repeat(16);

        assert_eq!(out, format!("Project  Type   \n{rule}\na        library\n"));
    }
}
