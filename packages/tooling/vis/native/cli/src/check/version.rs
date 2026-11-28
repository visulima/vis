//! The version arithmetic of `src/util/catalog/version.ts` and the parts of `semver` it leans on (`parse`,
//! `coerce`, `compare`, `rcompare`), for the inputs where this port and node-semver agree.
//!
//! A version string node-semver would read differently from this module (a numeric identifier above 2^53, a
//! text of more than 256 characters) is not a [`Parsed`]: [`parse_semver`] answers `None` for it, the way
//! `semver.parse` answers `null`. The registry versions a run compares are checked by [`is_strict_semver`] before
//! they are compared, so a version this module and node-semver might order differently never reaches the
//! comparison (the run goes to Node).

use std::cmp::Ordering;

use crate::marshall_check::resolve::coerce;

/// The largest integer a JS number holds exactly; node-semver rejects a main version component above it.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// node-semver's `MAX_LENGTH`.
const MAX_LENGTH: usize = 256;

/// `ParsedVersion`: the numbers of a version and its prerelease text (`""` for a stable release).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Parsed {
    pub(super) major: u64,
    pub(super) minor: u64,
    pub(super) patch: u64,
    pub(super) prerelease: String,
}

/// How far a target version is from the current one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UpdateType {
    Major,
    Minor,
    Patch,
    None,
}

impl UpdateType {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Major => "major",
            Self::Minor => "minor",
            Self::Patch => "patch",
            Self::None => "none",
        }
    }
}

/// `--target`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Latest,
    Minor,
    Patch,
}

impl Target {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Latest => "latest",
            Self::Minor => "minor",
            Self::Patch => "patch",
        }
    }
}

/// A version that is a plain `major.minor.patch[-pre][+build]`, with each part's text kept: what `semver.parse` reads
/// in strict mode, less the ones whose numbers it would read through a double.
struct Strict<'a> {
    parsed: Parsed,
    /// The dot-separated prerelease identifiers, empty for a stable release.
    identifiers: Vec<&'a str>,
}

/// `semver.parse(text)` in strict mode: a leading `v`, the text trimmed first, at most 256 characters.
fn strict(text: &str) -> Option<Strict<'_>> {
    let text = crate::js::trim(text);

    if text.len() > MAX_LENGTH {
        return None;
    }

    let text = text.strip_prefix('v').unwrap_or(text);
    let (core, rest) = match text.find(['-', '+']) {
        Some(index) => (&text[..index], &text[index..]),
        None => (text, ""),
    };
    let mut numbers = core.split('.');
    let mut component = || -> Option<u64> {
        let digits = numbers.next()?;

        if digits.is_empty()
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
            || (digits.len() > 1 && digits.starts_with('0'))
        {
            return None;
        }

        digits.parse::<u64>().ok().filter(|value| *value <= MAX_SAFE_INTEGER)
    };
    let (major, minor, patch) = (component()?, component()?, component()?);

    if numbers.next().is_some() {
        return None;
    }

    let (pre, build) = match rest.strip_prefix('-') {
        Some(after) => match after.split_once('+') {
            Some((pre, build)) => (Some(pre), Some(build)),
            None => (Some(after), None),
        },
        None => (None, rest.strip_prefix('+')),
    };

    if !rest.is_empty() && pre.is_none() && build.is_none() {
        return None;
    }

    let identifiers: Vec<&str> = match pre {
        Some(pre) => {
            let identifiers: Vec<&str> = pre.split('.').collect();

            if !identifiers.iter().all(|identifier| prerelease_identifier(identifier)) {
                return None;
            }

            identifiers
        }
        None => Vec::new(),
    };

    if let Some(build) = build {
        if !build.split('.').all(|identifier| {
            !identifier.is_empty() && identifier.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        }) {
            return None;
        }
    }

    Some(Strict { parsed: Parsed { major, minor, patch, prerelease: identifiers.join(".") }, identifiers })
}

/// `0|[1-9]\d*|\d*[a-zA-Z-][a-zA-Z0-9-]*`.
fn prerelease_identifier(identifier: &str) -> bool {
    if identifier.is_empty() || !identifier.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
        return false;
    }

    if identifier.bytes().all(|byte| byte.is_ascii_digit()) {
        return identifier == "0" || !identifier.starts_with('0');
    }

    true
}

/// Whether `text` is a version this module orders the way node-semver does: a strict semver whose numeric
/// prerelease identifiers are small enough to compare as the integers they are.
pub(super) fn is_strict_semver(text: &str) -> bool {
    strict(text).is_some_and(|version| {
        version
            .identifiers
            .iter()
            .all(|identifier| !identifier.bytes().all(|byte| byte.is_ascii_digit()) || identifier.len() <= 15)
    })
}

