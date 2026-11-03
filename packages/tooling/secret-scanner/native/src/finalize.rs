// Turns raw detector findings into the NAPI report: path relativisation, span dedup,
// stable ordering, redaction.

use std::path::PathBuf;

use crate::detector::RawFinding;
use crate::skip::Skipped;
use crate::{Finding, RequiredFinding, ScanReport, SkippedFile};

/// Build the NAPI report: finalize findings, rewrite skipped paths like findings. `roots`
/// are the scan roots that paths are made relative to; an in-memory scan passes `&[]` and
/// keeps its paths as given.
pub fn build_report(
    findings: Vec<RawFinding>,
    skipped: Vec<Skipped>,
    roots: &[PathBuf],
    redact_secrets: bool,
) -> ScanReport {
    let canon_roots = canonicalize_roots(roots);
    let mut skipped: Vec<SkippedFile> = skipped
        .into_iter()
        .map(|Skipped { path, entry, reason }| {
            let raw = path.to_string_lossy().to_string();
            let on_disk = relative_to_root(&raw, &canon_roots).unwrap_or(raw);
            SkippedFile { path: format!("{on_disk}{entry}"), reason: reason.as_str().to_string() }
        })
        .collect();
    skipped.sort_by(|a, b| a.path.cmp(&b.path));

    let (active, suppressed) = finalize_findings(findings, &canon_roots);
    ScanReport {
        findings: active.into_iter().map(|f| to_napi_finding(f, redact_secrets)).collect(),
        // Every finding of the suppressed group carries its reason.
        suppressed: suppressed
            .into_iter()
            .filter_map(|f| {
                let reason = f.suppressed_by?;
                Some(to_napi_finding(f, redact_secrets).suppressed(reason))
            })
            .collect(),
        skipped,
    }
}

/// Post-process raw findings: relative paths, priority-based span dedup, exact-duplicate
/// collapse, stable ordering. `canon_roots` come from [`canonicalize_roots`]. Returns the
/// active and the suppressed findings.
fn finalize_findings(findings: Vec<RawFinding>, canon_roots: &[PathBuf]) -> (Vec<RawFinding>, Vec<RawFinding>) {
    // Suppressed findings (only present with `reportSuppressed`) are deduped
    // separately: a suppressed higher-priority match must never swallow a real
    // finding at the same span.
    let (suppressed, active): (Vec<RawFinding>, Vec<RawFinding>) =
        findings.into_iter().partition(|f| f.suppressed_by.is_some());
    (finalize_group(active, canon_roots), finalize_group(suppressed, canon_roots))
}

fn finalize_group(mut findings: Vec<RawFinding>, canon_roots: &[PathBuf]) -> Vec<RawFinding> {
    // #1059 — rewrite `file` relative to the nearest root so baselines are portable across cwd.
    // `scan_text_sync` passes `&[]` and opts out of the rewrite (in-memory scan has no root).
    if !canon_roots.is_empty() {
        for f in &mut findings {
            // Archive entries: relativise the archive's own path, then re-attach the
            // `!entry` suffix (the virtual path doesn't exist on disk, so it can't be
            // canonicalised as a whole).
            let suffix = f.archive_entry.as_deref().filter(|s| f.file.ends_with(s)).unwrap_or("");
            let on_disk = &f.file[..f.file.len() - suffix.len()];
            if let Some(rel) = relative_to_root(on_disk, canon_roots) {
                f.file = format!("{rel}{suffix}");
            }
        }
    }

    // Sort so findings at the same span sit next to each other: then we can dedup + apply
    // priority in a single linear pass.
    //
    // Decoded findings share their encoded span with any plain finding on the blob itself,
    // so the decode origin (chain, then inner offsets) is part of the key: `None` sorts
    // first, keeping plain-only output (and its order) exactly as before.
    //
    // A satisfied composite finding (`required_findings` set) sorts ahead of every other
    // rule at its span, so the dedup below keeps it whatever its priority: its dependencies
    // were found, which is stronger evidence than a higher-priority single-pattern match.
    findings.sort_by(|a, b| {
        (
            &a.file,
            a.start_line,
            a.start_column,
            a.start_offset,
            a.end_offset,
            &a.decoded,
            a.required_findings.is_none(),
            std::cmp::Reverse(a.priority),
            &a.rule_id,
        )
            .cmp(&(
                &b.file,
                b.start_line,
                b.start_column,
                b.start_offset,
                b.end_offset,
                &b.decoded,
                b.required_findings.is_none(),
                std::cmp::Reverse(b.priority),
                &b.rule_id,
            ))
    });

    // #1054 — collapse exact duplicates (same file + rule + position + secret).
    findings.dedup_by(|a, b| {
        a.file == b.file
            && a.rule_id == b.rule_id
            && a.start_line == b.start_line
            && a.start_column == b.start_column
            && a.end_line == b.end_line
            && a.end_column == b.end_column
            && a.secret == b.secret
            && a.decode_chain() == b.decode_chain()
    });

    // #1567 / #1997 — when two rules match the **same byte span** on the same file, keep the
    // highest-priority finding. Ties fall back to deterministic rule-id order (already sorted).
    //
    // Behavioural note: different rules extracting different `secretGroup` slices from the
    // same whole-match span collapse to one finding (the higher-priority rule wins). This is
    // intentional — one span = one leak — but it means documenting a specific-over-generic
    // preference is the right way to model priority for custom rules.
    //
    // Path-only findings all emit offsets (0, 0) as a sentinel; we skip the span-dedup for
    // them so two different path-only rules on the same file can coexist (they represent
    // different file-level concerns — e.g. `keepass-kdbx-file` + `password-manager-export-path`).
    let mut deduped: Vec<RawFinding> = Vec::with_capacity(findings.len());
    for f in findings {
        let is_path_only = f.start_offset == 0 && f.end_offset == 0;
        if let Some(last) = deduped.last_mut() {
            if !is_path_only
                && last.file == f.file
                && last.start_offset == f.start_offset
                && last.end_offset == f.end_offset
                && last.decoded == f.decoded
            {
                // Same span — the sort put a composite, then the highest priority first. Record the
                // dropped rule on the winner so reporters can show "also: id1, id2".
                if last.rule_id != f.rule_id && !last.alternate_matches.contains(&f.rule_id) {
                    last.alternate_matches.push(f.rule_id);
                }
                continue;
            }
        }
        deduped.push(f);
    }
    deduped
}

