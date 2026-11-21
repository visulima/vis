#![deny(clippy::all)]
//! NAPI addon for `@visulima/secret-scanner`.
//!
//! The scanner itself lives in `secret-scanner-core` (plain Rust). This crate only
//! declares the JS-visible option / report objects, converts them to and from the
//! core types, and runs the blocking scans off the Node thread.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use secret_scanner_core as core;

/// Core errors surface to JS as a plain `GenericFailure` with the same message the
/// scanner has always used.
fn to_napi_error(error: core::ScanError) -> Error {
    Error::from_reason(error.to_string())
}

#[napi(object)]
#[derive(Default)]
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
    /// Collect opt-in timing data (phases, per-file, per-rule) and attach it to `ScanReport.profile`.
    pub profile: Option<bool>,
}

impl From<ScanOptions> for core::ScanOptions {
    fn from(v: ScanOptions) -> Self {
        Self {
            config: v.config,
            respect_gitignore: v.respect_gitignore,
            include_hidden: v.include_hidden,
            extra_ignores: v.extra_ignores,
            ignore_files: v.ignore_files,
            max_file_size: v.max_file_size,
            redact: v.redact,
            concurrency: v.concurrency,
            min_confidence: v.min_confidence,
            max_decode_depth: v.max_decode_depth,
            max_archive_depth: v.max_archive_depth,
            inline_allow: v.inline_allow,
            report_suppressed: v.report_suppressed,
            commit: v.commit,
            profile: v.profile,
        }
    }
}

#[napi(object)]
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
    /// The scan root `file` is relative to, as a canonical absolute path. `None` when `file`
    /// was not rewritten against a root (in-memory scans, history scans, paths outside every
    /// root). Not part of a finding's identity: fingerprints and baselines ignore it.
    pub root: Option<String>,
}

impl From<core::Finding> for Finding {
    fn from(v: core::Finding) -> Self {
        let core::Finding {
            rule_id,
            description,
            file,
            start_line,
            end_line,
            start_column,
            end_column,
            r#match,
            secret,
            entropy,
            tags,
            source,
            confidence,
            alternate_matches,
            decoded,
            required_findings,
            root,
        } = v;
        Self {
            rule_id,
            description,
            file,
            start_line,
            end_line,
            start_column,
            end_column,
            r#match,
            secret,
            entropy,
            tags,
            source,
            confidence,
            alternate_matches,
            decoded,
            required_findings: required_findings.map(|list| list.into_iter().map(Into::into).collect()),
            root,
        }
    }
}

/// A match an allowlist or inline marker suppressed: a [`Finding`] plus its reason.
/// Only returned with `reportSuppressed`. NAPI objects can't flatten, so the fields
/// are repeated; keep them in sync with [`Finding`].
#[napi(object)]
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
    /// The scan root `file` is relative to, as a canonical absolute path. `None` when `file`
    /// was not rewritten against a root (in-memory scans, history scans, paths outside every
    /// root). Not part of a finding's identity: fingerprints and baselines ignore it.
    pub root: Option<String>,
    /// `"allowlist"` or `"inline-allow"`.
    pub suppressed_by: String,
}

impl From<core::SuppressedFinding> for SuppressedFinding {
    fn from(v: core::SuppressedFinding) -> Self {
        let core::SuppressedFinding {
            rule_id,
            description,
            file,
            start_line,
            end_line,
            start_column,
            end_column,
            r#match,
            secret,
            entropy,
            tags,
            source,
            confidence,
            alternate_matches,
            decoded,
            required_findings,
            root,
            suppressed_by,
        } = v;
        Self {
            rule_id,
            description,
            file,
            start_line,
            end_line,
            start_column,
            end_column,
            r#match,
            secret,
            entropy,
            tags,
            source,
            confidence,
            alternate_matches,
            decoded,
            required_findings: required_findings.map(|list| list.into_iter().map(Into::into).collect()),
            root,
            suppressed_by,
        }
    }
}

/// A dependency finding attached to a composite-rule finding. Same file as its primary.
#[napi(object)]
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

