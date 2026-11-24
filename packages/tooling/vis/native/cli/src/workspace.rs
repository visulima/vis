//! Workspace project membership for a JS-only repo, read natively.
//!
//! Mirrors the directory list that `resolveWorkspacePatterns` (with `isProjectCandidate`) and
//! the `package.json` filter produce in `packages/tooling/vis/src/config/workspace.ts`, for the
//! pattern shapes below. Anything else returns `Membership::Delegate`, and the Node CLI answers it.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path};

use rayon::prelude::*;

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
const NON_JS_MARKERS: &[&str] = &[
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
    resolve(root, false, None).unwrap_or(Membership::Delegate)
}

/// Like [`project_directories`], but a workspace with `limit` directories or more (the patterns' matches, before
/// the `.gitignore` and the manifest checks) is Node's, and none of its manifests is read: a caller that could not
/// answer such a workspace anyway does not pay for reading it.
pub fn project_directories_below(root: &Path, limit: usize) -> Membership {
    resolve(root, false, Some(limit)).unwrap_or(Membership::Delegate)
}

/// Like [`project_directories`], but a `vis.config.*` at the root does not delegate. The caller
/// has read that config and knows none of its keys can change which directories are projects.
pub fn project_directories_vetted(root: &Path) -> Membership {
    resolve(root, true, None).unwrap_or(Membership::Delegate)
}

/// Whether `root` is a path this module reads: absolute and UTF-8, off Windows.
fn root_is_readable(root: &Path) -> bool {
    !cfg!(windows) && root.is_absolute() && root.to_str().is_some()
}

/// `None` means delegate. Every step below returns `None` where the Node path would
/// either error or depend on something this module does not reproduce.
fn resolve(root: &Path, config_vetted: bool, limit: Option<usize>) -> Option<Membership> {
    if !root_is_readable(root) {
        return None;
    }

    if root.components().any(|component| !matches!(component, Component::RootDir | Component::Normal(_))) {
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
        return Some(Membership::Native(directories));
    }

    let unique = unique(directories);

    if limit.is_some_and(|limit| unique.len() >= limit) {
        return None;
    }

    let rules = gitignore_rules(root)?;
    // Every directory is looked at on every core; one that sends the workspace to Node (`None`) does that whichever
    // directory it is, and the ones that stay keep the order they were discovered in.
    let kept: Vec<Option<String>> = unique
        .into_par_iter()
        .map(|directory| {
            if !is_unignored(&rules, &directory)? {
                return Some(None);
            }

            let absolute = root.join(&directory);

            // Node names a project from its package.json (or project.json, which wins) and drops a directory
            // with no name, so a candidate that does not yield a name is left to Node.
            if !has_package_name(&absolute)
                || absolute.join("project.json").exists()
                || OVERLAY_NAMES.iter().any(|name| absolute.join(name).exists())
            {
                return None;
            }

            Some(Some(directory))
        })
        .collect::<Option<Vec<_>>>()?;
    let kept: Vec<String> = kept.into_iter().flatten().collect();

    Some(Membership::Native(kept))
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

                    if star_match(glob, &name) && is_project(&root.join(&name)) {
                        directories.push(name);
                    }
                }
            }
        }
    }

    Some(directories)
}

/// Whether `directory/package.json` parses and has a non-empty string `name` other than `__proto__`.
/// Node drops an empty name (`if (!projectName) continue`), and it stores projects on a plain object,
/// where `__proto__` sets the prototype instead of adding a project.
fn has_package_name(directory: &Path) -> bool {
    fs::read_to_string(directory.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|manifest| {
            manifest
                .get("name")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|name| !name.is_empty() && name != "__proto__")
        })
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

