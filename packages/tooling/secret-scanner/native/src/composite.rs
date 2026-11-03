// Composite rules (gitleaks 8.28+ `[[rules.required]]` + `skipReport`).
//
// Runs once per scanned unit (a file, an archive entry, or an in-memory string) on the
// detector's raw findings, before `finalize_findings` dedups spans. Doing it before the
// dedup matters: a `skipReport` finding that won a same-span collapse would otherwise take
// a reportable finding down with it.

use std::collections::HashMap;

use crate::detector::RawFinding;
use crate::rules::{CompiledRuleset, RequiredRule};

/// Keep a primary finding only when each of its required rules has a finding in the same
/// unit within the proximity bounds, attach the nearest such finding per required id, and
/// drop every finding of a `skipReport` rule.
///
/// Required findings are taken from the unit's raw findings as detected, so a required rule
/// counts even when it is itself a composite whose own requirements fail, or is `skipReport`.
/// Suppressed findings (allowlisted or inline-allowed, present only with `reportSuppressed`)
/// never satisfy a requirement, as in gitleaks, where allowlisted matches don't exist.
pub fn apply(ruleset: &CompiledRuleset, findings: Vec<RawFinding>) -> Vec<RawFinding> {
    if !ruleset.has_composite || findings.is_empty() {
        return findings;
    }

    let rules: HashMap<&str, (&[RequiredRule], bool)> =
        ruleset.rules.iter().map(|r| (r.id.as_str(), (r.required.as_slice(), r.skip_report))).collect();

    let mut attached: Vec<Option<Vec<RawFinding>>> = Vec::with_capacity(findings.len());
    let mut keep: Vec<bool> = Vec::with_capacity(findings.len());

    for (i, primary) in findings.iter().enumerate() {
        let (required, skip_report) = rules.get(primary.rule_id.as_str()).copied().unwrap_or((&[], false));
        if skip_report {
            keep.push(false);
            attached.push(None);
            continue;
        }
        if required.is_empty() {
            keep.push(true);
            attached.push(None);
            continue;
        }

        let mut matches = Vec::with_capacity(required.len());
        for req in required {
            match nearest(&findings, i, req) {
                Some(found) => matches.push(found),
                None => break,
            }
        }

        if matches.len() == required.len() {
            keep.push(true);
            attached.push(Some(matches.into_iter().map(|j| findings[j].clone()).collect()));
        } else {
            keep.push(false);
            attached.push(None);
        }
    }

    findings
        .into_iter()
        .zip(keep)
        .zip(attached)
        .filter_map(|((mut f, keep), required)| {
            if !keep {
                return None;
            }
            if required.is_some() {
                f.required_findings = required;
            }
            Some(f)
        })
        .collect()
}

/// Index of the closest finding of `req.rule_id` that satisfies the bounds, ties broken by
/// line distance, then column distance, then detection order.
fn nearest(findings: &[RawFinding], primary_idx: usize, req: &RequiredRule) -> Option<usize> {
    let primary = &findings[primary_idx];
    findings
        .iter()
        .enumerate()
        .filter(|(j, f)| {
            *j != primary_idx && f.suppressed_by.is_none() && f.rule_id == req.rule_id && within(primary, f, req)
        })
        .min_by_key(|(j, f)| {
            (primary.start_line.abs_diff(f.start_line), primary.start_column.abs_diff(f.start_column), *j)
        })
        .map(|(j, _)| j)
}

