// Suppression checks: inline allow markers (same-line comment, allow-start/end regions,
// nextline pragma) and config allowlists.

use crate::lines::line_slice;
use crate::rules::{AllowlistTarget, CompiledAllowlist};

/// Why a match was suppressed. Only surfaced with `reportSuppressed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuppressionReason {
    /// A rule or global `[[allowlists]]` entry matched.
    Allowlist,
    /// An inline marker (`gitleaks:allow`, allow region, nextline pragma) matched.
    InlineAllow,
}

impl SuppressionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allowlist => "allowlist",
            Self::InlineAllow => "inline-allow",
        }
    }
}

/// Byte ranges inside `content` marked by `gitleaks:allow-start` ... `gitleaks:allow-end`
/// or `secret-scanner:allow-start` ... `:allow-end` pairs. Any finding whose match falls
/// inside one of these ranges is suppressed.
pub fn find_allow_regions(content: &str) -> Vec<(usize, usize)> {
    let lc = content.to_ascii_lowercase();
    let mut regions = Vec::new();
    let mut cursor = 0;

    while cursor < lc.len() {
        let rest = &lc[cursor..];
        let start_off =
            [rest.find("gitleaks:allow-start"), rest.find("secret-scanner:allow-start")].into_iter().flatten().min();

        let Some(start_rel) = start_off else { break };
        let start_abs = cursor + start_rel;
        let after_start = start_abs + "gitleaks:allow-start".len().min("secret-scanner:allow-start".len());

        let remaining = &lc[after_start..];
        let end_rel = [remaining.find("gitleaks:allow-end"), remaining.find("secret-scanner:allow-end")]
            .into_iter()
            .flatten()
            .min();

        match end_rel {
            Some(end_rel) => {
                let end_abs = after_start + end_rel;

                regions.push((start_abs, end_abs));
                cursor = end_abs + "gitleaks:allow-end".len().min("secret-scanner:allow-end".len());
            }
            None => break,
        }
    }

    regions
}

fn is_in_allow_region(regions: &[(usize, usize)], offset: usize) -> bool {
    regions.iter().any(|&(start, end)| offset >= start && offset <= end)
}

/// Inline allow-comment on the match's line, an allow region around `offset`, or a
/// nextline pragma on the line before. `line` is 1-based; `offsets` come from
/// [`crate::lines::compute_line_offsets`] over `content`.
pub fn inline_suppressed(
    content: &str,
    offsets: &[usize],
    regions: &[(usize, usize)],
    line: u32,
    offset: usize,
) -> bool {
    has_allow_comment(line_slice(content, offsets, line))
        || is_in_allow_region(regions, offset)
        || (line > 1 && has_nextline_pragma(line_slice(content, offsets, line - 1)))
}

/// Returns true if the line contains a recognised inline allow-comment.
/// Matching is case-insensitive. We accept `gitleaks:allow` (upstream compat),
/// `secret-scanner:allow` (our own), and `pragma: allowlist secret`
/// (detect-secrets compat). All three work regardless of the comment syntax
/// used by the host language (`#`, `//`, `/* */`, `--`, `<!-- -->`, …) — we
/// look for the marker text itself, not the comment delimiters.
fn has_allow_comment(line: &str) -> bool {
    const MARKERS: [&str; 3] = ["gitleaks:allow", "secret-scanner:allow", "pragma: allowlist secret"];
    // Shortest marker bounds the cheap-path length check.
    if line.len() < "gitleaks:allow".len() {
        return false;
    }
    let lc = line.to_ascii_lowercase();
    MARKERS.iter().any(|m| lc.contains(m))
}

/// Returns true when the line carries a `pragma: allowlist nextline secret`
/// marker (detect-secrets compat) — the scanner checks this on the line
/// *before* a potential match, suppressing findings on the line below.
/// Useful for multi-line block-scalar cases where an inline comment on the
/// secret line itself is awkward (YAML) or impossible (PEM body).
///
/// Cheap pre-check: scan the raw bytes for `p`/`P` before paying the
/// `to_ascii_lowercase()` allocation. The vast majority of source lines
/// contain neither, so the allocation only fires on ~1% of lookups.
fn has_nextline_pragma(line: &str) -> bool {
    const MARKER: &str = "pragma: allowlist nextline secret";
    if line.len() < MARKER.len() {
        return false;
    }
    if !line.bytes().any(|b| b == b'p' || b == b'P') {
        return false;
    }
    line.to_ascii_lowercase().contains(MARKER)
}

