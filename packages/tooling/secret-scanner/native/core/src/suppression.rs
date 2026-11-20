// Suppression checks: inline allow markers (same-line comment, allow-start/end regions,
// nextline pragma) and config allowlists.

use crate::lines::line_slice;
use crate::rules::{AllowlistTarget, CompiledAllowlist, CompiledRuleset};

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

const SAME_LINE_MARKERS: [&str; 3] = ["gitleaks:allow", "secret-scanner:allow", "pragma: allowlist secret"];
const REGION_START_MARKERS: [&str; 2] = ["gitleaks:allow-start", "secret-scanner:allow-start"];
const REGION_END_MARKERS: [&str; 2] = ["gitleaks:allow-end", "secret-scanner:allow-end"];
const NEXT_LINE_MARKERS: [&str; 1] = ["pragma: allowlist nextline secret"];

/// Which rules an allow marker applies to. A bare marker has `All`; a marker with
/// one or more rule ids applies only to those rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowScope {
    All,
    Rules(Vec<String>),
}

impl AllowScope {
    fn from_trailing(trailing: &str, is_known_rule: &dyn Fn(&str) -> bool) -> Self {
        let ids = trailing_rule_ids(trailing, is_known_rule);

        if ids.is_empty() {
            Self::All
        } else {
            Self::Rules(ids)
        }
    }

    fn suppresses(&self, rule_id: &str) -> bool {
        match self {
            Self::All => true,
            Self::Rules(ids) => ids.iter().any(|id| id == rule_id),
        }
    }
}

/// A `allow-start` ... `allow-end` pair. The scope comes from the start marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowRegion {
    start: usize,
    end: usize,
    scope: AllowScope,
}

/// Leading comma/space separated tokens that are active rule ids. The first token
/// that is not one ends the list, so prose after a bare marker ("gitleaks:allow
/// safe in tests") and mistyped ids leave the marker bare. Marker text is
/// case-insensitive; rule ids are not.
fn trailing_rule_ids(trailing: &str, is_known_rule: &dyn Fn(&str) -> bool) -> Vec<String> {
    trailing
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|token| !token.is_empty())
        .map_while(|token| is_known_rule(token).then(|| token.to_string()))
        .collect()
}

/// Marker offsets in a lowercased buffer, found lazily. Each marker keeps its next
/// hit until the cursor passes it, so a marker that never occurs costs one scan to
/// the end of the buffer instead of one per query.
struct MarkerScan<'a> {
    lc: &'a str,
    markers: &'a [&'a str],
    next: Vec<Option<usize>>,
    exhausted: Vec<bool>,
}

impl<'a> MarkerScan<'a> {
    fn new(lc: &'a str, markers: &'a [&'a str]) -> Self {
        Self { lc, markers, next: vec![None; markers.len()], exhausted: vec![false; markers.len()] }
    }

    /// Earliest marker at or after `from`, as `(offset, marker_len)`.
    fn first_from(&mut self, from: usize) -> Option<(usize, usize)> {
        for (index, marker) in self.markers.iter().enumerate() {
            if self.exhausted[index] || self.next[index].is_some_and(|position| position >= from) {
                continue;
            }

            match self.lc[from..].find(marker) {
                Some(position) => self.next[index] = Some(from + position),
                None => self.exhausted[index] = true,
            }
        }

        self.markers
            .iter()
            .zip(&self.next)
            .zip(&self.exhausted)
            .filter_map(|((marker, next), exhausted)| {
                next.filter(|_| !exhausted).map(|position| (position, marker.len()))
            })
            .min_by_key(|(position, _)| *position)
    }
}

fn find_marker<'a>(lc: &str, markers: &[&'a str]) -> Option<(usize, &'a str)> {
    markers
        .iter()
        .filter_map(|marker| lc.find(marker).map(|position| (position, *marker)))
        .min_by_key(|(position, _)| *position)
}

