//! What a `package.json` adds to a component: description, author, licence and external references
//! (`decoratePackageComponent`), read from a workspace project or from the installed copy of a
//! registry package (`readInstalledPackageMetadata`).
//!
//! Every field is read with the truthiness rules of the Node code. A value of a type that Node would pass
//! through to the BOM untouched (a number as a description, say) is [`Unsupported`] here, as is a file that
//! exists but that `serde_json` and `JSON.parse` might read differently.

use std::cell::OnceCell;
use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// The input is outside what this port reproduces; the Node CLI answers.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Unsupported;

/// A dependency map in `Object.entries` order (a repeated key keeps its first place and its last value).
#[derive(Default)]
pub(super) enum Deps {
    #[default]
    Absent,
    Map(Vec<(String, Value)>),
    /// A string, number, array or boolean: `Object.entries` of those is not a dependency list.
    Other,
}

impl<'de> Deserialize<'de> for Deps {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(DepsVisitor)
    }
}

struct DepsVisitor;

impl<'de> Visitor<'de> for DepsVisitor {
    type Value = Deps;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_unit<E>(self) -> Result<Deps, E> {
        Ok(Deps::Absent)
    }

    fn visit_bool<E>(self, _: bool) -> Result<Deps, E> {
        Ok(Deps::Other)
    }

    fn visit_i64<E>(self, _: i64) -> Result<Deps, E> {
        Ok(Deps::Other)
    }

    fn visit_u64<E>(self, _: u64) -> Result<Deps, E> {
        Ok(Deps::Other)
    }

    fn visit_f64<E>(self, _: f64) -> Result<Deps, E> {
        Ok(Deps::Other)
    }

    fn visit_str<E>(self, _: &str) -> Result<Deps, E> {
        Ok(Deps::Other)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Deps, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}

        Ok(Deps::Other)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Deps, A::Error> {
        let mut entries: Vec<(String, Value)> = Vec::new();

        while let Some((key, value)) = map.next_entry::<String, Value>()? {
            match entries.iter_mut().find(|(existing, _)| *existing == key) {
                Some(slot) => slot.1 = value,
                None => entries.push((key, value)),
            }
        }

        Ok(Deps::Map(entries))
    }
}

/// The fields of a `package.json` that the BOM reads.
#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Manifest {
    pub(super) name: Option<Value>,
    pub(super) version: Option<Value>,
    description: Option<Value>,
    author: Option<Value>,
    license: Option<Value>,
    licenses: Option<Value>,
    homepage: Option<Value>,
    repository: Option<Value>,
    bugs: Option<Value>,
    pub(super) dependencies: Deps,
    #[serde(rename = "devDependencies")]
    pub(super) dev_dependencies: Deps,
    #[serde(rename = "peerDependencies")]
    pub(super) peer_dependencies: Deps,
    #[serde(rename = "optionalDependencies")]
    pub(super) optional_dependencies: Deps,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum License {
    Id(String),
    Name(String),
    Expression(String),
}

/// The decoration of one component, in the order the Node code adds it.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Decoration {
    pub(super) description: Option<String>,
    pub(super) author: Option<String>,
    pub(super) licenses: Option<License>,
    pub(super) references: Vec<(&'static str, String)>,
}

/// A JavaScript truthiness test on a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value` when it is a truthy string, `None` when it is falsy, and an error when Node would pass another
/// kind of value on.
fn text(value: Option<&Value>) -> Result<Option<&str>, Unsupported> {
    match value {
        None => Ok(None),
        Some(value) if !truthy(value) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(Unsupported),
    }
}

fn author(value: Option<&Value>) -> Result<Option<String>, Unsupported> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
        Some(Value::Object(map)) => {
            let Some(name) = text(map.get("name"))? else {
                return Ok(None);
            };

            Ok(Some(match text(map.get("email"))? {
                Some(email) => format!("{name} <{email}>"),
                None => name.to_owned(),
            }))
        }
        _ => Ok(None),
    }
}

/// `repository` and `bugs`: a string is the URL; an object has it under `url`.
fn url(value: Option<&Value>) -> Result<Option<String>, Unsupported> {
    match value {
        Some(Value::Object(map)) => Ok(text(map.get("url"))?.map(str::to_owned)),
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
        _ => Ok(None),
    }
}

const KNOWN_SPDX_IDS: [&str; 36] = [
    "0BSD",
    "AGPL-3.0",
    "AGPL-3.0-only",
    "AGPL-3.0-or-later",
    "Apache-1.1",
    "Apache-2.0",
    "Artistic-2.0",
    "BlueOak-1.0.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSL-1.0",
    "CC0-1.0",
    "CC-BY-3.0",
    "CC-BY-4.0",
    "CDDL-1.0",
    "CDDL-1.1",
    "EPL-1.0",
    "EPL-2.0",
    "GPL-2.0",
    "GPL-2.0-only",
    "GPL-2.0-or-later",
    "GPL-3.0",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "ISC",
    "LGPL-2.0",
    "LGPL-2.1",
    "LGPL-3.0",
    "MIT",
    "MIT-0",
    "MPL-1.1",
    "MPL-2.0",
    "Python-2.0",
    "Unlicense",
    "WTFPL",
    "Zlib",
];

