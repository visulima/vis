//! One read and one parse of a project's `package.json`, shared by every native command that looks at it.
//!
//! The project membership (`workspace`), the dependency graph (`graph`) and the listing (`list`) each used to
//! read and parse the file on their own. The parse here keeps the text of each field a consumer reads, and the
//! consumer applies its own rule to it, so a field one of them rejects (a `null` dependency map, a repeated
//! key) does not change what another accepts.

use std::fmt;
use std::fs;
use std::path::Path;

use serde::de::{self, Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;
use serde_json::Value;

/// The fields whose repetition makes the graph delegate (a derived struct refuses a repeated field).
pub(crate) const GRAPH_FIELDS: u8 = NAME | BIN | DEPENDENCIES | DEV_DEPENDENCIES | PEER_DEPENDENCIES;

/// The fields whose repetition makes the listing delegate.
pub(crate) const LIST_FIELDS: u8 =
    SCRIPTS | DEPENDENCIES | DEV_DEPENDENCIES | OPTIONAL_DEPENDENCIES | PEER_DEPENDENCIES;

const NAME: u8 = 1;
const BIN: u8 = 1 << 1;
const SCRIPTS: u8 = 1 << 2;
const DEPENDENCIES: u8 = 1 << 3;
const DEV_DEPENDENCIES: u8 = 1 << 4;
const PEER_DEPENDENCIES: u8 = 1 << 5;
const OPTIONAL_DEPENDENCIES: u8 = 1 << 6;

/// A parsed `package.json`: the top-level object, with the fields the native commands read kept as text. The last
/// of a repeated key wins, as in `JSON.parse`, and `repeated` records which known fields were given more than once.
#[derive(Debug, Default)]
pub(crate) struct PackageJson {
    name: Option<Box<RawValue>>,
    /// Whether `bin` is present at all, whatever its value: Node tests `bin !== undefined`.
    pub(crate) has_bin: bool,
    pub(crate) scripts: Option<Box<RawValue>>,
    pub(crate) dependencies: Option<Box<RawValue>>,
    pub(crate) dev_dependencies: Option<Box<RawValue>>,
    pub(crate) peer_dependencies: Option<Box<RawValue>>,
    pub(crate) optional_dependencies: Option<Box<RawValue>>,
    repeated: u8,
}

impl PackageJson {
    /// Reads and parses `directory/package.json`; `None` when it is missing, unreadable or not a JSON object.
    pub(crate) fn read(directory: &Path) -> Option<Self> {
        serde_json::from_str(&fs::read_to_string(directory.join("package.json")).ok()?).ok()
    }

    /// The project name, when it is a non-empty string other than `__proto__`. Node drops a project with an empty
    /// name (`if (!projectName) continue`), and it stores projects on a plain object, where `__proto__` sets the
    /// prototype instead of adding one.
    pub(crate) fn name(&self) -> Option<String> {
        serde_json::from_str::<String>(self.name.as_deref()?.get())
            .ok()
            .filter(|name| !name.is_empty() && name != "__proto__")
    }

    /// Whether one of the fields in `fields` (`GRAPH_FIELDS`, `LIST_FIELDS`) was given more than once.
    pub(crate) fn repeats(&self, fields: u8) -> bool {
        self.repeated & fields != 0
    }
}

/// Parses the text of a field with its consumer's own rule: a missing field is the type's default, and `None`
/// means the consumer refuses the field.
pub(crate) fn parse_field<'a, T: Deserialize<'a> + Default>(field: Option<&'a RawValue>) -> Option<T> {
    match field {
        None => Some(T::default()),
        Some(raw) => serde_json::from_str(raw.get()).ok(),
    }
}

impl<'de> Deserialize<'de> for PackageJson {
    /// An object only: a derived struct would also take a JSON array here.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(PackageJsonVisitor)
    }
}

struct PackageJsonVisitor;

