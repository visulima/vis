//! Workspace project membership for a JS-only repo, read natively.
//!
//! Mirrors the directory list that `resolveWorkspacePatterns` (with `isProjectCandidate`) and
//! the `package.json` filter produce in `packages/tooling/vis/src/config/workspace.ts`, for the
//! pattern shapes below. Anything else returns `Membership::Delegate`, and the Node CLI answers it.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, Prefix};

use rayon::prelude::*;

use crate::package_json::PackageJson;
use crate::sort_package_json::gitignore::Rules;
use crate::sort_package_json::segment_matches;
use crate::vis_config::has_vis_config;

/// Outcome of resolving a root's project directories.
#[derive(Debug, PartialEq)]
pub enum Membership {
    /// Project directories relative to the root, in discovery order.
    Native(Vec<String>),
    /// The Node CLI must answer for this root.
    Delegate,
}

/// Files that make a directory a project candidate (`isProjectCandidate`).
const CANDIDATE_MARKERS: [&str; 5] = ["package.json", "project.json", "Cargo.toml", "pyproject.toml", "pom.xml"];

/// Root-level manifests of the non-JS ecosystems. Their resolvers claim directories the JS
/// path would not, so any of them delegates. `*.gemspec`, `*.csproj` and `*.fsproj` are checked
/// by suffix.
pub(crate) const NON_JS_MARKERS: &[&str] = &[
    "project.json",
    "Cargo.toml",
    "pyproject.toml",
    "pom.xml",
    "go.mod",
    "go.work",
    "settings.gradle",
    "settings.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
    "mix.exs",
    "Package.swift",
    "pubspec.yaml",
    "composer.json",
    "build.zig",
    "build.zig.zon",
];
const NON_JS_SUFFIXES: &[&str] = &[".gemspec", ".csproj", ".fsproj"];

/// Per-package overlays. A project with one delegates, since the overlay can change its target set.
const OVERLAY_NAMES: [&str; 7] =
    ["vis.task.ts", "vis.task.mts", "vis.task.cts", "vis.task.js", "vis.task.mjs", "vis.task.cjs", "vis.task.json"];

/// Workspace-config YAML names in precedence order (`WORKSPACE_YAML_NAMES`).
pub(crate) const WORKSPACE_YAML_NAMES: [&str; 2] = [AUBE_WORKSPACE_YAML, "pnpm-workspace.yaml"];

/// aube's workspace file, which wins over pnpm's and which this crate does not read.
pub(crate) const AUBE_WORKSPACE_YAML: &str = "aube-workspace.yaml";

/// Resolves the project directories of the workspace rooted at `root`, or delegates.
///
/// `root` must be an absolute path with no `.` or `..` components. The result is
/// `Native` only when every gate passes: no config or overlay that applies, no non-JS
/// marker, and only the pattern shapes this module reproduces.
pub fn project_directories(root: &Path) -> Membership {
    membership(resolve(root, false, None, &[]))
}

/// [`project_directories`] with the manifest each directory was admitted on, so a caller that needs the manifest
/// does not read it again. `None` where [`project_directories`] is `Delegate`.
pub(crate) fn project_packages(root: &Path) -> Option<Vec<(String, PackageJson)>> {
    resolve(root, false, None, &[])
}

/// [`project_packages`] for a root whose `vis.config.*` the caller has read and found free of keys that change the
/// project set (see [`project_directories_vetted`]), except `projectIgnore`: `ignore` holds its entries, each a
/// `.gitignore` line the caller has checked [`Rules::extend`] reads, and Node layers them on the root `.gitignore`.
pub(crate) fn project_packages_vetted(root: &Path, ignore: &[String]) -> Option<Vec<(String, PackageJson)>> {
    resolve(root, true, None, ignore)
}

fn membership(found: Option<Vec<(String, PackageJson)>>) -> Membership {
    found.map_or(Membership::Delegate, |found| {
        Membership::Native(found.into_iter().map(|(directory, _)| directory).collect())
    })
}

/// Like [`project_directories`], but a workspace with `limit` directories or more (the patterns' matches, before
/// the `.gitignore` and the manifest checks) is Node's, and none of its manifests is read: a caller that could not
/// answer such a workspace anyway does not pay for reading it.
pub fn project_directories_below(root: &Path, limit: usize) -> Membership {
    membership(resolve(root, false, Some(limit), &[]))
}

/// Like [`project_directories`], but a `vis.config.*` at the root does not delegate. The caller
/// has read that config and knows none of its keys can change which directories are projects.
pub fn project_directories_vetted(root: &Path) -> Membership {
    membership(resolve(root, true, None, &[]))
}

/// Whether `root` is a path this module reads: absolute and UTF-8.
fn root_is_readable(root: &Path) -> bool {
    root.is_absolute() && root.to_str().is_some()
}