/// Canonicalise each root and sort by descending path length so `relative_to_root` picks
/// the deepest-matching root first (e.g. with roots `/a` and `/a/b`, a file under `/a/b/c`
/// strips against `/a/b` → `c`, not `/a` → `b/c`).
fn canonicalize_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut canon: Vec<PathBuf> = roots.iter().map(|r| r.canonicalize().unwrap_or_else(|_| r.clone())).collect();
    canon.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));
    canon
}

fn relative_to_root(file: &str, roots: &[PathBuf]) -> Option<String> {
    let file_path = PathBuf::from(file);
    let file_canon = file_path.canonicalize().unwrap_or(file_path);
    for root in roots {
        if let Ok(stripped) = file_canon.strip_prefix(root) {
            let s = stripped.to_string_lossy();
            // Normalise separators so baselines are identical across platforms.
            let out = s.replace('\\', "/");
            return Some(out);
        }
    }
    None
}

/// Mask all but the first and last three **characters**. Works on `chars()` rather than
/// bytes so a multibyte secret (`pässwört`) never slices through a UTF-8 sequence (#2261).
/// For ASCII input the output is byte-identical to the previous byte-based mask.
fn redact(s: &str) -> String {
    let len = s.chars().count();
    if len <= 6 {
        return "******".into();
    }
    let mut out = String::with_capacity(s.len());
    out.extend(s.chars().take(3));
    out.extend(std::iter::repeat_n('*', len - 6));
    out.extend(s.chars().skip(len - 3));
    out
}

