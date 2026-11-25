//! The part of node-semver the marshalls use: `valid` and `lt` on versions in the strict form every registry
//! publishes (`MAJOR.MINOR.PATCH` with an optional `-prerelease`), and nothing else.
//!
//! node-semver's `valid` also takes `v1.2.3`, `=1.2.3`, surrounding spaces and a `+build` suffix, and `compare` ignores
//! the build. A version in any of those shapes, one over 256 characters, and a number past `Number.MAX_SAFE_INTEGER`
//! is not parsed here ([`Version::parse`] is `None`), and the caller hands the whole run to Node.

use std::cmp::Ordering;

use crate::js::MAX_SAFE_INTEGER;

/// node-semver's `MAX_LENGTH`.
const MAX_LENGTH: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Identifier {
    Numeric(u64),
    Text(String),
}

impl Ord for Identifier {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Numeric(a), Self::Numeric(b)) => a.cmp(b),
            (Self::Numeric(_), Self::Text(_)) => Ordering::Less,
            (Self::Text(_), Self::Numeric(_)) => Ordering::Greater,
            (Self::Text(a), Self::Text(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Identifier {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Version {
    core: [u64; 3],
    pre: Vec<Identifier>,
}

/// A number node-semver reads: `0` or digits without a leading zero, no larger than a double holds exactly.
fn number(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) || (text.len() > 1 && text.starts_with('0')) {
        return None;
    }

    text.parse::<u64>().ok().filter(|value| *value <= MAX_SAFE_INTEGER)
}

impl Version {
    /// The version `text` spells in the strict form, or `None`.
    pub(super) fn parse(text: &str) -> Option<Self> {
        if text.len() > MAX_LENGTH || !text.is_ascii() {
            return None;
        }

        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let mut parts = core.split('.');
        let (major, minor, patch) = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);

        if parts.next().is_some() {
            return None;
        }

        let mut identifiers = Vec::new();

        for identifier in pre.into_iter().flat_map(|pre| pre.split('.')) {
            if identifier.is_empty() || !identifier.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
                return None;
            }

            identifiers.push(if identifier.bytes().all(|byte| byte.is_ascii_digit()) {
                Identifier::Numeric(number(identifier)?)
            } else {
                Identifier::Text(identifier.to_owned())
            });
        }

        Some(Self { core: [major, minor, patch], pre: identifiers })
    }

    pub(super) fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            // A release is above its own prereleases.
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => self.pre.cmp(&other.pre),
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::Version;

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn only_the_strict_form_parses() {
        for text in ["1.2.3", "0.0.0", "1.0.0-beta.1", "1.0.0-0", "1.0.0-x-y.z", "9007199254740991.0.0"] {
            assert!(Version::parse(text).is_some(), "{text}");
        }

        for text in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "v1.2.3",
            "=1.2.3",
            " 1.2.3",
            "01.2.3",
            "1.02.3",
            "1.2.3-",
            "1.2.3-01",
            "1.2.3+build",
            "1.2.3-a+b",
            "1.2.3-a..b",
            "9007199254740992.0.0",
            "1.2.3-9007199254740992",
            "1.x.3",
            "-1.2.3",
            "1.2.3-\u{e9}",
        ] {
            assert!(Version::parse(text).is_none(), "{text}");
        }

        assert!(Version::parse(&format!("1.0.0-{}", "a".repeat(260))).is_none());
    }

    #[test]
    fn versions_order_the_way_semver_does() {
        let ordered = [
            "0.9.9",
            "1.0.0-0",
            "1.0.0-1",
            "1.0.0-2",
            "1.0.0-10",
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.1.0",
            "2.0.0",
            "10.0.0",
        ];

        for window in ordered.windows(2) {
            assert!(version(window[0]) < version(window[1]), "{} < {}", window[0], window[1]);
        }

        assert_eq!(version("1.0.0-a-b"), version("1.0.0-a-b"));
        assert!(version("1.0.0-ab") < version("1.0.0-b"));
        assert!(version("1.0.0-Z") < version("1.0.0-a"));
        assert!(version("1.0.0-1").is_prerelease() && !version("1.0.0").is_prerelease());
    }
}