/// The workspace directories `resolveWorkspacePatterns` gives the commands that scan every project's
/// `package.json` (`vis optimize`): the directories the YAML's `packages` patterns name that hold a
/// `package.json`, deduplicated, minus those the built-in excludes and the root `.gitignore` drop. Unlike
/// [`project_directories`], no project name, overlay or other ecosystem matters. `None` delegates: no pattern
/// list in the workspace YAML, a pattern or `.gitignore` line outside the shapes above, or a non-ASCII name.
pub(crate) fn directories_with_package_json(root: &Path) -> Option<Vec<String>> {
    directories_for_patterns(root, &workspace_yaml(root).ok()??.patterns)
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
/// as for [`directories_with_package_json`].
pub(crate) fn directories_for_patterns(root: &Path, patterns: &[String]) -> Option<Vec<String>> {
    let directories = unique(expand_patterns(root, patterns, &|directory| directory.join("package.json").exists())?);
    let rules = gitignore_rules(root)?;
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
fn is_unignored(rules: &[Rule], directory: &str) -> Option<bool> {
    directory.is_ascii().then(|| !is_ignored(rules, directory))
}

/// The directory names directly under `directory`, in the order `walkSync` yields them (see [`list_dirs`]).
pub(crate) fn child_directories(directory: &Path) -> Option<Vec<String>> {
    list_dirs(directory, Some(1))
}

fn star_match(pattern: &str, text: &str) -> bool {
    let (pattern, text) = (pattern.as_bytes(), text.as_bytes());
    let (mut p, mut t) = (0, 0);
    let mut star: Option<usize> = None;
    let mut mark = 0;

    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some(position) = star {
            p = position + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }

    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }

    p == pattern.len()
}

/// A directory the Node walk would skip. Its skip regexes (`/node_modules/`, `/\.git/`) run on
/// the absolute path, so any `.git` substring prunes the entry and its subtree.
fn skipped(path: &Path) -> Option<bool> {
    let text = path.to_str()?;

    Some(text.contains("node_modules") || text.contains(".git"))
}

/// Directories under `dir` in the order `walkSync` yields them: sorted by name, depth-first,
/// symlinks and skipped paths left out. `max_depth` of `Some(1)` lists only the children.
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

/// One root `.gitignore` rule, with segments compared case-insensitively.
struct Rule {
    anchored: bool,
    segments: Vec<String>,
}

/// The rules `buildGitignoreMatcher` applies: the built-in excludes, then the root `.gitignore`.
/// Only literal names are reproduced. Negations, globs, escapes, and whitespace delegate.
fn gitignore_rules(root: &Path) -> Option<Vec<Rule>> {
    let mut rules = vec![
        Rule { anchored: false, segments: vec![".git".to_string()] },
        Rule { anchored: false, segments: vec!["node_modules".to_string()] },
    ];
    let path = root.join(".gitignore");

    // Matches `safeRead`: an unreadable or non-file `.gitignore` is treated as absent.
    if !path.is_file() {
        return Some(rules);
    }

    let text = fs::read_to_string(&path).ok()?;

    if !text.is_ascii() {
        return None;
    }

    for line in text.split('\n') {
        if let Some(rule) = parse_gitignore_line(line)? {
            rules.push(rule);
        }
    }

    Some(rules)
}

/// `None` delegates. `Some(None)` is a blank or comment line.
fn parse_gitignore_line(line: &str) -> Option<Option<Rule>> {
    if line.is_empty() || line.starts_with('#') {
        return Some(None);
    }

    if line.starts_with('!') || !line.bytes().all(|byte| byte == b'/' || is_name_byte(byte)) {
        return None;
    }

    let body = line.strip_prefix('/').unwrap_or(line);
    let body = body.strip_suffix('/').unwrap_or(body);

    if body.is_empty() || body.ends_with('/') {
        return None;
    }

    let segments: Vec<&str> = body.split('/').collect();

    if segments.iter().any(|segment| segment.is_empty() || *segment == "." || *segment == "..") {
        return None;
    }

    Some(Some(Rule {
        anchored: line.starts_with('/') || segments.len() > 1,
        segments: segments.iter().map(|segment| segment.to_ascii_lowercase()).collect(),
    }))
}

/// Whether `directory` (relative, `/`-separated) is ignored. A rule also ignores everything under
/// the directory it matches, so every ancestor prefix is tested.
fn is_ignored(rules: &[Rule], directory: &str) -> bool {
    let components: Vec<&str> = directory.split('/').collect();

    (1..=components.len()).any(|depth| {
        rules.iter().any(|rule| {
            if rule.anchored {
                rule.segments.len() == depth
                    && rule
                        .segments
                        .iter()
                        .zip(&components[..depth])
                        .all(|(rule_segment, component)| rule_segment.eq_ignore_ascii_case(component))
            } else {
                rule.segments.len() == 1 && rule.segments[0].eq_ignore_ascii_case(components[depth - 1])
            }
        })
    })
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
    fn star_match_is_anchored_and_star_only() {
        assert!(star_match("pkg-*", "pkg-a"));
        assert!(star_match("pkg-*", "pkg-"));
        assert!(!star_match("pkg-*", "xpkg-a"));
        assert!(star_match("@*", "@scope"));
        assert!(star_match("*", ""));
        assert!(star_match("a*b*c", "axxbyyc"));
        assert!(!star_match("a*b", "ab!"));
        assert!(!star_match("pkg.a", "pkgXa"));
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

    fn rules(text: &str) -> Vec<Rule> {
        let mut all = vec![
            Rule { anchored: false, segments: vec![".git".into()] },
            Rule { anchored: false, segments: vec!["node_modules".into()] },
        ];

        for line in text.split('\n') {
            if let Some(rule) = parse_gitignore_line(line).expect("supported rule") {
                all.push(rule);
            }
        }

        all
    }

    #[test]
    fn gitignore_unanchored_name_ignores_at_any_depth() {
        let r = rules("skipped\n");

        assert!(is_ignored(&r, "skipped"));
        assert!(is_ignored(&r, "packages/skipped"));
        assert!(is_ignored(&r, "packages/skipped/deeper"));
        assert!(!is_ignored(&r, "packages/skipped2"));
    }

    #[test]
    fn gitignore_anchored_path_only_matches_from_the_root() {
        let r = rules("/root-skip\nnested/hidden\n");

        assert!(is_ignored(&r, "root-skip"));
        assert!(!is_ignored(&r, "packages/root-skip"));
        assert!(is_ignored(&r, "nested/hidden/p"));
        assert!(!is_ignored(&r, "x/nested/hidden"));
    }

    #[test]
    fn gitignore_matches_ascii_case_insensitively() {
        assert!(is_ignored(&rules("Upper/\n"), "upper"));
        assert!(is_ignored(&rules("Upper\n"), "x/UPPER"));
    }

    #[test]
    fn gitignore_builtin_excludes_apply_at_any_depth() {
        let r = rules("");

        assert!(is_ignored(&r, "a/node_modules"));
        assert!(is_ignored(&r, ".git"));
        assert!(!is_ignored(&r, ".github"));
    }

    #[test]
    fn gitignore_delegates_on_unsupported_rules() {
        for line in ["!keep", "*.log", "a/**/b", "dist*", "a b", "\\#x", "a//b", "/"] {
            assert!(parse_gitignore_line(line).is_none(), "{line}");
        }

        assert!(matches!(parse_gitignore_line("# note"), Some(None)));
        assert!(matches!(parse_gitignore_line(""), Some(None)));
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
}
