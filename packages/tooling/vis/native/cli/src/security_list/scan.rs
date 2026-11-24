//! The `node_modules` walk and the allowlist triage of `vis security list`: ports of
//! `collectBuildScriptPackages` (`src/security/build-scripts.ts`), `collectBinShadows`
//! (`src/security/bin-shadows.ts`) and `scanBuildScriptStatus`.
//!
//! Both Node walks share one traversal, so they run as one here. Every difference between what Node would
//! read and what this module can read exactly (an unreadable or non-strict `package.json`, a name that is not
//! UTF-8, a very deep tree) returns `None`, and the caller hands the command to Node.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;

use crate::js::is_truthy;

/// The lifecycle hooks vis inspects, in the order the report lists them.
const BUILD_HOOKS: [&str; 4] = ["preinstall", "install", "postinstall", "prepare"];

/// Deeper trees are left to Node (a symlink loop only ends there when the path gets too long).
const MAX_DEPTH: usize = 48;

/// One installed package that declares lifecycle scripts.
#[derive(Clone)]
pub(super) struct BuildEntry {
    pub(super) name: String,
    pub(super) version: Option<String>,
    pub(super) hooks: Vec<String>,
}

/// A bin name that two or more packages expose.
pub(super) struct BinConflict {
    pub(super) bin: String,
    pub(super) packages: Vec<(String, String)>,
}

/// What the walk found.
pub(super) struct Found {
    pub(super) packages: Vec<BuildEntry>,
    /// Every bin name with the `(package, relative path)` pairs that expose it, in discovery order.
    bins: Vec<(String, Vec<(String, String)>)>,
}

/// The `allowBuilds` triage.
pub(super) struct Status {
    pub(super) excess: Vec<String>,
    pub(super) installed: Vec<BuildEntry>,
    pub(super) unapproved: Vec<BuildEntry>,
    pub(super) version_drift: Vec<(String, String)>,
}

struct Walker<'a> {
    root: &'a Path,
    packages: Vec<BuildEntry>,
    names: HashSet<String>,
    bins: Vec<(String, Vec<(String, String)>)>,
    bin_index: HashMap<String, usize>,
    recorded: HashSet<String>,
}

/// Walks `<cwd>/node_modules` the way both Node collectors do. `None` delegates.
pub(super) fn walk(cwd: &Path) -> Option<Found> {
    let node_modules = cwd.join("node_modules");

    if !node_modules.exists() {
        return Some(Found { packages: Vec::new(), bins: Vec::new() });
    }

    let mut walker = Walker {
        root: cwd,
        packages: Vec::new(),
        names: HashSet::new(),
        bins: Vec::new(),
        bin_index: HashMap::new(),
        recorded: HashSet::new(),
    };

    walker.scan(&node_modules, "", 0)?;

    Some(Found { packages: walker.packages, bins: walker.bins })
}

/// The directory entries of `directory` in the order Node's `readdirSync` lists them (libuv sorts them by byte),
/// as `Some(None)` for one that cannot be read (Node's `catch` skips it) and `None` for a name that is not UTF-8.
fn entries(directory: &Path) -> Option<Option<Vec<String>>> {
    let Ok(read) = fs::read_dir(directory) else {
        return Some(None);
    };
    let mut names: Vec<String> = Vec::new();

    for entry in read {
        let Ok(entry) = entry else {
            return Some(None);
        };

        names.push(entry.file_name().into_string().ok()?);
    }

    // `String` order is byte order, which is how libuv sorts.
    names.sort();

    Some(Some(names))
}

