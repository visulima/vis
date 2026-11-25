//! The four settings of `pnpm-workspace.yaml` that `vis security list` compares with `vis.config`
//! (`readPmNativeSnapshot` in `src/security/drift.ts`, pnpm branch): `allowBuilds`, `onlyBuiltDependencies`,
//! `minimumReleaseAge` and `minimumReleaseAgeExclude`.
//!
//! This is not a YAML parser. It reads a file only when every line fits a small grammar whose meaning in YAML is
//! unambiguous, and returns `None` (the caller hands the command to Node) for anything else:
//!
//! - ASCII text with `\n` line ends, no tabs, no document markers, no duplicate top-level key;
//! - a top-level line is `key:` or `key: scalar`; the lines under a `key:` are all `  - scalar` or all
//!   `  key: scalar`, indented by exactly two spaces; a comment line may sit anywhere;
//! - a scalar is a plain word (letters, digits and `._/@^<>=+*~-`, no space, `:` or `#`, not starting with a
//!   YAML indicator) or a quoted string without backslashes.

use std::collections::HashSet;

use crate::js::is_index_like;

/// What the four keys hold after the read.
#[derive(Default, Debug, PartialEq)]
pub(super) struct Snapshot {
    /// `allowBuilds` (the keys whose value is truthy), else `onlyBuiltDependencies`, in file order.
    pub(super) allow_builds: Option<Vec<String>>,
    pub(super) min_release_age: Option<i64>,
    pub(super) min_release_age_excludes: Option<Vec<String>>,
}

/// What a scalar is in YAML's core schema, as far as this module distinguishes.
#[derive(Clone, Debug, PartialEq)]
enum Scalar {
    Bool(bool),
    Null,
    /// A plain scalar that YAML may read as a number, a boolean spelling or a null spelling.
    Other,
    Number(String),
    Text(String),
}

#[derive(Debug)]
enum Body {
    /// `key:` with nothing under it (null).
    Empty,
    Scalar(Scalar),
    List(Vec<Scalar>),
    Map(Vec<(String, Scalar)>),
}

fn classify_plain(word: &str) -> Scalar {
    match word {
        "true" => return Scalar::Bool(true),
        "false" => return Scalar::Bool(false),
        "null" | "~" => return Scalar::Null,
        _ => {}
    }

    let lower = word.to_ascii_lowercase();

    if matches!(lower.as_str(), "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "y" | "n") {
        return Scalar::Other;
    }

    let first = word.as_bytes()[0];

    // Digits, signs and a leading dot start a number in YAML (and `.inf`, `.nan`).
    if first.is_ascii_digit() || matches!(first, b'-' | b'+' | b'.') {
        return if word.bytes().all(|byte| byte.is_ascii_digit()) {
            Scalar::Number(word.to_owned())
        } else {
            Scalar::Other
        };
    }

    Scalar::Text(word.to_owned())
}

/// A scalar after `key:` or `- `.
fn scalar(text: &str) -> Option<Scalar> {
    let text = text.trim();

    if text.is_empty() {
        return None;
    }

    let bytes = text.as_bytes();

    if matches!(bytes[0], b'\'' | b'"') {
        let quote = bytes[0] as char;
        let inner = text[1..].strip_suffix(quote)?;

        return inner
            .chars()
            .all(|character| (' '..='~').contains(&character) && character != '\\' && character != quote)
            .then(|| Scalar::Text(inner.to_owned()));
    }

    // The first character of a plain scalar may not be a YAML indicator; `-` and `.` start numbers and are classified.
    let first = bytes[0];

    if !(first.is_ascii_alphanumeric() || matches!(first, b'.' | b'_' | b'/' | b'-' | b'+' | b'~' | b'^' | b'<')) {
        return None;
    }

    if !bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || b"._/@^<>=+*~-".contains(byte)) {
        return None;
    }

    // `<<` is the merge key of YAML 1.1 parsers.
    if text.starts_with("<<") {
        return None;
    }

    // A lone `-` is a sequence indicator, and `-x` / `--x` are fine only when they are not one.
    if text == "-" {
        return None;
    }

    Some(classify_plain(text))
}

/// The key of a `key: value` line and the rest of it.
fn split_key(line: &str) -> Option<(String, &str)> {
    let (key, rest) = if line.starts_with(['\'', '"']) {
        let quote = line.as_bytes()[0] as char;
        let end = line[1..].find(quote)? + 1;

        (&line[..=end], line[end + 1..].strip_prefix(':')?)
    } else {
        let end = line.find(':')?;

        (&line[..end], &line[end + 1..])
    };

    // After the colon comes a space or the end of the line.
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }

    match scalar(key)? {
        Scalar::Text(text) => Some((text, rest)),
        _ => None,
    }
}

