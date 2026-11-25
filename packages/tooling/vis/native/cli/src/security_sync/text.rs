//! The regular expressions of `native-config-sync.ts` and `min-release-age.ts`, written out for the plain text
//! this module accepts (ASCII, `\n` line ends, no other control character), where `^`, `$` and `.` of a JavaScript
//! `m` regex split the text at `\n` alone.

use std::ops::Range;

/// `String.prototype.trimEnd` on such text: only the blanks and line ends it may hold.
pub(super) fn trim_end(text: &str) -> &str {
    text.trim_end_matches([' ', '\t', '\n'])
}

/// The start of every line, as `^` matches in an `m` regex.
fn line_starts(content: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0)
        .chain(content.match_indices('\n').map(|(index, _)| index + 1))
        .filter(|start| *start < content.len())
}

fn line_end(content: &str, start: usize) -> usize {
    content[start..].find('\n').map_or(content.len(), |offset| start + offset)
}

/// The first match of `^<key>[ \t]*:.*$` (`m`): the whole line of a `key:` entry, without its line end.
pub(super) fn entry_line(content: &str, key: &str) -> Option<Range<usize>> {
    line_starts(content).find_map(|start| {
        let end = line_end(content, start);
        let rest = content[start..end].strip_prefix(key)?.trim_start_matches([' ', '\t']);

        rest.starts_with(':').then_some(start..end)
    })
}

/// The first match of `^<key>:[ \t]*\n(?:[ \t]{2}[^\n]*\n)*` (`m`): the `key:` line and the lines under it that start with
/// two blanks. A line that does not (a blank one, a comment, a line that starts a new key) ends the block, whatever YAML
/// makes of it.
pub(super) fn block(content: &str, key: &str) -> Option<Range<usize>> {
    line_starts(content).find_map(|start| {
        let end = line_end(content, start);
        let rest = content[start..end].strip_prefix(key)?.strip_prefix(':')?;

        if end == content.len() || !rest.bytes().all(|byte| byte == b' ' || byte == b'\t') {
            return None;
        }

        let mut next = end + 1;

        while let Some(offset) = content[next..].find('\n') {
            if !is_indent(&content.as_bytes()[next..]) {
                break;
            }

            next += offset + 1;
        }

        Some(start..next)
    })
}

/// Whether `bytes` starts with two blanks, each a space or a tab.
fn is_indent(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && matches!(bytes[0], b' ' | b'\t') && matches!(bytes[1], b' ' | b'\t')
}

/// `content.replace(regex, replacement)` for the first match of `range`, or `content.trimEnd()`, a blank line and
/// `appended` when the regex found nothing.
pub(super) fn replace_or_append(
    content: &str,
    range: Option<Range<usize>>,
    replacement: &str,
    appended: &str,
) -> String {
    match range {
        Some(range) => format!("{}{}{}", &content[..range.start], replacement, &content[range.end..]),
        None => format!("{}\n\n{}", trim_end(content), appended),
    }
}

/// `key.startsWith("@") || key.includes("/") || /[:#\s]/.test(key)` for printable ASCII.
fn needs_quote(key: &str) -> bool {
    key.starts_with('@') || key.contains(['/', ':', '#', ' '])
}

/// `renderKey` / `renderYamlKey`: the key, in single quotes (doubled inside) when YAML needs them.
pub(super) fn render_key(key: &str) -> String {
    if needs_quote(key) {
        format!("'{}'", key.replace('\'', "''"))
    } else {
        key.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_line_is_found_at_any_line_start_and_not_inside_a_longer_key() {
        let content = "a: 1\nminimumReleaseAgeExclude:\n  - x\nminimumReleaseAge :  5\n";
        let range = entry_line(content, "minimumReleaseAge").unwrap();

        assert_eq!(&content[range], "minimumReleaseAge :  5");
        assert!(entry_line("  minimumReleaseAge: 1\n", "minimumReleaseAge").is_none());
        assert!(entry_line("x: minimumReleaseAge: 1", "minimumReleaseAge").is_none());
    }

    #[test]
    fn a_block_ends_at_the_first_line_without_two_blanks() {
        let content = "a: 1\nallowBuilds:  \n  x: true\n \ty: true\n# note\n  z: true\nb: 2\n";
        let range = block(content, "allowBuilds").unwrap();

        assert_eq!(&content[range], "allowBuilds:  \n  x: true\n \ty: true\n");
        assert!(block("allowBuilds:", "allowBuilds").is_none());
        assert!(block("allowBuilds: x\n", "allowBuilds").is_none());
    }

    #[test]
    fn a_block_at_the_end_needs_its_last_line_break() {
        assert_eq!(block("allowBuilds:\n  a: true", "allowBuilds"), Some(0..13));
    }

    #[test]
    fn replacing_and_appending_follow_replace_and_trim_end() {
        assert_eq!(replace_or_append("a: 1\n\n", None, "", "k: 2\n"), "a: 1\n\nk: 2\n");
        assert_eq!(replace_or_append("a: 1\nk: 0\n", Some(5..9), "k: 2", ""), "a: 1\nk: 2\n");
    }

    #[test]
    fn keys_are_quoted_like_the_node_helper() {
        assert_eq!(render_key("esbuild"), "esbuild");
        assert_eq!(render_key("@scope/x"), "'@scope/x'");
        assert_eq!(render_key("a:b"), "'a:b'");
        assert_eq!(render_key("it's #1"), "'it''s #1'");
    }
}
