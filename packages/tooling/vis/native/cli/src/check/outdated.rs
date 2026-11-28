//! `collectEntries`, `buildOutdatedEntries` and `findTargetVersion` of `src/util/catalog/outdated.ts`, and the glob
//! of `src/util/catalog/patterns.ts`, for a run with no release-age rule, no release channel and no per-package target
//! (what the command gives them when its config has no `update` key).

use std::cmp::Ordering;
use std::collections::HashMap;

use super::catalogs::Catalog;
use super::registry::Info;
use super::version::{
    compare_semver, extract_prefix, is_newer, parse_version, update_type, version_to_string, Parsed, Target, UpdateType,
};

/// `OutdatedEntry`, in the field order `JSON.stringify` writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Outdated {
    pub(super) catalog_name: String,
    pub(super) current_range: String,
    pub(super) new_range: String,
    pub(super) package_name: String,
    pub(super) target_version: String,
    pub(super) update_type: UpdateType,
}

/// One dependency to look up.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Entry {
    pub(super) catalog: String,
    pub(super) package: String,
    pub(super) range: String,
}

/// The filters of a run: the names it looks up.
pub(super) struct Rules<'a> {
    pub(super) exclude: &'a [String],
    pub(super) include: &'a [String],
}

/// `matchesPattern(name, pattern)`: `*` is any run of characters and `?` any one; every other character is itself.
/// Both are ASCII here, so a character and a UTF-16 unit are the same thing.
pub(super) fn matches_pattern(name: &str, pattern: &str) -> bool {
    let (name, pattern) = (name.as_bytes(), pattern.as_bytes());
    let (mut n, mut p) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;

    while n < name.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            backtrack = Some((p, n));
            p += 1;
        } else if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if let Some((star, matched)) = backtrack {
            p = star + 1;
            n = matched + 1;
            backtrack = Some((star, matched + 1));
        } else {
            return false;
        }
    }

    pattern[p..].iter().all(|byte| *byte == b'*')
}

/// `matchesFilters(name, include, exclude)`.
fn matches_filters(name: &str, include: &[String], exclude: &[String]) -> bool {
    if exclude.iter().any(|pattern| matches_pattern(name, pattern)) {
        return false;
    }

    include.is_empty() || include.iter().any(|pattern| matches_pattern(name, pattern))
}

/// `collectEntries`: the dependencies a run looks up, in catalog order. Ranges that are not versions, or that name
/// one exactly (no `^`, `~` or comparator in front), are left out, as are the names the filters drop.
pub(super) fn collect_entries(catalogs: &[Catalog], rules: &Rules<'_>) -> Vec<Entry> {
    let mut entries = Vec::new();

    for catalog in catalogs {
        for (package, range) in &catalog.dependencies {
            if range.starts_with("workspace:")
                || range.starts_with("file:")
                || range.starts_with("link:")
                || range == "*"
            {
                continue;
            }

            if extract_prefix(range).is_empty() {
                continue;
            }

            if matches_filters(package, rules.include, rules.exclude) {
                entries.push(Entry { catalog: catalog.name.clone(), package: package.clone(), range: range.clone() });
            }
        }
    }

    entries
}

/// `matchesReleaseChannel` for the two channels the command has: `any` with `--prerelease`, else `stable`.
fn in_channel(candidate: &Parsed, include_prerelease: bool) -> bool {
    include_prerelease || candidate.prerelease.is_empty()
}

/// `filterCandidates`: the newest version after `current` that the channel and the constraint allow.
fn filter_candidates(
    versions: &[String],
    current: &Parsed,
    include_prerelease: bool,
    constraint: &dyn Fn(&Parsed) -> bool,
) -> Option<String> {
    let mut candidates: Vec<(Parsed, &String)> = versions
        .iter()
        .filter_map(|raw| parse_version(raw).map(|parsed| (parsed, raw)))
        .filter(|(parsed, _)| in_channel(parsed, include_prerelease) && is_newer(current, parsed) && constraint(parsed))
        .collect();

    // `rcompare` on the raw versions: newest first, and a stable sort keeps the registry's order for equal ones.
    candidates.sort_by(|(_, a), (_, b)| compare_semver(b, a).unwrap_or(Ordering::Equal));

    candidates.first().map(|(_, raw)| (*raw).clone())
}

