import { createHash } from "node:crypto";

import type { Finding } from "./types";

/**
 * Content-addressed fingerprint: SHA-256 truncated to 16 hex chars over the
 * tuple `(secret, ruleId, file)`. Stable when the same secret moves between
 * lines (edits, formatter churn, import re-ordering); breaks correctly when
 * the rule id changes, the file is renamed, or the secret itself changes.
 *
 * The NUL separator is theoretically ambiguous for secrets containing literal
 * `\0` bytes, but gitleaks/Kingfisher rules capture textual tokens (hex, base64,
 * JSON) where NUL is not a valid character — in practice a zero-collision risk.
 * Switching to length-prefixed hashing would invalidate every existing baseline
 * without any observed benefit.
 *
 * Truncating to 64 bits of entropy is more than enough for a single repo's
 * baseline — collisions require ≥4 billion findings before the birthday bound
 * becomes visible.
 */
export const fingerprint = (finding: Finding): string => {
    const input = `${finding.secret}\0${finding.ruleId}\0${finding.file}`;

    return createHash("sha256").update(input).digest("hex").slice(0, 16);
};

/**
 * Legacy gitleaks-compatible fingerprint (`&lt;file>:&lt;ruleID>:&lt;startLine>`).
 * Retained so baselines written before the content-hash switch continue to
 * suppress matching findings — the baseline loader stores *both* forms, the
 * suppression filter checks both, and users can refresh at their own pace via
 * `vis secrets --update-baseline`.
 */
export const legacyFingerprint = (finding: Finding): string => `${finding.file}:${finding.ruleId}:${String(finding.startLine)}`;

/**
 * Content-hash fingerprint computed with the whole `match` as the secret. Before
 * gitleaks secret-group parity, a rule without `secretGroup` reported the whole
 * match as its secret; it now reports the first non-empty capture group, as
 * gitleaks does. Baselines written before that change hold the old secret, so
 * suppression and baseline diffs also accept this form. Equal to
 * {@link fingerprint} when the secret is the whole match.
 */
export const wholeMatchFingerprint = (finding: Finding): string => fingerprint({ ...finding, secret: finding.match });

/**
 * Every key a baseline entry may be stored under for `finding`: the content
 * hash, the legacy line-based form and the whole-match content hash. A finding
 * is baselined when the baseline holds any of them.
 */
export const baselineKeys = (finding: Finding): string[] => [fingerprint(finding), legacyFingerprint(finding), wholeMatchFingerprint(finding)];

/**
 * The gitleaks fingerprint of a finding as `.gitleaksignore` accepts it:
 * `file:rule:line`, prefixed with the full commit SHA for git history findings.
 */
export const gitleaksIgnoreFingerprint = (finding: Finding & { commit?: { sha: string } }): string => {
    const base = legacyFingerprint(finding);

    return finding.commit === undefined ? base : `${finding.commit.sha}:${base}`;
};