impl From<core::RequiredFinding> for RequiredFinding {
    fn from(v: core::RequiredFinding) -> Self {
        let core::RequiredFinding { rule_id, start_line, end_line, start_column, end_column, r#match, secret, decoded } =
            v;
        Self { rule_id, start_line, end_line, start_column, end_column, r#match, secret, decoded }
    }
}

/// A file the scan could not read. `reason` is `"permission-denied"`,
/// `"not-found"` (e.g. a broken symlink passed to `scanFiles`), `"too-large"`,
/// `"symlink-loop"` or `"io-error"`. Archive entries that could not be scanned use
/// their virtual path (`a.zip!dir/file.env`); an archive whose walk stopped at the
/// byte / entry budget is listed under its own path as `"too-large"`.
#[napi(object)]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

impl From<core::SkippedFile> for SkippedFile {
    fn from(v: core::SkippedFile) -> Self {
        let core::SkippedFile { path, reason } = v;
        Self { path, reason }
    }
}

/// An inline allow marker (`gitleaks:allow`, an allow-start / allow-end boundary or a
/// nextline pragma) that lists id-shaped tokens naming no active rule, so it still
/// suppresses every rule. Archive entries use their virtual path. An id-shaped token is
/// lowercase kebab-case with at least one hyphen (`github-pat`) or a dotted id with two
/// or more dots (`kingfisher.stripe.1`); the scan of the token list ends at the first
/// token that is neither a known rule id nor id-shaped.
#[napi(object)]
pub struct AllowWarning {
    pub file: String,
    /// 1-based line of the marker.
    pub line: u32,
    /// Each unknown id once, in order of appearance.
    pub unknown_rule_ids: Vec<String>,
}

impl From<core::AllowWarning> for AllowWarning {
    fn from(v: core::AllowWarning) -> Self {
        let core::AllowWarning { file, line, unknown_rule_ids } = v;
        Self { file, line, unknown_rule_ids }
    }
}

/// Result of every scan entry point.
#[napi(object)]
#[derive(Default)]
pub struct ScanReport {
    /// Active findings.
    pub findings: Vec<Finding>,
    /// Allowlisted / inline-allowed matches. Empty unless `reportSuppressed`.
    pub suppressed: Vec<SuppressedFinding>,
    /// Content that could not be read. Always empty for `scanTextSync`.
    pub skipped: Vec<SkippedFile>,
    /// Allow markers naming rule ids that are not active. Empty with `inlineAllow: false`.
    pub allow_warnings: Vec<AllowWarning>,
    /// Timing data, present only when `profile` was requested.
    pub profile: Option<ProfileReport>,
}

impl From<core::ScanReport> for ScanReport {
    fn from(v: core::ScanReport) -> Self {
        let core::ScanReport { findings, suppressed, skipped, allow_warnings, profile } = v;
        Self {
            findings: findings.into_iter().map(Into::into).collect(),
            suppressed: suppressed.into_iter().map(Into::into).collect(),
            skipped: skipped.into_iter().map(Into::into).collect(),
            allow_warnings: allow_warnings.into_iter().map(Into::into).collect(),
            profile: profile.map(Into::into),
        }
    }
}

/// A coarse scan phase (ruleset load, walk, detect, finalize, …).
#[napi(object)]
pub struct ProfilePhase {
    /// How many times the phase ran.
    pub count: u32,
    /// Total milliseconds spent in the phase.
    pub ms: f64,
    pub name: String,
}

impl From<core::ProfilePhase> for ProfilePhase {
    fn from(v: core::ProfilePhase) -> Self {
        let core::ProfilePhase { count, ms, name } = v;
        Self { count: u32::try_from(count).unwrap_or(u32::MAX), ms, name }
    }
}

/// Time spent in one rule's matcher, aggregated across every file and pass.
#[napi(object)]
pub struct ProfileRule {
    /// How many times the rule's matcher ran.
    pub count: u32,
    /// Total milliseconds spent in the rule.
    pub ms: f64,
    /// The rule's main regex, when it has one.
    pub pattern: Option<String>,
    pub rule_id: String,
}

impl From<core::ProfileRule> for ProfileRule {
    fn from(v: core::ProfileRule) -> Self {
        let core::ProfileRule { count, ms, pattern, rule_id } = v;
        Self { count: u32::try_from(count).unwrap_or(u32::MAX), ms, pattern, rule_id }
    }
}

/// Wall-clock cost of scanning one file, relative to the scan root like findings.
#[napi(object)]
pub struct ProfileFile {
    pub file: String,
    pub ms: f64,
}

impl From<core::ProfileFile> for ProfileFile {
    fn from(v: core::ProfileFile) -> Self {
        let core::ProfileFile { file, ms } = v;
        Self { file, ms }
    }
}

/// Opt-in timing breakdown of one native scan. Each list is sorted by descending `ms`.
#[napi(object)]
pub struct ProfileReport {
    pub files: Vec<ProfileFile>,
    pub phases: Vec<ProfilePhase>,
    pub rules: Vec<ProfileRule>,
    /// Total wall-clock of the native scan, in milliseconds.
    pub total_ms: f64,
}

impl From<core::ProfileReport> for ProfileReport {
    fn from(v: core::ProfileReport) -> Self {
        let core::ProfileReport { files, phases, rules, total_ms } = v;
        Self {
            files: files.into_iter().map(Into::into).collect(),
            phases: phases.into_iter().map(Into::into).collect(),
            rules: rules.into_iter().map(Into::into).collect(),
            total_ms,
        }
    }
}

#[napi(object)]
pub struct SkippedRule {
    pub rule_id: String,
    pub reason: String,
}

impl From<core::SkippedRule> for SkippedRule {
    fn from(v: core::SkippedRule) -> Self {
        let core::SkippedRule { rule_id, reason } = v;
        Self { rule_id, reason }
    }
}

#[napi(object)]
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

impl From<core::RuleInfo> for RuleInfo {
    fn from(v: core::RuleInfo) -> Self {
        let core::RuleInfo {
            id,
            description,
            tags,
            keywords,
            entropy,
            has_regex,
            has_path_filter,
            always_runs,
            source,
            confidence,
        } = v;
        Self { id, description, tags, keywords, entropy, has_regex, has_path_filter, always_runs, source, confidence }
    }
}

/// Walk `paths` and scan every file on the rayon pool. `skipped` lists what could not
/// be read (permission denied, unreadable directory, I/O error, larger than
/// `maxFileSize`).
#[napi]
pub async fn scan_detailed(paths: Vec<String>, options: Option<ScanOptions>) -> Result<ScanReport> {
    let opts: core::ScanOptions = options.unwrap_or_default().into();
    tokio::task::spawn_blocking(move || core::scan_dirs(paths, &opts))
        .await
        .map_err(|e| Error::from_reason(format!("join: {e}")))?
        .map(Into::into)
        .map_err(to_napi_error)
}

/// Same as `scanDetailed`. Kept as the plain name the native-binding smoke test loads.
#[napi]
pub async fn scan(paths: Vec<String>, options: Option<ScanOptions>) -> Result<ScanReport> {
    scan_detailed(paths, options).await
}

/// `scanDetailed` on the calling thread.
#[napi]
pub fn scan_sync(paths: Vec<String>, options: Option<ScanOptions>) -> Result<ScanReport> {
    let opts: core::ScanOptions = options.unwrap_or_default().into();
    core::scan_dirs(paths, &opts).map(Into::into).map_err(to_napi_error)
}

/// Scan an in-memory string as if it lived at `file`. Paths are kept as given.
#[napi]
pub fn scan_text_sync(content: String, file: String, options: Option<ScanOptions>) -> Result<ScanReport> {
    let opts: core::ScanOptions = options.unwrap_or_default().into();
    core::scan_text(&content, &file, &opts).map(Into::into).map_err(to_napi_error)
}

/// Compile a ruleset and return rules that failed to compile, with their reason.
/// Useful for tooling that wants to validate a custom gitleaks.toml.
#[napi]
pub fn inspect_ruleset(options: Option<ScanOptions>) -> Result<Vec<SkippedRule>> {
    let opts: core::ScanOptions = options.unwrap_or_default().into();
    core::inspect_ruleset(&opts).map(|rules| rules.into_iter().map(Into::into).collect()).map_err(to_napi_error)
}

/// Return metadata for every rule compiled from the config.
#[napi]
pub fn list_rules(options: Option<ScanOptions>) -> Result<Vec<RuleInfo>> {
    let opts: core::ScanOptions = options.unwrap_or_default().into();
    core::list_rules(&opts).map(|rules| rules.into_iter().map(Into::into).collect()).map_err(to_napi_error)
}

/// Scan a fixed list of files (e.g. from `git diff --name-only`), bypassing the walker.
/// A listed file that can't be read lands in `skipped`.
#[napi]
pub async fn scan_files_detailed(files: Vec<String>, options: Option<ScanOptions>) -> Result<ScanReport> {
    let opts: core::ScanOptions = options.unwrap_or_default().into();
    tokio::task::spawn_blocking(move || core::scan_files(files, &opts))
        .await
        .map_err(|e| Error::from_reason(format!("join: {e}")))?
        .map(Into::into)
        .map_err(to_napi_error)
}