/// `findTargetVersion(versions, latest, currentRange, target, includePrerelease)`.
pub(super) fn find_target_version(
    versions: &[String],
    latest: &str,
    current_range: &str,
    target: Target,
    include_prerelease: bool,
) -> Option<String> {
    let current = parse_version(current_range)?;

    if target == Target::Latest {
        let latest_parsed = parse_version(latest)?;

        if !in_channel(&latest_parsed, include_prerelease) {
            // The tag points off the channel: the newest version on it is the answer instead.
            return filter_candidates(versions, &current, include_prerelease, &|_| true);
        }

        return is_newer(&current, &latest_parsed).then(|| latest.to_owned());
    }

    if target == Target::Patch {
        filter_candidates(versions, &current, include_prerelease, &|candidate| {
            candidate.major == current.major && candidate.minor == current.minor
        })
    } else {
        filter_candidates(versions, &current, include_prerelease, &|candidate| candidate.major == current.major)
    }
}

/// `buildOutdatedEntries`: one entry per dependency whose range has a newer target.
pub(super) fn build(
    entries: &[Entry],
    registry: &HashMap<String, Info>,
    target: Target,
    include_prerelease: bool,
) -> Vec<Outdated> {
    let mut outdated = Vec::new();

    for entry in entries {
        let Some(info) = registry.get(&entry.package) else { continue };
        let Some(target_version) =
            find_target_version(&info.versions, &info.latest, &entry.range, target, include_prerelease)
        else {
            continue;
        };
        let (Some(current), Some(newer)) = (parse_version(&entry.range), parse_version(&target_version)) else {
            continue;
        };
        let kind = update_type(&current, &newer);

        if kind == UpdateType::None {
            continue;
        }

        outdated.push(Outdated {
            catalog_name: entry.catalog.clone(),
            current_range: entry.range.clone(),
            new_range: format!("{}{target_version}", extract_prefix(&entry.range)),
            package_name: entry.package.clone(),
            target_version,
            update_type: kind,
        });
    }

    outdated
}

/// `filteredByTarget`: what `latest` would offer for the packages the chosen target leaves out. Empty for `latest`.
pub(super) fn filtered_by_target(
    entries: &[Entry],
    registry: &HashMap<String, Info>,
    outdated: &[Outdated],
    target: Target,
    include_prerelease: bool,
) -> Vec<Outdated> {
    if target == Target::Latest {
        return Vec::new();
    }

    build(entries, registry, Target::Latest, include_prerelease)
        .into_iter()
        .filter(|entry| !outdated.iter().any(|kept| kept.package_name == entry.package_name))
        .collect()
}

