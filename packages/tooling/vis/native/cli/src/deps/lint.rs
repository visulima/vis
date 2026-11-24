//! The thirteen lints of `src/deps/*.ts`, for a workspace with no `policy` (no `vis.config` is read natively) and
//! without `--fix`, `--ban`, `--pin`, `--dep` or `--resolve`.
//!
//! `workspace-versions` and `custom-types` only report drift, and which specifier they call canonical needs a semver
//! order that this module does not reproduce, so a drift sends the command to Node. A workspace with no drift has
//! no issue in either, which is all the printers need. `banned-deps` has nothing to ban without a
//! policy.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use super::data::{DepType, Instance, Package, Workspace};
use super::Selection;
use crate::json::Json;
use crate::workspace::{child_directories, directories_for_patterns};

pub(super) struct WorkspaceProtocol {
    pub(super) dep_name: String,
    pub(super) dep_type: DepType,
    pub(super) package: usize,
    pub(super) specifier: String,
}

pub(super) struct RedefineRoot {
    pub(super) child_specifier: String,
    pub(super) dep_name: String,
    pub(super) dep_type: DepType,
    pub(super) package: usize,
    pub(super) root_dep_type: DepType,
    pub(super) root_specifier: String,
}

pub(super) struct TypesInDeps {
    pub(super) child_specifier: String,
    pub(super) dep_name: String,
    pub(super) package: usize,
}

pub(super) struct SimilarMember {
    pub(super) dep_name: String,
    pub(super) dep_type: DepType,
    pub(super) package: usize,
    pub(super) specifier: String,
}

pub(super) struct SimilarDeps {
    pub(super) family: &'static str,
    pub(super) label: &'static str,
    pub(super) members: Vec<SimilarMember>,
    pub(super) specifiers: Vec<String>,
}

pub(super) struct DeadPattern {
    pub(super) pattern: String,
}

/// Every lint's issues. Which of them print is the selection's business.
#[derive(Default)]
pub(super) struct Report {
    pub(super) dead_patterns: Vec<DeadPattern>,
    /// `(package, block)` of each empty dependency block.
    pub(super) empty_deps: Vec<(usize, DepType)>,
    pub(super) missing_package_json: Vec<String>,
    pub(super) redefine_root: Vec<RedefineRoot>,
    /// The runtime dependency names of the private root, when it has any.
    pub(super) root_deps: Option<Vec<String>>,
    /// Whether the root lacks `packageManager`.
    pub(super) root_package_manager: bool,
    /// The root's `private` value (`None` inside when it is absent), when it is not `true`.
    pub(super) root_private: Option<Option<Json>>,
    pub(super) similar_deps: Vec<SimilarDeps>,
    pub(super) types_in_deps: Vec<TypesInDeps>,
    pub(super) workspace_protocol: Vec<WorkspaceProtocol>,
}

const DEFAULT_REDEFINE_TYPES: [DepType; 4] =
    [DepType::Dependencies, DepType::DevDependencies, DepType::OptionalDependencies, DepType::PeerDependencies];

const VERSION_TYPES: [DepType; 3] = [DepType::Dependencies, DepType::DevDependencies, DepType::PeerDependencies];

/// `BUILTIN_SIMILAR_FAMILIES`: id, label, member names, prefixes.
type Family = (&'static str, &'static str, &'static [&'static str], &'static [&'static str]);

const SIMILAR_FAMILIES: [Family; 13] = [
    ("react", "React", &["react", "react-dom", "react-test-renderer"], &[]),
    (
        "next",
        "Next.js",
        &[
            "next",
            "@next/font",
            "@next/bundle-analyzer",
            "@next/mdx",
            "@next/third-parties",
            "@next/eslint-plugin-next",
            "eslint-config-next",
        ],
        &[],
    ),
    ("babel", "Babel", &[], &["@babel/"]),
    ("storybook", "Storybook", &["storybook", "sb"], &["@storybook/"]),
    ("vitest", "Vitest", &["vitest"], &["@vitest/"]),
    ("playwright", "Playwright", &["playwright", "@playwright/test"], &[]),
    ("trpc", "tRPC", &[], &["@trpc/"]),
    ("prisma", "Prisma", &["prisma"], &["@prisma/"]),
    (
        "turborepo",
        "Turborepo",
        &["turbo", "turbo-ignore", "@turbo/gen", "eslint-config-turbo", "eslint-plugin-turbo"],
        &[],
    ),
    ("typescript-eslint", "typescript-eslint", &["typescript-eslint"], &["@typescript-eslint/"]),
    ("eslint-stylistic", "ESLint Stylistic", &[], &["@stylistic/"]),
    ("lexical", "Lexical", &["lexical"], &["@lexical/"]),
    ("nx", "Nx", &[], &["@nx/", "@nrwl/"]),
];

