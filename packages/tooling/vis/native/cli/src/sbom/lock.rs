//! The pnpm lockfile reader of `@visulima/package` (`parsePnpmLockFile`), ported expression for expression.
//!
//! That parser is a set of regular expressions over the file's text, not a YAML parser, and it
//! silently drops what its expressions do not match (a key with a `:` in it, such as a git or
//! tarball dependency). Reproducing it means keeping the expressions, so the same text gives the same
//! entries, including the ones it gets wrong. The expressions run on bytes with ASCII classes; the
//! text must therefore hold nothing that a JavaScript `\s`, `^` or `$` treats differently from them
//! (see [`readable`]).

use std::collections::{HashMap, HashSet};

use regex::bytes::Regex;

/// `name -> specifiers`, in the order the lockfile gives them.
pub(super) type DependencyMap = Vec<(String, Vec<String>)>;

/// An integrity hash with a digest length CycloneDX accepts.
pub(super) struct Hash {
    pub(super) algorithm: &'static str,
    pub(super) hex: String,
}

pub(super) struct Entry {
    pub(super) name: String,
    pub(super) version: String,
    pub(super) hash: Option<Hash>,
    pub(super) dependencies: DependencyMap,
    pub(super) peer_dependencies: DependencyMap,
    pub(super) optional_dependencies: DependencyMap,
}

/// Property names of `Object.prototype`. The parser keeps maps in plain objects, where a dependency
/// of one of these names reads the inherited member and the result differs.
const PROTOTYPE_KEYS: [&str; 12] = [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// Whether the text is one the expressions give the same answer on as in JavaScript: valid UTF-8, no
/// carriage return, line or paragraph separator, and no whitespace character beyond ASCII (JavaScript's `\s`
/// includes `U+FEFF` and the Unicode spaces).
pub(super) fn readable(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };

    !text.chars().any(|character| {
        character == '\r' || (!character.is_ascii() && (character.is_whitespace() || character == '\u{feff}'))
    })
}

/// The expressions, compiled once per run.
struct Patterns {
    entry: Regex,
    resolution: Regex,
    section_end: Regex,
    dependency: Regex,
    /// The opening line of the `packages` and `snapshots` sections.
    sections: [Regex; 2],
    /// `    dependencies:`, `    peerDependencies:` and `    optionalDependencies:` with the block under each.
    fields: [Regex; 3],
}

