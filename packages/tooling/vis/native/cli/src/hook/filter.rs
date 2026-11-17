//! File selection for one hook: `files` / `exclude` regexes, then `types` /
//! `typesOr` / `excludeTypes` tags. Mirrors `filter.ts`.
//!
//! The regex half is the risky one — JS `RegExp` and the Rust `regex` crate
//! disagree on enough syntax that [`select_paths`] only compiles patterns from a
//! small subset where they provably agree, and returns `None` for the rest so the
//! run goes to Node.

use regex::bytes::{Regex, RegexBuilder};

use super::config::Entry;

fn is_printable_ascii(text: &str) -> bool {
    text.bytes().all(|b| (0x20..0x7f).contains(&b))
}

/// Digits starting at `*at`; advances `*at` past them and returns how many.
fn skip_digits(bytes: &[u8], at: &mut usize) -> usize {
    let start = *at;

    while bytes.get(*at).is_some_and(u8::is_ascii_digit) {
        *at += 1;
    }

    *at - start
}

/// End index (the `}`) of a strict `{n}` / `{n,}` / `{n,m}` quantifier starting at `start`.
/// Anything else is literal text in JS but may be a quantifier in Rust (`{ 2}`, `{,3}`).
fn brace_quantifier_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut at = start + 1;

    if skip_digits(bytes, &mut at) == 0 {
        return None;
    }

    if bytes.get(at) == Some(&b',') {
        at += 1;
        skip_digits(bytes, &mut at);
    }

    (bytes.get(at) == Some(&b'}')).then_some(at)
}

/// Compile `pattern` only when JS `RegExp` and Rust `regex` provably agree on it.
///
/// The accepted subset is printable ASCII where:
/// - the only `(?` form is `(?:`;
/// - backslash escapes are one of `\\ \. \/ \- \^ \$ \* \+ \? \( \) \[ \] \{ \} \|` or the ASCII
///   classes `\d \D \w \W \s \S`, plus `\b` / `\B` outside a bracket class and not followed by
///   `{` (Rust reads `\b{start}`);
/// - bracket classes hold no nested `[`, no `&&` / `--` / `~~` set operators (Rust-only) and are
///   not empty (`[]` is "nothing" in JS, `[]a]` in Rust);
/// - `{` only appears as a strict `{n}` / `{n,}` / `{n,m}` quantifier;
/// - quantifiers follow something quantifiable and are never stacked (`a**`, `a?+`, `^*`, `\b*`
///   are a `SyntaxError` in JS but compile in Rust); a single lazy `?` after one is fine.
///
/// Compiled with Unicode off so `\d \w \s \b` are ASCII-only like JS; callers also require
/// every candidate path to be printable ASCII.
fn compile_js_regex(pattern: &str) -> Option<Regex> {
    let bytes = pattern.as_bytes();

    if !is_printable_ascii(pattern) {
        return None;
    }

    let mut in_class = false;
    // The previous token can take a quantifier / is a quantifier / already has its lazy `?`.
    let (mut atom, mut quantified, mut lazy) = (false, false, false);
    let mut i = 0;

    while i < bytes.len() {
        let c = bytes[i];

        if c == b'\\' {
            let next = *bytes.get(i + 1)?;
            let class_escape = b"dDwWsS".contains(&next);
            let boundary = matches!(next, b'b' | b'B') && !in_class && bytes.get(i + 2) != Some(&b'{');

            if !(class_escape || boundary || b"\\./-^$*+?()[]{}|".contains(&next)) {
                return None;
            }

            if !in_class {
                atom = !boundary;
                quantified = false;
            }

            i += 2;

            continue;
        }

        if in_class {
            if c == b'[' || (matches!(c, b'&' | b'-' | b'~') && bytes.get(i + 1) == Some(&c)) {
                return None;
            }

            if c == b']' {
                in_class = false;
                atom = true;
                quantified = false;
            }

            i += 1;

            continue;
        }

        match c {
            b'[' => {
                let first = if bytes.get(i + 1) == Some(&b'^') { i + 2 } else { i + 1 };

                if bytes.get(first) == Some(&b']') {
                    return None;
                }

                in_class = true;
                i += 1;
            }
            b'(' => {
                if bytes.get(i + 1) == Some(&b'?') {
                    if bytes.get(i + 2) != Some(&b':') {
                        return None;
                    }

                    i += 2;
                }

                atom = false;
                quantified = false;
                i += 1;
            }
            b'|' | b'^' | b'$' => {
                atom = false;
                quantified = false;
                i += 1;
            }
            b'*' | b'+' | b'?' | b'{' => {
                let end = if c == b'{' { brace_quantifier_end(bytes, i)? } else { i };

                if quantified {
                    if c != b'?' || lazy {
                        return None;
                    }

                    lazy = true;
                } else if atom {
                    quantified = true;
                    lazy = false;
                } else {
                    return None;
                }

                i = end + 1;
            }
            _ => {
                atom = true;
                quantified = false;
                i += 1;
            }
        }
    }

    if in_class {
        return None;
    }

    RegexBuilder::new(pattern).unicode(false).build().ok()
}

