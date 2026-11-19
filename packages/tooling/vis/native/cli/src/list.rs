//! Native `vis list`: the default project listing, as a table or JSON, for a JS-only workspace.
//!
//! Mirrors the no-filter path of `packages/tooling/vis/src/commands/list/handler.ts`. Every other
//! shape (`--deps`, `--targets`, `--inferred`, `--query`, `--tag`, ndjson, bad formats, globals) is
//! delegated to Node, as is any root the gates reject.
//!
//! The root is the one `findMonorepoRootSync` picks for the working directory (see
//! [`monorepo_root`]), since `cli-main` overwrites `VIS_MONOREPO_ROOT` with that result. Target names
//! come from `package.json` scripts alone. That is exact only when no inference detector applies to
//! the project (`inference-triggers.json`, checked by `__tests__/native/list-inference-triggers.test.ts`)
//! and no config changes the target set. Node prints tips and first-run notices to stderr outside CI,
//! so the native path needs the same quiet context `advisories` uses.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::graph::{project_graph, GraphResult, ProjectGraph};
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
/// entries are left to Node, since JS key order and last-wins parsing are not reproduced here.
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

            if key.is_empty() || key.bytes().all(|byte| byte.is_ascii_digit()) || !key.is_ascii() {
                return Err(de::Error::custom("script name left to Node"));
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

/// Whether any inference detector would run on this project directory. Node then may enrich
/// the script targets with a `type`, so the native path hands the project to Node.
fn detector_triggered(project: &Path, manifest: &Manifest, triggers: &Triggers) -> Option<bool> {
    for pattern in &triggers.config_files {
        match pattern.strip_prefix('*') {
            Some(suffix) => {
                for entry in fs::read_dir(project).ok()? {
                    let entry = entry.ok()?;

                    if entry.file_name().as_encoded_bytes().ends_with(suffix.as_bytes()) {
                        return Some(true);
                    }
                }
            }
            None => {
                if project.join(pattern).exists() {
                    return Some(true);
                }
            }
        }
    }

    Some(triggers.fallback_dependencies.iter().any(|name| manifest.declares(name)))
}

/// Reads one project's script targets, or `None` when Node must answer for it.
fn project_scripts(root: &Path, directory: &str, triggers: &Triggers) -> Option<Vec<(String, String)>> {
    if directory == "." || !directory.is_ascii() {
        return None;
    }

    let project = root.join(directory);
    let manifest: Manifest = serde_json::from_str(&fs::read_to_string(project.join("package.json")).ok()?).ok()?;

    if detector_triggered(&project, &manifest, triggers)? {
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
    let mut listed = Vec::new();

    for (name, node) in &graph.nodes {
        if !name.is_ascii() {
            return None;
        }

        let directory = graph.directories.get(name)?;
        let targets = project_scripts(root, directory, &triggers)?;

        listed.push(Listed {
            directory: directory.clone(),
            kind: node.project_type.as_str(),
            name: name.clone(),
            targets,
        });
    }

    Some(listed)
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

/// The workspace root Node picks for `cwd`: `findMonorepoRootSync` in `@visulima/package`, which
/// takes the nearest lockfile (or `packageManager` manifest) and, for pnpm, the directory holding
/// `pnpm-workspace.yaml`. Anything else, including a lerna or turbo marker, another lockfile or a
/// `packageManager` field, delegates, because the outcome then depends on details this path skips.
fn monorepo_root(cwd: &Path) -> Option<PathBuf> {
    if cwd.ancestors().any(|dir| dir.join("lerna.json").exists() || dir.join("turbo.json").exists()) {
        return None;
    }

    for dir in cwd.ancestors() {
        if dir.join("pnpm-lock.yaml").is_file() {
            return dir.join("pnpm-workspace.yaml").is_file().then(|| dir.to_path_buf());
        }

        if OTHER_LOCKFILES.iter().any(|name| dir.join(name).exists()) {
            return None;
        }

        let manifest = dir.join("package.json");

        if manifest.exists() {
            let parsed: serde_json::Value = serde_json::from_str(&fs::read_to_string(&manifest).ok()?).ok()?;

            if parsed.get("packageManager").is_some() {
                return None;
            }
        }
    }

    None
}

/// Lockfiles that `findMonorepoRootSync` reads as a package manager other than pnpm.
const OTHER_LOCKFILES: [&str; 5] = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"];

/// Answers `vis list` natively or hands the whole invocation to Node. `args` keeps the raw
/// argv for the delegation; the `String` view is only for matching.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let answer = || -> Option<String> {
        let format = parse(args)?;
        let cwd = env::current_dir().ok()?;
        let root = monorepo_root(&cwd)?;

        if !crate::advisories::quiet_context(&cwd, &root) || vis_config::requires_node(&vis_config::read(&root)) {
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
            use std::io::Write;

            if std::io::stdout().write_all(text.as_bytes()).and_then(|()| std::io::stdout().flush()).is_err() {
                std::process::exit(1);
            }

            std::process::exit(0);
        }
        None => crate::delegate(raw_args),
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
    fn table_pads_every_cell_including_the_last() {
        let mut out = String::new();

        render_table(&mut out, &["Project", "Type"], &[vec!["a".to_owned(), "library".to_owned()]]);

        let rule = "─".repeat(16);

        assert_eq!(out, format!("Project  Type   \n{rule}\na        library\n"));
    }
}