impl Patterns {
    fn new() -> Self {
        let compile = |source: &str| Regex::new(source).expect("pattern is valid");

        Self {
            entry: compile(r#"(?m)(?-u)^ {2}(['"]?[^\s:][^:\n]*?['"]?):\s*\n((?: {4}[^\n]*\n?)+)"#),
            resolution: compile(r"(?-u)resolution:\s*\{[^}]*integrity:\s*([^,}\s]+)"),
            section_end: compile(r"(?m)(?-u)^[a-z][a-zA-Z0-9]*:\s*$"),
            dependency: compile(r"(?m)(?-u)^ {6}([^\s:]+):\s*([^\n]+)"),
            sections: ["packages", "snapshots"].map(|name| compile(&format!(r"(?m)(?-u)^{name}:\s*$"))),
            fields: FIELDS.map(|field| compile(&format!(r"(?m)(?-u)^ {{4}}{field}:\s*\n((?: {{6,}}[^\n]*\n?)+)"))),
        }
    }
}

/// `readFileSync(...).parsePnpmLockFile`: the entries, or `None` where this port cannot answer exactly.
pub(super) fn parse(bytes: &[u8]) -> Option<Vec<Entry>> {
    if !readable(bytes) {
        return None;
    }

    let patterns = Patterns::new();
    let Some(packages) = section(&patterns, bytes, 0) else {
        return Some(Vec::new());
    };

    let snapshots = snapshots(&patterns, bytes)?;
    let mut entries: Vec<Entry> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for captures in patterns.entry.captures_iter(packages) {
        let Some((name, version)) = split_key(&captures[1]) else {
            continue;
        };

        if !seen.insert((name.clone(), version.clone())) {
            continue;
        }

        let block = &captures[2];
        let hash = patterns.resolution.captures(block).and_then(|found| decode_integrity(&found[1]));
        let snapshot = snapshots.get(&(name.clone(), version.clone()));
        let mut maps: [Option<DependencyMap>; 3] = [None, None, None];

        for (index, slot) in maps.iter_mut().enumerate() {
            *slot = match snapshot.and_then(|own| own[index].clone()) {
                Some(map) => Some(map),
                None => dependency_map(&patterns, block, index)?,
            };
        }

        let [dependencies, peer_dependencies, optional_dependencies] = maps;

        entries.push(Entry {
            name,
            version,
            hash,
            dependencies: dependencies.unwrap_or_default(),
            peer_dependencies: peer_dependencies.unwrap_or_default(),
            optional_dependencies: optional_dependencies.unwrap_or_default(),
        });
    }

    Some(entries)
}

const FIELDS: [&str; 3] = ["dependencies", "peerDependencies", "optionalDependencies"];

type Snapshots = HashMap<(String, String), [Option<DependencyMap>; 3]>;

/// The `snapshots` section, which holds each package's own dependency maps in lockfile version 9.
/// `None` when a map in it cannot be reproduced.
fn snapshots(patterns: &Patterns, bytes: &[u8]) -> Option<Snapshots> {
    let mut found: Snapshots = HashMap::new();

    let Some(text) = section(patterns, bytes, 1) else {
        return Some(found);
    };

    for captures in patterns.entry.captures_iter(text) {
        let Some(key) = split_key(&captures[1]) else {
            continue;
        };

        for (index, slot) in found.entry(key).or_default().iter_mut().enumerate() {
            let Some(map) = dependency_map(patterns, &captures[2], index)? else {
                continue;
            };

            let target = slot.get_or_insert_with(Vec::new);

            for (name, specifiers) in map {
                merge(target, name, specifiers);
            }
        }
    }

    Some(found)
}

/// Adds the specifiers of `name`, keeping each once, to a map in lockfile order.
fn merge(map: &mut DependencyMap, name: String, specifiers: Vec<String>) {
    let position = map.iter().position(|(existing, _)| *existing == name);
    let slot = match position {
        Some(position) => position,
        None => {
            map.push((name, Vec::new()));
            map.len() - 1
        }
    };

    for specifier in specifiers {
        if !map[slot].1.contains(&specifier) {
            map[slot].1.push(specifier);
        }
    }
}

/// `readSection`: the text after the line `<name>:` up to the next top-level key.
fn section<'a>(patterns: &Patterns, bytes: &'a [u8], which: usize) -> Option<&'a [u8]> {
    let found = patterns.sections[which].find(bytes)?;
    let rest = &bytes[found.end()..];

    Some(patterns.section_end.find(rest).map_or(rest, |next| &rest[..next.start()]))
}

/// `parseDependencyKey`: the package name and version of a `packages:`/`snapshots:` key.
fn split_key(raw: &[u8]) -> Option<(String, String)> {
    let text = std::str::from_utf8(raw).ok()?.trim();
    let text = text.strip_prefix('/').unwrap_or(text);
    let text = strip_quotes(text);
    let text = match text.find('(') {
        Some(position) if position > 0 => &text[..position],
        _ => text,
    };

    let at = text.rfind('@').filter(|&position| position > 0)?;
    let (name, version) = (&text[..at], &text[at + 1..]);

    if name.is_empty()
        || version.is_empty()
        || ["link:", "workspace:", "file:"].iter().any(|prefix| version.starts_with(prefix))
    {
        return None;
    }

    Some((name.to_owned(), version.to_owned()))
}

/// `.replace(/^['"]/, "").replace(/['"]$/, "")`.
fn strip_quotes(text: &str) -> &str {
    let text = text.strip_prefix(['\'', '"']).unwrap_or(text);

    text.strip_suffix(['\'', '"']).unwrap_or(text)
}

/// `parseDependencyBlock`: the map under `    <field>:` of one entry. `Some(None)` is no map; `None` is a name
/// this port cannot key a map by exactly.
fn dependency_map(patterns: &Patterns, block: &[u8], field: usize) -> Option<Option<DependencyMap>> {
    let Some(found) = patterns.fields[field].captures(block) else {
        return Some(None);
    };

    let mut map: DependencyMap = Vec::new();

    for captures in patterns.dependency.captures_iter(&found[1]) {
        let key = std::str::from_utf8(&captures[1]).ok()?;
        let name = strip_quotes(key);
        let value = strip_quotes(std::str::from_utf8(&captures[2]).ok()?.trim());
        let value = match value.find('(') {
            Some(position) if position > 0 => value[..position].trim(),
            _ => value,
        };

        if PROTOTYPE_KEYS.contains(&name) {
            return None;
        }

        if name.is_empty() || value.is_empty() {
            continue;
        }

        merge(&mut map, name.to_owned(), vec![value.to_owned()]);
    }

    Some((!map.is_empty()).then_some(map))
}