/// `commits` is only evaluated here for `condition = "AND"` allowlists that also list
/// paths / regexes / stopwords. A commit list on its own, or under OR, is applied by the
/// git-history scan in TypeScript (`git-commit-allowlist.ts`), which can skip a whole
/// commit before reading it.
pub fn is_allowlisted(
    lists: &[CompiledAllowlist],
    rule_id: &str,
    path: &str,
    m: &str,
    secret: &str,
    line: &str,
    commit: Option<&str>,
) -> bool {
    for a in lists {
        // #1919 — an allowlist with a non-empty `targetRules` only applies to those rules.
        if !a.target_rules.is_empty() && !a.target_rules.iter().any(|r| r == rule_id) {
            continue;
        }

        let mut matched_any = false;
        let mut matched_all = true;

        let check_paths = !a.paths.is_empty();
        let check_regexes = !a.regexes.is_empty();
        let check_stopwords = !a.stopwords_lower.is_empty();

        let target = match a.regex_target {
            AllowlistTarget::Match => m,
            AllowlistTarget::Secret => secret,
            AllowlistTarget::Line => line,
        };

        let path_hit = check_paths && a.paths.iter().any(|r| r.is_match(path).unwrap_or(false));
        let regex_hit = check_regexes && a.regexes.iter().any(|r| r.is_match(target).unwrap_or(false));
        let stopword_hit = check_stopwords && {
            let lc = secret.to_lowercase();
            a.stopwords_lower.iter().any(|s| lc.contains(s))
        };

        if check_paths {
            matched_any |= path_hit;
            matched_all &= path_hit;
        }
        if check_regexes {
            matched_any |= regex_hit;
            matched_all &= regex_hit;
        }
        if check_stopwords {
            matched_any |= stopword_hit;
            matched_all &= stopword_hit;
        }
        if !check_paths && !check_regexes && !check_stopwords {
            continue;
        }
        if a.condition_and && !a.commits.is_empty() {
            matched_all &= commit.is_some_and(|c| a.commits.iter().any(|listed| listed.eq_ignore_ascii_case(c.trim())));
        }

        if (a.condition_and && matched_all) || (!a.condition_and && matched_any) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_comment_gitleaks() {
        assert!(has_allow_comment("let x = \"ghp_...\"; // gitleaks:allow"));
        assert!(has_allow_comment("token = \"...\"  # gitleaks:allow"));
    }

    #[test]
    fn allow_comment_our_marker() {
        assert!(has_allow_comment("key = \"...\" // secret-scanner:allow"));
        assert!(has_allow_comment("# SECRET-SCANNER:ALLOW"));
    }

    #[test]
    fn allow_comment_absent() {
        assert!(!has_allow_comment("normal line"));
        assert!(!has_allow_comment("// just a comment"));
        assert!(!has_allow_comment("allow")); // too short
    }

    #[test]
    fn allow_comment_pragma() {
        // detect-secrets compat — same-line marker across comment syntaxes.
        assert!(has_allow_comment("token = \"abc123\"  # pragma: allowlist secret"));
        assert!(has_allow_comment("let x = \"...\"; // PRAGMA: ALLOWLIST SECRET"));
        assert!(has_allow_comment("/* pragma: allowlist secret */ const k = \"…\";"));
        assert!(!has_allow_comment("token = \"abc\" # pragma: allow"));
    }

    #[test]
    fn nextline_pragma_suppresses_following_line() {
        assert!(has_nextline_pragma("# pragma: allowlist nextline secret"));
        assert!(has_nextline_pragma("// PRAGMA: ALLOWLIST NEXTLINE SECRET"));
        assert!(!has_nextline_pragma("# pragma: allowlist secret"));
        assert!(!has_nextline_pragma("normal comment"));
        assert!(!has_nextline_pragma("")); // empty line
    }

    #[test]
    fn allow_region_pair() {
        let src = "head\n# gitleaks:allow-start\nSECRET=abc\n# gitleaks:allow-end\ntail";
        let regions = find_allow_regions(src);
        assert_eq!(regions.len(), 1);
        let secret_off = src.find("SECRET").unwrap();
        assert!(is_in_allow_region(&regions, secret_off));
    }

    #[test]
    fn allow_region_unpaired_is_ignored() {
        let src = "# gitleaks:allow-start\nonly one marker";
        let regions = find_allow_regions(src);
        assert!(regions.is_empty());
    }
}
