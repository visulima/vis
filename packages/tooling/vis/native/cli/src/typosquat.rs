//! The typosquat name check `vis install` runs over `package.json` before it installs
//! (`src/security/typosquats.ts` and `typosquat-variants.ts`).
//!
//! The native path only needs a yes or no: a name that matches anything sends the whole command to
//! Node, which prints the warning and asks (or aborts without a terminal). So a miss is the only
//! error that matters: it would let a typosquat through where Node stops, and it is why this module
//! ports the matching exactly and embeds the very blocklists the TypeScript side imports, rather
//! than a copy. `__tests__/native/typosquat-parity.test.ts` checks both sides against a fixture the
//! TypeScript code writes.
//!
//! The blocklist names are ASCII, so every generated variant is, and a name that is not ASCII can
//! never match. That is why the variant generator works on bytes.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::Value;

const AUTO_BLOCKLIST: &str = include_str!("../../../data/typosquats.json");
const MANUAL_BLOCKLIST: &str = include_str!("../../../data/typosquats-manual.json");

/// Homoglyph and keyboard substitutions, keyed by the lowercase character they replace.
fn substitutions(character: u8) -> &'static [&'static str] {
    match character {
        b'a' => &["4", "e"],
        b'b' => &["d"],
        b'd' => &["b"],
        b'e' => &["3", "a"],
        b'g' => &["9", "q"],
        b'i' => &["1", "l"],
        b'l' => &["1", "i"],
        b'm' => &["n"],
        b'n' => &["m"],
        b'o' => &["0"],
        b's' => &["5", "z"],
        b't' => &["7"],
        b'u' => &["v"],
        b'v' => &["u"],
        _ => &[],
    }
}

/// Suffixes brand-jacks of scoped packages append (`@tanstack/start` -> `tanstack-app`).
const SCOPED_BRAND_SUFFIXES: [&str; 7] = ["app", "cli", "core", "kit", "lib", "pkg", "sdk"];

fn is_separator(character: u8) -> bool {
    matches!(character, b'-' | b'.' | b'_')
}

/// `generateVariants`: every typosquat variant of `name`, never the name itself. Names shorter than
/// three characters have none.
pub(crate) fn generate_variants(name: &str) -> HashSet<String> {
    let mut variants = HashSet::new();
    let bytes = name.as_bytes();
    let length = bytes.len();

    if length < 3 {
        return variants;
    }

    let slice = |from: usize, to: usize| String::from_utf8_lossy(&bytes[from..to]).into_owned();

    for index in 0..length {
        let character = bytes[index];
        let separator = is_separator(character);

        if !separator {
            // Character omission.
            variants.insert(format!("{}{}", slice(0, index), slice(index + 1, length)));
            // Character duplication.
            variants.insert(format!("{}{}{}", slice(0, index), character as char, slice(index, length)));
        }

        // Adjacent transposition, unless either side is a separator.
        if index + 1 < length && bytes[index] != bytes[index + 1] && !separator && !is_separator(bytes[index + 1]) {
            let mut swapped = bytes.to_vec();

            swapped.swap(index, index + 1);
            variants.insert(String::from_utf8_lossy(&swapped).into_owned());
        }

        // Homoglyph substitution.
        for replacement in substitutions(character.to_ascii_lowercase()) {
            variants.insert(format!("{}{}{}", slice(0, index), replacement, slice(index + 1, length)));
        }
    }

    // Separator manipulation.
    if bytes.iter().any(|&byte| is_separator(byte)) {
        for replacement in ["", "-", ".", "_"] {
            let replaced: String =
                name.chars()
                    .map(|character| {
                        if matches!(character, '-' | '.' | '_') {
                            replacement.to_owned()
                        } else {
                            character.to_string()
                        }
                    })
                    .collect();

            variants.insert(replaced);
        }
    } else if length > 5 {
        for index in 2..length - 2 {
            for separator in ["-", ".", "_"] {
                variants.insert(format!("{}{}{}", slice(0, index), separator, slice(index, length)));
            }
        }
    }

    // Common suffixes of unscoped names.
    if !name.starts_with('@') {
        variants.insert(format!("{name}-js"));
        variants.insert(format!("{name}js"));
        variants.insert(format!("{name}-node"));
    }

    // Brand-jacks of scoped names: `@scope/sub` -> `scope`, `scope-sub`, `sub-scope`, `scope-app`, ...
    if name.starts_with('@') {
        if let Some(slash) = name.find('/') {
            if slash > 1 && slash < length - 1 {
                let scope = &name[1..slash];
                let sub = &name[slash + 1..];

                if scope.len() >= 3 {
                    variants.insert(scope.to_owned());
                }

                for separator in ["", "-", ".", "_"] {
                    variants.insert(format!("{scope}{separator}{sub}"));
                    variants.insert(format!("{sub}{separator}{scope}"));
                }

                for suffix in SCOPED_BRAND_SUFFIXES {
                    variants.insert(format!("{scope}-{suffix}"));
                    variants.insert(format!("{sub}-{scope}-{suffix}"));
                    variants.insert(format!("{suffix}-{scope}-{sub}"));
                }
            }
        }
    }

    variants.remove(name);

    variants
}