/// `semver.parse(text)` as `parseVersion` uses it.
pub(super) fn parse_semver(text: &str) -> Option<Parsed> {
    strict(text).map(|version| version.parsed)
}

/// `parseVersion`: the range prefix is dropped and the rest read as a version; what is no version is coerced from the
/// whole input (`19` is `19.0.0`, `>=1.2.3 <2` is `1.2.3`).
pub(super) fn parse_version(input: &str) -> Option<Parsed> {
    let stripped = if let Some(rest) = input.strip_prefix(['^', '~']) {
        rest
    } else if let Some(rest) = input.strip_prefix(">=").or_else(|| input.strip_prefix("<=")) {
        rest
    } else if let Some(rest) = input.strip_prefix(['>', '<']) {
        rest
    } else {
        input
    };

    if let Some(parsed) = parse_semver(stripped) {
        return Some(parsed);
    }

    let coerced = coerce(input)?;
    let mut parts = coerced.split('.').map(|part| part.parse::<u64>().ok());

    Some(Parsed { major: parts.next()??, minor: parts.next()??, patch: parts.next()??, prerelease: String::new() })
}

/// `extractPrefix`: `^([\^~]|>=|<=|[><=])` or `""`.
pub(super) fn extract_prefix(range: &str) -> &str {
    for prefix in [">=", "<="] {
        if range.starts_with(prefix) {
            return &range[..2];
        }
    }

    match range.chars().next() {
        Some('^' | '~' | '>' | '<' | '=') => &range[..1],
        _ => "",
    }
}

/// `versionToString`.
pub(super) fn version_to_string(version: &Parsed) -> String {
    let base = format!("{}.{}.{}", version.major, version.minor, version.patch);

    if version.prerelease.is_empty() {
        base
    } else {
        format!("{base}-{}", version.prerelease)
    }
}

/// `getUpdateType`.
pub(super) fn update_type(current: &Parsed, target: &Parsed) -> UpdateType {
    if current.major != target.major {
        UpdateType::Major
    } else if current.minor != target.minor {
        UpdateType::Minor
    } else if current.patch != target.patch || current.prerelease != target.prerelease {
        UpdateType::Patch
    } else {
        UpdateType::None
    }
}

/// `compareIdentifiers` for two identifiers of a prerelease.
fn compare_identifiers(a: &str, b: &str) -> Ordering {
    let numeric = |text: &str| text.bytes().all(|byte| byte.is_ascii_digit());

    match (numeric(a), numeric(b)) {
        (true, true) => {
            let (a, b) = (a.parse::<f64>().unwrap_or(0.0), b.parse::<f64>().unwrap_or(0.0));

            a.partial_cmp(&b).unwrap_or(Ordering::Equal)
        }
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

/// `SemVer#comparePre`, with a version that has no prerelease above one that has.
fn compare_prerelease(a: &str, b: &str) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }

    let (mut left, mut right) = (a.split('.'), b.split('.'));

    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (Some(x), Some(y)) if x == y => {}
            (Some(x), Some(y)) => return compare_identifiers(x, y),
        }
    }
}

/// `semver.compare(a, b)` for two strict semver texts (build metadata does not count). `None` when either is not one.
pub(super) fn compare_semver(a: &str, b: &str) -> Option<Ordering> {
    let (a, b) = (parse_semver(a)?, parse_semver(b)?);

    Some(
        a.major
            .cmp(&b.major)
            .then(a.minor.cmp(&b.minor))
            .then(a.patch.cmp(&b.patch))
            .then_with(|| compare_prerelease(&a.prerelease, &b.prerelease)),
    )
}

/// `compareVersions(a, b)` of `version.ts`.
fn compare_versions(a: &Parsed, b: &Parsed) -> Ordering {
    a.major
        .cmp(&b.major)
        .then(a.minor.cmp(&b.minor))
        .then(a.patch.cmp(&b.patch))
        .then_with(|| compare_prerelease(&a.prerelease, &b.prerelease))
}

