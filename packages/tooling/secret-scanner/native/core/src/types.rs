//! Plain-Rust option, finding and report types of the scanner API. The napi addon
//! mirrors these one-to-one (same field names, camelCased on the JS side).

use crate::suppression::SuppressionReason;

#[derive(Clone, Debug, Default)]
pub struct ScanOptions {
    /// Parsed config object (gitleaks-compatible shape). The JS wrapper is responsible
    /// for loading from any format (TOML/JSON/YAML/TS/JS) via c12 and passing the result
    /// here. If absent, no rules are loaded and every scan returns an empty result.
    pub config: Option<serde_json::Value>,
    /// Respect .gitignore / .ignore (default: true)
    pub respect_gitignore: Option<bool>,
    /// Visit dotfiles (default: false — matches ignore crate default)
    pub include_hidden: Option<bool>,
    /// Extra gitignore-syntax patterns to exclude (negation, directory markers, etc. all work).
    pub extra_ignores: Option<Vec<String>>,
    /// Paths to additional `.gitignore`-syntax files to honor (beyond the walker's default
    /// `.gitignore` / `.git/info/exclude` pickup). Useful for `.secretsignore` etc.
    pub ignore_files: Option<Vec<String>>,
    /// Max file size in bytes (default 10 MiB). Files above are skipped.
    pub max_file_size: Option<u32>,
    /// Redact secret values in output (default: false)
    pub redact: Option<bool>,
    /// Number of rayon worker threads. 0/omitted = use rayon's global pool.
    pub concurrency: Option<u32>,
    /// Minimum author-declared confidence required for a rule to load. Accepts
    /// "low" | "medium" | "high". Unset (or "low") loads every rule — matching
    /// legacy behaviour. Rules with no declared confidence are treated as "low"
    /// and so are dropped whenever a higher floor is set.
    pub min_confidence: Option<String>,
    /// Recursion depth of the decode pass (base64 / hex / percent-encoding). Each level
    /// decodes printable-UTF-8 segments and rescans them. Default 2; 0 disables decoding.
    pub max_decode_depth: Option<u32>,
    /// Nesting depth for archive scanning (gitleaks `--max-archive-depth`). zip / tar /
    /// gzip / tar.gz files, detected by magic bytes, are opened and their entries scanned;
    /// findings use the virtual path `archive.zip!inner/file`. 1 opens top-level archives,
    /// each extra level one more layer of nested archives (max 8). Default 0 (off).
    pub max_archive_depth: Option<u32>,
    /// Honour inline suppressions (`gitleaks:allow`, `secret-scanner:allow`,
    /// `pragma: allowlist secret`, allow-start/end blocks, nextline pragma).
    /// Default `true`; `false` lets CI audit them.
    pub inline_allow: Option<bool>,
    /// Return allowlisted / inline-allowed matches in `ScanReport.suppressed`
    /// instead of dropping them. Default `false`.
    pub report_suppressed: Option<bool>,
    /// Commit SHA the scanned content belongs to (git-history scans). Lets allowlists
    /// with `condition = "AND"` that list `commits` next to paths / regexes / stopwords
    /// match; without it they never do.
    pub commit: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Finding {
    pub rule_id: String,
    pub description: String,
    pub file: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub r#match: String,
    pub secret: String,
    pub entropy: f64,
    pub tags: Vec<String>,
    /// Rule provenance — `"gitleaks"`, `"kingfisher"`, `"visulima"`, or a user string.
    /// `None` for legacy rules that don't declare a source.
    pub source: Option<String>,
    /// Author-declared quality signal: `"low"`, `"medium"`, or `"high"`. Always set —
    /// rules that don't declare confidence resolve to `"low"`.
    pub confidence: String,
    /// Rule ids that matched the same byte span and were collapsed by the dedup
    /// pass. Lets reporters surface "also: X, Y" without emitting duplicate findings.
    pub alternate_matches: Vec<String>,
    /// Set when the secret was found inside encoded text: the encoding chain, outermost
    /// first (e.g. `["base64"]`, `["base64", "hex"]`). Line/column then point at the
    /// original encoded span while `match` / `secret` hold the decoded text.
    pub decoded: Option<Vec<String>>,
    /// Composite rules only: the findings of the rule's `required` dependencies that
    /// satisfied it, one per required id (the nearest), in declaration order.
    pub required_findings: Option<Vec<RequiredFinding>>,
}

/// A match an allowlist or inline marker suppressed: a [`Finding`] plus its reason.
/// Only returned with `report_suppressed`. Fields are repeated rather than flattened
/// so the napi mirror (which cannot flatten) stays a 1:1 copy; keep them in sync with [`Finding`].
#[derive(Clone, Debug)]
pub struct SuppressedFinding {
    pub rule_id: String,
    pub description: String,
    pub file: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub r#match: String,
    pub secret: String,
    pub entropy: f64,
    pub tags: Vec<String>,
    /// Rule provenance — `"gitleaks"`, `"kingfisher"`, `"visulima"`, or a user string.
    /// `None` for legacy rules that don't declare a source.
    pub source: Option<String>,
    /// Author-declared quality signal: `"low"`, `"medium"`, or `"high"`. Always set —
    /// rules that don't declare confidence resolve to `"low"`.
    pub confidence: String,
    /// Rule ids that matched the same byte span and were collapsed by the dedup
    /// pass. Lets reporters surface "also: X, Y" without emitting duplicate findings.
    pub alternate_matches: Vec<String>,
    /// Set when the secret was found inside encoded text: the encoding chain, outermost
    /// first (e.g. `["base64"]`, `["base64", "hex"]`). Line/column then point at the
    /// original encoded span while `match` / `secret` hold the decoded text.
    pub decoded: Option<Vec<String>>,
    /// Composite rules only: the findings of the rule's `required` dependencies that
    /// satisfied it, one per required id (the nearest), in declaration order.
    pub required_findings: Option<Vec<RequiredFinding>>,
    /// `"allowlist"` or `"inline-allow"`.
    pub suppressed_by: String,
}

/// A dependency finding attached to a composite-rule finding. Same file as its primary.
#[derive(Clone, Debug)]
pub struct RequiredFinding {
    pub rule_id: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub r#match: String,
    pub secret: String,
    pub decoded: Option<Vec<String>>,
}

/// A file the scan could not read. `reason` is `"permission-denied"`,
/// `"not-found"` (e.g. a broken symlink passed to `scanFiles`), `"too-large"`,
/// `"symlink-loop"` or `"io-error"`. Archive entries that could not be scanned use
/// their virtual path (`a.zip!dir/file.env`); an archive whose walk stopped at the
/// byte / entry budget is listed under its own path as `"too-large"`.
#[derive(Clone, Debug)]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

/// Result of every scan entry point.
#[derive(Clone, Debug, Default)]
pub struct ScanReport {
    /// Active findings.
    pub findings: Vec<Finding>,
    /// Allowlisted / inline-allowed matches. Empty unless `reportSuppressed`.
    pub suppressed: Vec<SuppressedFinding>,
    /// Content that could not be read. Always empty for `scanTextSync`.
    pub skipped: Vec<SkippedFile>,
}

#[derive(Clone, Debug)]
pub struct SkippedRule {
    pub rule_id: String,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct RuleInfo {
    pub id: String,
    pub description: String,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
    pub entropy: Option<f64>,
    pub has_regex: bool,
    pub has_path_filter: bool,
    /// `true` when the rule has no `keywords` and therefore bypasses the AC prefilter —
    /// its main regex runs against every file. Surface this in tooling so users can spot
    /// perf-regressing custom rules (#1675).
    pub always_runs: bool,
    pub source: Option<String>,
    pub confidence: String,
}

impl Finding {
    pub(crate) fn suppressed(self, reason: SuppressionReason) -> SuppressedFinding {
        SuppressedFinding {
            rule_id: self.rule_id,
            description: self.description,
            file: self.file,
            start_line: self.start_line,
            end_line: self.end_line,
            start_column: self.start_column,
            end_column: self.end_column,
            r#match: self.r#match,
            secret: self.secret,
            entropy: self.entropy,
            tags: self.tags,
            source: self.source,
            confidence: self.confidence,
            alternate_matches: self.alternate_matches,
            decoded: self.decoded,
            required_findings: self.required_findings,
            suppressed_by: reason.as_str().to_string(),
        }
    }
}