/// Runs the selected lints; the others stay empty, as in the handler. `None` sends the command to Node.
pub(super) fn run(workspace: &Workspace, selection: &Selection) -> Option<Report> {
    if (selection.workspace_versions && has_version_drift(&workspace.instances))
        || (selection.custom_types && has_custom_type_drift(&workspace.packages)?)
    {
        return None;
    }

    let packages = &workspace.packages;
    let instances = &workspace.instances;
    let mut report = Report::default();

    if selection.workspace_protocol {
        report.workspace_protocol = workspace_protocol(instances);
    }

    if selection.redefine_root {
        report.redefine_root = redefine_root(instances);
    }

    if selection.empty_deps {
        report.empty_deps = empty_deps(packages);
    }

    if selection.root_private {
        report.root_private = root_private(packages);
    }

    if selection.root_package_manager {
        report.root_package_manager = root_package_manager(packages)?;
    }

    if selection.root_deps {
        report.root_deps = root_deps(packages);
    }

    if selection.missing_package_json {
        report.missing_package_json = missing_package_json(workspace)?;
    }

    if selection.dead_workspace_patterns {
        report.dead_patterns = dead_patterns(workspace)?;
    }

    if selection.types_in_deps {
        report.types_in_deps = types_in_deps(workspace);
    }

    if selection.similar_deps {
        report.similar_deps = similar_deps(instances);
    }

    Some(report)
}

fn workspace_protocol(instances: &[Instance]) -> Vec<WorkspaceProtocol> {
    instances
        .iter()
        .filter(|instance| instance.is_internal && !instance.specifier.starts_with("workspace:"))
        .map(|instance| WorkspaceProtocol {
            dep_name: instance.dep_name.clone(),
            dep_type: instance.dep_type,
            package: instance.package,
            specifier: instance.specifier.clone(),
        })
        .collect()
}

fn redefine_root(instances: &[Instance]) -> Vec<RedefineRoot> {
    let in_scope = |instance: &Instance| DEFAULT_REDEFINE_TYPES.contains(&instance.dep_type);
    let mut roots: HashMap<&str, (DepType, &str)> = HashMap::new();

    // The root is package 0; a later declaration of a name replaces an earlier one.
    for instance in instances.iter().filter(|instance| instance.package == 0 && in_scope(instance)) {
        roots.insert(&instance.dep_name, (instance.dep_type, &instance.specifier));
    }

    instances
        .iter()
        .filter(|instance| instance.package != 0 && in_scope(instance))
        .filter_map(|instance| {
            let (root_dep_type, root_specifier) = roots.get(instance.dep_name.as_str())?;

            Some(RedefineRoot {
                child_specifier: instance.specifier.clone(),
                dep_name: instance.dep_name.clone(),
                dep_type: instance.dep_type,
                package: instance.package,
                root_dep_type: *root_dep_type,
                root_specifier: (*root_specifier).to_owned(),
            })
        })
        .collect()
}

/// `lintWorkspaceVersions` with the default `highest` strategy: an external dependency that two packages declare with
/// two different specifiers is a drift.
fn has_version_drift(instances: &[Instance]) -> bool {
    let mut seen: HashMap<&str, &str> = HashMap::new();

    for instance in instances {
        let eligible = !instance.is_internal
            && VERSION_TYPES.contains(&instance.dep_type)
            && !instance.specifier.starts_with("workspace:")
            && !instance.specifier.starts_with("catalog:");

        if eligible && *seen.entry(&instance.dep_name).or_insert(&instance.specifier) != instance.specifier {
            return true;
        }
    }

    false
}

/// The `name` and version of a `name@version[+hash]` value, as `parsePackageManager` reads it: the regular
/// expression `^([@\w./-]+?)@([^+]+)(\+.+)?$` on the trimmed text. `None` when it does not match.
fn parse_package_manager(raw: &str) -> Option<(&str, &str)> {
    let text = raw.trim_matches(|character| character == ' ' || character == '\t');
    let is_name = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'_' | b'.' | b'/' | b'-');

    for (index, byte) in text.bytes().enumerate() {
        if !is_name(byte) {
            return None;
        }

        if byte != b'@' || index == 0 {
            continue;
        }

        let rest = &text[index + 1..];
        let (version, hash) = rest.split_once('+').map_or((rest, None), |(version, hash)| (version, Some(hash)));

        if !version.is_empty() && hash.is_none_or(|hash| !hash.is_empty() && !hash.contains(['\n', '\r'])) {
            return Some((&text[..index], version));
        }
    }

    None
}

