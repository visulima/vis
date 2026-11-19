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

/// Marker text is case-insensitive; rule ids stay case-sensitive. A token is
/// treated as a rule id when it is either a known id in the active ruleset or
/// has the shape of one (hyphen, underscore, dot, slash, or an `@` namespace).
/// That keeps prose after a bare marker ("gitleaks:allow safe in tests") bare
/// while still recognising simple user-defined ids such as `openrouter`.
fn trailing_rule_ids(trailing: &str, is_known_rule: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut ids = Vec::new();
    let mut token = String::new();

    for character in trailing.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/' | '@') {
            token.push(character);
            continue;
        }

        if !token.is_empty() {
            if !looks_like_rule_id(&token, is_known_rule) {
                break;
            }
            ids.push(std::mem::take(&mut token));
        }
    }

    if !token.is_empty() && looks_like_rule_id(&token, is_known_rule) {
        ids.push(token);
    }

    ids
}

fn looks_like_rule_id(token: &str, is_known_rule: &dyn Fn(&str) -> bool) -> bool {
    if token.len() <= 1 {
        return false;
    }

    is_known_rule(token)
        || token.starts_with('@')
        || (token.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            && token.chars().any(|c| matches!(c, '-' | '_' | '.' | '/')))
}

fn find_marker<'a>(lc: &str, markers: &[&'a str]) -> Option<(usize, &'a str)> {
    markers
        .iter()
        .filter_map(|marker| lc.find(marker).map(|position| (position, *marker)))
        .min_by_key(|(position, _)| *position)
}

/// Parse the first matching marker on `line`. `reject_after` excludes longer
/// directives that begin with the same text (e.g. `allow-start` is not a
/// same-line `allow`).
fn allow_scope_on_line(
    line: &str,
    markers: &[&str],
    reject_after: &[&str],
    is_known_rule: &dyn Fn(&str) -> bool,
) -> Option<AllowScope> {
    if line.is_empty() {
        return None;
    }

    let lc = line.to_ascii_lowercase();
    let mut base = 0;

    while base < lc.len() {
        let Some((position, marker)) = find_marker(&lc[base..], markers) else { break };
        let absolute = base + position;
        let after_marker = position + marker.len();

        if reject_after.iter().any(|suffix| lc[absolute + marker.len()..].starts_with(suffix)) {
            base += after_marker;
            continue;
        }

        // `to_ascii_lowercase` keeps byte offsets, so this slice preserves the
        // original case of any rule id.
        return Some(AllowScope::from_trailing(&line[absolute + marker.len()..], is_known_rule));
    }

    None
}

fn allow_scope_at_offset(
    content: &str,
    marker_start: usize,
    marker_len: usize,
    is_known_rule: &dyn Fn(&str) -> bool,
) -> AllowScope {
    let line_end = content[marker_start..].find('\n').map_or(content.len(), |offset| marker_start + offset);

    AllowScope::from_trailing(&content[marker_start + marker_len..line_end], is_known_rule)
}