impl Walker<'_> {
    /// `scanDir`. `None` means this module cannot reproduce Node here.
    fn scan(&mut self, directory: &Path, scope_prefix: &str, depth: usize) -> Option<()> {
        if depth > MAX_DEPTH {
            return None;
        }

        let Some(names) = entries(directory)? else {
            return Some(());
        };

        for entry in names {
            let path = directory.join(&entry);

            if entry.starts_with('@') {
                self.scan(&path, &format!("{entry}/"), depth + 1)?;

                continue;
            }

            if entry == ".pnpm" && scope_prefix.is_empty() {
                let Some(store) = entries(&path)? else {
                    continue;
                };

                for store_entry in store {
                    let store_modules = path.join(&store_entry).join("node_modules");

                    if store_modules.exists() {
                        self.scan(&store_modules, "", depth + 1)?;
                    }
                }

                continue;
            }

            if entry.starts_with('.') {
                continue;
            }

            let name = format!("{scope_prefix}{entry}");
            let manifest = path.join("package.json");

            // `statSync(path).isDirectory()` follows symlinks, and a failing stat is skipped like a non-directory.
            if !fs::metadata(&path).is_ok_and(|metadata| metadata.is_dir()) || !manifest.exists() {
                continue;
            }

            // `readJsonSync` throws for an unreadable file, which skips the package and its nested modules.
            let Ok(bytes) = fs::read(&manifest) else {
                continue;
            };
            let text = std::str::from_utf8(&bytes).ok()?;

            let package: Value = serde_json::from_str(text).ok()?;

            // `pkg.scripts` of `null` throws, which skips the package like an unreadable file.
            if package.is_null() {
                continue;
            }

            self.build_scripts(&name, &path, &package);
            self.bins(&name, &path, &package, text)?;

            let nested = path.join("node_modules");

            if nested.exists() {
                self.scan(&nested, "", depth + 1)?;
            }
        }

        Some(())
    }

    /// The `collectBuildScriptPackages` step for one package: the first package of a name wins.
    fn build_scripts(&mut self, name: &str, path: &Path, package: &Value) {
        let scripts = package.get("scripts");
        let script = |hook: &str| scripts.and_then(|scripts| scripts.get(hook)).is_some_and(is_truthy);
        let mut hooks: Vec<String> =
            BUILD_HOOKS.iter().filter(|hook| script(hook)).map(|hook| (*hook).to_owned()).collect();

        if !script("preinstall") && !script("install") && !script("postinstall") && path.join("binding.gyp").exists() {
            hooks.push("install (binding.gyp)".to_owned());
        }

        if !hooks.is_empty() && self.names.insert(name.to_owned()) {
            let version = package.get("version").and_then(Value::as_str).map(str::to_owned);

            self.packages.push(BuildEntry { name: name.to_owned(), version, hooks });
        }
    }

    /// The `collectBinShadows` step for one package. `None` when the order of its bin names cannot be read.
    fn bins(&mut self, name: &str, path: &Path, package: &Value, text: &str) -> Option<()> {
        let canonical = package.get("name").and_then(Value::as_str).unwrap_or(name);

        match package.get("bin") {
            Some(Value::String(_)) => {
                let bin = canonical.rsplit('/').next().unwrap_or(canonical);

                self.record_bin(bin, canonical, path);
            }
            Some(Value::Object(_)) => {
                // `Object.keys` lists the names in the order of the file, and a package is recorded under the first
                // one only (the walk's `seenPkgs` is keyed by package and path), so the order decides the report.
                let probe: BinProbe = serde_json::from_str(text).ok()?;

                for bin in js_key_order(probe.bin?.0) {
                    self.record_bin(&bin, canonical, path);
                }
            }
            // `Object.keys` of an array lists its indices.
            Some(Value::Array(items)) => {
                for index in 0..items.len() {
                    self.record_bin(&index.to_string(), canonical, path);
                }
            }
            _ => {}
        }

        Some(())
    }

    fn record_bin(&mut self, bin: &str, package: &str, path: &Path) {
        let full = path.to_string_lossy();

        if !self.recorded.insert(format!("{package}@{full}")) {
            return;
        }

        let relative = full
            .strip_prefix(&*self.root.to_string_lossy())
            .map_or_else(|| full.to_string(), |rest| rest.get(1..).unwrap_or("").to_owned());
        let index = *self.bin_index.entry(bin.to_owned()).or_insert_with(|| {
            self.bins.push((bin.to_owned(), Vec::new()));

            self.bins.len() - 1
        });
        let list = &mut self.bins[index].1;

        if !list.iter().any(|(name, _)| name == package) {
            list.push((package.to_owned(), relative));
        }
    }
}

/// The top-level `bin` of a `package.json`, as the keys of its object in file order.
#[derive(Deserialize)]
struct BinProbe {
    bin: Option<KeysInOrder>,
}

struct KeysInOrder(Vec<String>);

impl<'de> Deserialize<'de> for KeysInOrder {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Keys;

        impl<'de> Visitor<'de> for Keys {
            type Value = KeysInOrder;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut keys: Vec<String> = Vec::new();