/// Whether a component of a root is one this module reads: a name, the root directory, and on Windows the drive
/// letter. A verbatim (`\\?\`) or UNC prefix is Node's, which normalises those differently.
fn component_is_readable(component: Component<'_>) -> bool {
    match component {
        Component::RootDir | Component::Normal(_) => true,
        Component::Prefix(prefix) => matches!(prefix.kind(), Prefix::Disk(_)),
        Component::CurDir | Component::ParentDir => false,
    }
}

/// `None` means delegate. Every step below returns `None` where the Node path would
/// either error or depend on something this module does not reproduce.
fn resolve(
    root: &Path,
    config_vetted: bool,
    limit: Option<usize>,
    ignore: &[String],
) -> Option<Vec<(String, PackageJson)>> {
    if !root_is_readable(root) || !root.components().all(component_is_readable) {
        return None;
    }

    if !config_vetted && has_vis_config(root) {
        return None;
    }

    if OVERLAY_NAMES.iter().any(|name| root.join(name).exists()) || has_non_js_marker(root)? {
        return None;
    }

    let patterns = workspace_patterns(root)?;
    let directories = expand_patterns(root, &patterns, &is_candidate)?;

    if directories.is_empty() {
        return Some(Vec::new());
    }

    let unique = unique(directories);

    if limit.is_some_and(|limit| unique.len() >= limit) {
        return None;
    }

    let rules = gitignore_rules(root, ignore)?;
    // Every directory is looked at on every core; one that sends the workspace to Node (`None`) does that whichever
    // directory it is, and the ones that stay keep the order they were discovered in.
    let kept: Vec<Option<(String, PackageJson)>> = unique
        .into_par_iter()
        .map(|directory| {
            if !is_unignored(&rules, &directory)? {
                return Some(None);
            }

            let absolute = root.join(&directory);

            // Node names a project from its package.json (or project.json, which wins) and drops a directory
            // with no name, so a candidate that does not yield a name is left to Node.
            let package = PackageJson::read(&absolute).filter(|package| package.name().is_some())?;

            if absolute.join("project.json").exists() || OVERLAY_NAMES.iter().any(|name| absolute.join(name).exists()) {
                return None;
            }

            Some(Some((directory, package)))
        })
        .collect::<Option<Vec<_>>>()?;

    Some(kept.into_iter().flatten().collect())
}

/// The directories the workspace `patterns` name, in discovery order, each a candidate when `is_project` says
/// so. A pattern outside the shapes this module reproduces (see [`classify`]) or an unreadable directory is `None`.
/// The result may list a directory twice, and no ignore rule has been applied to it yet.
pub(crate) fn expand_patterns(
    root: &Path,
    patterns: &[String],
    is_project: &dyn Fn(&Path) -> bool,
) -> Option<Vec<String>> {
    let mut directories: Vec<String> = Vec::new();

    for pattern in patterns {
        match classify(pattern)? {
            Shape::Exact(path) => {
                if is_project(&root.join(path)) {
                    directories.push(path.to_string());
                }
            }
            Shape::Simple(base) => {
                let dir = root.join(base);

                if !dir.exists() {
                    continue;
                }

                if !dir.is_dir() {
                    return None;
                }

                for child in list_dirs(&dir, Some(1))? {
                    if is_project(&dir.join(&child)) {
                        directories.push(format!("{base}/{child}"));
                    }
                }
            }
            Shape::Double { base, star_star } => {
                let dir = root.join(base);

                if !dir.exists() {
                    continue;
                }

                if !dir.is_dir() {
                    return None;
                }

                // `dir/**` matches `dir` itself; `dir/*/*` does not. The check is kept even when
                // `dir` is inside a skipped segment, as the Node path does.
                if star_star && is_project(&dir) {
                    directories.push(base.to_string());
                }

                for relative in list_dirs(&dir, None)? {
                    if is_project(&dir.join(&relative)) {
                        directories.push(format!("{base}/{relative}"));
                    }
                }
            }
            Shape::Bare(glob) => {
                for name in list_dirs(root, Some(1))? {
                    if name.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
                        return None;
                    }

                    if segment_matches(glob.as_bytes(), name.as_bytes()) && is_project(&root.join(&name)) {
                        directories.push(name);
                    }
                }
            }
        }
    }

    Some(directories)
}

pub(crate) fn has_non_js_marker(root: &Path) -> Option<bool> {
    let mut names = Vec::new();

    for entry in fs::read_dir(root).ok()? {
        names.push(entry.ok()?.file_name().into_string().ok()?);
    }

    Some(names_hold_non_js_marker(&names))
}

/// Whether one of the entry names of a directory is a non-JS manifest (see [`has_non_js_marker`]).
pub(crate) fn names_hold_non_js_marker(names: &[String]) -> bool {
    names.iter().any(|name| {
        NON_JS_MARKERS.contains(&name.as_str()) || NON_JS_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
    })
}

/// Whether a directory is a project candidate (`isProjectCandidate`).
fn is_candidate(directory: &Path) -> bool {
    CANDIDATE_MARKERS.iter().any(|marker| directory.join(marker).exists())
}