impl<'de> Visitor<'de> for PackageJsonVisitor {
    type Value = PackageJson;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a package.json object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<PackageJson, A::Error> {
        let mut package = PackageJson::default();
        let mut seen = 0_u8;

        while let Some(key) = map.next_key::<String>()? {
            let (bit, slot) = match key.as_str() {
                "name" => (NAME, Some(&mut package.name)),
                "scripts" => (SCRIPTS, Some(&mut package.scripts)),
                "dependencies" => (DEPENDENCIES, Some(&mut package.dependencies)),
                "devDependencies" => (DEV_DEPENDENCIES, Some(&mut package.dev_dependencies)),
                "peerDependencies" => (PEER_DEPENDENCIES, Some(&mut package.peer_dependencies)),
                "optionalDependencies" => (OPTIONAL_DEPENDENCIES, Some(&mut package.optional_dependencies)),
                "bin" => (BIN, None),
                _ => {
                    map.next_value::<Value>()?;

                    continue;
                }
            };

            package.repeated |= seen & bit;
            seen |= bit;

            match slot {
                Some(slot) => {
                    let raw = map.next_value::<Box<RawValue>>()?;

                    // Skipping a value does not check it as parsing it does (a number beyond `f64`, a lone surrogate
                    // escape), and a manifest the whole-file parse refused is still refused.
                    serde_json::from_str::<Value>(raw.get()).map_err(de::Error::custom)?;

                    *slot = Some(raw);
                }
                None => {
                    map.next_value::<Value>()?;

                    package.has_bin = true;
                }
            }
        }

        Ok(package)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Option<PackageJson> {
        serde_json::from_str(text).ok()
    }

    #[test]
    fn the_name_is_a_non_empty_string_other_than_the_prototype_key() {
        assert_eq!(parse(r#"{"name":"a"}"#).unwrap().name().as_deref(), Some("a"));

        for text in [r#"{}"#, r#"{"name":""}"#, r#"{"name":null}"#, r#"{"name":1}"#, r#"{"name":"__proto__"}"#] {
            assert_eq!(parse(text).unwrap().name(), None, "{text}");
        }
    }

    #[test]
    fn the_last_of_a_repeated_name_wins() {
        assert_eq!(parse(r#"{"name":"a","name":"b"}"#).unwrap().name().as_deref(), Some("b"));
        assert_eq!(parse(r#"{"name":"a","name":""}"#).unwrap().name(), None);
    }

    /// An unread field is parsed (and dropped) as the whole-file `Value` parse did, so what that parse refused is
    /// still refused: a number beyond `f64`, a lone surrogate escape, nesting past the parser's limit.
    #[test]
    fn a_value_the_whole_file_parse_refused_is_still_refused() {
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        let cases = [
            r#"{"name":"a","extra":1e999}"#.to_owned(),
            r#"{"name":"a","extra":"\ud800"}"#.to_owned(),
            r#"{"name":"a","bin":1e999}"#.to_owned(),
            r#"{"name":"a","dependencies":{"b":1e999}}"#.to_owned(),
            format!(r#"{{"name":"a","extra":{deep}}}"#),
        ];

        for text in &cases {
            assert!(serde_json::from_str::<Value>(text).is_err(), "{}", &text[..30.min(text.len())]);
            assert!(parse(text).is_none(), "{}", &text[..30.min(text.len())]);
        }
    }

    #[test]
    fn only_an_object_is_a_manifest() {
        for text in ["[]", r#"["a"]"#, "null", "1", r#""a""#, "{", ""] {
            assert!(parse(text).is_none(), "{text}");
        }
    }

    #[test]
    fn a_repeated_field_is_known_to_the_consumers_that_refuse_it() {
        let package = parse(r#"{"scripts":{},"optionalDependencies":{},"optionalDependencies":{}}"#).unwrap();

        assert!(package.repeats(LIST_FIELDS));
        assert!(!package.repeats(GRAPH_FIELDS));

        let package = parse(r#"{"bin":"a","bin":"b","scripts":{}}"#).unwrap();

        assert!(package.repeats(GRAPH_FIELDS));
        assert!(!package.repeats(LIST_FIELDS));
        assert!(package.has_bin);
    }

    #[test]
    fn a_present_bin_of_any_value_counts() {
        assert!(parse(r#"{"bin":null}"#).unwrap().has_bin);
        assert!(!parse(r#"{}"#).unwrap().has_bin);
    }

    #[test]
    fn a_field_is_parsed_with_its_consumers_rule() {
        let package = parse(r#"{"dependencies":null,"scripts":{"a":"b"}}"#).unwrap();

        assert_eq!(parse_field::<Option<Vec<String>>>(package.dependencies.as_deref()), Some(None));
        assert!(parse_field::<Vec<String>>(package.dependencies.as_deref()).is_none());
        assert_eq!(parse_field::<Option<String>>(None), Some(None));
    }
}