/// `files` then `exclude`, in input order. `None` ⇒ the filter cannot be reproduced
/// exactly (unsupported pattern, or a pattern with a non-printable-ASCII path).
pub fn select_paths(entry: &Entry, candidates: &[String]) -> Option<Vec<String>> {
    let mut files = candidates.to_vec();

    if entry.files.is_none() && entry.exclude.is_none() {
        return Some(files);
    }

    if !candidates.iter().all(|file| is_printable_ascii(file)) {
        return None;
    }

    if let Some(pattern) = &entry.files {
        let rx = compile_js_regex(pattern)?;

        files.retain(|f| rx.is_match(f.as_bytes()));
    }

    if let Some(pattern) = &entry.exclude {
        let rx = compile_js_regex(pattern)?;

        files.retain(|f| !rx.is_match(f.as_bytes()));
    }

    Some(files)
}

/// Whether every tag the entry names is in the upstream `prek-identify` universe.
/// vis-specific overlay tags live on the JS side, so those go to Node.
pub fn tags_are_known(entry: &Entry) -> bool {
    let universe = prek_identify::tags::ALL_TAGS;

    entry.types.iter().chain(&entry.types_or).chain(&entry.exclude_types).all(|tag| universe.contains(&tag.as_str()))
}

/// `types` / `typesOr` / `excludeTypes` against the file classifier. Runs just before
/// the hook does, like the Node runner, so it sees what earlier hooks changed (a deleted
/// file, a new exec bit).
pub fn by_tags(files: Vec<String>, entry: &Entry) -> Vec<String> {
    files
        .into_iter()
        .filter(|file| {
            // A classification error collapses to "no tags", like the addon.
            let tags: Vec<&str> = prek_identify::tags_from_path(std::path::Path::new(file))
                .map(|set| set.iter().collect())
                .unwrap_or_default();
            let has = |tag: &String| tags.contains(&tag.as_str());

            entry.types.iter().all(has)
                && (entry.types_or.is_empty() || entry.types_or.iter().any(has))
                && !entry.exclude_types.iter().any(has)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(pattern: &str, text: &str) -> Option<bool> {
        compile_js_regex(pattern).map(|rx| rx.is_match(text.as_bytes()))
    }

    #[test]
    fn subset_matches_like_js_on_ascii_paths() {
        assert_eq!(matches(r"\.ts$", "src/a.ts"), Some(true));
        assert_eq!(matches(r"\.ts$", "src/a.tsx"), Some(false));
        assert_eq!(matches(r"^src/.*\.(ts|md)$", "src/x/y.md"), Some(true));
        assert_eq!(matches(r"\bok\b", "src/ok.txt"), Some(true));
        assert_eq!(matches(r"[a-z]+\.txt$", "a.txt"), Some(true));
        assert_eq!(matches(r"(?:ws|ok)\.", "ok.txt"), Some(true));
        assert_eq!(matches(r"^\w+$", "abc_1"), Some(true));
        assert_eq!(matches(r"a{2}", "baab"), Some(true));
        assert_eq!(matches(r"a{2,}?b", "aaab"), Some(true));
        assert_eq!(matches(r"x*?y", "xxy"), Some(true));
    }

    #[test]
    fn anything_js_and_rust_could_read_differently_is_refused() {
        for pattern in [
            "(?i)a",
            "(?=a)",
            "(?<n>a)",
            r"\p{L}",
            r"\1",
            r"\<a",
            r"\b{start}",
            "[[:alpha:]]",
            "[a&&b]",
            "[a--b]",
            "[a~~b]",
            "[[a]]",
            "[]a]",
            "[^]",
            "a{,3}",
            "(",
            "[a",
            "ü",
            r"\u0041",
            r"\cA",
            // quantifiers JS rejects but Rust accepts
            "a**",
            "a++",
            "a?+",
            "a{2}*",
            "a*??",
            "^*",
            "$+",
            r"\b*",
            "(*a)",
            "|*",
            "*a",
            // whitespace in braces is literal in JS, a quantifier in Rust
            "a{ 2}",
            "a{2 }",
            "a{1, 2}",
        ] {
            assert!(compile_js_regex(pattern).is_none(), "{pattern} must fall back to Node");
        }
    }
}