fn to_napi_finding(f: RawFinding, redact_secrets: bool) -> Finding {
    Finding {
        rule_id: f.rule_id,
        description: f.description,
        file: f.file,
        start_line: f.start_line,
        end_line: f.end_line,
        start_column: f.start_column,
        end_column: f.end_column,
        r#match: if redact_secrets { redact(&f.r#match) } else { f.r#match },
        secret: if redact_secrets { redact(&f.secret) } else { f.secret },
        entropy: f.entropy as f64,
        tags: f.tags,
        source: f.source,
        confidence: f.confidence.to_string(),
        alternate_matches: f.alternate_matches,
        decoded: f.decoded.map(|d| d.chain),
        required_findings: f.required_findings.map(|list| {
            list.into_iter()
                .map(|r| RequiredFinding {
                    rule_id: r.rule_id,
                    start_line: r.start_line,
                    end_line: r.end_line,
                    start_column: r.start_column,
                    end_column: r.end_column,
                    r#match: if redact_secrets { redact(&r.r#match) } else { r.r#match },
                    secret: if redact_secrets { redact(&r.secret) } else { r.secret },
                    decoded: r.decoded.map(|d| d.chain),
                })
                .collect()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detector::DecodeOrigin;

    fn raw_finding(rule_id: &str, priority: i32, start: u32, end: u32) -> RawFinding {
        RawFinding {
            rule_id: rule_id.into(),
            file: "/tmp/fixture.txt".into(),
            start_line: 1,
            end_line: 1,
            start_column: 1,
            end_column: (end - start + 1),
            r#match: "AKIA0123456789ABCDEF".into(),
            secret: "AKIA0123456789ABCDEF".into(),
            entropy: 3.5,
            priority,
            start_offset: start,
            end_offset: end,
            confidence: "low",
            ..Default::default()
        }
    }

    #[test]
    fn redact_masks_ascii_by_position() {
        assert_eq!(redact("abcdefghij"), "abc****hij");
        assert_eq!(redact("abcdef"), "******");
    }

    #[test]
    fn redact_handles_multibyte_secrets() {
        // Byte slicing would panic here: `ä` is two bytes, so byte 3 is mid-sequence.
        assert_eq!(redact("pässwört"), "päs**ört");
        assert_eq!(redact("€€€€€€€€"), "€€€**€€€");
        assert_eq!(redact("äöü"), "******");
        assert_eq!(redact("äöüäöü"), "******");
    }

    #[test]
    fn finalize_records_alternate_matches_for_same_span() {
        // Two rules matching the exact same byte span — the higher-priority wins,
        // the loser's rule_id lands in `alternate_matches`.
        let winner = raw_finding("kingfisher.aws.1", 2, 10, 30);
        let loser = raw_finding("aws-access-token", 1, 10, 30);

        let (out, _) = finalize_findings(vec![winner, loser], &[]);

        assert_eq!(out.len(), 1, "same-span findings should collapse to one");
        assert_eq!(out[0].rule_id, "kingfisher.aws.1");
        assert_eq!(out[0].alternate_matches, vec!["aws-access-token"]);
    }

    #[test]
    fn finalize_keeps_distinct_spans_untouched() {
        let a = raw_finding("rule.a", 0, 10, 30);
        let b = raw_finding("rule.b", 0, 40, 60);

        let (out, _) = finalize_findings(vec![a, b], &[]);

        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|f| f.alternate_matches.is_empty()));
    }

    #[test]
    fn finalize_keeps_decoded_finding_on_same_span_as_plain() {
        // A plain rule matching the base64 blob and a decoded finding inside it share the
        // encoded span; they must not collapse into one.
        let plain = raw_finding("generic", 5, 10, 30);
        let mut decoded = raw_finding("openrouter", 0, 10, 30);
        decoded.decoded = Some(DecodeOrigin { chain: vec!["base64".into()], ..Default::default() });
        decoded.secret = "sk-or-v1-...".into();
        let mut second = decoded.clone();
        second.decoded = Some(DecodeOrigin { chain: vec!["base64".into()], inner_start: 40, inner_end: 60 });
        second.secret = "other".into();

        let (out, _) = finalize_findings(vec![second, decoded, plain], &[]);

        assert_eq!(out.len(), 3);
        assert_eq!(out[0].rule_id, "generic");
        assert!(out.iter().all(|f| f.alternate_matches.is_empty()));
    }

    #[test]
    fn finalize_dedups_three_rules_at_same_span() {
        // Three rules at the same span — the winner accumulates two alternates,
        // losers collapse entirely (no duplicate entries in `alternate_matches`).
        let a = raw_finding("rule.a", 3, 10, 30); // winner
        let b = raw_finding("rule.b", 2, 10, 30);
        let c = raw_finding("rule.c", 1, 10, 30);

        let (out, _) = finalize_findings(vec![c, a, b], &[]);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rule_id, "rule.a");
        assert_eq!(out[0].alternate_matches.len(), 2);
        assert!(out[0].alternate_matches.contains(&"rule.b".into()));
        assert!(out[0].alternate_matches.contains(&"rule.c".into()));
    }

    #[test]
    fn finalize_keeps_a_satisfied_composite_over_a_higher_priority_rule() {
        let high = raw_finding("rule.high", 10, 10, 30);
        let mut composite = raw_finding("rule.composite", 0, 10, 30);
        composite.required_findings = Some(vec![raw_finding("rule.dep", 0, 40, 50)]);

        let (out, _) = finalize_findings(vec![high, composite], &[]);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rule_id, "rule.composite");
        assert_eq!(out[0].alternate_matches, vec!["rule.high".to_string()]);
    }

    #[test]
    fn finalize_never_collapses_a_real_finding_into_a_suppressed_one() {
        let mut suppressed = raw_finding("rule.high", 5, 10, 30);
        suppressed.suppressed_by = Some(crate::suppression::SuppressionReason::Allowlist);
        let active = raw_finding("rule.low", 1, 10, 30);

        let (active, suppressed) = finalize_findings(vec![suppressed, active], &[]);

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].rule_id, "rule.low");
        assert_eq!(suppressed.len(), 1);
        assert_eq!(suppressed[0].suppressed_by, Some(crate::suppression::SuppressionReason::Allowlist));
    }
}
