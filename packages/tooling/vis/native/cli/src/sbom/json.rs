//! An ordered JSON value and the writer for `JSON.stringify(value, undefined, 2)`.
//!
//! The BOM's key order is the insertion order of the Node objects, so the values are built
//! by hand instead of through a map type that sorts or hashes its keys.

pub(super) enum Json {
    Array(Vec<Json>),
    Number(u64),
    Object(Vec<(&'static str, Json)>),
    String(String),
}

impl Json {
    pub(super) fn string(text: impl Into<String>) -> Self {
        Self::String(text.into())
    }

    /// The text `JSON.stringify(self, undefined, 2)` gives.
    pub(super) fn pretty(&self) -> String {
        let mut out = String::new();

        self.write(&mut out, 0);

        out
    }

    fn write(&self, out: &mut String, depth: usize) {
        match self {
            Self::Number(number) => out.push_str(&number.to_string()),
            Self::String(text) => write_string(out, text),
            Self::Array(items) => write_items(out, depth, '[', ']', items.iter().map(|item| (None, item))),
            Self::Object(entries) => {
                write_items(out, depth, '{', '}', entries.iter().map(|(key, value)| (Some(*key), value)));
            }
        }
    }
}

fn write_items<'a>(
    out: &mut String,
    depth: usize,
    open: char,
    close: char,
    items: impl ExactSizeIterator<Item = (Option<&'a str>, &'a Json)>,
) {
    out.push(open);

    if items.len() == 0 {
        out.push(close);

        return;
    }

    let last = items.len() - 1;

    for (index, (key, value)) in items.enumerate() {
        out.push('\n');
        out.push_str(&"  ".repeat(depth + 1));

        if let Some(key) = key {
            write_string(out, key);
            out.push_str(": ");
        }

        value.write(out, depth + 1);

        if index != last {
            out.push(',');
        }
    }

    out.push('\n');
    out.push_str(&"  ".repeat(depth));
    out.push(close);
}

/// A JSON string as `JSON.stringify` writes it: the two quotes and the five short escapes, the other
/// control characters as lower-case `\u00xx`, and everything else (including U+2028) verbatim.
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
    use super::Json;

    #[test]
    fn writes_like_json_stringify_with_two_spaces() {
        let value = Json::Object(vec![
            ("a", Json::Array(vec![])),
            ("b", Json::Object(vec![])),
            ("c", Json::Array(vec![Json::string("x\"\\\n\u{1}\u{7f}\u{2028}é"), Json::Number(1)])),
        ]);

        assert_eq!(
            value.pretty(),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    \"x\\\"\\\\\\n\\u0001\u{7f}\u{2028}é\",\n    1\n  ]\n}"
        );
    }
}