fn parse_body(text: &str) -> Option<Vec<(String, Body)>> {
    if !text.is_ascii() || text.contains(['\t', '\r', '\0']) {
        return None;
    }

    let mut entries: Vec<(String, Body)> = Vec::new();
    let mut keys = HashSet::new();

    for line in text.split('\n') {
        let trimmed = line.trim_end();
        let content = trimmed.trim_start_matches(' ');

        if content.is_empty() || content.starts_with('#') {
            continue;
        }

        let indent = trimmed.len() - content.len();

        if content.contains(" #") || content == "---" || content == "..." {
            return None;
        }

        if indent == 0 {
            let (key, rest) = split_key(content)?;

            if !keys.insert(key.clone()) {
                return None;
            }

            let body = if rest.trim().is_empty() { Body::Empty } else { Body::Scalar(scalar(rest)?) };

            entries.push((key, body));

            continue;
        }

        if indent != 2 {
            return None;
        }

        let (_, body) = entries.last_mut()?;

        if let Some(item) = content.strip_prefix("- ") {
            let item = scalar(item)?;

            match body {
                Body::Empty => *body = Body::List(vec![item]),
                Body::List(items) => items.push(item),
                _ => return None,
            }
        } else {
            let (key, rest) = split_key(content)?;
            let value = scalar(rest)?;

            match body {
                Body::Empty => *body = Body::Map(vec![(key, value)]),
                Body::Map(items) if !items.iter().any(|(name, _)| *name == key) => items.push((key, value)),
                _ => return None,
            }
        }
    }

    Some(entries)
}

/// A list item that is a string in YAML.
fn text_of(scalar: &Scalar) -> Option<String> {
    match scalar {
        Scalar::Text(text) => Some(text.clone()),
        _ => None,
    }
}