/// The common spellings `normalizeSpdxId` maps to an identifier (lower case).
const SPDX_ALIASES: [(&str, &str); 8] = [
    ("apache2", "Apache-2.0"),
    ("apache 2.0", "Apache-2.0"),
    ("bsd", "BSD-3-Clause"),
    ("bsd-2", "BSD-2-Clause"),
    ("bsd-3", "BSD-3-Clause"),
    ("mit", "MIT"),
    ("public", "Unlicense"),
    ("public domain", "Unlicense"),
];

fn normalize_spdx_id(trimmed: &str) -> Option<&'static str> {
    if let Some(known) = KNOWN_SPDX_IDS.iter().find(|known| **known == trimmed) {
        return Some(known);
    }

    let lower = trimmed.to_ascii_lowercase();

    SPDX_ALIASES
        .iter()
        .find(|(alias, _)| *alias == lower)
        .map(|(_, canonical)| *canonical)
        .or_else(|| KNOWN_SPDX_IDS.iter().find(|known| known.to_ascii_lowercase() == lower).copied())
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `/[()]|\b(?:and|or|with)\b/i` on ASCII text.
fn is_expression(text: &str) -> bool {
    if text.contains(['(', ')']) {
        return true;
    }

    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    ["and", "or", "with"].iter().any(|word| {
        lower.match_indices(word).any(|(start, _)| {
            let end = start + word.len();

            (start == 0 || !is_word(bytes[start - 1])) && (end == bytes.len() || !is_word(bytes[end]))
        })
    })
}

/// `extractLicenseChoice`.
fn license(manifest: &Manifest) -> Result<Option<License>, Unsupported> {
    let from_object = |value: &Value| value.get("type").and_then(Value::as_str).map(str::to_owned);

    let raw = match &manifest.license {
        Some(Value::String(text)) => Some(text.clone()),
        Some(object @ Value::Object(_)) if from_object(object).is_some() => from_object(object),
        _ => match &manifest.licenses {
            Some(Value::Array(list)) => list.first().and_then(from_object),
            _ => None,
        },
    };

    let Some(raw) = raw else {
        return Ok(None);
    };

    // JavaScript's `trim` and `toLowerCase` differ from the ASCII ones on other characters.
    if !raw.is_ascii() {
        return Err(Unsupported);
    }

    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Ok(None);
    }

    Ok(Some(if is_expression(trimmed) {
        License::Expression(trimmed.to_owned())
    } else if let Some(id) = normalize_spdx_id(trimmed) {
        License::Id(id.to_owned())
    } else {
        License::Name(trimmed.to_owned())
    }))
}

/// `decoratePackageComponent` for a parsed `package.json`.
pub(super) fn decorate(manifest: &Manifest) -> Result<Decoration, Unsupported> {
    let mut references = Vec::new();

    if let Some(homepage) = text(manifest.homepage.as_ref())? {
        references.push(("website", homepage.to_owned()));
    }

    if let Some(vcs) = url(manifest.repository.as_ref())? {
        references.push(("vcs", vcs));
    }

    if let Some(issues) = url(manifest.bugs.as_ref())? {
        references.push(("issue-tracker", issues));
    }

    Ok(Decoration {
        description: text(manifest.description.as_ref())?.map(str::to_owned),
        author: author(manifest.author.as_ref())?,
        licenses: license(manifest)?,
        references,
    })
}

/// `readJsonSync` on a `package.json`: `None` for a file that is not there, an error for one that is there
/// and that this port cannot be sure to read as `JSON.parse` does.
pub(super) fn read_manifest(path: &Path) -> Result<Option<Manifest>, Unsupported> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) => {
            return Ok(None)
        }
        Err(_) => return Err(Unsupported),
    };

    let text = std::str::from_utf8(&bytes).map_err(|_| Unsupported)?;

    serde_json::from_str(text).map(Some).map_err(|_| Unsupported)
}

/// A package name that cannot leave the directory it is joined to (`isSafePackageName`).
fn is_safe_name(name: &str) -> bool {
    if name.is_empty() || name.contains("..") || name.starts_with('.') || name.contains('\0') || name.contains('\\') {
        return false;
    }

    match name.strip_prefix('@') {
        Some(_) => name.find('/').is_some_and(|slash| slash > 1 && !name[slash + 1..].contains('/')),
        None => !name.contains('/'),
    }
}

fn is_safe_version(version: &str) -> bool {
    !version.is_empty() && !version.contains(['/', '\\', '\0']) && !version.contains("..")
}

/// The installed copies of the registry packages under a workspace root.
pub(super) struct Installed {
    root: PathBuf,
    /// The names in `node_modules/.pnpm`, sorted, read once; `None` when the directory is not there.
    store: OnceCell<Option<Vec<String>>>,
}

impl Installed {
    pub(super) fn new(root: &Path) -> Self {
        Self { root: root.to_path_buf(), store: OnceCell::new() }
    }