/// The raw workspace patterns: the first workspace YAML with a `packages` list, else the
/// `package.json` `workspaces` array. Object form and every malformed case delegate.
fn workspace_patterns(root: &Path) -> Option<Vec<String>> {
    match workspace_yaml(root) {
        Ok(Some(yaml)) => return Some(yaml.patterns),
        Ok(None) => {}
        Err(Delegate) => return None,
    }

    let path = root.join("package.json");

    if !path.exists() {
        return None;
    }

    let text = fs::read_to_string(&path).ok()?;

    if text.starts_with('\u{feff}') {
        return None;
    }

    let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
    let entries = manifest.get("workspaces")?.as_array()?;

    if entries.is_empty() {
        return None;
    }

    entries
        .iter()
        .map(|entry| {
            let pattern = entry.as_str()?;

            if pattern.trim().is_empty() {
                None
            } else {
                Some(pattern.to_string())
            }
        })
        .collect()
}

/// Port of `readWorkspaceYamlPatterns`: a line scanner, not a YAML parser. It reads the
/// `- ` entries under a bare `packages:` line and stops at the next non-comment line.
pub(crate) fn yaml_packages(text: &str) -> Vec<String> {
    let mut patterns = Vec::new();
    let mut in_packages = false;

    for line in text.split('\n') {
        let trimmed = line.trim();

        if trimmed == "packages:" {
            in_packages = true;
            continue;
        }

        if in_packages {
            if let Some(entry) = trimmed.strip_prefix("- ") {
                patterns.push(strip_quotes(entry).to_string());
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                break;
            }
        }
    }

    patterns
}

/// The JS `replaceAll(/^['"]|['"]$/g, "")`: drops one leading and one trailing quote.
fn strip_quotes(entry: &str) -> &str {
    let unquoted = entry.strip_prefix(['\'', '"']).unwrap_or(entry);

    unquoted.strip_suffix(['\'', '"']).unwrap_or(unquoted)
}

/// One pattern after its form is known. Slices borrow from the pattern.
pub(crate) enum Shape<'a> {
    Exact(&'a str),
    Simple(&'a str),
    Double { base: &'a str, star_star: bool },
    Bare(&'a str),
}

/// Sorts a pattern into the form `resolveWorkspacePatterns` gives it. Negations (`!`), empty
/// or absolute paths, `.`/`..` segments, and any character outside the allowlist return `None`.
pub(crate) fn classify(pattern: &str) -> Option<Shape<'_>> {
    let clean = pattern.trim_end_matches('/');

    if let Some(base) = clean.strip_suffix("/**") {
        return valid_path(base).then_some(Shape::Double { base, star_star: true });
    }

    if let Some(base) = clean.strip_suffix("/*/*") {
        return valid_path(base).then_some(Shape::Double { base, star_star: false });
    }

    if let Some(base) = clean.strip_suffix("/*") {
        return valid_path(base).then_some(Shape::Simple(base));
    }

    if !clean.contains('/') && clean.contains('*') {
        return (!clean.is_empty() && clean.bytes().all(|byte| byte == b'*' || is_name_byte(byte)))
            .then_some(Shape::Bare(clean));
    }

    valid_path(clean).then_some(Shape::Exact(clean))
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'.' | b'_' | b'-')
}

/// A non-empty `/`-separated path of plain names, with no `*`, `.` or `..` segment.
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.split('/').all(|segment| {
            !segment.is_empty() && segment != "." && segment != ".." && segment.bytes().all(is_name_byte)
        })
}

/// The workspace directories `vis optimize` scans, as `discoverWorkspacePackages` gives them for any manager: the
/// directories that hold a `package.json` and that the workspace YAML's `packages` patterns name, deduplicated, minus those
/// the built-in excludes and the root `.gitignore` drop; with no such list, the ones the root `package.json` names in
/// `workspaces` (an array, or the `packages` of an object, as npm and yarn write them), and none when it names none. Unlike
/// [`project_directories`], no project name, overlay or other ecosystem matters. `None` delegates: a pattern or `.gitignore`
/// line outside the shapes of [`classify`], a non-ASCII name, a workspace YAML that is unreadable or not ASCII, a
/// `package.json` that is not strict JSON (Node reads it with a parser that may accept more) and a `workspaces` entry that is
/// not a string (Node throws on it).
pub(crate) fn directories_of_workspace(root: &Path) -> Option<Vec<String>> {
    let patterns = match workspace_yaml(root) {
        Ok(Some(yaml)) => yaml.patterns,
        Ok(None) => manifest_patterns(root)?,
        Err(Delegate) => return None,
    };

    // Node returns before it reads the `.gitignore` when there is nothing to resolve.
    if patterns.is_empty() {
        return Some(Vec::new());
    }

    directories_for_patterns(root, &patterns)
}