                while let Some(key) = map.next_key::<String>()? {
                    map.next_value::<IgnoredAny>()?;

                    // A repeated key keeps the place of its first appearance, as in a JS object.
                    if !keys.contains(&key) {
                        keys.push(key);
                    }
                }

                Ok(KeysInOrder(keys))
            }
        }

        deserializer.deserialize_map(Keys)
    }
}

/// The order `Object.keys` gives: canonical array indices first, ascending, then the other keys as they came.
fn js_key_order(keys: Vec<String>) -> Vec<String> {
    let index = |key: &str| key.parse::<u32>().ok().filter(|number| *number != u32::MAX && number.to_string() == key);
    let (mut indices, names): (Vec<String>, Vec<String>) = keys.into_iter().partition(|key| index(key).is_some());

    indices.sort_by_key(|key| index(key));
    indices.extend(names);

    indices
}

impl Found {
    /// The bins two or more packages expose and `allowBins` does not bless, sorted by `localeCompare`. `None`
    /// when the sort is one this crate does not reproduce (see [`collation_key`]).
    pub(super) fn conflicts(&self, allow_bins: &HashSet<String>) -> Option<Vec<BinConflict>> {
        let mut conflicts: Vec<BinConflict> = Vec::new();

        for (bin, list) in &self.bins {
            if list.len() < 2 || allow_bins.contains(bin) {
                continue;
            }

            if list.iter().all(|(name, _)| allow_bins.contains(&format!("{name}#{bin}"))) {
                continue;
            }

            conflicts.push(BinConflict { bin: bin.clone(), packages: list.clone() });
        }

        if conflicts.len() > 1 {
            if !locale_is_english() {
                return None;
            }

            let mut keyed = conflicts
                .into_iter()
                .map(|conflict| collation_key(&conflict.bin).map(|key| (key, conflict)))
                .collect::<Option<Vec<_>>>()?;

            keyed.sort_by(|a, b| a.0.cmp(&b.0));

            conflicts = keyed.into_iter().map(|(_, conflict)| conflict).collect();
        }

        Some(conflicts)
    }
}

/// Whether the locale Node's `localeCompare` uses is one whose collation of the characters below is the root
/// order: the variables ICU reads (`LC_ALL`, `LC_MESSAGES`, `LANG`) are unset, `C`, `POSIX` or an English locale.
fn locale_is_english() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LANG"].iter().all(|name| {
        std::env::var_os(name).is_none_or(|value| {
            let value = value.to_string_lossy();

            value.is_empty() || value == "C" || value == "POSIX" || value.starts_with("en")
        })
    })
}

/// The ICU root collation order of a bin name made of `a-z`, `0-9`, `_`, `-` and `.`: punctuation (`_` before
/// `-` before `.`), then digits, then letters, compared place by place. `None` for any other character, which
/// has a rank this crate does not know.
fn collation_key(bin: &str) -> Option<Vec<u8>> {
    bin.bytes()
        .map(|byte| match byte {
            b'_' => Some(0),
            b'-' => Some(1),
            b'.' => Some(2),
            b'0'..=b'9' => Some(3 + (byte - b'0')),
            b'a'..=b'z' => Some(13 + (byte - b'a')),
            _ => None,
        })
        .collect()
}

/// `splitAllowKey`: the name and the optional `@version` suffix (a leading `@` belongs to the scope).
fn split_allow_key(key: &str) -> (&str, Option<&str>) {
    let from = usize::from(key.starts_with('@'));

    match key[from..].find('@') {
        None => (key, None),
        Some(offset) => (&key[..from + offset], Some(&key[from + offset + 1..])),
    }
}

/// `isPatternAllowed`.
fn is_pattern_allowed(entry: &BuildEntry, allow: &[(String, bool)], pin_versions: bool) -> bool {
    for (pattern, allowed) in allow {
        if !allowed {
            continue;
        }

        if let Some(bare) = pattern.strip_suffix("@*") {
            if bare == entry.name {
                return true;
            }

            continue;
        }

        if let Some(prefix) = pattern.strip_suffix('*') {
            if entry.name.starts_with(prefix) {
                return true;
            }

            continue;
        }

        let (name, version) = split_allow_key(pattern);

        if name != entry.name {
            continue;
        }

        if !pin_versions || version.is_none() || entry.version.as_deref() == version {
            return true;
        }
    }

    false
}