/// Whether every character of `text` is one the readers of this module treat like JavaScript does.
fn is_plain(text: &str) -> bool {
    text.bytes().all(|byte| matches!(byte, b' ' | 0x21..=0x7e))
}

/// `iterateCustomTypeDeps` and `lintCustomTypes`: a pin (`engines.node`, `packageManager`, `volta.node`) that two
/// packages declare with two different values is a drift. `None` when a value is outside the plain text this module
/// reads, or the package has a `devEngines` field, whose entries it does not read.
fn has_custom_type_drift(packages: &[Package]) -> Option<bool> {
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut drifts =
        |key: String, specifier: &str| -> bool { seen.entry(key).or_insert_with(|| specifier.to_owned()) != specifier };

    for package in packages {
        if package.json.get("devEngines").is_some() {
            return None;
        }

        for field in ["engines", "volta"] {
            let Some(Json::Object(fields)) = package.json.get(field) else { continue };

            for (name, value) in fields {
                let Some(specifier) = value.as_str() else { continue };

                if !is_plain(name) || !is_plain(specifier) {
                    return None;
                }

                if (field != "volta" || name != "extends") && drifts(format!("{field} {name}"), specifier) {
                    return Some(true);
                }
            }
        }

        if let Some(Json::Str(value)) = package.json.get("packageManager") {
            if !is_plain(value) {
                return None;
            }

            if let Some((name, version)) = parse_package_manager(value) {
                if drifts(format!("packageManager {name}"), version) {
                    return Some(true);
                }
            }
        }
    }

    Some(false)
}

fn empty_deps(packages: &[Package]) -> Vec<(usize, DepType)> {
    let mut found = Vec::new();

    for (index, package) in packages.iter().enumerate() {
        for dep_type in
            [DepType::Dependencies, DepType::DevDependencies, DepType::PeerDependencies, DepType::OptionalDependencies]
        {
            if matches!(package.json.get(dep_type.name()), Some(Json::Object(fields)) if fields.is_empty()) {
                found.push((index, dep_type));
            }
        }
    }

    found
}

/// `lintRootPrivate`: `None` when the root is `"private": true`, else its value (`None` inside when absent).
fn root_private(packages: &[Package]) -> Option<Option<Json>> {
    match packages[0].json.get("private") {
        Some(Json::Bool(true)) => None,
        value => Some(value.cloned()),
    }
}