/// The patterns `discoverWorkspacePackages` reads from the root `package.json`: `workspaces` as an array, or its
/// `packages` when it is an object, and none for anything else (a missing file included). `None` delegates.
fn manifest_patterns(root: &Path) -> Option<Vec<String>> {
    let Ok(bytes) = fs::read(root.join("package.json")) else {
        return Some(Vec::new());
    };

    let manifest: serde_json::Value = serde_json::from_str(std::str::from_utf8(&bytes).ok()?).ok()?;
    let listed = match manifest.get("workspaces") {
        Some(serde_json::Value::Array(entries)) => Some(entries),
        Some(serde_json::Value::Object(map)) => match map.get("packages") {
            Some(serde_json::Value::Array(entries)) => Some(entries),
            // A missing, null, `false`, `0` or empty `packages` is falsy, so Node resolves nothing; any other
            // value it iterates in a way this module does not reproduce.
            None | Some(serde_json::Value::Null | serde_json::Value::Bool(false)) => None,
            Some(serde_json::Value::Number(number)) if number.as_f64() == Some(0.0) => None,
            Some(serde_json::Value::String(text)) if text.is_empty() => None,
            Some(_) => return None,
        },
        _ => None,
    };

    listed.map_or_else(
        || Some(Vec::new()),
        |entries| entries.iter().map(|entry| entry.as_str().map(str::to_owned)).collect(),
    )
}

/// The workspace is one this module does not read: the caller hands the command to Node.
pub(crate) struct Delegate;

/// The first workspace YAML that lists any `packages`, with the text it was read from.
pub(crate) struct WorkspaceYaml {
    pub(crate) patterns: Vec<String>,
    pub(crate) text: String,
}

/// The first of [`WORKSPACE_YAML_NAMES`] whose `packages` list (read as [`yaml_packages`] does) is not empty, or
/// `Ok(None)` when no workspace YAML lists any. `Err` when `root` is not a path this module reads, or a workspace
/// YAML is unreadable or not ASCII.
pub(crate) fn workspace_yaml(root: &Path) -> Result<Option<WorkspaceYaml>, Delegate> {
    if !root_is_readable(root) {
        return Err(Delegate);
    }

    for file in WORKSPACE_YAML_NAMES {
        let path = root.join(file);

        if path.exists() {
            let text = fs::read_to_string(&path).map_err(|_| Delegate)?;

            if !text.is_ascii() {
                return Err(Delegate);
            }

            let patterns = yaml_packages(&text);

            if !patterns.is_empty() {
                return Ok(Some(WorkspaceYaml { patterns, text }));
            }
        }
    }

    Ok(None)
}

/// What `resolveWorkspacePatterns(root, patterns)` returns: the directories the patterns name that hold a
/// `package.json`, deduplicated, minus those the built-in excludes and the root `.gitignore` drop. `None` delegates,
/// as for [`directories_of_workspace`].
pub(crate) fn directories_for_patterns(root: &Path, patterns: &[String]) -> Option<Vec<String>> {
    let directories = unique(expand_patterns(root, patterns, &|directory| directory.join("package.json").exists())?);
    let rules = gitignore_rules(root, &[])?;
    let mut kept = Vec::new();

    for directory in directories {
        if is_unignored(&rules, &directory)? {
            kept.push(directory);
        }
    }

    Some(kept)
}

/// `directories` without the repeats (overlapping patterns such as `tools` and `tools/**` name a directory
/// twice), each at its first position.
fn unique(directories: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::with_capacity(directories.len());

    directories.into_iter().filter(|directory| seen.insert(directory.clone())).collect()
}

/// Whether `directory` survives the `.gitignore` rules; `None` for a name outside ASCII, which Node compares
/// differently, and so is Node's.
fn is_unignored(rules: &Rules, directory: &str) -> Option<bool> {
    directory.is_ascii().then(|| !rules.ignores(directory, true))
}

/// The directory names directly under `directory`, in the order `walkSync` yields them (see [`list_dirs`]).
pub(crate) fn child_directories(directory: &Path) -> Option<Vec<String>> {
    list_dirs(directory, Some(1))
}

/// A directory the Node walk would skip. Its skip regexes (`/node_modules/`, `/\.git/`) run on
/// the absolute path, so any `.git` substring prunes the entry and its subtree.
fn skipped(path: &Path) -> Option<bool> {
    let text = path.to_str()?;

    Some(text.contains("node_modules") || text.contains(".git"))
}

/// Directories under `dir` in the order `walkSync` yields them: each directory's entries in `readdir` order (sorted by
/// name on unix, the file system's own on Windows), depth-first, symlinks and skipped paths left out. `max_depth` of
/// `Some(1)` lists only the children.
fn list_dirs(dir: &Path, max_depth: Option<usize>) -> Option<Vec<String>> {
    let mut found = Vec::new();

    if skipped(dir)? {
        return Some(found);
    }

    walk(dir, "", max_depth.unwrap_or(usize::MAX), &mut found)?;

    Some(found)
}