/// `isNewer(current, target)`.
pub(super) fn is_newer(current: &Parsed, target: &Parsed) -> bool {
    compare_versions(target, current) == Ordering::Greater
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> (u64, u64, u64, String) {
        let version = parse_version(text).unwrap_or_else(|| panic!("{text} reads"));

        (version.major, version.minor, version.patch, version.prerelease)
    }

    #[test]
    fn a_range_is_read_as_the_version_it_names() {
        assert_eq!(parsed("^1.2.3"), (1, 2, 3, String::new()));
        assert_eq!(parsed("~0.4.0-beta.1"), (0, 4, 0, "beta.1".to_owned()));
        assert_eq!(parsed(">=2.0.0"), (2, 0, 0, String::new()));
        assert_eq!(parsed("<3.1.4"), (3, 1, 4, String::new()));
        assert_eq!(parsed("v5.0.1"), (5, 0, 1, String::new()));
        assert_eq!(parsed(" 1.2.3 "), (1, 2, 3, String::new()));
        // Not a version of its own: the first numbers of the text.
        assert_eq!(parsed("19"), (19, 0, 0, String::new()));
        assert_eq!(parsed("^1.2"), (1, 2, 0, String::new()));
        assert_eq!(parsed(">=1.0.0 <2.0.0"), (1, 0, 0, String::new()));
        assert_eq!(parsed("^1.0.0 || ^2.0.0"), (1, 0, 0, String::new()));
        assert_eq!(parsed("=1.2.3"), (1, 2, 3, String::new()));
        assert_eq!(parsed("1.x"), (1, 0, 0, String::new()));
        assert_eq!(parse_version("latest"), None);
        assert_eq!(parse_version("workspace:*"), None);
        assert_eq!(parse_version("01.2.3"), None);
    }

    #[test]
    fn strict_semver_follows_the_grammar() {
        for good in [
            "1.0.0",
            "v1.0.0",
            "1.0.0-0",
            "1.0.0-alpha.1",
            "1.0.0-0a",
            "1.0.0-1-1",
            "1.0.0+build.5",
            "1.0.0-rc.1+exp.sha",
        ] {
            assert!(is_strict_semver(good), "{good}");
        }

        for bad in [
            "1",
            "1.0",
            "1.0.0.0",
            "01.0.0",
            "1.0.0-",
            "1.0.0-01",
            "1.0.0-a..b",
            "1.0.0+",
            "1.0.0+a b",
            "1.0.0-1234567890123456",
            "1.x.0",
            "",
            "9007199254740992.0.0",
        ] {
            assert!(!is_strict_semver(bad), "{bad}");
        }
    }

    #[test]
    fn prefixes_are_found_as_the_regex_finds_them() {
        assert_eq!(extract_prefix("^1.0.0"), "^");
        assert_eq!(extract_prefix("~1.0.0"), "~");
        assert_eq!(extract_prefix(">=1.0.0"), ">=");
        assert_eq!(extract_prefix("<=1.0.0"), "<=");
        assert_eq!(extract_prefix(">1.0.0"), ">");
        assert_eq!(extract_prefix("<1.0.0"), "<");
        assert_eq!(extract_prefix("=1.0.0"), "=");
        assert_eq!(extract_prefix("1.0.0"), "");
        assert_eq!(extract_prefix(""), "");
        assert_eq!(extract_prefix("latest"), "");
    }

    #[test]
    fn versions_are_ordered_as_semver_orders_them() {
        let order = |a: &str, b: &str| compare_semver(a, b).expect("both are versions");

        assert_eq!(order("1.0.0", "1.0.0+build"), Ordering::Equal);
        assert_eq!(order("1.0.0-alpha", "1.0.0"), Ordering::Less);
        assert_eq!(order("1.0.0-alpha", "1.0.0-alpha.1"), Ordering::Less);
        assert_eq!(order("1.0.0-alpha.1", "1.0.0-alpha.beta"), Ordering::Less);
        assert_eq!(order("1.0.0-alpha.beta", "1.0.0-beta"), Ordering::Less);
        assert_eq!(order("1.0.0-beta.2", "1.0.0-beta.11"), Ordering::Less);
        assert_eq!(order("1.0.0-rc.1", "1.0.0"), Ordering::Less);
        assert_eq!(order("1.10.0", "1.9.0"), Ordering::Greater);
        assert_eq!(order("2.0.0", "10.0.0"), Ordering::Less);
        assert_eq!(compare_semver("1.0", "1.0.0"), None);
    }

    #[test]
    fn newer_and_update_type_follow_the_parsed_fields() {
        let version = |text: &str| parse_version(text).expect("a version");

        assert!(is_newer(&version("1.0.0"), &version("1.0.1")));
        assert!(is_newer(&version("1.0.0-beta.1"), &version("1.0.0")));
        assert!(!is_newer(&version("1.0.0"), &version("1.0.0-beta.1")));
        assert!(!is_newer(&version("1.0.0"), &version("1.0.0")));
        assert_eq!(update_type(&version("1.0.0"), &version("2.0.0")), UpdateType::Major);
        assert_eq!(update_type(&version("1.0.0"), &version("1.1.0")), UpdateType::Minor);
        assert_eq!(update_type(&version("1.0.0"), &version("1.0.1")), UpdateType::Patch);
        assert_eq!(update_type(&version("1.0.0-a"), &version("1.0.0")), UpdateType::Patch);
        assert_eq!(update_type(&version("1.0.0"), &version("1.0.0")), UpdateType::None);
        assert_eq!(version_to_string(&version("^1.2.3-rc.1")), "1.2.3-rc.1");
    }
}
