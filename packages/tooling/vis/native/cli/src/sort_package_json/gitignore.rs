//! The part of `.gitignore` matching this command can reproduce: patterns made of plain name characters,
//! `*` and `?` (neither crossing a `/`), an optional leading and trailing `/`, and no negation.
//!
//! Node filters the package.json files with `buildGitignoreMatcher` (the `ignore` package, which compares
//! without regard to case). A line outside the subset (`!`, `**`, `[...]`, escapes, spaces, non-ASCII
//! text) makes [`Rules::from_lines`] return `None`, and the command then goes to Node. A rule that ignores
//! a directory also ignores everything under it, which is how a path is tested: every prefix of it.

/// One compiled line.
struct Rule {
    /// Matches from the root (the line has a `/` in it) instead of at any depth.
    anchored: bool,
    /// Matches directories only (the line ends in `/`).
    directories_only: bool,
    segments: Vec<String>,
}

#[derive(Default)]
pub struct Rules(Vec<Rule>);

impl Rules {
    /// The rules of the built-in excludes (`.git/`, `node_modules/`) followed by `lines`, or `None` when a
    /// line leaves the subset. Blank lines and `#` comments are skipped, as the `ignore` package does.
    pub fn from_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> Option<Self> {
        let mut rules = Self::default();

        for line in [".git/", "node_modules/"].into_iter().chain(lines) {
            if let Some(rule) = compile(line)? {
                rules.0.push(rule);
            }
        }

        Some(rules)
    }

    /// Adds `lines` to the rules, with the same outcome as [`Rules::from_lines`].
    pub fn extend<'a>(&mut self, lines: impl IntoIterator<Item = &'a str>) -> Option<()> {
        for line in lines {
            if let Some(rule) = compile(line)? {
                self.0.push(rule);
            }
        }

        Some(())
    }

    /// Whether the relative `/`-separated `path` is ignored. `is_directory` says whether its last component
    /// is a directory (every other component is one).
    pub fn ignores(&self, path: &str, is_directory: bool) -> bool {
        let components: Vec<&str> = path.split('/').collect();

        (1..=components.len()).any(|depth| {
            let directory = depth < components.len() || is_directory;

            self.0.iter().any(|rule| rule.matches(&components[..depth], directory))
        })
    }
}

impl Rule {
    /// Whether the rule matches the path made of `components`, whose last one is a directory or not.
    fn matches(&self, components: &[&str], directory: bool) -> bool {
        if self.directories_only && !directory {
            return false;
        }

        if self.anchored {
            self.segments.len() == components.len()
                && self.segments.iter().zip(components).all(|(pattern, component)| segment_matches(pattern, component))
        } else {
            components.last().is_some_and(|component| segment_matches(&self.segments[0], component))
        }
    }
}

/// `Some(None)` for a blank line or a comment, `None` for a line outside the subset.
fn compile(line: &str) -> Option<Option<Rule>> {
    // The `ignore` package splits on `\r?\n`; a stray `\r` is left to Node like any other control character.
    // A line of nothing but spaces and tabs is blank to the `ignore` package, too.
    if line.bytes().all(|byte| byte == b' ' || byte == b'\t') || line.starts_with('#') {
        return Some(None);
    }

    if !line.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"@._-*?/".contains(&byte)) {
        return None;
    }

    let directories_only = line.ends_with('/');
    let body = line.strip_suffix('/').unwrap_or(line);
    let anchored = body.contains('/');
    let body = body.strip_prefix('/').unwrap_or(body);

    if body.is_empty() || body.contains("**") {
        return None;
    }

    let segments: Vec<String> = body.split('/').map(str::to_owned).collect();

    if segments.iter().any(|segment| segment.is_empty() || segment == "." || segment == "..") {
        return None;
    }

    Some(Some(Rule { anchored, directories_only, segments }))
}

/// `*` matches any run of characters and `?` exactly one, case-insensitively; both stay inside a segment.
fn segment_matches(pattern: &str, text: &str) -> bool {
    super::segment_matches(pattern.to_ascii_lowercase().as_bytes(), text.to_ascii_lowercase().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ignored(lines: &[&str], path: &str, directory: bool) -> bool {
        Rules::from_lines(lines.iter().copied()).expect("inside the subset").ignores(path, directory)
    }

    #[test]
    fn the_built_in_excludes_apply_at_any_depth() {
        assert!(ignored(&[], "node_modules/a/package.json", false));
        assert!(ignored(&[], "packages/a/node_modules/b/package.json", false));
        assert!(ignored(&[], "a/.git", true));
        assert!(!ignored(&[], "packages/a/package.json", false));
    }

    #[test]
    fn a_name_matches_at_any_depth_and_a_path_from_the_root() {
        assert!(ignored(&["dist"], "packages/dist/package.json", false));
        assert!(ignored(&["/dist"], "dist/package.json", false));
        assert!(!ignored(&["/dist"], "packages/dist/package.json", false));
        assert!(ignored(&["packages/legacy"], "packages/legacy/package.json", false));
        assert!(!ignored(&["packages/legacy"], "other/packages/legacy/package.json", false));
        assert!(!ignored(&["legacy/x"], "legacy/package.json", false));
    }

    #[test]
    fn a_trailing_slash_matches_directories_only() {
        assert!(ignored(&["dist/"], "dist/package.json", false));
        assert!(!ignored(&["package.json/"], "package.json", false));
        assert!(ignored(&["package.json"], "package.json", false));
    }

    #[test]
    fn wildcards_stay_inside_a_segment_and_ignore_case() {
        assert!(ignored(&["pkg-*"], "packages/PKG-a/package.json", false));
        assert!(ignored(&["a?c"], "abc/package.json", false));
        assert!(!ignored(&["a?c"], "ac/package.json", false));
        assert!(ignored(&["*.json"], "package.json", false));
        assert!(!ignored(&["a*b"], "a/b/package.json", false));
        assert!(ignored(&["a/*"], "a/package.json", false));
        assert!(ignored(&["a/*"], "a/b/package.json", false));
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        assert!(!ignored(&["# dist", "", "  ", "\t", "# ü", "x"], "dist/package.json", false));
    }

    #[test]
    fn lines_outside_the_subset_are_declined() {
        for line in ["!keep", "**/x", "a/**", "[ab]", "a\\ b", "a b", "dist ", "é", "a é", "a//b", "/", "a/./b", "a\r"]
        {
            assert!(Rules::from_lines([line]).is_none(), "{line:?}");
        }
    }
}