    fn store_names(&self) -> Result<&Option<Vec<String>>, Unsupported> {
        if let Some(names) = self.store.get() {
            return Ok(names);
        }

        let names = match fs::read_dir(self.root.join("node_modules/.pnpm")) {
            Ok(entries) => {
                let mut names = Vec::new();

                for entry in entries {
                    names.push(entry.map_err(|_| Unsupported)?.file_name().into_string().map_err(|_| Unsupported)?);
                }

                names.sort();

                Some(names)
            }
            Err(error) if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) => None,
            Err(_) => return Err(Unsupported),
        };

        Ok(self.store.get_or_init(|| names))
    }

    /// `readInstalledPackageMetadata` followed by `decoratePackageComponent`: the pnpm virtual store, then
    /// the hoisted copy when its version matches.
    pub(super) fn decoration(&self, name: &str, version: &str) -> Result<Option<Decoration>, Unsupported> {
        if !is_safe_name(name) || !is_safe_version(version) {
            return Ok(None);
        }

        if let Some(found) = self.virtual_store(name, version)? {
            return decorate(&found).map(Some);
        }

        let hoisted = read_manifest(&self.root.join("node_modules").join(name).join("package.json"))?;

        match hoisted {
            Some(manifest) if matches!(&manifest.version, Some(Value::String(found)) if found == version) => {
                decorate(&manifest).map(Some)
            }
            Some(_) | None => Ok(None),
        }
    }

    fn virtual_store(&self, name: &str, version: &str) -> Result<Option<Manifest>, Unsupported> {
        let pnpm = self.root.join("node_modules/.pnpm");
        let exact = format!("{}@{version}", name.replace('/', "+"));
        let file = |directory: &str| pnpm.join(directory).join("node_modules").join(name).join("package.json");

        if let Some(manifest) = read_manifest(&file(&exact))? {
            return Ok(Some(manifest));
        }

        let Some(names) = self.store_names()? else {
            return Ok(None);
        };

        let prefix = format!("{exact}_");
        let mut found: Vec<Manifest> = Vec::new();

        for directory in names.iter().filter(|candidate| candidate.starts_with(&prefix)) {
            found.extend(read_manifest(&file(directory))?);
        }

        // Node takes the first directory in the order the file system lists them. Directories that
        // disagree on what they say would make that order matter.
        let decorations = found.iter().map(decorate).collect::<Result<Vec<_>, _>>()?;
        let distinct: BTreeSet<String> = decorations.iter().map(|decoration| format!("{decoration:?}")).collect();

        if distinct.len() > 1 {
            return Err(Unsupported);
        }

        Ok(found.into_iter().next())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{decorate, is_expression, License, Manifest};

    fn manifest(value: serde_json::Value) -> Manifest {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn normalizes_licences_like_the_node_helper() {
        let licence = |value: serde_json::Value| decorate(&manifest(json!({ "license": value }))).unwrap().licenses;

        assert_eq!(licence(json!("MIT")), Some(License::Id("MIT".into())));
        assert_eq!(licence(json!(" apache2 ")), Some(License::Id("Apache-2.0".into())));
        assert_eq!(licence(json!("blueoak-1.0.0")), Some(License::Id("BlueOak-1.0.0".into())));
        assert_eq!(licence(json!("MIT AND ISC")), Some(License::Expression("MIT AND ISC".into())));
        assert_eq!(licence(json!("SEE LICENSE IN x")), Some(License::Name("SEE LICENSE IN x".into())));
        assert_eq!(licence(json!("Custom")), Some(License::Name("Custom".into())));
        assert_eq!(licence(json!({ "type": "ISC" })), Some(License::Id("ISC".into())));
        assert_eq!(
            decorate(&manifest(json!({ "licenses": [{ "type": "MIT" }] }))).unwrap().licenses,
            Some(License::Id("MIT".into()))
        );
        assert_eq!(licence(json!("")), None);
        assert!(decorate(&manifest(json!({ "license": "É" }))).is_err());
    }

    #[test]
    fn the_expression_test_uses_ascii_word_boundaries() {
        assert!(is_expression("MIT OR Apache-2.0"));
        assert!(is_expression("(MIT)"));
        assert!(is_expression("GPL with exception"));
        assert!(!is_expression("Band"));
        assert!(!is_expression("MIT_or"));
        assert!(is_expression("a-or-b"));
    }

    #[test]
    fn decorates_in_the_order_node_adds_the_fields() {
        let decoration = decorate(&manifest(json!({
            "description": "d",
            "author": { "name": "A", "email": "a@x" },
            "homepage": "h",
            "repository": { "url": "r" },
            "bugs": "b"
        })))
        .unwrap();

        assert_eq!(decoration.author.as_deref(), Some("A <a@x>"));
        assert_eq!(
            decoration.references,
            vec![("website", "h".to_owned()), ("vcs", "r".to_owned()), ("issue-tracker", "b".to_owned())]
        );
    }

    #[test]
    fn a_truthy_value_of_another_type_is_left_to_node() {
        assert!(decorate(&manifest(json!({ "description": 5 }))).is_err());
        assert!(decorate(&manifest(json!({ "homepage": true }))).is_err());
        assert!(decorate(&manifest(json!({ "description": 0, "homepage": null }))).is_ok());
    }
}