/// The text a dependency's version contributes to the advisory key, for completeness of the OSV query: `name@version`.
pub(super) fn advisory_version(range: &str) -> Option<String> {
    parse_version(range).map(|parsed| version_to_string(&parsed)).filter(|version| !version.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versions(list: &[&str]) -> Vec<String> {
        list.iter().map(|version| (*version).to_owned()).collect()
    }

    #[test]
    fn globs_match_as_the_regular_expression_does() {
        for (name, pattern, expected) in [
            ("react", "react", true),
            ("react", "reac", false),
            ("react", "re*", true),
            ("react", "*", true),
            ("react", "**", true),
            ("react", "r?act", true),
            ("react", "r??ct", true),
            ("react", "r?ct", false),
            ("@types/node", "@types/*", true),
            ("@types/node", "@types/n*e", true),
            ("@types/node", "types/*", false),
            ("a.b", "a.b", true),
            ("axb", "a.b", false),
            ("a+b", "a+b", true),
            ("ab", "a+b", false),
            ("a-b", "a-b", true),
            ("abab", "*ab", true),
            ("abac", "*ab", false),
            ("", "*", true),
            ("", "", true),
            ("a", "", false),
            ("mississippi", "m*iss*pi", true),
            ("mississippi", "m*iss*pj", false),
        ] {
            assert_eq!(matches_pattern(name, pattern), expected, "{name} ~ {pattern}");
        }
    }

    #[test]
    fn filters_exclude_first_then_require_an_include_when_there_is_one() {
        let list = |items: &[&str]| items.iter().map(|item| (*item).to_owned()).collect::<Vec<_>>();

        assert!(matches_filters("a", &[], &[]));
        assert!(!matches_filters("a", &[], &list(&["a"])));
        assert!(!matches_filters("a", &list(&["a"]), &list(&["*"])));
        assert!(matches_filters("a", &list(&["a", "b"]), &[]));
        assert!(!matches_filters("c", &list(&["a", "b"]), &[]));
    }

    #[test]
    fn the_target_decides_which_version_is_offered() {
        let all = versions(&["1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0-beta.1"]);
        let find = |range: &str, latest: &str, target, pre| find_target_version(&all, latest, range, target, pre);

        assert_eq!(find("^1.0.0", "2.0.0", Target::Latest, false), Some("2.0.0".into()));
        assert_eq!(find("^1.0.0", "2.0.0", Target::Minor, false), Some("1.2.0".into()));
        assert_eq!(find("^1.0.0", "2.0.0", Target::Patch, false), None);
        assert_eq!(find("^1.1.0", "2.0.0", Target::Patch, false), None);
        assert_eq!(find("^2.0.0", "2.0.0", Target::Latest, false), None);
        assert_eq!(find("^2.0.0", "2.0.0", Target::Minor, true), Some("2.1.0-beta.1".into()));
        // A tag that is a prerelease is off the stable channel: the newest stable version is offered instead.
        assert_eq!(find("^1.0.0", "2.1.0-beta.1", Target::Latest, false), Some("2.0.0".into()));
        assert_eq!(find("^1.0.0", "2.1.0-beta.1", Target::Latest, true), Some("2.1.0-beta.1".into()));
        assert_eq!(find("^1.0.0", "", Target::Latest, false), None);
        assert_eq!(find("latest", "2.0.0", Target::Latest, false), None);
    }

    #[test]
    fn patch_stays_on_the_same_minor() {
        let all = versions(&["2.0.0", "2.0.5", "2.0.10", "2.1.0"]);

        assert_eq!(find_target_version(&all, "2.1.0", "~2.0.0", Target::Patch, false), Some("2.0.10".into()));
        assert_eq!(find_target_version(&all, "2.1.0", "~2.0.0", Target::Minor, false), Some("2.1.0".into()));
    }

    #[test]
    fn outdated_entries_carry_the_prefix_of_their_range() {
        let catalogs = vec![Catalog {
            name: ".:dependencies".into(),
            dependencies: vec![
                ("a".into(), "^1.0.0".into()),
                ("b".into(), "1.0.0".into()),
                ("c".into(), "workspace:^1".into()),
                ("d".into(), "~1.0.0".into()),
                ("e".into(), ">=1.0.0 <2".into()),
            ],
        }];
        let rules = Rules { exclude: &[], include: &[] };
        let entries = collect_entries(&catalogs, &rules);

        assert_eq!(entries.iter().map(|entry| entry.package.as_str()).collect::<Vec<_>>(), ["a", "d", "e"]);

        let mut registry = HashMap::new();

        for name in ["a", "d", "e"] {
            registry.insert(name.to_owned(), Info { latest: "1.4.0".into(), versions: versions(&["1.0.0", "1.4.0"]) });
        }

        let outdated = build(&entries, &registry, Target::Latest, false);

        assert_eq!(
            outdated.iter().map(|entry| entry.new_range.as_str()).collect::<Vec<_>>(),
            ["^1.4.0", "~1.4.0", ">=1.4.0"]
        );
        assert!(outdated.iter().all(|entry| entry.update_type == UpdateType::Minor));
        assert_eq!(filtered_by_target(&entries, &registry, &outdated, Target::Latest, false), []);
        assert_eq!(advisory_version("^1.2.3-rc.1").as_deref(), Some("1.2.3-rc.1"));
        assert_eq!(advisory_version("latest"), None);
    }
}
