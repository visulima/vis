//! What the report keeps of the raw findings: the generic rule yields to an overlapping finding of
//! another rule, the content-shape heuristics drop false positives, and the survivors are masked and
//! checked against the baseline.

use std::collections::{HashMap, HashSet};

use secret_scanner_core::Finding;

use super::baseline::baseline_keys;

const GENERIC_RULE: &str = "generic-api-key";

/// `abc***xyz`, and `******` for six characters or fewer. Counts characters like the Node mask.
fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();

    if chars.len() <= 6 {
        return "******".to_owned();
    }

    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 3..].iter().collect();

    format!("{head}{}{tail}", "*".repeat(chars.len() - 6))
}

/// The content-shape heuristics, on an ASCII secret: lock files by name, runs of one character or
/// of a sequence, UUIDs, and secrets with no alphanumeric character.
fn is_false_positive(finding: &Finding) -> bool {
    const LOCK_FILES: [&str; 28] = [
        ".terraform.lock.hcl",
        "Berksfile.lock",
        "Brewfile.lock.json",
        "bun.lock",
        "bun.lockb",
        "Cargo.lock",
        "Cartfile.resolved",
        "composer.lock",
        "conda-lock.yml",
        "flake.lock",
        "Gemfile.lock",
        "go.sum",
        "gradle.lockfile",
        "mix.lock",
        "npm-shrinkwrap.json",
        "package-lock.json",
        "Package.resolved",
        "packages.lock.json",
        "pdm.lock",
        "Pipfile.lock",
        "pnpm-lock.yaml",
        "pnpm-lock.yml",
        "Podfile.lock",
        "poetry.lock",
        "pubspec.lock",
        "shrinkwrap.yaml",
        "uv.lock",
        "yarn.lock",
    ];

    let secret = finding.secret.as_str();
    let basename = finding.file.rsplit('/').next().unwrap_or("");

    if !finding.tags.iter().any(|tag| tag == "exposure") && LOCK_FILES.contains(&basename) {
        return true;
    }

    is_sequential(secret)
        || is_uuid(secret)
        || (!secret.is_empty() && !secret.bytes().any(|byte| byte.is_ascii_alphanumeric()))
}

/// `AAAAAAAA`, `xxxxxxxx`, `abcdefgh`, `12345678`: six or more characters of one repeated
/// character or a substring of the alphabet, the digits or the hex digits (case-insensitively).
fn is_sequential(secret: &str) -> bool {
    if secret.len() < 6 {
        return false;
    }

    let bytes = secret.as_bytes();

    // `.` in the JS pattern does not match a line terminator.
    if bytes[0] != b'\n' && bytes[0] != b'\r' && bytes.iter().all(|byte| *byte == bytes[0]) {
        return true;
    }

    let upper = secret.to_ascii_uppercase();
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2);
    let digits = "0123456789".repeat(6);
    let hex = "0123456789ABCDEF".repeat(4);

    [&alphabet[..alphabet.len().min(60)], &digits[..60], &hex[..60]].iter().any(|sequence| sequence.contains(&upper))
}

fn is_uuid(secret: &str) -> bool {
    let groups: Vec<&str> = secret.split('-').collect();

    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, length)| group.len() == length && group.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// The line and column of one end of a finding, compared as a pair.
fn before(line_a: u32, column_a: u32, line_b: u32, column_b: u32) -> bool {
    (line_a, column_a) < (line_b, column_b)
}

fn overlaps(a: &Finding, b: &Finding) -> bool {
    before(a.start_line, a.start_column, b.end_line, b.end_column)
        && before(b.start_line, b.start_column, a.end_line, a.end_column)
}