/// Scopes of every marker on `line`; a finding is suppressed when any of them
/// covers its rule. A `-start` / `-end` suffix directly after the marker is skipped
/// so a region boundary line also acts as an inline allow, with any rule ids
/// following the suffix as its scope.
fn allow_scopes_on_line(
    line: &str,
    markers: &[&str],
    skip_suffixes: &[&str],
    is_known_rule: &dyn Fn(&str) -> bool,
) -> Vec<AllowScope> {
    let lc = line.to_ascii_lowercase();
    let mut scopes = Vec::new();
    let mut base = 0;

    while base < lc.len() {
        let Some((position, marker)) = find_marker(&lc[base..], markers) else { break };
        let after_marker = base + position + marker.len();
        let suffix_len = skip_suffixes
            .iter()
            .find(|suffix| lc[after_marker..].starts_with(*suffix))
            .map_or(0, |suffix| suffix.len());

        // `to_ascii_lowercase` keeps byte offsets, so this slice preserves the
        // original case of any rule id.
        scopes.push(AllowScope::from_trailing(&line[after_marker + suffix_len..], is_known_rule));
        base = after_marker;
    }

    scopes
}

/// Scopes of the inline allow-comments on `line`. Accepts `gitleaks:allow`,
/// `secret-scanner:allow` and `pragma: allowlist secret`, case-insensitively and
/// regardless of the host language's comment syntax: it looks for the marker text,
/// not the comment delimiters.
fn same_line_scopes(line: &str, is_known_rule: &dyn Fn(&str) -> bool) -> Vec<AllowScope> {
    // Shortest marker bounds the cheap-path length check.
    if line.len() < "gitleaks:allow".len() {
        return Vec::new();
    }

    allow_scopes_on_line(line, &SAME_LINE_MARKERS, &["-start", "-end"], is_known_rule)
}

/// Scopes of `pragma: allowlist nextline secret` marker (detect-secrets compat) on
/// the line *before* a potential match. Useful for multi-line block scalars (YAML)
/// and PEM bodies where an inline comment is awkward or impossible.
///
/// Cheap pre-check: scan the raw bytes for `p`/`P` before paying the
/// `to_ascii_lowercase()` allocation. The vast majority of source lines contain
/// neither.
fn next_line_scopes(line: &str, is_known_rule: &dyn Fn(&str) -> bool) -> Vec<AllowScope> {
    if line.len() < "pragma: allowlist nextline secret".len() || !line.bytes().any(|b| b == b'p' || b == b'P') {
        return Vec::new();
    }

    allow_scopes_on_line(line, &NEXT_LINE_MARKERS, &[], is_known_rule)
}

fn scope_after_marker(
    content: &str,
    marker_start: usize,
    marker_len: usize,
    is_known_rule: &dyn Fn(&str) -> bool,
) -> AllowScope {
    let after_marker = marker_start + marker_len;
    let line_end = content[after_marker..].find('\n').map_or(content.len(), |offset| after_marker + offset);

    AllowScope::from_trailing(&content[after_marker..line_end], is_known_rule)
}

/// Byte ranges inside `content` marked by `gitleaks:allow-start` ... `gitleaks:allow-end`
/// or `secret-scanner:allow-start` ... `:allow-end` pairs, with the scope declared on
/// the start marker. Any finding whose match falls inside a range and matches its
/// scope is suppressed.
pub fn find_allow_regions(content: &str, ruleset: &CompiledRuleset) -> Vec<AllowRegion> {
    allow_regions(content, &|id| ruleset.has_rule(id))
}

/// A start pairs with the first end after it; a start with no end is ignored. A
/// second start before that end does not open a region of its own.
fn allow_regions(content: &str, is_known_rule: &dyn Fn(&str) -> bool) -> Vec<AllowRegion> {
    let lc = content.to_ascii_lowercase();
    let mut starts = MarkerScan::new(&lc, &REGION_START_MARKERS);
    let mut ends = MarkerScan::new(&lc, &REGION_END_MARKERS);
    let mut regions = Vec::new();
    let mut cursor = 0;

    while let Some((start, start_len)) = starts.first_from(cursor) {
        let Some((end, end_len)) = ends.first_from(start + start_len) else { break };

        regions.push(AllowRegion { start, end, scope: scope_after_marker(content, start, start_len, is_known_rule) });
        cursor = end + end_len;
    }

    regions
}

fn is_in_allow_region(regions: &[AllowRegion], rule_id: &str, offset: usize) -> bool {
    regions.iter().any(|region| region.scope.suppresses(rule_id) && offset >= region.start && offset <= region.end)
}

