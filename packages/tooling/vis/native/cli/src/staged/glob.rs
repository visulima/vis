//! The glob patterns of a `staged` config that the binary matches itself.
//!
//! Node matches a pattern with `zeptomatch`. This is a matcher for the part of its syntax whose meaning is the same
//! in both, checked against `zeptomatch` for a matrix of patterns and paths (`native/cli/tests/fixtures/staged-glob.json`,
//! written by `__tests__/native/staged-glob-fixture.test.ts`):
//!
//! - literal characters `A-Z a-z 0-9 _ . -` and the separator `/`;
//! - `*` inside a segment: any run of characters but `/`, the empty run included, and no special case for a leading
//!   dot (`*.txt` matches `.txt`);
//! - `**` as a whole segment: any number of segments, none included (`src/**` matches `src`, `**/*.ts` matches `a.ts`);
//! - one level of braces, `{a,b}`, whose alternatives are non-empty runs of `A-Z a-z 0-9 _ -`.
//!
//! Anything else, a negation, `?`, a class, an extglob, an escape, a nested brace, an empty segment, `.` or `..` as a
//! segment, `**` inside a segment, is Node's.

/// The most patterns the braces of one glob may expand to.
const MAX_EXPANSIONS: usize = 32;

#[derive(Debug, PartialEq)]
enum Part {
    Literal(String),
    Star,
}

#[derive(Debug, PartialEq)]
enum Segment {
    Globstar,
    Wild(Vec<Part>),
}

/// A pattern the binary can match.
#[derive(Debug, PartialEq)]
pub(super) struct Glob {
    /// One list of segments per expansion of the braces.
    alternatives: Vec<Vec<Segment>>,
    /// Whether the glob is matched against the basename (no `/` in the pattern) or the path relative to the root.
    pub basename: bool,
}

fn is_literal(character: char, in_brace: bool) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '-' || (character == '.' && !in_brace)
}

/// The patterns `pattern` stands for with its braces expanded, or `None` for a brace this does not read.
fn expand(pattern: &str) -> Option<Vec<String>> {
    let mut results = vec![String::new()];
    let mut rest = pattern;

    while let Some(open) = rest.find('{') {
        let before = &rest[..open];
        let close = rest[open..].find('}')? + open;
        let inside = &rest[open + 1..close];

        // A nested or unbalanced brace.
        if inside.contains('{') || before.contains('}') {
            return None;
        }

        let choices: Vec<&str> = inside.split(',').collect();

        if choices.iter().any(|choice| choice.is_empty() || !choice.chars().all(|c| is_literal(c, true))) {
            return None;
        }

        let mut next = Vec::with_capacity(results.len() * choices.len());

        for prefix in &results {
            for choice in &choices {
                next.push(format!("{prefix}{before}{choice}"));
            }
        }

        if next.len() > MAX_EXPANSIONS {
            return None;
        }

        results = next;
        rest = &rest[close + 1..];
    }

    if rest.contains('}') {
        return None;
    }

    Some(results.into_iter().map(|prefix| format!("{prefix}{rest}")).collect())
}

fn segments(pattern: &str) -> Option<Vec<Segment>> {
    pattern
        .split('/')
        .map(|segment| {
            if segment.is_empty() || segment == "." || segment == ".." {
                return None;
            }

            if segment == "**" {
                return Some(Segment::Globstar);
            }

            if segment.contains("**") {
                return None;
            }

            let mut parts = Vec::new();

            for (index, piece) in segment.split('*').enumerate() {
                if index > 0 {
                    parts.push(Part::Star);
                }

                if !piece.is_empty() {
                    if !piece.chars().all(|c| is_literal(c, false)) {
                        return None;
                    }

                    parts.push(Part::Literal(piece.to_owned()));
                }
            }

            Some(Segment::Wild(parts))
        })
        .collect()
}

/// Reads `pattern` (lower-cased when the file system folds case, as Node lower-cases both sides then), or `None` when
/// Node must match it.
pub(super) fn compile(pattern: &str, fold_case: bool) -> Option<Glob> {
    if !pattern.is_ascii() {
        return None;
    }

    let pattern = if fold_case { pattern.to_ascii_lowercase() } else { pattern.to_owned() };
    let alternatives = expand(&pattern)?.iter().map(|alternative| segments(alternative)).collect::<Option<Vec<_>>>()?;

    Some(Glob { alternatives, basename: !pattern.contains('/') })
}

/// Whether `text` matches the parts, a `*` taking any run of characters.
fn wild(parts: &[Part], text: &[char]) -> bool {
    match parts.split_first() {
        None => text.is_empty(),
        Some((Part::Literal(literal), rest)) => {
            let literal: Vec<char> = literal.chars().collect();

            text.starts_with(&literal) && wild(rest, &text[literal.len()..])
        }
        Some((Part::Star, rest)) => (0..=text.len()).any(|taken| wild(rest, &text[taken..])),
    }
}

fn matches(pattern: &[Segment], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((Segment::Globstar, rest)) => (0..=path.len()).any(|taken| matches(rest, &path[taken..])),
        Some((Segment::Wild(parts), rest)) => path
            .split_first()
            .is_some_and(|(first, tail)| wild(parts, &first.chars().collect::<Vec<_>>()) && matches(rest, tail)),
    }
}

impl Glob {
    /// Whether `candidate` (already lower-cased where the glob was) matches.
    pub(super) fn is_match(&self, candidate: &str) -> bool {
        let path: Vec<&str> = candidate.split('/').collect();

        self.alternatives.iter().any(|alternative| matches(alternative, &path))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        /// Pattern to the paths `zeptomatch` matches, out of `paths`.
        supported: BTreeMap<String, Vec<String>>,
        declined: Vec<String>,
        paths: Vec<String>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../../tests/fixtures/staged-glob.json")).unwrap()
    }

    #[test]
    fn every_supported_pattern_matches_what_zeptomatch_matches() {
        let fixture = fixture();

        assert!(!fixture.supported.is_empty());

        for (pattern, expected) in &fixture.supported {
            let glob = compile(pattern, false).unwrap_or_else(|| panic!("{pattern:?} is supported"));
            // A path-style pattern is matched against the relative path and a bare one against the basename; the
            // fixture lists the paths of the first kind, so a bare pattern is checked against the same strings.
            let actual: Vec<&String> = fixture.paths.iter().filter(|path| glob.is_match(path)).collect();

            assert_eq!(actual, expected.iter().collect::<Vec<_>>(), "{pattern:?}");
        }
    }

    #[test]
    fn every_declined_pattern_is_nodes() {
        for pattern in fixture().declined {
            assert!(compile(&pattern, false).is_none(), "{pattern:?}");
        }
    }

    #[test]
    fn a_folding_file_system_lower_cases_the_pattern() {
        let glob = compile("*.TXT", true).unwrap();

        assert!(glob.is_match("a.txt"));
        assert!(!compile("*.TXT", false).unwrap().is_match("a.txt"));
    }

    #[test]
    fn the_basename_flag_follows_the_separator() {
        assert!(compile("*.ts", false).unwrap().basename);
        assert!(!compile("src/*.ts", false).unwrap().basename);
        assert!(compile("**", false).unwrap().basename);
    }
}