/// Every name the check flags: the blocklisted typosquats and the generated variants of each
/// legitimate name, over the generated and the hand-curated blocklist together.
fn flagged_set(sources: &[&str]) -> HashSet<String> {
    let mut flagged = HashSet::new();

    for source in sources {
        let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(source) else {
            continue;
        };

        for (legitimate, typosquats) in &entries {
            for typosquat in typosquats.as_array().into_iter().flatten().filter_map(Value::as_str) {
                flagged.insert(typosquat.to_owned());
            }

            flagged.extend(generate_variants(legitimate));
        }
    }

    flagged
}

fn blocklist() -> &'static HashSet<String> {
    static LIST: OnceLock<HashSet<String>> = OnceLock::new();

    LIST.get_or_init(|| flagged_set(&[AUTO_BLOCKLIST, MANUAL_BLOCKLIST]))
}

/// The part of a package name the check compares: the second `/` segment of a scoped name.
fn bare_name(package: &str) -> &str {
    if package.starts_with('@') {
        package.split('/').nth(1).unwrap_or(package)
    } else {
        package
    }
}

/// `checkTyposquat(name) !== undefined`.
pub(crate) fn is_typosquat(package: &str) -> bool {
    is_flagged(blocklist(), package)
}

fn is_flagged(flagged: &HashSet<String>, package: &str) -> bool {
    flagged.contains(bare_name(package))
}

/// The alias target of a dependency value (`npm:reaact@^18` -> `reaact`), the regex
/// `^(?:npm|pnpm|yarn):(.+?)(?:@.*)?$` of the TypeScript side. `None` when the value is no alias.
/// A value with a line terminator cannot match (`.` stops at one), so it has no target here either;
/// the caller sends such a value to Node.
fn alias_target(value: &str) -> Option<&str> {
    let rest = ["npm:", "pnpm:", "yarn:"].iter().find_map(|prefix| value.strip_prefix(prefix))?;

    if rest.is_empty() || rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }

    // `.+?` takes one character, then stops at the first `@`.
    let first = rest.chars().next()?.len_utf8();

    match rest[first..].find('@') {
        Some(at) => Some(&rest[..first + at]),
        None => Some(rest),
    }
}

/// What the dependency scan made of a `package.json`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Scan {
    /// Nothing is flagged: install may go on.
    Clean,
    /// A dependency matches, or the file has a shape this port does not read: Node decides.
    Delegate,
}