/// `lintRootPackageManager`: whether the root's `packageManager` is not a string of the form `name@version`
/// (`/^[a-z][\w-]*@\S+$/i`). `None` when the value is not ASCII, where `\S` would mean something else.
fn root_package_manager(packages: &[Package]) -> Option<bool> {
    let Some(Json::Str(text)) = packages[0].json.get("packageManager") else { return Some(true) };

    if !text.is_ascii() {
        return None;
    }

    let name_end = text
        .bytes()
        .position(|byte| !(byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
        .unwrap_or(text.len());
    let version = text[name_end..].strip_prefix('@');
    let is_valid = text.starts_with(|character: char| character.is_ascii_alphabetic())
        && version.is_some_and(|version| {
            !version.is_empty() && !version.bytes().any(|byte| byte.is_ascii_whitespace() || byte == 0x0b)
        });

    Some(!is_valid)
}

fn root_deps(packages: &[Package]) -> Option<Vec<String>> {
    let root = &packages[0];

    if !root.is_private() {
        return None;
    }

    match root.json.get("dependencies") {
        Some(Json::Object(fields)) if !fields.is_empty() => Some(fields.iter().map(|(name, _)| name.clone()).collect()),
        _ => None,
    }
}

fn types_in_deps(workspace: &Workspace) -> Vec<TypesInDeps> {
    workspace
        .instances
        .iter()
        .filter(|instance| {
            instance.dep_type == DepType::Dependencies
                && instance.dep_name.starts_with("@types/")
                && workspace.packages[instance.package].is_private()
        })
        .map(|instance| TypesInDeps {
            child_specifier: instance.specifier.clone(),
            dep_name: instance.dep_name.clone(),
            package: instance.package,
        })
        .collect()
}

fn similar_deps(instances: &[Instance]) -> Vec<SimilarDeps> {
    let mut buckets: Vec<(&Family, Vec<SimilarMember>)> = Vec::new();

    for instance in instances {
        let eligible = !instance.is_internal
            && VERSION_TYPES.contains(&instance.dep_type)
            && !instance.specifier.starts_with("workspace:")
            && !instance.specifier.starts_with("catalog:");

        if !eligible {
            continue;
        }

        let Some(family) = SIMILAR_FAMILIES.iter().find(|(_, _, members, prefixes)| {
            members.contains(&instance.dep_name.as_str())
                || prefixes.iter().any(|prefix| instance.dep_name.starts_with(prefix))
        }) else {
            continue;
        };

        let member = SimilarMember {
            dep_name: instance.dep_name.clone(),
            dep_type: instance.dep_type,
            package: instance.package,
            specifier: instance.specifier.clone(),
        };

        match buckets.iter_mut().find(|bucket| bucket.0 .0 == family.0) {
            Some(bucket) => bucket.1.push(member),
            None => buckets.push((family, vec![member])),
        }
    }

    buckets
        .into_iter()
        .filter_map(|((family, label, _, _), members)| {
            let mut specifiers: Vec<String> = Vec::new();

            for member in &members {
                if !specifiers.contains(&member.specifier) {
                    specifiers.push(member.specifier.clone());
                }
            }

            (specifiers.len() >= 2).then_some(SimilarDeps { family, label, members, specifiers })
        })
        .collect()
}

/// `lintDeadWorkspacePatterns` for the workspace YAML: the patterns that name no package directory.
fn dead_patterns(workspace: &Workspace) -> Option<Vec<DeadPattern>> {
    let mut found = Vec::new();

    for pattern in &workspace.patterns {
        if directories_for_patterns(&workspace.root, std::slice::from_ref(pattern))?.is_empty() {
            found.push(DeadPattern { pattern: pattern.clone() });
        }
    }

    Some(found)
}

/// `lintMissingPackageJson`: the directories the patterns name that hold no project. Only the `dir/*` and exact
/// shapes are read; any other pattern, and any directory with a `Cargo.toml`, goes to Node.
fn missing_package_json(workspace: &Workspace) -> Option<Vec<String>> {
    let root = workspace.root.as_path();
    let mut seen: Vec<String> = Vec::new();
    let mut missing = Vec::new();

    for pattern in &workspace.patterns {
        let clean = pattern.trim_end_matches('/');
        let matches: Vec<String> = match clean.strip_suffix("/*") {
            Some(base) if !base.contains('*') && !base.is_empty() => {
                if !root.join(base).exists() {
                    continue;
                }

                child_directories(&root.join(base))?
                    .into_iter()
                    .filter(|name| !name.starts_with('.'))
                    .map(|name| format!("{base}/{name}"))
                    .collect()
            }
            _ if !clean.contains('*') && !clean.starts_with('!') && !clean.is_empty() => {
                if root.join(clean).exists() {
                    vec![clean.to_owned()]
                } else {
                    Vec::new()
                }
            }
            _ => return None,
        };

        for directory in matches {
            if directory == "." || seen.contains(&directory) {
                continue;
            }

            seen.push(directory.clone());

            if !is_project_directory(&root.join(&directory))? {
                missing.push(directory);
            }
        }
    }

    Some(missing)
}

/// `isProjectDirectory`: a `package.json` or `project.json`. A `Cargo.toml` decides by its `[package]` table, which
/// this module does not read.
fn is_project_directory(directory: &Path) -> Option<bool> {
    if directory.join("package.json").exists() || directory.join("project.json").exists() {
        return Some(true);
    }

    if directory.join("Cargo.toml").exists() {
        return None;
    }

    // An entry that is neither readable nor a directory cannot be told apart from a project by this check.
    fs::symlink_metadata(directory).ok().map(|_| false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_manager_value_splits_at_the_first_workable_at_sign() {
        assert_eq!(parse_package_manager("pnpm@10.0.0"), Some(("pnpm", "10.0.0")));
        assert_eq!(parse_package_manager("pnpm@10.0.0+sha512.abc"), Some(("pnpm", "10.0.0")));
        assert_eq!(parse_package_manager("@scope/pm@1"), Some(("@scope/pm", "1")));
        assert_eq!(parse_package_manager("a@@1"), Some(("a", "@1")));
        assert_eq!(parse_package_manager("  pnpm@1 "), Some(("pnpm", "1")));
    }

    #[test]
    fn other_package_manager_values_do_not_match() {
        for value in ["pnpm", "@", "@1", "pnpm@", "pnpm@+x", "pnpm@1+", "pn pm@1", ""] {
            assert_eq!(parse_package_manager(value), None, "{value:?}");
        }
    }
}