fn walk(dir: &Path, prefix: &str, depth: usize, found: &mut Vec<String>) -> Option<()> {
    if depth == 0 {
        return Some(());
    }

    let mut entries = Vec::new();

    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        entries.push((entry.file_name().into_string().ok()?, entry.file_type().ok()?));
    }

    // Node lists a directory in the order `readdir` returns it. On unix libuv sorts that by name, bytewise. On Windows
    // it does not sort: the entries come as the file system holds them (NTFS: by upper-cased name, so `Beta` sits
    // between `b2` and `mid` and `_core` after `Zed`), and `read_dir` asks the file system the same way, so they are
    // left as they come instead of this module reproducing a file system's order. Checked on NTFS only (see the
    // `order` groups of `tests/fixtures/windows-node`).
    #[cfg(not(windows))]
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, file_type) in entries {
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }

        let child = dir.join(&name);

        if skipped(&child)? {
            continue;
        }

        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };

        found.push(relative.clone());
        walk(&child, &relative, depth - 1, found)?;
    }

    Some(())
}

/// The rules `buildGitignoreMatcher` applies: the built-in excludes, then the root `.gitignore`, then the extra
/// patterns (`projectIgnore`), as far as [`Rules`] reproduces them (`None` delegates).
fn gitignore_rules(root: &Path, extra: &[String]) -> Option<Rules> {
    let path = root.join(".gitignore");

    // Matches `safeRead`: an unreadable or non-file `.gitignore` is treated as absent.
    let mut rules = if path.is_file() {
        Rules::from_lines(fs::read_to_string(&path).ok()?.split('\n'))?
    } else {
        Rules::from_lines([])?
    };

    rules.extend(extra.iter().map(String::as_str))?;

    Some(rules)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/workspace")
    }

    fn shape_name(pattern: &str) -> &'static str {
        match classify(pattern) {
            Some(Shape::Exact(_)) => "exact",
            Some(Shape::Simple(_)) => "simple",
            Some(Shape::Double { star_star: true, .. }) => "double",
            Some(Shape::Double { star_star: false, .. }) => "nested",
            Some(Shape::Bare(_)) => "bare",
            None => "delegate",
        }
    }

    #[test]
    fn classify_accepts_each_glob_form() {
        assert_eq!(shape_name("packages/a"), "exact");
        assert_eq!(shape_name("packages/a/"), "exact");
        assert_eq!(shape_name("packages/*"), "simple");
        assert_eq!(shape_name("packages/**"), "double");
        assert_eq!(shape_name("packages/*/*"), "nested");
        assert_eq!(shape_name("@scope-*"), "bare");
        assert_eq!(shape_name("**"), "bare");
    }

    #[test]
    fn classify_delegates_everything_else() {
        for pattern in [
            "!packages/skip",
            "./packages/a",
            "../shared",
            "/abs/pkg",
            "a//b",
            "a/./b",
            "",
            ".",
            "*/**",
            "a/**/*",
            "a/b*",
            "a?",
            "a[1]",
            "a\\b",
            "x y",
            "packages/**/x",
        ] {
            assert_eq!(shape_name(pattern), "delegate", "{pattern}");
        }
    }

    #[test]
    fn yaml_reads_the_packages_list_only() {
        let text = "catalog:\n  x: 1\npackages:\n  # comment\n  - 'packages/*'\n  - \"libs/**\"\n  - tools/cli/\n\noverrides:\n  - ignored\n";

        assert_eq!(yaml_packages(text), vec!["packages/*", "libs/**", "tools/cli/"]);
    }

    #[test]
    fn yaml_flow_style_and_comment_suffix_give_no_patterns() {
        assert!(yaml_packages("packages: [\"a/*\"]\n").is_empty());
        assert!(yaml_packages("packages: # trailing\n  - a/*\n").is_empty());
        assert!(yaml_packages("name: x\n").is_empty());
    }

    #[test]
    fn yaml_stops_at_the_first_key_after_the_list() {
        assert_eq!(yaml_packages("packages:\n  - a\nonlyBuiltDependencies:\n  - b\n"), vec!["a"]);
    }

    #[test]
    fn strip_quotes_drops_one_matching_pair() {
        assert_eq!(strip_quotes("'a/*'"), "a/*");
        assert_eq!(strip_quotes("\"a/*\""), "a/*");
        assert_eq!(strip_quotes("a/*"), "a/*");
        assert_eq!(strip_quotes("'a/*"), "a/*");
    }

    fn rules(text: &str) -> Rules {
        Rules::from_lines(text.split('\n')).expect("supported rule")
    }

    #[test]
    fn gitignore_unanchored_name_ignores_at_any_depth() {
        let r = rules("skipped\n");

        assert!(r.ignores("skipped", true));
        assert!(r.ignores("packages/skipped", true));
        assert!(r.ignores("packages/skipped/deeper", true));
        assert!(!r.ignores("packages/skipped2", true));
    }

    #[test]
    fn gitignore_anchored_path_only_matches_from_the_root() {
        let r = rules("/root-skip\nnested/hidden\n");

        assert!(r.ignores("root-skip", true));
        assert!(!r.ignores("packages/root-skip", true));
        assert!(r.ignores("nested/hidden/p", true));
        assert!(!r.ignores("x/nested/hidden", true));
    }

    #[test]
    fn gitignore_matches_ascii_case_insensitively() {
        assert!(rules("Upper/\n").ignores("upper", true));
        assert!(rules("Upper\n").ignores("x/UPPER", true));
    }

    #[test]
    fn gitignore_builtin_excludes_apply_at_any_depth() {
        let r = rules("");

        assert!(r.ignores("a/node_modules", true));
        assert!(r.ignores(".git", true));
        assert!(!r.ignores(".github", true));
    }

    #[test]
    fn gitignore_delegates_on_unsupported_rules() {
        for line in ["!keep", "a/**/b", "**/b", "a b", "a[1]", "\\#x", "a//b", "/", "a\r", "ü"] {
            assert!(Rules::from_lines([line]).is_none(), "{line}");
        }

        for line in ["# note", "", "  ", "*.log", "dist*", "a?", "tmp?/", "/build-*", "# café"] {
            assert!(Rules::from_lines([line]).is_some(), "{line}");
        }
    }

    #[test]
    fn fixtures_match_their_expected_membership() {
        let mut checked = 0;

        for entry in fs::read_dir(fixture_root()).expect("fixture root") {
            let case = entry.expect("fixture entry").path();
            let expected: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(case.join("expected.json")).expect("expected.json"))
                    .expect("valid expected.json");
            let actual = project_directories(&case);

            match expected.get("native") {
                Some(native) => {
                    let mut want: Vec<String> = native
                        .as_array()
                        .expect("native list")
                        .iter()
                        .map(|value| value.as_str().expect("string").to_string())
                        .collect();
                    want.sort();

                    let Membership::Native(mut got) = actual else {
                        panic!("{}: expected native, got delegate", case.display());
                    };
                    got.sort();

                    assert_eq!(got, want, "{}", case.display());
                }
                None => assert_eq!(actual, Membership::Delegate, "{}", case.display()),
            }

            checked += 1;
        }

        assert!(checked >= 10, "fixtures went missing: {checked}");
    }
}