/// `decodeSriIntegrity` followed by the length check of `toResolvedPackage`: the hash when the digest has the
/// length of its algorithm, which CycloneDX's schema requires.
fn decode_integrity(raw: &[u8]) -> Option<Hash> {
    let text = std::str::from_utf8(raw).ok()?;

    if text.len() > 1024 {
        return None;
    }

    let dash = text.find('-').filter(|&position| position > 0)?;
    let (algorithm, expected) = match text[..dash].to_ascii_lowercase().as_str() {
        "sha256" => ("SHA-256", 64),
        "sha384" => ("SHA-384", 96),
        "sha512" => ("SHA-512", 128),
        _ => return None,
    };

    let digest = &text[dash + 1..];
    let body = digest.trim_end_matches('=');

    // `/^[A-Z0-9+/]+={0,2}$/i`
    let shaped = !body.is_empty()
        && digest.len() - body.len() <= 2
        && body.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/');

    if !shaped {
        return None;
    }

    let hex = base64_to_hex(body)?;

    (hex.len() == expected).then_some(Hash { algorithm, hex })
}

/// `Buffer.from(text, "base64").toString("hex")` for unpadded standard-alphabet text: whole bytes only, a trailing
/// partial group is dropped.
fn base64_to_hex(body: &str) -> Option<String> {
    let mut hex = String::new();
    let (mut accumulator, mut bits) = (0u32, 0u32);

    for byte in body.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            _ => 63,
        };

        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            hex.push_str(&format!("{:02x}", (accumulator >> bits) & 0xff));
            accumulator &= (1 << bits) - 1;
        }
    }

    (!hex.is_empty()).then_some(hex)
}

#[cfg(test)]
mod tests {
    use super::{decode_integrity, parse, readable};

    const LOCK: &str = "lockfileVersion: '9.0'\n\npackages:\n\n  '@scope/a@1.0.0':\n    resolution: {integrity: sha512-AAAA}\n\n  b@2.0.0:\n    resolution: {integrity: sha256-AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=}\n    peerDependencies:\n      react: '>=16'\n\nsnapshots:\n\n  '@scope/a@1.0.0':\n    dependencies:\n      b: 2.0.0(react@18.0.0)\n      'c-alias': c@3.0.0\n\n  b@2.0.0: {}\n";

    #[test]
    fn reads_entries_dependencies_and_hashes() {
        let entries = parse(LOCK.as_bytes()).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "@scope/a");
        assert_eq!(
            entries[0].dependencies,
            vec![("b".to_owned(), vec!["2.0.0".to_owned()]), ("c-alias".to_owned(), vec!["c@3.0.0".to_owned()])]
        );
        assert!(entries[0].hash.is_none());
        assert_eq!(entries[1].version, "2.0.0");
        assert_eq!(entries[1].peer_dependencies, vec![("react".to_owned(), vec![">=16".to_owned()])]);
        assert_eq!(
            entries[1].hash.as_ref().unwrap().hex,
            "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
        );
    }

    #[test]
    fn a_hash_of_the_wrong_length_is_dropped() {
        assert!(decode_integrity(b"sha512-aGVsbG8=").is_none());
        assert!(decode_integrity(b"md5-AAAA").is_none());
    }

    #[test]
    fn text_javascript_reads_differently_is_refused() {
        assert!(readable(b"a: 1\n"));
        assert!(!readable(b"a: 1\r\n"));
        assert!(!readable("a:\u{a0}1\n".as_bytes()));
        assert!(!readable("\u{feff}a: 1\n".as_bytes()));
        assert!(!readable(&[0xff]));
        assert!(readable("a: \u{e9}\n".as_bytes()));
    }

    #[test]
    fn a_dependency_named_like_an_object_member_is_refused() {
        let lock = "packages:\n\n  a@1.0.0:\n    resolution: {integrity: sha512-AAAA}\n    dependencies:\n      constructor: 1.0.0\n";

        assert!(parse(lock.as_bytes()).is_none());
    }
}