/// Byte ranges inside `content` marked by `gitleaks:allow-start` ... `gitleaks:allow-end`
/// or `secret-scanner:allow-start` ... `:allow-end` pairs, with the scope declared on
/// the start marker. Any finding whose match falls inside a range and matches its
/// scope is suppressed.
pub fn find_allow_regions(content: &str, is_known_rule: &dyn Fn(&str) -> bool) -> Vec<AllowRegion> {
    let lc = content.to_ascii_lowercase();
    let mut regions = Vec::new();
    let mut open: Vec<(usize, AllowScope)> = Vec::new();
    let mut cursor = 0;

    while cursor < lc.len() {
        let rest = &lc[cursor..];
        let next_start = find_marker(rest, &REGION_START_MARKERS).map(|(position, marker)| (cursor + position, marker));
        let next_end = find_marker(rest, &REGION_END_MARKERS).map(|(position, marker)| (cursor + position, marker));

        match (next_start, next_end) {
            (Some((start, marker)), Some((end, _))) if start < end => {
                open.push((start, allow_scope_at_offset(content, start, marker.len(), is_known_rule)));
                cursor = start + marker.len();
            }
            (Some(_), Some((end, marker))) | (None, Some((end, marker))) => {
                if let Some((start, scope)) = open.pop() {
                    regions.push(AllowRegion { start, end, scope });
                }
                cursor = end + marker.len();
            }
            (Some((start, marker)), None) => {
                open.push((start, allow_scope_at_offset(content, start, marker.len(), is_known_rule)));
                cursor = start + marker.len();
            }
            (None, None) => break,
        }
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
    is_known_rule: &dyn Fn(&str) -> bool,
    rule_id: &str,
    line: u32,
    offset: usize,
) -> bool {
    allow_scope_on_line(line_slice(content, offsets, line), &SAME_LINE_MARKERS, &["-start", "-end"], is_known_rule)
        .is_some_and(|scope| scope.suppresses(rule_id))
        || is_in_allow_region(regions, rule_id, offset)
        || (line > 1
            && allow_scope_on_line(line_slice(content, offsets, line - 1), &NEXT_LINE_MARKERS, &[], is_known_rule)
                .is_some_and(|scope| scope.suppresses(rule_id)))
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

    fn same_line_scope(line: &str) -> Option<AllowScope> {
        allow_scope_on_line(line, &SAME_LINE_MARKERS, &["-start", "-end"], &is_known_rule)
    }

    fn next_line_scope(line: &str) -> Option<AllowScope> {
        allow_scope_on_line(line, &NEXT_LINE_MARKERS, &[], &is_known_rule)
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
            let scope = same_line_scope(line).unwrap_or_else(|| panic!("no scope in {line}"));
            assert_eq!(scope, AllowScope::All);
            assert!(scope.suppresses("github-pat"));
            assert!(scope.suppresses("any-other-rule"));
        }
    }

    #[test]
    fn allow_comment_absent() {
        assert!(same_line_scope("normal line").is_none());
        assert!(same_line_scope("// just a comment").is_none());
        assert!(same_line_scope("allow").is_none()); // too short
        assert!(same_line_scope("# gitleaks:allow-start").is_none());
        assert!(same_line_scope("# gitleaks:allow-end").is_none());
        assert!(same_line_scope("token = \"abc\" # pragma: allow").is_none());
    }

    #[test]
    fn scoped_allow_comments_suppress_only_named_rules() {
        let scope = same_line_scope("token = \"...\" // gitleaks:allow github-pat, aws-access-token").unwrap();
        assert_eq!(scope, AllowScope::Rules(vec!["github-pat".to_string(), "aws-access-token".to_string()]));
        assert!(scope.suppresses("github-pat"));
        assert!(scope.suppresses("aws-access-token"));
        assert!(!scope.suppresses("generic-api-key"));

        let upper_marker = same_line_scope("token = \"...\" # SECRET-SCANNER:ALLOW github-pat").unwrap();
        assert!(upper_marker.suppresses("github-pat"));

        // Simple ids without punctuation still work when they are active rules.
        let simple = same_line_scope("token = \"...\" // gitleaks:allow openrouter").unwrap();
        assert_eq!(simple, AllowScope::Rules(vec!["openrouter".to_string()]));

        // Marker text is case-insensitive, but the rule id is not.
        let wrong_case = same_line_scope("token = \"...\" // gitleaks:allow GITHUB-PAT").unwrap();
        assert!(!wrong_case.suppresses("github-pat"));
    }

    #[test]
    fn unknown_scope_suppresses_nothing() {
        let scope = same_line_scope("token = \"...\" // secret-scanner:allow no-such-rule").unwrap();
        assert!(!scope.suppresses("github-pat"));
    }

    #[test]
    fn nextline_pragma_suppresses_following_line() {
        let scope = next_line_scope("# pragma: allowlist nextline secret").unwrap();
        assert_eq!(scope, AllowScope::All);
        let upper = next_line_scope("// PRAGMA: ALLOWLIST NEXTLINE SECRET").unwrap();
        assert_eq!(upper, AllowScope::All);

        assert!(next_line_scope("# pragma: allowlist secret").is_none());
        assert!(next_line_scope("normal comment").is_none());
        assert!(next_line_scope("").is_none()); // empty line
    }

    #[test]
    fn scoped_nextline_pragma_suppresses_only_named_rule() {
        let scope = next_line_scope("# pragma: allowlist nextline secret github-pat").unwrap();

        assert!(scope.suppresses("github-pat"));
        assert!(!scope.suppresses("aws-access-token"));
    }

    #[test]
    fn allow_region_pair() {
        let src = "head\n# gitleaks:allow-start\nSECRET=abc\n# gitleaks:allow-end\ntail";
        let regions = find_allow_regions(src, &is_known_rule);
        assert_eq!(regions.len(), 1);
        let secret_off = src.find("SECRET").unwrap();
        assert!(is_in_allow_region(&regions, "github-pat", secret_off));
    }

    #[test]
    fn scoped_allow_region_suppresses_only_named_rule() {
        let src = "head\n# secret-scanner:allow-start github-pat\nSECRET=abc\n# secret-scanner:allow-end\ntail";
        let regions = find_allow_regions(src, &is_known_rule);
        assert_eq!(regions.len(), 1);
        let secret_off = src.find("SECRET").unwrap();

        assert!(is_in_allow_region(&regions, "github-pat", secret_off));
        assert!(!is_in_allow_region(&regions, "aws-access-token", secret_off));
    }

    #[test]
    fn allow_region_unpaired_is_ignored() {
        let src = "# gitleaks:allow-start\nonly one marker";
        let regions = find_allow_regions(src, &is_known_rule);
        assert!(regions.is_empty());
    }
}