/// `scanDepsForTyposquats` without the prompt: the keys of the four dependency maps, and the alias
/// targets of their values. Reads generously: it tests the alias target of every map's value, where
/// the TypeScript side merges the maps first, and any shape it is unsure of goes to Node.
pub(crate) fn scan_manifest(manifest: &Value) -> Scan {
    for field in ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] {
        let map = match manifest.get(field) {
            None | Some(Value::Null) => continue,
            Some(Value::Object(map)) => map,
            Some(_) => return Scan::Delegate,
        };

        for (name, value) in map {
            if is_typosquat(name) {
                return Scan::Delegate;
            }

            let Value::String(spec) = value else {
                return Scan::Delegate;
            };

            // A line terminator makes the TypeScript regex not match at all, which this cannot
            // tell from an alias: leave the file to Node.
            if ["npm:", "pnpm:", "yarn:"].iter().any(|prefix| spec.starts_with(prefix))
                && spec.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
            {
                return Scan::Delegate;
            }

            if alias_target(spec).is_some_and(is_typosquat) {
                return Scan::Delegate;
            }
        }
    }

    Scan::Clean
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use std::collections::HashSet;

    use super::{
        alias_target, bare_name, flagged_set, generate_variants, is_flagged, is_typosquat, scan_manifest, Scan,
    };

    #[test]
    fn the_blocklist_names_are_ascii() {
        for source in [super::AUTO_BLOCKLIST, super::MANUAL_BLOCKLIST] {
            let entries: serde_json::Map<String, serde_json::Value> = serde_json::from_str(source).unwrap();

            // Variants are generated from the keys only, as bytes; the listed typosquats are compared whole.
            for legitimate in entries.keys() {
                assert!(legitimate.is_ascii(), "{legitimate}");
            }
        }
    }

    #[test]
    fn short_names_have_no_variants_and_the_name_is_never_its_own_variant() {
        assert!(generate_variants("ab").is_empty());
        assert!(!generate_variants("react").contains("react"));
    }

    #[test]
    fn a_scoped_name_compares_by_its_second_segment() {
        assert_eq!(bare_name("@scope/foo"), "foo");
        assert_eq!(bare_name("@scope/a/b"), "a");
        assert_eq!(bare_name("@scope"), "@scope");
        assert_eq!(bare_name("foo"), "foo");
    }

    #[test]
    fn alias_targets_follow_the_typescript_regex() {
        assert_eq!(alias_target("npm:reaact@^18"), Some("reaact"));
        assert_eq!(alias_target("npm:@scope/pkg@1.0.0"), Some("@scope/pkg"));
        assert_eq!(alias_target("pnpm:lodash"), Some("lodash"));
        assert_eq!(alias_target("yarn:a@b@c"), Some("a"));
        assert_eq!(alias_target("npm:"), None);
        assert_eq!(alias_target("^1.0.0"), None);
        assert_eq!(alias_target("npmx:lodash"), None);
    }

    #[test]
    fn a_known_typosquat_and_a_generated_variant_are_flagged_and_a_common_name_is_not() {
        // `lodash` is on the blocklist, so an omission variant of it is flagged.
        assert!(is_typosquat("lodas"));
        assert!(!is_typosquat("zzz-not-a-package-name"));
    }

    #[test]
    fn the_manifest_scan_delegates_on_a_hit_in_a_key_or_an_alias_and_on_an_unread_shape() {
        assert_eq!(scan_manifest(&json!({ "name": "x" })), Scan::Clean);
        assert_eq!(scan_manifest(&json!({ "dependencies": { "zzz-not-a-package-name": "1" } })), Scan::Clean);
        assert_eq!(scan_manifest(&json!({ "dependencies": { "ok": "npm:lodas@1" } })), Scan::Delegate);
        assert_eq!(scan_manifest(&json!({ "devDependencies": { "lodas": "1" } })), Scan::Delegate);
        assert_eq!(scan_manifest(&json!({ "dependencies": "lodash" })), Scan::Delegate);
        assert_eq!(scan_manifest(&json!({ "dependencies": { "a": 1 } })), Scan::Delegate);
        assert_eq!(scan_manifest(&json!({ "dependencies": null })), Scan::Clean);
    }

    /// What `__tests__/native/typosquat-parity.test.ts` wrote from the TypeScript implementation, and the
    /// flagged set the Rust code builds from the same two blocklists.
    fn fixture() -> (serde_json::Value, HashSet<String>) {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/typosquat-parity.json")).unwrap();
        let auto = fixture["blocklists"]["auto"].to_string();
        let manual = fixture["blocklists"]["manual"].to_string();

        (fixture, flagged_set(&[&auto, &manual]))
    }

    #[test]
    fn the_flagged_set_is_the_one_the_typescript_code_flags() {
        use sha2::{Digest, Sha256};

        let (fixture, flagged) = fixture();
        let mut names: Vec<&String> = flagged.iter().collect();

        names.sort();

        let joined = names.iter().map(|name| name.as_str()).collect::<Vec<_>>().join("\n");
        let digest: String = Sha256::digest(joined.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();

        assert_eq!(names.len() as u64, fixture["flagged"]["count"].as_u64().unwrap());
        assert_eq!(digest, fixture["flagged"]["sha256"].as_str().unwrap());
    }

    #[test]
    fn the_variants_of_each_sampled_name_are_the_typescript_variants() {
        let (fixture, _) = fixture();

        for (name, expected) in fixture["variants"].as_object().unwrap() {
            let mut variants: Vec<String> = generate_variants(name).into_iter().collect();

            variants.sort();

            let expected: Vec<String> =
                expected.as_array().unwrap().iter().map(|variant| variant.as_str().unwrap().to_owned()).collect();

            assert_eq!(variants, expected, "variants of {name}");
        }
    }

    #[test]
    fn every_lookup_gives_the_typescript_answer() {
        let (fixture, flagged) = fixture();
        let wrong: Vec<String> = fixture["lookups"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| {
                let name = entry[0].as_str().unwrap();
                let expected = entry[1].as_bool().unwrap();

                (is_flagged(&flagged, name) != expected).then(|| format!("{name:?} should be flagged: {expected}"))
            })
            .collect();

        assert!(wrong.is_empty(), "{wrong:?}");
    }

    #[test]
    fn the_embedded_blocklists_build_a_non_empty_set() {
        assert!(super::blocklist().len() > 1000);
        assert!(is_typosquat("lodas"));
    }
}
