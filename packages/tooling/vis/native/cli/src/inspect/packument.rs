//! The registry's packument: fetched, cut down to what the marshalls read (`stripPackument`), cached the way
//! `getPackument` caches it, and read through a view that finds a version, a tag and a time.
//!
//! The cut-down document is built in the order `stripPackument` builds it and written with [`Js::stringify`], so the
//! cache file is the bytes `JSON.stringify` writes. A document that Node would fail on or read through the prototype
//! (a version entry that is not an object, a `dist` that is `null`, a version named `constructor`) is Node's.

use std::cell::OnceCell;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::js_value::into_ordered;
use super::semver_js::Version;
use crate::http::{HttpClient, HttpError};
use crate::keys_refresh::Js;

/// `PACKUMENT_CACHE_VERSION`.
const CACHE_VERSION: f64 = 3.0;
/// `DEFAULT_TTL_MS`: half an hour.
const TTL_MS: u64 = 30 * 60 * 1000;

/// What the registry answered for a package.
pub(super) enum Answer {
    Found(Js),
    NotFound,
}

/// What `getPackument` finds in the cache.
pub(super) enum Cached {
    /// No entry, or one `getPackument` deletes and fetches again (expired, or written by another version).
    Fetch {
        stale_file: bool,
    },
    Fresh(Js),
}

/// `encodeURIComponent` for a name made of lower-case letters, digits, `.`, `_`, `-`, `@` and `/`.
fn encode(name: &str) -> String {
    name.replace('@', "%40").replace('/', "%2F")
}

pub(super) fn cache_file(cache_dir: &str, name: &str) -> PathBuf {
    Path::new(cache_dir).join("packuments").join(format!("{}.json", encode(name)))
}

fn number_of(entry: &Js, key: &str) -> Option<f64> {
    match entry.member(key)? {
        Js::Number(number) => Some(*number),
        _ => None,
    }
}

/// `readCached`: the packument of a fresh entry, `Fetch` for one that is gone or that Node deletes, and the reason for a
/// hand-off for a file this module does not read the way Node does.
pub(super) fn read_cache(file: &Path, now_ms: f64) -> Result<Cached, String> {
    match fs::metadata(file) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("the packument cache path is not a regular file".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Cached::Fetch { stale_file: false }),
        Err(error) => return Err(format!("the packument cache cannot be read: {error}")),
    }

    let text = fs::read_to_string(file).map_err(|error| format!("the packument cache cannot be read: {error}"))?;
    let entry: Js =
        serde_json::from_str(&text).map_err(|_| "the packument cache is not JSON this module reads".to_owned())?;

    if !entry.is_object() {
        return Err("the packument cache is not an object".to_owned());
    }

    if number_of(&entry, "cacheVersion") != Some(CACHE_VERSION) {
        return Ok(Cached::Fetch { stale_file: true });
    }

    let (Some(created), Some(ttl)) = (number_of(&entry, "createdAt"), number_of(&entry, "ttlMs")) else {
        return Err("the packument cache has no numeric createdAt and ttlMs".to_owned());
    };

    if now_ms - created > ttl {
        return Ok(Cached::Fetch { stale_file: true });
    }

    match entry {
        Js::Object(entries) => entries
            .into_iter()
            .find(|(key, _)| key == "packument")
            .map(|(_, packument)| Cached::Fresh(packument))
            .ok_or_else(|| "the packument cache has no packument".to_owned()),
        _ => unreachable!("checked above"),
    }
}

/// `writeCached`: `JSON.stringify({cacheVersion, createdAt, packument, ttlMs})`.
pub(super) fn cache_entry(packument: &Js, now_ms: u64) -> Option<String> {
    let mut text = format!("{{\"cacheVersion\":3,\"createdAt\":{now_ms},\"packument\":");

    packument.stringify(&mut text)?;
    text.push_str(&format!(",\"ttlMs\":{TTL_MS}}}"));

    Some(text)
}