/// `scanBuildScriptStatus`: what is approved, what is not, which allowlist entries match nothing, and (with
/// `pinVersions`) which entries point at an old version.
pub(super) fn status(packages: &[BuildEntry], allow: &[(String, bool)], pin_versions: bool) -> Status {
    let mut installed = Vec::new();
    let mut unapproved = Vec::new();
    let by_name: HashMap<&str, &BuildEntry> = packages.iter().map(|entry| (entry.name.as_str(), entry)).collect();

    for entry in packages {
        if is_pattern_allowed(entry, allow, pin_versions) {
            installed.push(entry.clone());
        } else {
            unapproved.push(entry.clone());
        }
    }

    let mut excess = Vec::new();
    let mut version_drift = Vec::new();

    for (pattern, allowed) in allow {
        if !allowed {
            continue;
        }

        if let Some(bare) = pattern.strip_suffix("@*") {
            if !by_name.contains_key(bare) {
                excess.push(pattern.clone());
            }

            continue;
        }

        if let Some(prefix) = pattern.strip_suffix('*') {
            if !packages.iter().any(|entry| entry.name.starts_with(prefix)) {
                excess.push(pattern.clone());
            }

            continue;
        }

        let (name, version) = split_allow_key(pattern);
        let Some(entry) = by_name.get(name) else {
            excess.push(pattern.clone());

            continue;
        };

        if let (true, Some(version), Some(current)) = (pin_versions, version, entry.version.as_deref()) {
            if version != "*" && !current.is_empty() && current != version {
                version_drift.push((pattern.clone(), format!("{name}@{current}")));
            }
        }
    }

    Status { excess, installed, unapproved, version_drift }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, version: &str) -> BuildEntry {
        BuildEntry { name: name.to_owned(), version: Some(version.to_owned()), hooks: vec!["postinstall".to_owned()] }
    }

    fn allow(items: &[(&str, bool)]) -> Vec<(String, bool)> {
        items.iter().map(|(key, value)| ((*key).to_owned(), *value)).collect()
    }

    #[test]
    fn keys_split_into_a_name_and_a_version() {
        assert_eq!(split_allow_key("foo"), ("foo", None));
        assert_eq!(split_allow_key("foo@1.2.3"), ("foo", Some("1.2.3")));
        assert_eq!(split_allow_key("@org/foo"), ("@org/foo", None));
        assert_eq!(split_allow_key("@org/foo@1.2.3"), ("@org/foo", Some("1.2.3")));
        assert_eq!(split_allow_key("@"), ("@", None));
    }

    #[test]
    fn patterns_follow_the_node_rules() {
        let packages = [entry("esbuild", "0.2.0"), entry("@org/x", "1.0.0"), entry("sharp", "1.0.0")];
        let rules = allow(&[
            ("esbuild@0.1.0", true),
            ("@org/*", true),
            ("sharp@*", false),
            ("gone@*", true),
            ("zzz*", true),
            ("old", true),
        ]);
        let loose = status(&packages, &rules, false);
        let pinned = status(&packages, &rules, true);

        assert_eq!(loose.installed.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["esbuild", "@org/x"]);
        assert_eq!(loose.unapproved.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["sharp"]);
        assert_eq!(loose.excess, ["gone@*", "zzz*", "old"]);
        assert!(loose.version_drift.is_empty());
        assert_eq!(pinned.installed.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["@org/x"]);
        assert_eq!(pinned.version_drift, [("esbuild@0.1.0".to_owned(), "esbuild@0.2.0".to_owned())]);
    }

    #[test]
    fn bin_names_keep_the_order_of_the_file() {
        let probe: BinProbe =
            serde_json::from_str(r#"{"name":"x","bin":{"b":"1","10":"2","a":"3","2":"4","b":"5"}}"#).unwrap();

        assert_eq!(js_key_order(probe.bin.unwrap().0), ["2", "10", "b", "a"]);
        assert!(serde_json::from_str::<BinProbe>(r#"{"bin":{},"bin":{}}"#).is_err());
    }

    #[test]
    fn collation_puts_punctuation_before_digits_before_letters() {
        let mut names = ["ab", "a1", "a.b", "a-b", "a_b", "aa", "a", "1", "_x"];

        names.sort_by_key(|name| collation_key(name).unwrap());

        assert_eq!(names, ["_x", "1", "a", "a_b", "a-b", "a.b", "a1", "aa", "ab"]);
        assert!(collation_key("B").is_none());
    }
}