#[cfg(test)]
mod root_tests {
    use super::*;

    fn readable(root: &str) -> bool {
        let root = Path::new(root);

        root_is_readable(root) && root.components().all(component_is_readable)
    }

    #[test]
    fn a_relative_root_or_one_with_a_parent_segment_is_left_to_node() {
        for root in ["packages", "./packages", "../repo"] {
            assert!(!readable(root), "{root}");
        }

        #[cfg(unix)]
        assert!(!readable("/repo/../a"));
    }

    #[cfg(unix)]
    #[test]
    fn an_absolute_root_is_read() {
        assert!(readable("/repo"));
        assert!(readable("/"));
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_root_is_read_and_a_verbatim_or_network_root_is_left_to_node() {
        for root in [r"C:\repo", r"c:\repo\packages", r"D:\"] {
            assert!(readable(root), "{root}");
        }

        for root in
            [r"\\?\C:\repo", r"\\?\UNC\server\share\repo", r"\\server\share\repo", r"\\.\C:\repo", r"C:repo", r"\repo"]
        {
            assert!(!readable(root), "{root}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_directory_junction_is_not_a_project_directory() {
        let root = std::env::temp_dir().join(format!("vis-workspace-junction-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        fs::create_dir_all(root.join("elsewhere/a")).expect("target");
        fs::create_dir_all(root.join("pkgs/real")).expect("project");
        fs::write(root.join("package.json"), r#"{"name":"root","workspaces":["pkgs/*"]}"#).expect("root manifest");
        fs::write(root.join("elsewhere/a/package.json"), r#"{"name":"a"}"#).expect("manifest");
        fs::write(root.join("pkgs/real/package.json"), r#"{"name":"real"}"#).expect("manifest");

        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("pkgs").join("linked"))
            .arg(root.join("elsewhere").join("a"))
            .status()
            .expect("mklink");

        assert!(status.success());
        assert_eq!(project_directories(&root), Membership::Native(vec!["pkgs/real".to_owned()]));

        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod gitignore_fixture_tests {
    use std::fs;

    use super::*;

    /// Built at test time: a fixture-local `.gitignore` would make git drop the directories it
    /// names, so this case cannot live in the committed fixtures.
    #[test]
    fn root_gitignore_drops_literal_matches() {
        let root = std::env::temp_dir().join(format!("vis-workspace-gitignore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let files = [
            ("package.json", "{\"name\":\"root\",\"private\":true}"),
            (".gitignore", "skipped\n/root-skip\nnested/hidden\nUpper\n# comment\n"),
            (
                "pnpm-workspace.yaml",
                "packages:\n  - \"packages/**\"\n  - \"root-skip\"\n  - \"nested/**\"\n  - \"upper/**\"\n",
            ),
            ("packages/a/package.json", "{\"name\":\"p\"}"),
            ("packages/skipped/package.json", "{\"name\":\"p\"}"),
            ("packages/x/skipped/package.json", "{\"name\":\"p\"}"),
            ("root-skip/package.json", "{\"name\":\"p\"}"),
            ("nested/hidden/p/package.json", "{\"name\":\"p\"}"),
            ("nested/keep/package.json", "{\"name\":\"p\"}"),
            ("upper/x/package.json", "{\"name\":\"p\"}"),
        ];

        for (path, text) in files {
            let target = root.join(path);
            fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
            fs::write(target, text).expect("write");
        }

        assert_eq!(
            project_directories(&root),
            Membership::Native(vec!["packages/a".to_string(), "nested/keep".to_string()])
        );
    }

    /// The same files and the same list as the wildcard case of `workspace-membership.test.ts`, whose Node run is the
    /// reference: `*` and `?` in the root `.gitignore` are matched here, not left to Node.
    #[test]
    fn root_gitignore_drops_wildcard_matches() {
        let root = std::env::temp_dir().join(format!("vis-workspace-gitignore-wildcard-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let files = [
            ("package.json", "{\"name\":\"root\",\"private\":true}"),
            (".gitignore", "*-skip\ntmp?\n/build-*\nnested/*/gen\nMixed*\n   \n# café\n"),
            ("pnpm-workspace.yaml", "packages:\n  - \"packages/**\"\n  - \"nested/**\"\n  - \"build-*\"\n"),
            ("build-one/package.json", "{\"name\":\"p\"}"),
            ("nested/a/gen/package.json", "{\"name\":\"p\"}"),
            ("nested/a/keep/package.json", "{\"name\":\"p\"}"),
            ("nested/gen/package.json", "{\"name\":\"p\"}"),
            ("packages/MixedCase/package.json", "{\"name\":\"p\"}"),
            ("packages/a-skip/package.json", "{\"name\":\"p\"}"),
            ("packages/a/package.json", "{\"name\":\"p\"}"),
            ("packages/build-two/package.json", "{\"name\":\"p\"}"),
            ("packages/tmp1/package.json", "{\"name\":\"p\"}"),
            ("packages/tmp12/package.json", "{\"name\":\"p\"}"),
            ("packages/x/b-skip/package.json", "{\"name\":\"p\"}"),
        ];

        for (path, text) in files {
            let target = root.join(path);
            fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
            fs::write(target, text).expect("write");
        }

        let Membership::Native(mut got) = project_directories(&root) else {
            panic!("wildcard rules should stay native");
        };
        got.sort();

        assert_eq!(got, ["nested/a/keep", "nested/gen", "packages/a", "packages/build-two", "packages/tmp12"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_ignore_lines_join_the_gitignore_rules() {
        let root = std::env::temp_dir().join(format!("vis-workspace-project-ignore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        for (path, text) in [
            ("package.json", "{\"name\":\"root\",\"private\":true}"),
            ("pnpm-workspace.yaml", "packages:\n  - \"packages/**\"\n"),
            ("packages/a/package.json", "{\"name\":\"a\"}"),
            ("packages/legacy/package.json", "{\"name\":\"legacy\"}"),
            ("packages/x/legacy/package.json", "{\"name\":\"nested-legacy\"}"),
            ("packages/old/inner/package.json", "{\"name\":\"inner\"}"),
            ("packages/old/package.json", "{\"name\":\"old\"}"),
        ] {
            let target = root.join(path);
            fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
            fs::write(target, text).expect("write");
        }

        let kept = |ignore: &[&str]| -> Vec<String> {
            let ignore: Vec<String> = ignore.iter().map(|line| (*line).to_owned()).collect();
            let mut directories: Vec<String> = project_packages_vetted(&root, &ignore)
                .expect("native")
                .into_iter()
                .map(|(directory, _)| directory)
                .collect();

            directories.sort();
            directories
        };

        assert_eq!(
            kept(&[]),
            ["packages/a", "packages/legacy", "packages/old", "packages/old/inner", "packages/x/legacy"]
        );
        // An unanchored name drops the directory at any depth, and what is under an ignored directory with it.
        assert_eq!(kept(&["legacy", "packages/old"]), ["packages/a"]);
        // An anchored path drops that directory only.
        assert_eq!(
            kept(&["packages/legacy"]),
            ["packages/a", "packages/old", "packages/old/inner", "packages/x/legacy"]
        );
        // A line outside the subset sends the workspace to Node.
        assert!(project_packages_vetted(&root, &["!a".to_owned()]).is_none());
        assert!(project_packages_vetted(&root, &["**/old".to_owned()]).is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_workspace_at_the_limit_is_left_to_node_and_below_it_is_not() {
        let root = std::env::temp_dir().join(format!("vis-workspace-limit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("package.json"), "{\"name\":\"root\",\"private\":true}").expect("root manifest");
        fs::write(root.join("pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n").expect("workspace");

        for name in ["a", "b", "c"] {
            fs::create_dir_all(root.join("packages").join(name)).expect("project");
            fs::write(root.join("packages").join(name).join("package.json"), format!("{{\"name\":\"{name}\"}}"))
                .expect("manifest");
        }

        let all = project_directories(&root);

        assert!(matches!(&all, Membership::Native(directories) if directories.len() == 3));
        assert_eq!(project_directories_below(&root, 4), all);
        assert_eq!(project_directories_below(&root, 3), Membership::Delegate);
        assert_eq!(project_directories_below(&root, 1), Membership::Delegate);
    }

    #[test]
    fn a_project_named_empty_or_proto_is_left_to_node() {
        for (index, manifest) in [r#"{"name":""}"#, r#"{"name":"__proto__"}"#].into_iter().enumerate() {
            let root = std::env::temp_dir().join(format!("vis-workspace-name-{}-{index}", std::process::id()));
            let _ = fs::remove_dir_all(&root);

            fs::create_dir_all(root.join("pkgs/a")).expect("project");
            fs::write(root.join("package.json"), r#"{"name":"root","workspaces":["pkgs/*"]}"#).expect("root manifest");
            fs::write(root.join("pkgs/a/package.json"), manifest).expect("manifest");

            assert_eq!(project_directories(&root), Membership::Delegate, "{manifest}");

            let _ = fs::remove_dir_all(&root);
        }
    }

    /// The directories `directories_of_workspace` gives for a root holding `files`, with a project at `packages/a`.
    fn of_workspace(name: &str, files: &[(&str, &str)]) -> Option<Vec<String>> {
        let root = std::env::temp_dir().join(format!("vis-workspace-of-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        for project in ["packages/a", "apps/web"] {
            fs::create_dir_all(root.join(project)).expect("project");
            fs::write(root.join(project).join("package.json"), "{}").expect("manifest");
        }

        for (file, content) in files {
            fs::write(root.join(file), content).expect("file");
        }

        let directories = directories_of_workspace(&root);

        let _ = fs::remove_dir_all(&root);

        directories
    }

    #[test]
    fn the_directories_of_a_workspace_come_from_the_yaml_first_and_the_manifest_second() {
        let listed = |directories: &[&str]| Some(directories.iter().map(|directory| (*directory).to_owned()).collect::<Vec<_>>());
        let yaml = ("pnpm-workspace.yaml", "packages:\n  - \"apps/*\"\n");

        assert_eq!(of_workspace("array", &[("package.json", r#"{"workspaces":["packages/*","apps/*"]}"#)]), listed(&["packages/a", "apps/web"]));
        assert_eq!(of_workspace("object", &[("package.json", r#"{"workspaces":{"packages":["packages/a"],"nohoist":["x"]}}"#)]), listed(&["packages/a"]));
        assert_eq!(of_workspace("yaml-wins", &[("package.json", r#"{"workspaces":["packages/*"]}"#), yaml]), listed(&["apps/web"]));
        assert_eq!(of_workspace("yaml-without-list", &[("package.json", r#"{"workspaces":["packages/*"]}"#), ("pnpm-workspace.yaml", "onlyBuiltDependencies:\n  - x\n")]), listed(&["packages/a"]));

        // Nothing named, or a value Node reads as nothing.
        for (name, manifest) in [
            ("empty", r#"{"workspaces":[]}"#),
            ("no-packages", r#"{"workspaces":{"nohoist":[]}}"#),
            ("null-packages", r#"{"workspaces":{"packages":null}}"#),
            ("false-packages", r#"{"workspaces":{"packages":false}}"#),
            ("string", r#"{"workspaces":"packages/*"}"#),
            ("absent", r#"{"name":"r"}"#),
            ("not-an-object", "[1,2]"),
        ] {
            assert_eq!(of_workspace(name, &[("package.json", manifest)]), listed(&[]), "{name}");
        }

        assert_eq!(of_workspace("no-manifest", &[]), listed(&[]));
    }

    #[test]
    fn a_manifest_workspaces_value_node_reads_in_another_way_is_left_to_node() {
        for (name, manifest) in [
            ("not-json", "{ not json"),
            ("comment", "{ // c\n \"workspaces\": [\"packages/*\"] }"),
            ("number-entry", r#"{"workspaces":["packages/*", 1]}"#),
            ("null-entry", r#"{"workspaces":[null]}"#),
            ("string-packages", r#"{"workspaces":{"packages":"packages/*"}}"#),
            ("object-packages", r#"{"workspaces":{"packages":{"0":"packages/*"}}}"#),
            ("negation", r#"{"workspaces":["packages/*","!packages/a"]}"#),
            ("dot-path", r#"{"workspaces":["./packages/*"]}"#),
            ("brace", r#"{"workspaces":["packages/{a,b}"]}"#),
        ] {
            assert_eq!(of_workspace(name, &[("package.json", manifest)]), None, "{name}");
        }

        assert_eq!(of_workspace("bom", &[("package.json", "\u{feff}{\"workspaces\":[\"packages/*\"]}")]), None);
    }
}