/// Asks the registry for `url`. A 404 is the answer "no such package"; every other failure, and every answer this
/// module cannot read the way `response.json()` and `stripPackument` do, is the reason for a hand-off.
pub(super) fn fetch(client: &HttpClient, url: &str) -> Result<Answer, String> {
    let response = match client.get(url, &[("accept", "application/json")]) {
        Ok(response) => response,
        Err(HttpError::Status { code: 404, .. }) => return Ok(Answer::NotFound),
        Err(error) => return Err(format!("the registry request failed: {error}")),
    };
    let text = response.text().map_err(|error| format!("the answer is not UTF-8 text: {error}"))?;

    if text.starts_with('\u{feff}') {
        return Err("the answer starts with a byte-order mark".to_owned());
    }

    let raw: Js = serde_json::from_str(text).map_err(|_| "the answer is not JSON this module reads".to_owned())?;

    strip(raw).map(Answer::Found)
}

/// Removes member `key` from an object's entries.
fn take(entries: &mut Vec<(String, Js)>, key: &str) -> Option<Js> {
    entries.iter().position(|(name, _)| name == key).map(|at| entries.remove(at).1)
}

fn is_text(value: &Js) -> bool {
    matches!(value, Js::String(_))
}

fn is_non_negative_number(value: &Js, integer: bool) -> bool {
    matches!(value, Js::Number(number) if number.is_finite() && *number >= 0.0 && (!integer || number.fract() == 0.0))
}

/// Moves member `key` of `from` to `to` when `accepts` takes its value.
fn keep(to: &mut Vec<(String, Js)>, from: &mut Vec<(String, Js)>, key: &str, accepts: fn(&Js) -> bool) {
    if let Some(value) = take(from, key) {
        if accepts(&value) {
            to.push((key.to_owned(), value));
        }
    }
}

/// `stripPackument`'s version entry: the key as `version`, then the fields it keeps, in its order.
fn strip_version(version: String, entry: Js) -> Result<Js, String> {
    let Js::Object(mut fields) = entry else {
        return Err(format!("the entry of version {version} is not an object"));
    };
    let mut out = vec![("version".to_owned(), Js::String(version.clone()))];
    keep(&mut out, &mut fields, "_npmUser", |_| true);
    keep(&mut out, &mut fields, "maintainers", |_| true);
    keep(&mut out, &mut fields, "bin", |_| true);

    if let Some(dist) = take(&mut fields, "dist") {
        let Js::Object(mut parts) = dist else {
            return Err(format!("the dist of version {version} is not an object"));
        };
        let mut trimmed = Vec::new();

        keep(&mut trimmed, &mut parts, "signatures", |_| true);
        keep(&mut trimmed, &mut parts, "attestations", |_| true);
        keep(&mut trimmed, &mut parts, "integrity", is_text);
        keep(&mut trimmed, &mut parts, "tarball", is_text);
        keep(&mut trimmed, &mut parts, "unpackedSize", |value| is_non_negative_number(value, false));
        keep(&mut trimmed, &mut parts, "fileCount", |value| is_non_negative_number(value, true));
        out.push(("dist".to_owned(), Js::Object(trimmed)));
    }

    keep(&mut out, &mut fields, "repository", |_| true);
    keep(&mut out, &mut fields, "license", |_| true);
    keep(&mut out, &mut fields, "readme", is_text);
    keep(&mut out, &mut fields, "readmeFilename", is_text);
    keep(&mut out, &mut fields, "private", |value| matches!(value, Js::Bool(_)));
    keep(&mut out, &mut fields, "deprecated", is_text);
    // `typeof scripts === "object"`: an object, an array or `null`.
    keep(&mut out, &mut fields, "scripts", |value| matches!(value, Js::Object(_) | Js::Array(_) | Js::Null));

    Ok(Js::Object(out))
}

