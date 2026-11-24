//! The JavaScript behaviours the native `vis` CLI and the Node hasher both need: what `trim` strips, `Number.parseInt`
//! and `JSON.stringify` of a string.

/// JS `String.prototype.trim` whitespace: the Unicode space separators, the line
/// terminators, tab, vertical tab, form feed and the byte order mark.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `Number.parseInt(text.trim(), 10)`: an optional sign and the leading decimal
/// digits, anything after them ignored. `None` is NaN. A value beyond `i64`
/// saturates; it is no exit code a process can have.
pub fn parse_int(text: &str) -> Option<i64> {
    let trimmed = text.trim_matches(is_js_whitespace);
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: &str = &digits[..digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len())];

    if digits.is_empty() {
        return None;
    }

    let magnitude = digits
        .bytes()
        .try_fold(0i64, |acc, digit| acc.checked_mul(10)?.checked_add(i64::from(digit - b'0')))
        .unwrap_or(i64::MAX);

    Some(if negative { -magnitude } else { magnitude })
}

/// Serialises `text` as `JSON.stringify` does: the escapes `\"` `\\` `\b` `\f` `\n`
/// `\r` `\t`, `\u00xx` for the other control characters, everything else verbatim
/// (Rust strings cannot hold the lone surrogates `JSON.stringify` escapes).
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);

    out.push('"');

    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }

    out.push('"');

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_follows_js() {
        assert_eq!(parse_int("0"), Some(0));
        assert_eq!(parse_int(" 12\n"), Some(12));
        assert_eq!(parse_int("0x1f"), Some(0));
        assert_eq!(parse_int("12abc"), Some(12));
        assert_eq!(parse_int("-3"), Some(-3));
        assert_eq!(parse_int("+7"), Some(7));
        assert_eq!(parse_int("\u{feff}1"), Some(1));
        assert_eq!(parse_int("1e3"), Some(1));
        assert_eq!(parse_int("3.9"), Some(3));
        assert_eq!(parse_int(""), None);
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int("-"), None);
        assert_eq!(parse_int("\u{85}1"), None, "U+0085 is not JS whitespace");
        assert_eq!(parse_int("99999999999999999999"), Some(i64::MAX));
    }

    #[test]
    fn json_strings_are_escaped_like_js() {
        assert_eq!(json_string("plain"), "\"plain\"");
        assert_eq!(json_string("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(json_string("l1\nl2\r\t\u{8}\u{c}"), r#""l1\nl2\r\t\b\f""#);
        assert_eq!(json_string("\u{0}\u{1f}\u{b}"), r#""\u0000\u001f\u000b""#);
        assert_eq!(json_string("é€😀\u{7f}\u{2028}"), "\"é€😀\u{7f}\u{2028}\"");
    }
}