/// Proximity check between the start positions of two findings.
///
/// - No bounds: anywhere in the unit counts.
/// - Same start line: `withinColumns` (when set) bounds the column distance.
/// - Different start lines: only `withinLines` applies. `withinColumns` is never compared
///   across lines (the bug gitleaks #2123/#2150/#2175/#2187/#2201/#2255 fix), so a rule
///   with only `withinColumns` requires the same line.
fn within(primary: &RawFinding, other: &RawFinding, req: &RequiredRule) -> bool {
    if req.within_lines.is_none() && req.within_columns.is_none() {
        return true;
    }

    let line_diff = primary.start_line.abs_diff(other.start_line);
    if line_diff == 0 {
        return req.within_columns.is_none_or(|max| primary.start_column.abs_diff(other.start_column) <= max);
    }

    req.within_lines.is_some_and(|max| line_diff <= max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn ruleset(json: serde_json::Value) -> CompiledRuleset {
        let cfg: Config = serde_json::from_value(json).expect("config");
        CompiledRuleset::compile(&cfg).expect("compile")
    }

    fn finding(rule_id: &str, line: u32, col: u32) -> RawFinding {
        RawFinding {
            rule_id: rule_id.into(),
            file: "f.env".into(),
            start_line: line,
            end_line: line,
            start_column: col,
            end_column: col + 4,
            r#match: format!("{rule_id}@{line}:{col}"),
            secret: format!("{rule_id}@{line}:{col}"),
            start_offset: line * 100 + col,
            end_offset: line * 100 + col + 4,
            confidence: "low",
            ..Default::default()
        }
    }

    fn rules_with(required: serde_json::Value) -> CompiledRuleset {
        ruleset(serde_json::json!({
            "rules": [
                { "id": "primary", "regex": "P", "required": required },
                { "id": "dep", "regex": "D" },
            ]
        }))
    }

    #[test]
    fn same_line_uses_columns_other_lines_ignore_them() {
        let rs = rules_with(serde_json::json!([{ "id": "dep", "withinLines": 2, "withinColumns": 5 }]));

        // Same line, too far apart in columns.
        assert!(apply(&rs, vec![finding("primary", 1, 1), finding("dep", 1, 40)])
            .iter()
            .all(|f| f.rule_id != "primary"));
        // Same line, close.
        assert!(apply(&rs, vec![finding("primary", 1, 1), finding("dep", 1, 4)])
            .iter()
            .any(|f| f.rule_id == "primary"));
        // Next line, far column: only withinLines applies.
        let out = apply(&rs, vec![finding("primary", 1, 1), finding("dep", 2, 80)]);
        let primary = out.iter().find(|f| f.rule_id == "primary").expect("kept");
        assert_eq!(primary.required_findings.as_ref().map(Vec::len), Some(1));
        // Out of line range.
        assert!(apply(&rs, vec![finding("primary", 1, 1), finding("dep", 4, 1)])
            .iter()
            .all(|f| f.rule_id != "primary"));
    }

    #[test]
    fn columns_alone_require_the_same_line() {
        let rs = rules_with(serde_json::json!([{ "id": "dep", "withinColumns": 50 }]));

        assert!(apply(&rs, vec![finding("primary", 1, 1), finding("dep", 2, 1)])
            .iter()
            .all(|f| f.rule_id != "primary"));
        assert!(apply(&rs, vec![finding("primary", 3, 1), finding("dep", 3, 30)])
            .iter()
            .any(|f| f.rule_id == "primary"));
    }

    #[test]
    fn no_bounds_means_anywhere_and_nearest_is_attached() {
        let rs = rules_with(serde_json::json!([{ "id": "dep" }]));
        let out = apply(&rs, vec![finding("dep", 900, 1), finding("primary", 10, 1), finding("dep", 12, 1)]);
        let primary = out.iter().find(|f| f.rule_id == "primary").expect("kept");
        let attached = primary.required_findings.as_ref().expect("attached");
        assert_eq!(attached[0].start_line, 12);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn skip_report_findings_are_dropped_but_satisfy_requirements() {
        let rs = ruleset(serde_json::json!({
            "rules": [
                { "id": "primary", "regex": "P", "required": [{ "id": "dep" }] },
                { "id": "dep", "regex": "D", "skipReport": true },
            ]
        }));
        let out = apply(&rs, vec![finding("primary", 1, 1), finding("dep", 5, 1)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rule_id, "primary");
        assert_eq!(out[0].required_findings.as_ref().unwrap()[0].rule_id, "dep");
    }

    #[test]
    fn suppressed_findings_never_satisfy_a_requirement() {
        let rs = rules_with(serde_json::json!([{ "id": "dep" }]));
        let mut dep = finding("dep", 1, 10);
        dep.suppressed_by = Some(crate::suppression::SuppressionReason::Allowlist);
        let mut primary = finding("primary", 1, 1);
        primary.suppressed_by = Some(crate::suppression::SuppressionReason::InlineAllow);

        // The primary is dropped; the suppressed dependency itself is passed through.
        let out = apply(&rs, vec![finding("primary", 1, 1), dep]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rule_id, "dep");
        // A suppressed primary is still a composite: kept (as suppressed) only when satisfied.
        let out = apply(&rs, vec![primary, finding("dep", 1, 10)]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].suppressed_by, Some(crate::suppression::SuppressionReason::InlineAllow));
    }

    #[test]
    fn unknown_required_id_skips_the_rule_with_a_reason() {
        let rs = ruleset(serde_json::json!({
            "rules": [
                { "id": "primary", "regex": "P", "required": [{ "id": "nope" }] },
                { "id": "outer", "regex": "O", "required": [{ "id": "primary" }] },
                { "id": "bad", "regex": "(" },
                { "id": "needs-bad", "regex": "N", "required": [{ "id": "bad" }] },
            ]
        }));
        assert!(rs.rules.is_empty());
        let reason = |id: &str| rs.skipped_rules.iter().find(|(r, _)| r == id).map(|(_, why)| why.clone()).unwrap();
        assert!(reason("primary").contains("'nope' is not defined"));
        assert!(reason("outer").contains("'primary' was skipped"));
        assert!(reason("needs-bad").contains("'bad' was skipped"));
    }

    #[test]
    fn rulesets_without_composites_pass_through() {
        let rs = ruleset(serde_json::json!({ "rules": [{ "id": "a", "regex": "A" }] }));
        assert!(!rs.has_composite);
        assert_eq!(apply(&rs, vec![finding("a", 1, 1)]).len(), 1);
    }

    #[test]
    fn gitleaks_key_aliases_load() {
        let rs = ruleset(serde_json::json!({
            "rules": [
                { "id": "primary", "regex": "P", "required": [{ "id": "dep", "within_lines": 1, "withincolumns": 3 }] },
                { "id": "dep", "regex": "D", "skip_report": true },
            ]
        }));
        let primary = rs.rules.iter().find(|r| r.id == "primary").unwrap();
        assert_eq!(primary.required[0].within_lines, Some(1));
        assert_eq!(primary.required[0].within_columns, Some(3));
        assert!(rs.rules.iter().find(|r| r.id == "dep").unwrap().skip_report);
    }
}