/// `stripPackument` of a registry answer that is a JSON object.
fn strip(raw: Js) -> Result<Js, String> {
    let Js::Object(mut fields) = raw else {
        return Err("the answer is not a JSON object".to_owned());
    };

    let versions = match take(&mut fields, "versions") {
        None | Some(Js::Null) => Vec::new(),
        Some(Js::Object(entries)) => into_ordered(entries),
        Some(_) => return Err("`versions` is neither an object nor missing".to_owned()),
    };
    let mut kept = Vec::with_capacity(versions.len());

    for (version, entry) in versions {
        if crate::js::PROTOTYPE_NAMES.contains(&version.as_str()) {
            return Err(format!("a version named {version}"));
        }

        kept.push((version.clone(), strip_version(version, entry)?));
    }

    let name = match take(&mut fields, "name") {
        Some(Js::String(name)) => name,
        _ => String::new(),
    };
    let mut out = vec![("name".to_owned(), Js::String(name)), ("versions".to_owned(), Js::Object(kept))];

    for key in ["dist-tags", "time"] {
        if let Some(value) = take(&mut fields, key) {
            out.push((key.to_owned(), value));
        }
    }

    if let Some(readme @ Js::String(_)) = take(&mut fields, "readme") {
        out.push(("readme".to_owned(), readme));
    }

    Ok(Js::Object(out))
}

/// A cut-down packument as the marshalls read it: its versions in JavaScript's order and by name, its tags and times.
pub(crate) struct View<'a> {
    versions: Vec<(&'a str, &'a Js)>,
    by_name: HashMap<&'a str, &'a Js>,
    dist_tags: Option<&'a Js>,
    time: HashMap<&'a str, &'a Js>,
    pub(crate) readme: Option<&'a str>,
    parsed: OnceCell<Result<Vec<(&'a str, Version)>, String>>,
}

impl<'a> View<'a> {
    /// The view of a cut-down packument, or the reason it is Node's.
    pub(crate) fn new(packument: &'a Js) -> Result<Self, String> {
        let Js::Object(_) = packument else { return Err("the packument is not an object".to_owned()) };
        let versions_value = packument.member("versions").ok_or("the packument has no versions member")?;

        if !versions_value.is_object() {
            return Err("`versions` is not an object".to_owned());
        }

        let versions = versions_value.ordered();

        for (name, entry) in &versions {
            if !entry.is_object() || crate::js::PROTOTYPE_NAMES.contains(name) {
                return Err(format!("the entry of version {name} is not a plain object entry"));
            }
        }

        let dist_tags = match packument.member("dist-tags") {
            None | Some(Js::Null) => None,
            Some(tags @ Js::Object(_)) => Some(tags),
            Some(_) => return Err("`dist-tags` is not an object".to_owned()),
        };
        let time = match packument.member("time") {
            None | Some(Js::Null) => HashMap::new(),
            Some(times @ Js::Object(_)) => times.ordered().into_iter().collect(),
            Some(_) => return Err("`time` is not an object".to_owned()),
        };

        Ok(Self {
            by_name: versions.iter().copied().collect(),
            versions,
            dist_tags,
            time,
            readme: packument.member("readme").and_then(Js::text),
            parsed: OnceCell::new(),
        })
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.versions.is_empty()
    }

