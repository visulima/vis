//! A strict JSON reader and a `JSON.stringify` writer, for the documents where both agree with JavaScript.
//!
//! Node reads `package.json` with `JSON.parse` and writes it with `JSON.stringify(value, null, indent)`.
//! The reader here accepts a document only when `JSON.parse` would give the same value in the same order
//! and the writer reproduces `JSON.stringify` byte for byte. Everything else makes [`parse`] return `None`
//! so the caller hands the command to Node:
//!
//! - duplicate keys, a `__proto__` key, and keys JavaScript orders first (array indices), because a JS
//!   object does not keep insertion order for those and assigns `__proto__` through the prototype setter;
//! - numbers other than plain integers below 2^53 (`-0`, fractions, exponents), whose text JS rewrites;
//! - lone surrogate escapes, which `JSON.parse` keeps and Rust strings cannot hold;
//! - nesting deeper than [`MAX_DEPTH`].

/// Deeper documents are left to Node (the sorter crate itself stops at 128).
const MAX_DEPTH: usize = 64;

/// The largest integer a JS number holds exactly: 2^53 - 1.
const MAX_SAFE_DIGITS: usize = 15;

/// A JSON value. Objects keep their key order.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// An integer of at most 15 digits.
    Int(i64),
    Str(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Self::Object(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(text) => Some(text),
            _ => None,
        }
    }
}

/// Parses `text` as one JSON document, or `None` when it is invalid or JavaScript would read it differently.
pub fn parse(text: &str) -> Option<Json> {
    let mut reader = Reader { bytes: text.as_bytes(), position: 0 };

    reader.skip_whitespace();

    let value = reader.value(0)?;

    reader.skip_whitespace();

    (reader.position == reader.bytes.len()).then_some(value)
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Option<()> {
        (self.peek() == Some(byte)).then(|| self.position += 1)
    }

    fn literal(&mut self, word: &str, value: Json) -> Option<Json> {
        let end = self.position.checked_add(word.len())?;

        (self.bytes.get(self.position..end)? == word.as_bytes()).then(|| {
            self.position = end;
            value
        })
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }

        match self.peek()? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => self.string().map(Json::Str),
            b't' => self.literal("true", Json::Bool(true)),
            b'f' => self.literal("false", Json::Bool(false)),
            b'n' => self.literal("null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.position;
        let negative = self.peek() == Some(b'-');

        if negative {
            self.position += 1;
        }

        let digits_start = self.position;

        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.position += 1;
        }

        let digits = &self.bytes[digits_start..self.position];

        // No leading zero, no `-0` (JS prints it as `0`), and nothing past a plain integer.
        let plain = !digits.is_empty()
            && digits.len() <= MAX_SAFE_DIGITS
            && (digits[0] != b'0' || digits.len() == 1)
            && !(negative && digits == b"0")
            && !matches!(self.peek(), Some(b'.' | b'e' | b'E'));

        if !plain {
            return None;
        }

        std::str::from_utf8(&self.bytes[start..self.position]).ok()?.parse().ok().map(Json::Int)
    }

    fn string(&mut self) -> Option<String> {
        self.expect(b'"')?;

        let mut text = String::new();

        loop {
            let run_start = self.position;

            while !matches!(self.peek()?, b'"' | b'\\' | 0..=0x1f) {
                self.position += 1;
            }

            // The input is a `&str` and the run stops at an ASCII byte, so it ends on a char boundary.
            text.push_str(std::str::from_utf8(&self.bytes[run_start..self.position]).ok()?);

            match self.peek()? {
                b'"' => {
                    self.position += 1;

                    return Some(text);
                }
                b'\\' => {
                    self.position += 1;
                    text.push(self.escape()?);
                }
                _ => return None,
            }
        }
    }

    fn escape(&mut self) -> Option<char> {
        let byte = self.peek()?;

        self.position += 1;

        Some(match byte {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{8}',
            b'f' => '\u{c}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => {
                let unit = self.hex4()?;

                match unit {
                    0xd800..=0xdbff => {
                        self.expect(b'\\')?;
                        self.expect(b'u')?;

                        let low = self.hex4()?;

                        if !(0xdc00..=0xdfff).contains(&low) {
                            return None;
                        }

                        char::from_u32(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00))?
                    }
                    // A lone low surrogate.
                    0xdc00..=0xdfff => return None,
                    _ => char::from_u32(unit)?,
                }
            }
            _ => return None,
        })
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = self.bytes.get(self.position..self.position.checked_add(4)?)?;
        let mut unit = 0;

        for byte in digits {
            unit = unit * 16 + char::from(*byte).to_digit(16)?;
        }

        self.position += 4;

        Some(unit)
    }

    fn array(&mut self, depth: usize) -> Option<Json> {
        self.expect(b'[')?;
        self.skip_whitespace();

        let mut items = Vec::new();

        if self.peek() == Some(b']') {
            self.position += 1;

            return Some(Json::Array(items));
        }

        loop {
            self.skip_whitespace();
            items.push(self.value(depth + 1)?);
            self.skip_whitespace();

            match self.peek()? {
                b',' => self.position += 1,
                b']' => {
                    self.position += 1;

                    return Some(Json::Array(items));
                }
                _ => return None,
            }
        }
    }

    fn object(&mut self, depth: usize) -> Option<Json> {
        self.expect(b'{')?;
        self.skip_whitespace();

        let mut entries: Vec<(String, Json)> = Vec::new();

        if self.peek() == Some(b'}') {
            self.position += 1;

            return Some(Json::Object(entries));
        }

        loop {
            self.skip_whitespace();

            let key = self.string()?;

            if is_order_sensitive_key(&key) || entries.iter().any(|(name, _)| *name == key) {
                return None;
            }

            self.skip_whitespace();
            self.expect(b':')?;
            self.skip_whitespace();

            let value = self.value(depth + 1)?;

            entries.push((key, value));
            self.skip_whitespace();

            match self.peek()? {
                b',' => self.position += 1,
                b'}' => {
                    self.position += 1;

                    return Some(Json::Object(entries));
                }
                _ => return None,
            }
        }
    }
}