/// Inline allow-comment on the match's line, an allow region around `offset`, or a
/// nextline pragma on the line before. `line` is 1-based; `offsets` come from
/// [`crate::lines::compute_line_offsets`] over `content`. Marker text is
/// case-insensitive; rule ids are compared case-sensitively.
pub fn inline_suppressed(
    content: &str,
    offsets: &[usize],
    regions: &[AllowRegion],
    ruleset: &CompiledRuleset,
    rule_id: &str,
    line: u32,
    offset: usize,
) -> bool {
    let is_known_rule = |id: &str| ruleset.has_rule(id);

    let any_suppresses = |scopes: Vec<AllowScope>| scopes.iter().any(|scope| scope.suppresses(rule_id));

    any_suppresses(same_line_scopes(line_slice(content, offsets, line), &is_known_rule))
        || is_in_allow_region(regions, rule_id, offset)
        || (line > 1 && any_suppresses(next_line_scopes(line_slice(content, offsets, line - 1), &is_known_rule)))
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

    fn is_known_rule(id: &str) -> bool {
        matches!(id, "github-pat" | "aws-access-token" | "openrouter")
    }

    fn same_line(line: &str) -> Option<AllowScope> {
        same_line_scopes(line, &is_known_rule).into_iter().next()
    }

    fn next_line(line: &str) -> Option<AllowScope> {
        next_line_scopes(line, &is_known_rule).into_iter().next()
    }

    #[test]
    fn bare_allow_comments_suppress_every_rule() {
        for line in [
            "let x = \"ghp_...\"; // gitleaks:allow",
            "token = \"...\"  # gitleaks:allow because this is a fixture",
            "key = \"...\" // secret-scanner:allow",
            "# SECRET-SCANNER:ALLOW",
            "token = \"abc123\"  # pragma: allowlist secret",
            "/* pragma: allowlist secret */ const k = \"…\";",
        ] {
            let scope = same_line(line).unwrap_or_else(|| panic!("no scope in {line}"));
            assert_eq!(scope, AllowScope::All);
            assert!(scope.suppresses("github-pat"));
            assert!(scope.suppresses("any-other-rule"));
        }
    }

    #[test]
    fn allow_comment_absent() {
        assert!(same_line("normal line").is_none());
        assert!(same_line("// just a comment").is_none());
        assert!(same_line("allow").is_none()); // too short
        assert!(same_line("token = \"abc\" # pragma: allow").is_none());
    }

    #[test]
    fn scoped_allow_comments_suppress_only_named_rules() {
        let scope = same_line("token = \"...\" // gitleaks:allow github-pat, aws-access-token").unwrap();
        assert_eq!(scope, AllowScope::Rules(vec!["github-pat".to_string(), "aws-access-token".to_string()]));
        assert!(scope.suppresses("github-pat"));
        assert!(scope.suppresses("aws-access-token"));
        assert!(!scope.suppresses("generic-api-key"));

        let upper_marker = same_line("token = \"...\" # SECRET-SCANNER:ALLOW github-pat").unwrap();
        assert!(upper_marker.suppresses("github-pat"));

        // Simple ids without punctuation still work when they are active rules.
        let simple = same_line("token = \"...\" // gitleaks:allow openrouter").unwrap();
        assert_eq!(simple, AllowScope::Rules(vec!["openrouter".to_string()]));

        // Marker text is case-insensitive, but the rule id is not: a wrong-case id is
        // prose, so the marker stays bare.
        assert_eq!(same_line("token = \"...\" // gitleaks:allow GITHUB-PAT"), Some(AllowScope::All));
    }

    #[test]
    fn prose_and_unknown_ids_leave_the_marker_bare() {
        for line in [
            "x // gitleaks:allow false-positive",
            "x // gitleaks:allow test-only",
            "x // gitleaks:allow @alice",
            "x // secret-scanner:allow no-such-rule",
            "x // gitleaks:allow githb-pat",
            "x // gitleaks:allow safe in tests",
        ] {
            assert_eq!(same_line(line), Some(AllowScope::All), "{line}");
        }
    }

    #[test]
    fn region_boundary_lines_act_as_inline_allows() {
        assert_eq!(same_line("k = \"x\" # gitleaks:allow-start"), Some(AllowScope::All));
        assert_eq!(same_line("k = \"x\" # gitleaks:allow-end"), Some(AllowScope::All));
        assert_eq!(
            same_line("k = \"x\" # secret-scanner:allow-start github-pat"),
            Some(AllowScope::Rules(vec!["github-pat".to_string()]))
        );
    }

    #[test]
    fn every_marker_on_a_line_counts() {
        let scopes = same_line_scopes("x // gitleaks:allow github-pat // gitleaks:allow", &is_known_rule);

        assert!(scopes.iter().any(|scope| scope.suppresses("aws-access-token")));

        let scopes =
            same_line_scopes("x // gitleaks:allow github-pat // secret-scanner:allow aws-access-token", &is_known_rule);

        assert!(scopes.iter().any(|scope| scope.suppresses("github-pat")));
        assert!(scopes.iter().any(|scope| scope.suppresses("aws-access-token")));
        assert!(!scopes.iter().any(|scope| scope.suppresses("openrouter")));
    }

    #[test]
    fn scope_list_ends_at_first_unknown_token() {
        let scope = same_line("x // gitleaks:allow github-pat, then prose aws-access-token").unwrap();

        assert_eq!(scope, AllowScope::Rules(vec!["github-pat".to_string()]));
    }

    #[test]
    fn nextline_pragma_suppresses_following_line() {
        let scope = next_line("# pragma: allowlist nextline secret").unwrap();
        assert_eq!(scope, AllowScope::All);
        let upper = next_line("// PRAGMA: ALLOWLIST NEXTLINE SECRET").unwrap();
        assert_eq!(upper, AllowScope::All);

        assert!(next_line("# pragma: allowlist secret").is_none());
        assert!(next_line("normal comment").is_none());
        assert!(next_line("").is_none()); // empty line
    }

    #[test]
    fn scoped_nextline_pragma_suppresses_only_named_rule() {
        let scope = next_line("# pragma: allowlist nextline secret github-pat").unwrap();

        assert!(scope.suppresses("github-pat"));
        assert!(!scope.suppresses("aws-access-token"));
    }

    #[test]
    fn allow_region_pair() {
        let src = "head\n# gitleaks:allow-start\nSECRET=abc\n# gitleaks:allow-end\ntail";
        let regions = allow_regions(src, &is_known_rule);
        assert_eq!(regions.len(), 1);
        let secret_off = src.find("SECRET").unwrap();
        assert!(is_in_allow_region(&regions, "github-pat", secret_off));
    }

    #[test]
    fn scoped_allow_region_suppresses_only_named_rule() {
        let src = "head\n# secret-scanner:allow-start github-pat\nSECRET=abc\n# secret-scanner:allow-end\ntail";
        let regions = allow_regions(src, &is_known_rule);
        assert_eq!(regions.len(), 1);
        let secret_off = src.find("SECRET").unwrap();

        assert!(is_in_allow_region(&regions, "github-pat", secret_off));
        assert!(!is_in_allow_region(&regions, "aws-access-token", secret_off));
    }

    #[test]
    fn allow_region_prose_after_start_stays_bare() {
        let src = "# gitleaks:allow-start test-only\nSECRET=abc\n# gitleaks:allow-end";
        let regions = allow_regions(src, &is_known_rule);

        assert!(is_in_allow_region(&regions, "github-pat", src.find("SECRET").unwrap()));
    }

    #[test]
    fn nested_starts_pair_first_start_with_first_end() {
        let src =
            "# gitleaks:allow-start github-pat\nA\n# gitleaks:allow-start aws-access-token\nB\n# gitleaks:allow-end\nC";
        let regions = allow_regions(src, &is_known_rule);

        assert_eq!(regions.len(), 1);
        assert!(is_in_allow_region(&regions, "github-pat", src.find('B').unwrap()));
        assert!(!is_in_allow_region(&regions, "aws-access-token", src.find('B').unwrap()));
        assert!(!is_in_allow_region(&regions, "github-pat", src.find('C').unwrap()));
    }

    #[test]
    fn many_end_only_markers_scan_in_linear_time() {
        let src = "secret-scanner:allow-end\n".repeat(200_000);
        let started = std::time::Instant::now();

        assert!(allow_regions(&src, &is_known_rule).is_empty());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn many_regions_with_one_marker_kind_absent_scan_in_linear_time() {
        let src = "gitleaks:allow-start\nx\ngitleaks:allow-end\n".repeat(50_000);
        let started = std::time::Instant::now();

        assert_eq!(allow_regions(&src, &is_known_rule).len(), 50_000);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn allow_region_unpaired_is_ignored() {
        let src = "# gitleaks:allow-start\nonly one marker";
        let regions = allow_regions(src, &is_known_rule);
        assert!(regions.is_empty());
    }
}