    /// `Object.keys(versions).at(-1)`.
    pub(crate) fn last_version(&self) -> Option<&'a str> {
        self.versions.last().map(|(name, _)| *name)
    }

    pub(crate) fn entry(&self, version: &str) -> Option<&'a Js> {
        self.by_name.get(version).copied()
    }

    pub(crate) fn versions(&self) -> &[(&'a str, &'a Js)] {
        &self.versions
    }

    /// `dist-tags[tag]`: `Ok(None)` when it is missing, and the reason for a hand-off when it is not text.
    pub(crate) fn tag(&self, tag: &str) -> Result<Option<&'a str>, String> {
        match self.dist_tags.and_then(|tags| tags.member(tag)) {
            None => Ok(None),
            Some(Js::String(version)) => Ok(Some(version)),
            Some(_) => Err(format!("the dist-tag {tag} is not text")),
        }
    }

    /// `time[version]`: `Ok(None)` when it is missing, and the reason for a hand-off when it is not text.
    pub(crate) fn time(&self, version: &str) -> Result<Option<&'a str>, String> {
        match self.time.get(version) {
            None => Ok(None),
            Some(Js::String(stamp)) => Ok(Some(stamp)),
            Some(_) => Err(format!("the time of {version} is not text")),
        }
    }

    /// Every version, in the order of `Object.keys`, parsed; the reason for a hand-off when one is not in the strict
    /// semver form node-semver reads the same way.
    pub(super) fn semver(&self) -> Result<&[(&'a str, Version)], String> {
        self.parsed
            .get_or_init(|| {
                self.versions
                    .iter()
                    .map(|(name, _)| {
                        Version::parse(name)
                            .map(|version| (*name, version))
                            .ok_or_else(|| format!("the version {name} is not strict semver"))
                    })
                    .collect()
            })
            .as_ref()
            .map(Vec::as_slice)
            .map_err(Clone::clone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Js {
        serde_json::from_str(text).unwrap()
    }

    fn stripped(text: &str) -> String {
        let mut out = String::new();

        strip(parse(text)).unwrap().stringify(&mut out).unwrap();

        out
    }

    #[test]
    fn a_packument_is_cut_down_in_the_order_node_cuts_it() {
        let raw = r#"{
            "readme": "top", "_id": "x", "time": {"created": "t"}, "dist-tags": {"latest": "1.0.0"}, "name": "pkg",
            "versions": {
                "1.0.0": {
                    "license": "MIT", "scripts": {"postinstall": "x"}, "extra": 1, "version": "ignored", "readme": 5, "private": "no",
                    "dist": {"tarball": "t", "fileCount": 2.5, "unpackedSize": 10, "integrity": 1, "shasum": "s", "attestations": {"provenance": {}}, "signatures": []},
                    "_npmUser": {"name": "n"}, "deprecated": "old", "bin": "cli.js", "maintainers": [], "repository": null, "readmeFilename": "R"
                }
            }
        }"#;

        assert_eq!(
            stripped(raw),
            concat!(
                r#"{"name":"pkg","versions":{"1.0.0":{"version":"1.0.0","_npmUser":{"name":"n"},"maintainers":[],"bin":"cli.js","#,
                r#""dist":{"signatures":[],"attestations":{"provenance":{}},"tarball":"t","unpackedSize":10},"repository":null,"#,
                r#""license":"MIT","readmeFilename":"R","deprecated":"old","scripts":{"postinstall":"x"}}},"dist-tags":{"latest":"1.0.0"},"#,
                r#""time":{"created":"t"},"readme":"top"}"#
            )
        );
    }

    #[test]
    fn missing_parts_become_what_node_makes_of_them() {
        assert_eq!(stripped("{}"), r#"{"name":"","versions":{}}"#);
        assert_eq!(
            stripped(r#"{"name":5,"versions":null,"time":null,"readme":5}"#),
            r#"{"name":"","versions":{},"time":null}"#
        );
        assert_eq!(
            stripped(r#"{"versions":{"10.0.0":{},"2.0.0":{}}}"#),
            r#"{"name":"","versions":{"10.0.0":{"version":"10.0.0"},"2.0.0":{"version":"2.0.0"}}}"#
        );
    }

    #[test]
    fn what_node_fails_on_or_reads_through_the_prototype_is_handed_over() {
        for raw in [
            "[]",
            r#"{"versions":[]}"#,
            r#"{"versions":"x"}"#,
            r#"{"versions":{"1.0.0":null}}"#,
            r#"{"versions":{"1.0.0":[]}}"#,
            r#"{"versions":{"1.0.0":{"dist":null}}}"#,
            r#"{"versions":{"1.0.0":{"dist":"x"}}}"#,
            r#"{"versions":{"constructor":{}}}"#,
            r#"{"versions":{"__proto__":{}}}"#,
        ] {
            assert!(strip(parse(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn the_view_reads_by_name_tag_and_time() {
        let packument = parse(
            r#"{"name":"p","versions":{"2.0.0":{"version":"2.0.0"},"1.0.0":{"version":"1.0.0"}},"dist-tags":{"latest":"2.0.0","bad":5},"time":{"1.0.0":"t","2.0.0":7},"readme":"r"}"#,
        );
        let view = View::new(&packument).unwrap();

        assert_eq!(view.last_version(), Some("1.0.0"));
        assert!(view.entry("1.0.0").is_some() && view.entry("3.0.0").is_none());
        assert_eq!(view.tag("latest"), Ok(Some("2.0.0")));
        assert_eq!(view.tag("next"), Ok(None));
        assert!(view.tag("bad").is_err());
        assert_eq!(view.time("1.0.0"), Ok(Some("t")));
        assert!(view.time("2.0.0").is_err());
        assert_eq!(view.time("3.0.0"), Ok(None));
        assert_eq!(view.readme, Some("r"));
        assert_eq!(view.semver().unwrap().len(), 2);

        let odd = parse(r#"{"versions":{"1.0":{}}}"#);

        assert!(View::new(&odd).unwrap().semver().is_err());
        assert!(View::new(&parse(r#"{"versions":{"1.0.0":5}}"#)).is_err());
        assert!(View::new(&parse(r#"{"versions":{"1.0.0":{}},"time":[]}"#)).is_err());
    }

    #[test]
    fn the_cache_file_has_node_s_name_and_bytes() {
        assert_eq!(cache_file("/c", "@scope/pkg"), Path::new("/c/packuments/%40scope%2Fpkg.json"));
        assert_eq!(cache_file("/c", "pkg.js"), Path::new("/c/packuments/pkg.js.json"));
        assert_eq!(
            cache_entry(&parse(r#"{"name":"p","versions":{}}"#), 1234).unwrap(),
            r#"{"cacheVersion":3,"createdAt":1234,"packument":{"name":"p","versions":{}},"ttlMs":1800000}"#
        );
    }

    #[test]
    fn a_cache_entry_is_fresh_stale_or_odd() {
        let directory = std::env::temp_dir().join(format!("vis-inspect-packument-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let file = directory.join("p.json");
        let at = |text: &str, now: f64| {
            fs::write(&file, text).unwrap();

            read_cache(&file, now)
        };

        assert!(matches!(read_cache(&directory.join("none.json"), 0.0), Ok(Cached::Fetch { stale_file: false })));
        assert!(matches!(
            at(r#"{"cacheVersion":3,"createdAt":1000,"packument":{"name":"p"},"ttlMs":500}"#, 1500.0),
            Ok(Cached::Fresh(_))
        ));
        assert!(matches!(
            at(r#"{"cacheVersion":3,"createdAt":1000,"packument":{"name":"p"},"ttlMs":500}"#, 1501.0),
            Ok(Cached::Fetch { stale_file: true })
        ));
        assert!(matches!(
            at(r#"{"cacheVersion":2,"createdAt":1000,"packument":{},"ttlMs":500}"#, 1000.0),
            Ok(Cached::Fetch { stale_file: true })
        ));
        assert!(matches!(at("{}", 0.0), Ok(Cached::Fetch { stale_file: true })));

        for odd in [
            "not json",
            "[]",
            r#"{"cacheVersion":3,"packument":{},"ttlMs":500}"#,
            r#"{"cacheVersion":3,"createdAt":"1","packument":{},"ttlMs":5}"#,
            r#"{"cacheVersion":3,"createdAt":1,"ttlMs":5}"#,
        ] {
            assert!(at(odd, 0.0).is_err(), "{odd}");
        }

        fs::remove_dir_all(&directory).unwrap();
    }
}