/// Distinct items in first-seen order (`new Set(list)`).
fn distinct(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();

    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

/// `readPmNativeSnapshot` for pnpm, or `None` when the file is outside the grammar or holds a value this module
/// does not reproduce (a number that is not a plain integer, a non-string key or list item, a nested value).
pub(super) fn snapshot(text: &str) -> Option<Snapshot> {
    let entries = parse_body(text)?;
    let find = |name: &str| entries.iter().find(|(key, _)| key == name).map(|(_, body)| body);
    // A key that is a number or a flag as a map key (`123: true`) orders first in a JS object; none is accepted.
    let mut allow_builds = match find("allowBuilds") {
        Some(Body::Map(items)) => {
            let mut keys = Vec::new();

            for (key, value) in items {
                match value {
                    Scalar::Bool(true) => keys.push(key.clone()),
                    Scalar::Bool(false) => {}
                    _ => return None,
                }

                if key.is_empty() || is_index_like(key) {
                    return None;
                }
            }

            Some(keys)
        }
        // `allowBuilds:` with a list, a scalar or nothing is not an object of entries; the next source applies.
        Some(Body::List(_)) => return None,
        _ => None,
    };

    if allow_builds.is_none() {
        if let Some(Body::List(items)) = find("onlyBuiltDependencies") {
            allow_builds = Some(distinct(items.iter().map(text_of).collect::<Option<Vec<_>>>()?));
        }
    }

    let min_release_age = match find("minimumReleaseAge") {
        Some(Body::Scalar(Scalar::Number(digits)))
            if digits == "0" || (!digits.starts_with('0') && digits.len() <= 15) =>
        {
            Some(digits.parse().ok()?)
        }
        // A number in another spelling, which YAML reads as a number (or a string) in ways this module does not.
        Some(Body::Scalar(Scalar::Number(_) | Scalar::Other)) => return None,
        _ => None,
    };

    let min_release_age_excludes = match find("minimumReleaseAgeExclude") {
        Some(Body::List(items)) => Some(distinct(items.iter().map(text_of).collect::<Option<Vec<_>>>()?)),
        _ => None,
    };

    Some(Snapshot { allow_builds, min_release_age, min_release_age_excludes })
}

/// What `syncAllowBuildsToNativeConfig` reads from `pnpm-workspace.yaml`: the `allowBuilds` entries and the
/// `onlyBuiltDependencies` list, each in file order.
#[derive(Default, Debug, PartialEq)]
pub(crate) struct Workspace {
    pub(crate) allow_builds: Vec<(String, bool)>,
    pub(crate) only_built: Vec<String>,
}

/// The two settings `vis security sync` merges into, or `None` when the file is outside the grammar or holds a
/// value this module does not reproduce: an `allowBuilds` that is not a map of booleans (keys that are empty,
/// integer-like or `__proto__` included), or an `onlyBuiltDependencies` list with an item that is not a string.
/// An `onlyBuiltDependencies` that is not a list counts as empty, as it does for `Array.isArray`.
pub(crate) fn workspace(text: &str) -> Option<Workspace> {
    let entries = parse_body(text)?;
    let find = |name: &str| entries.iter().find(|(key, _)| key == name).map(|(_, body)| body);

    let allow_builds = match find("allowBuilds") {
        Some(Body::Map(items)) => {
            let mut found = Vec::new();

            for (key, value) in items {
                let Scalar::Bool(value) = value else {
                    return None;
                };

                if key.is_empty() || is_index_like(key) {
                    return None;
                }

                found.push((key.clone(), *value));
            }

            found
        }
        Some(Body::Empty) | None => Vec::new(),
        Some(_) => return None,
    };

    let only_built = match find("onlyBuiltDependencies") {
        Some(Body::List(items)) => items.iter().map(text_of).collect::<Option<Vec<_>>>()?,
        _ => Vec::new(),
    };

    Some(Workspace { allow_builds, only_built })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> Option<Snapshot> {
        snapshot(text)
    }

    #[test]
    fn an_integer_like_allow_key_is_left_to_node() {
        assert!(read("allowBuilds:\n  123: true\n").is_none());
        assert!(read("allowBuilds:\n  __proto__: true\n").is_none());
    }

    #[test]
    fn a_typical_workspace_file_reads() {
        let text = "packages:\n  - \"packages/*\"\n  - '!**/test/**'\n# a comment\nonlyBuiltDependencies:\n  - esbuild\n  - '@scope/pkg'\n  - esbuild\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - webpack\noverrides:\n  left-pad: ^1.0.0\n";

        assert_eq!(
            read(text),
            Some(Snapshot {
                allow_builds: Some(vec!["esbuild".to_owned(), "@scope/pkg".to_owned()]),
                min_release_age: Some(1440),
                min_release_age_excludes: Some(vec!["webpack".to_owned()]),
            })
        );
    }

    #[test]
    fn allow_builds_wins_over_the_list_and_keeps_true_entries() {
        let text = "allowBuilds:\n  esbuild: true\n  '@a/b': false\n  sharp: true\nonlyBuiltDependencies:\n  - other\n";

        assert_eq!(read(text).unwrap().allow_builds, Some(vec!["esbuild".to_owned(), "sharp".to_owned()]));
    }

    #[test]
    fn an_empty_key_is_null_and_falls_through() {
        assert_eq!(
            read("allowBuilds:\nonlyBuiltDependencies:\n  - a\n").unwrap().allow_builds,
            Some(vec!["a".to_owned()])
        );
        assert_eq!(read("minimumReleaseAge:\n").unwrap().min_release_age, None);
        assert_eq!(read("minimumReleaseAge: '1440'\n").unwrap().min_release_age, None);
        assert_eq!(read("minimumReleaseAge: soon\n").unwrap().min_release_age, None);
    }

    #[test]
    fn anything_outside_the_grammar_is_declined() {
        assert!(read("a: [1, 2]\n").is_none());
        assert!(read("a:\n    - x\n").is_none());
        assert!(read("a:\n  - x\n  b: y\n").is_none());
        assert!(read("a: 1\na: 2\n").is_none());
        assert!(read("a: &x 1\n").is_none());
        assert!(read("<<: {a: 1}\n").is_none());
        assert!(read("a:\n  <<: x\n").is_none());
        assert!(read("a: b # c\n").is_none());
        assert!(read("a:\r\n").is_none());
        assert!(read("a: é\n").is_none());
        assert!(read("minimumReleaseAge: 1.5\n").is_none());
        assert!(read("minimumReleaseAge: 007\n").is_none());
        assert!(read("allowBuilds:\n  a: yes\n").is_none());
        assert!(read("onlyBuiltDependencies:\n  - 123\n").is_none());
        assert!(read("onlyBuiltDependencies:\n  - true\n").is_none());
        assert!(read("nested:\n  a:\n    b: 1\n").is_none());
    }

    #[test]
    fn a_missing_or_empty_file_has_nothing() {
        assert_eq!(read(""), Some(Snapshot::default()));
        assert_eq!(read("# only a comment\n"), Some(Snapshot::default()));
    }

    #[test]
    fn the_workspace_view_keeps_false_entries_and_the_list_apart() {
        let text = "allowBuilds:\n  b: false\n  a: true\nonlyBuiltDependencies:\n  - x\n  - x\n";

        assert_eq!(
            workspace(text),
            Some(Workspace {
                allow_builds: vec![("b".to_owned(), false), ("a".to_owned(), true)],
                only_built: vec!["x".to_owned(), "x".to_owned()],
            })
        );
        assert_eq!(workspace("packages:\n  - a\n"), Some(Workspace::default()));
        assert_eq!(workspace("allowBuilds:\nonlyBuiltDependencies: 3\n"), Some(Workspace::default()));
    }

    #[test]
    fn the_workspace_view_declines_what_it_cannot_read_exactly() {
        assert!(workspace("allowBuilds:\n  - a\n").is_none());
        assert!(workspace("allowBuilds: x\n").is_none());
        assert!(workspace("allowBuilds:\n  a: yes\n").is_none());
        assert!(workspace("allowBuilds:\n  1: true\n").is_none());
        assert!(workspace("onlyBuiltDependencies:\n  - 1\n").is_none());
        assert!(workspace("a:\n  b:\n    c: 1\n").is_none());
    }
}