/// `__proto__`, and the keys a JS object lists before all others: canonical array indices (`"0"`, `"17"`, up
/// to 2^32 - 2). Every all-digit key without a leading zero is treated as one, which only over-delegates.
fn is_order_sensitive_key(key: &str) -> bool {
    key == "__proto__"
        || (!key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit()) && (key == "0" || !key.starts_with('0')))
}

/// `JSON.stringify(value, null, indent)`. `indent` is what JS calls the gap: at most its first ten
/// characters are used, and an empty one gives the compact form with no spaces at all.
pub fn stringify(value: &Json, indent: &str) -> String {
    // Every indent this port produces is spaces and tabs, so ten bytes are ten UTF-16 units.
    let gap = &indent[..indent.len().min(10)];
    let mut out = String::new();

    write_value(&mut out, value, gap, 0);

    out
}

fn write_value(out: &mut String, value: &Json, gap: &str, depth: usize) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Int(number) => out.push_str(&number.to_string()),
        Json::Str(text) => write_string(out, text),
        Json::Array(items) => write_container(out, '[', ']', items.len(), gap, depth, |out, index| {
            write_value(out, &items[index], gap, depth + 1);
        }),
        Json::Object(entries) => write_container(out, '{', '}', entries.len(), gap, depth, |out, index| {
            write_string(out, &entries[index].0);
            out.push(':');

            if !gap.is_empty() {
                out.push(' ');
            }

            write_value(out, &entries[index].1, gap, depth + 1);
        }),
    }
}

fn write_container(
    out: &mut String,
    open: char,
    close: char,
    length: usize,
    gap: &str,
    depth: usize,
    mut item: impl FnMut(&mut String, usize),
) {
    out.push(open);

    if length == 0 {
        out.push(close);

        return;
    }

    for index in 0..length {
        if index > 0 {
            out.push(',');
        }

        newline(out, gap, depth + 1);
        item(out, index);
    }

    newline(out, gap, depth);
    out.push(close);
}

fn newline(out: &mut String, gap: &str, depth: usize) {
    if gap.is_empty() {
        return;
    }

    out.push('\n');

    for _ in 0..depth {
        out.push_str(gap);
    }
}

/// `JSON.stringify` of a string: the two quote characters, the short escapes, `\u00xx` (lower-case) for the
/// other control characters, and everything else as is.
fn write_string(out: &mut String, text: &str) {
    out.push('"');

    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if control < ' ' => out.push_str(&format!("\\u{:04x}", u32::from(control))),
            other => out.push(other),
        }
    }

    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(text: &str, indent: &str) -> Option<String> {
        parse(text).map(|value| stringify(&value, indent))
    }

    #[test]
    fn it_writes_what_json_stringify_writes() {
        assert_eq!(
            round(r#"{"a":[1,{"b":null}],"c":{},"d":[]}"#, "  ").unwrap(),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": null\n    }\n  ],\n  \"c\": {},\n  \"d\": []\n}"
        );
        assert_eq!(round(r#"{"a": [1, true], "b": "x"}"#, "").unwrap(), r#"{"a":[1,true],"b":"x"}"#);
        assert_eq!(round(r#"{"a":1}"#, "\t").unwrap(), "{\n\t\"a\": 1\n}");
    }

    #[test]
    fn the_indent_is_cut_to_ten_characters() {
        assert_eq!(round(r#"{"a":1}"#, &" ".repeat(12)).unwrap(), format!("{{\n{}\"a\": 1\n}}", " ".repeat(10)));
    }

    #[test]
    fn strings_use_the_json_stringify_escapes() {
        let text = parse(r#"["\u0001\u001f\u007f 😀\/\b\f"]"#).unwrap();

        assert_eq!(stringify(&text, ""), "[\"\\u0001\\u001f\u{7f}\u{2028}\u{1f600}/\\b\\f\"]");
    }

    #[test]
    fn it_declines_what_js_reads_differently() {
        for text in [
            r#"{"a":1,"a":2}"#,
            r#"{"__proto__":{}}"#,
            r#"{"1":1}"#,
            r#"{"a":1.5}"#,
            r#"{"a":1e3}"#,
            r#"{"a":-0}"#,
            r#"{"a":9007199254740993}"#,
            r#"{"a":"\ud800"}"#,
            r#"{"a":"\udc00x"}"#,
            "{\"a\":\"tab\there\"}",
            "{\"a\":01}",
            "{\"a\":1,}",
            "{\"a\":1} x",
            "",
        ] {
            assert_eq!(parse(text), None, "{text:?}");
        }

        assert!(parse(&format!("{}1{}", "[".repeat(80), "]".repeat(80))).is_none());
    }

    #[test]
    fn keys_that_only_look_numeric_stay_in_order() {
        assert!(parse(r#"{"01":1,"-1":2,"1a":3}"#).is_some());
    }
}
