//! The YAML the renderers emit by hand (`src/util/ci-workflow/yaml.ts`): double-quoted scalars,
//! `|` blocks for multi-line strings, and maps and lists nested four spaces deeper per level.

use crate::js::{is_index_like, js_number, json_string};

/// A config value the renderers print: scalars, lists and maps, with a map's keys in source order.
/// `null`, a list inside a list and a key that sorts as an array index in JavaScript never get this
/// far (the config reader hands those runs to Node), so every shape here prints as Node prints it.
#[derive(Clone, Debug, PartialEq)]
pub enum Yaml {
    Bool(bool),
    List(Vec<Yaml>),
    Map(Vec<(String, Yaml)>),
    Number(f64),
    Str(String),
}

impl Yaml {
    pub fn str(value: impl Into<String>) -> Yaml {
        Yaml::Str(value.into())
    }

    /// A map of string values from `(key, value)` pairs.
    pub fn strings<K: Into<String>, V: Into<String>>(pairs: impl IntoIterator<Item = (K, V)>) -> Yaml {
        Yaml::Map(pairs.into_iter().map(|(key, value)| (key.into(), Yaml::Str(value.into()))).collect())
    }

    fn is_scalar(&self) -> bool {
        matches!(self, Yaml::Bool(_) | Yaml::Number(_) | Yaml::Str(_))
    }
}

/// `/^[\w.-]+$/u`: `\w` is ASCII only.
fn plain_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn key(key: &str) -> String {
    if plain_key(key) {
        key.to_owned()
    } else {
        json_string(key)
    }
}

/// A scalar value; a multi-line string becomes a `|` block indented at `block_indent`.
fn scalar(value: &Yaml, block_indent: &str) -> String {
    match value {
        Yaml::Bool(value) => value.to_string(),
        Yaml::Number(value) => js_number(*value),
        Yaml::Str(value) if value.contains('\n') => {
            let body = value.strip_suffix('\n').unwrap_or(value);
            let lines: Vec<String> = body.split('\n').map(|line| format!("{block_indent}{line}")).collect();

            format!("|\n{}", lines.join("\n"))
        }
        Yaml::Str(value) => json_string(value),
        Yaml::List(_) | Yaml::Map(_) => String::new(),
    }
}

/// A map's members as `key: value` lines at `indent`.
fn map_entries(entries: &[(String, Yaml)], indent: &str) -> Vec<String> {
    entries.iter().flat_map(|(name, child)| entry(name, child, indent)).collect()
}

/// `key: value` lines at `indent`.
pub fn entry(name: &str, value: &Yaml, indent: &str) -> Vec<String> {
    let nested = format!("{indent}    ");

    match value {
        Yaml::Map(entries) => {
            let mut lines = vec![format!("{indent}{}:", key(name))];

            lines.extend(map_entries(entries, &nested));

            lines
        }
        Yaml::List(items) => {
            let mut lines = vec![format!("{indent}{}:", key(name))];

            for item in items {
                if item.is_scalar() {
                    lines.push(format!("{nested}- {}", scalar(item, &format!("{nested}    "))));

                    continue;
                }

                // A map item: its first line carries the `- `, the rest line up under it.
                let Yaml::Map(entries) = item else {
                    continue;
                };
                let rendered = map_entries(entries, &format!("{nested}  "));
                let mut rendered = rendered.into_iter();
                let first = rendered.next().unwrap_or_default();

                lines.push(format!("{nested}- {}", first.trim_start()));
                lines.extend(rendered);
            }

            lines
        }
        scalar_value => vec![format!("{indent}{}: {}", key(name), scalar(scalar_value, &nested))],
    }
}

/// Whether Node prints `value` exactly as [`entry`] does. A list inside a list is rendered by Node as a
/// map keyed by index, and a key JavaScript sorts as an array index moves to the front of its map.
pub fn printable(value: &Yaml) -> bool {
    match value {
        Yaml::List(items) => items.iter().all(|item| !matches!(item, Yaml::List(_)) && printable(item)),
        Yaml::Map(entries) => entries.iter().all(|(name, child)| !is_index_like(name) && printable(child)),
        Yaml::Number(value) => value.is_finite(),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_are_quoted_like_json() {
        assert_eq!(json_string("plain"), "\"plain\"");
        assert_eq!(json_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(json_string("tab\tline\nret\r\u{8}\u{c}"), "\"tab\\tline\\nret\\r\\b\\f\"");
        assert_eq!(json_string("\u{1}\u{1f}"), "\"\\u0001\\u001f\"");
        // DEL, U+2028 and non-ASCII text stay raw, as `JSON.stringify` leaves them.
        assert_eq!(json_string("\u{7f}\u{2028}é☃😀"), "\"\u{7f}\u{2028}é☃😀\"");
    }

    #[test]
    fn keys_are_quoted_unless_plain() {
        assert_eq!(key("fetch-depth"), "fetch-depth");
        assert_eq!(key("a.b_c"), "a.b_c");
        assert_eq!(key("a b"), "\"a b\"");
        assert_eq!(key("é"), "\"é\"");
        assert_eq!(key(""), "\"\"");
    }

    #[test]
    fn multi_line_strings_become_blocks_without_the_trailing_newline() {
        let lines = entry("run", &Yaml::str("a\n\nb\n"), "  ");

        assert_eq!(lines, vec!["  run: |\n      a\n      \n      b".to_owned()]);
    }

    #[test]
    fn maps_and_lists_nest_four_spaces_per_level() {
        let value = Yaml::Map(vec![
            ("image".to_owned(), Yaml::str("postgres:17")),
            ("ports".to_owned(), Yaml::List(vec![Yaml::str("5432:5432"), Yaml::Number(80.0), Yaml::Bool(true)])),
            ("empty".to_owned(), Yaml::Map(vec![])),
        ]);

        assert_eq!(
            entry("db", &value, "").join("\n"),
            "db:\n    image: \"postgres:17\"\n    ports:\n        - \"5432:5432\"\n        - 80\n        - true\n    empty:"
        );
    }

    #[test]
    fn a_list_of_maps_puts_the_dash_on_the_first_key() {
        let value = Yaml::List(vec![Yaml::Map(vec![
            ("name".to_owned(), Yaml::str("x")),
            ("alias".to_owned(), Yaml::str("y")),
        ])]);

        assert_eq!(entry("services", &value, "").join("\n"), "services:\n    - name: \"x\"\n      alias: \"y\"");
    }

    #[test]
    fn what_node_orders_differently_is_not_printable() {
        assert!(printable(&Yaml::Map(vec![("a".to_owned(), Yaml::Number(1.0))])));
        assert!(!printable(&Yaml::Map(vec![("1".to_owned(), Yaml::str("x"))])));
        // A key with a leading zero or no text is an ordinary key, kept in insertion order.
        assert!(printable(&Yaml::Map(vec![("007".to_owned(), Yaml::str("x")), (String::new(), Yaml::str("y"))])));
        assert!(!printable(&Yaml::Map(vec![("__proto__".to_owned(), Yaml::str("x"))])));
        assert!(!printable(&Yaml::List(vec![Yaml::List(vec![])])));
        assert!(!printable(&Yaml::Number(f64::INFINITY)));
    }
}