/// The findings a scan reports: the generic rule yields to any overlapping finding of another
/// rule, then the heuristics drop false positives. `None` when a finding needs something this
/// module does not do (a checksum, composite dependencies, JS string semantics, a path outside the
/// root).
pub(super) fn report_findings(found: Vec<Finding>, checksum_rules: &HashSet<String>) -> Option<Vec<Finding>> {
    for finding in &found {
        if finding.required_findings.is_some()
            || checksum_rules.contains(&finding.rule_id)
            || !finding.secret.is_ascii()
            || finding.file.starts_with('/')
            || finding.file.contains('\\')
        {
            return None;
        }
    }

    let shadowers: Vec<&Finding> =
        found.iter().filter(|finding| !is_false_positive(finding) && finding.rule_id != GENERIC_RULE).collect();
    let mut by_file: HashMap<&str, Vec<&Finding>> = HashMap::new();

    for finding in shadowers {
        by_file.entry(finding.file.as_str()).or_default().push(finding);
    }

    let shadowed = |finding: &Finding| {
        finding.rule_id == GENERIC_RULE
            && by_file
                .get(finding.file.as_str())
                .is_some_and(|others| others.iter().any(|other| overlaps(finding, other)))
    };

    Some(found.iter().filter(|finding| !shadowed(finding) && !is_false_positive(finding)).cloned().collect())
}

/// Masks the findings, as the report shows them, and drops the baselined ones.
pub(super) fn shown(found: Vec<Finding>, baseline: &HashSet<String>) -> Vec<Finding> {
    found
        .into_iter()
        .filter_map(|finding| {
            let mut masked = finding.clone();

            masked.r#match = mask(&finding.r#match);
            masked.secret = mask(&finding.secret);

            let baselined = !baseline.is_empty()
                && baseline_keys(&finding)
                    .iter()
                    .chain(baseline_keys(&masked).iter())
                    .any(|key| baseline.contains(key));

            (!baselined).then_some(masked)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::secrets::tests::finding;

    #[test]
    fn masks_like_the_node_pipeline() {
        assert_eq!(mask("abcdef"), "******");
        assert_eq!(mask("abcdefg"), "abc*efg");
        assert_eq!(mask("abcdefghijklmnop"), "abc**********nop");
        assert_eq!(mask("äöüäöüä"), "äöü*öüä");
    }

    #[test]
    fn sequences_uuids_and_punctuation_are_false_positives() {
        for secret in [
            "AAAAAAAA",
            "xxxxxx",
            "abcdefgh",
            "12345678",
            "ABCDEF",
            "89abcdef",
            "*****",
            "------",
            "123e4567-e89b-12d3-a456-426614174000",
        ] {
            assert!(is_false_positive(&finding(secret, "a.env")), "{secret}");
        }

        for secret in ["abcde", "Zx9fK2mQ", "abcdefgz", ""] {
            assert!(!is_false_positive(&finding(secret, "a.env")), "{secret}");
        }
    }

    #[test]
    fn lock_files_are_false_positives_unless_tagged_exposure() {
        assert!(is_false_positive(&finding("Zx9fK2mQ", "sub/yarn.lock")));
        assert!(!is_false_positive(&finding("Zx9fK2mQ", "sub/yarn.lock.txt")));

        let mut exposed = finding("Zx9fK2mQ", "package-lock.json");

        exposed.tags.push("exposure".to_owned());
        assert!(!is_false_positive(&exposed));
    }

    #[test]
    fn a_generic_finding_yields_to_an_overlapping_one() {
        let mut generic = finding("Zx9fK2mQ", "a.env");
        let mut specific = finding("Zx9fK2mQ", "a.env");

        generic.rule_id = GENERIC_RULE.to_owned();
        generic.end_column = 20;
        specific.start_column = 5;
        specific.end_column = 15;

        let kept = report_findings(vec![generic.clone(), specific], &HashSet::new()).unwrap();

        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].rule_id, "demo");

        // Touching spans do not overlap.
        let mut adjacent = finding("Zx9fK2mQ", "a.env");

        adjacent.start_column = 20;
        adjacent.end_column = 25;
        assert_eq!(report_findings(vec![generic, adjacent], &HashSet::new()).unwrap().len(), 2);
    }

    #[test]
    fn findings_that_need_node_are_not_reported_natively() {
        let checksum: HashSet<String> = ["demo".to_owned()].into();

        assert!(report_findings(vec![finding("Zx9fK2mQ", "a.env")], &checksum).is_none());
        assert!(report_findings(vec![finding("Zx9fK2mQ", "/abs/a.env")], &HashSet::new()).is_none());
        assert!(report_findings(vec![finding("Zx9fK2mÖ", "a.env")], &HashSet::new()).is_none());
    }
}
