#![deny(clippy::all)]

mod archive;
mod composite;
mod config;
mod decode;
mod detector;
mod entropy;
mod finalize;
mod lines;
mod rules;
mod scanner;
mod skip;
mod suppression;
mod walker;

use std::collections::hash_map::DefaultHasher;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use rayon::prelude::*;

use crate::archive::ArchiveOptions;
use crate::config::Config;
use crate::decode::DecodeOptions;
use crate::detector::{DetectOptions, RawFinding};
use crate::finalize::build_report;
use crate::rules::{CompiledRuleset, Confidence};
use crate::scanner::{scan_file, scan_text_full, TextScanOptions};
use crate::skip::{SkipReason, Skipped};
use crate::suppression::SuppressionReason;
use crate::walker::{walk_paths_reporting, WalkOptions};

/// Capacity of the compiled-ruleset cache. Four is enough to cover the
/// common matrix: `gitleaks` vs `kingfisher` vs `combined` × optional
/// `min_confidence` / user preset layering.
const RULESET_CACHE_CAPACITY: usize = 4;

/// FIFO cache keyed by a content hash of `(config JSON, min_confidence)`.
/// Eliminates the per-scan 5-9s compile cost when the same config is reused
/// across `scan()` / `scanFiles()` / `listRules()` / repeat CLI invocations
/// within the same process. FIFO is sufficient at cap 4; a true LRU would
/// need an extra dep without measurable benefit at this size.
static RULESET_CACHE: Lazy<Mutex<VecDeque<(u64, Arc<CompiledRuleset>)>>> =
    Lazy::new(|| Mutex::new(VecDeque::with_capacity(RULESET_CACHE_CAPACITY)));

fn hash_ruleset_key(value: &serde_json::Value, min_confidence: Option<&str>) -> u64 {
    let mut hasher = DefaultHasher::new();

    // `serde_json::to_vec` preserves object-key insertion order — for a given
    // source JSON (our `data/*.json` or a user-supplied file), the hash is
    // stable across calls. A user who hand-builds the config object and
    // shuffles keys between calls will miss the cache; that's the exact
    // right behaviour (different inputs → different hash).
    if let Ok(bytes) = serde_json::to_vec(value) {
        bytes.hash(&mut hasher);
    }

    min_confidence.unwrap_or("").hash(&mut hasher);
    hasher.finish()
}

const DEFAULT_MAX_FILE_SIZE: u32 = 10 * 1024 * 1024; // 10 MiB

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
    /// `"allowlist"` or `"inline-allow"`.
    pub suppressed_by: String,
}

impl Finding {
    fn suppressed(self, reason: SuppressionReason) -> SuppressedFinding {
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
}

#[napi(object)]
pub struct SkippedRule {
    pub rule_id: String,
    pub reason: String,
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

fn text_scan_options(opts: &ScanOptions) -> TextScanOptions<'_> {
    TextScanOptions {
        decode: DecodeOptions {
            max_depth: opts.max_decode_depth.unwrap_or(decode::DEFAULT_MAX_DECODE_DEPTH),
            ..Default::default()
        },
        detect: DetectOptions {
            inline_allow: opts.inline_allow.unwrap_or(true),
            report_suppressed: opts.report_suppressed.unwrap_or(false),
            commit: opts.commit.as_deref(),
        },
    }
}

fn archive_options(opts: &ScanOptions, max_bytes: u64) -> ArchiveOptions {
    ArchiveOptions {
        max_depth: opts.max_archive_depth.unwrap_or(archive::DEFAULT_MAX_ARCHIVE_DEPTH),
        max_entry_bytes: max_bytes,
        ..Default::default()
    }
}

fn load_ruleset(opts: &ScanOptions) -> Result<Arc<CompiledRuleset>> {
    let Some(value) = opts.config.as_ref() else {
        return Err(Error::from_reason("ScanOptions.config is required (pass a parsed gitleaks-shaped object)"));
    };

    let min_conf_str = opts.min_confidence.as_deref();
    let cache_key = hash_ruleset_key(value, min_conf_str);

    if let Ok(cache) = RULESET_CACHE.lock() {
        if let Some((_, arc)) = cache.iter().find(|(k, _)| *k == cache_key) {
            return Ok(Arc::clone(arc));
        }
    }

    let mut cfg: Config =
        serde_json::from_value(value.clone()).map_err(|e| Error::from_reason(format!("config shape: {e}")))?;

    if let Some(floor) = min_conf_str {
        let floor = Confidence::parse(floor).ok_or_else(|| {
            Error::from_reason(format!("min_confidence must be one of 'low' | 'medium' | 'high', got {floor:?}"))
        })?;

        cfg.rules.retain(|raw| raw.confidence.as_deref().and_then(Confidence::parse).unwrap_or_default() >= floor);
    }

    let ruleset = CompiledRuleset::compile(&cfg).map_err(|e| Error::from_reason(format!("compile rules: {e}")))?;
    let arc = Arc::new(ruleset);

    if let Ok(mut cache) = RULESET_CACHE.lock() {
        // Race-tolerant: another thread may have inserted the same key while we
        // were compiling. Duplicate entries waste a slot but don't affect
        // correctness — keep the first one and drop the newcomer.
        if !cache.iter().any(|(k, _)| *k == cache_key) {
            cache.push_back((cache_key, Arc::clone(&arc)));
            while cache.len() > RULESET_CACHE_CAPACITY {
                cache.pop_front();
            }
        }
    }

    Ok(arc)
}

/// Scan `files` on the configured pool, collecting findings and unreadable files.
fn scan_paths(
    files: &[PathBuf],
    ruleset: &CompiledRuleset,
    opts: &ScanOptions,
) -> Result<(Vec<RawFinding>, Vec<Skipped>)> {
    let max_bytes = opts.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE) as u64;
    let concurrency = opts.concurrency.unwrap_or(0) as usize;
    let text_opts = text_scan_options(opts);
    let archive_opts = archive_options(opts, max_bytes);

    let do_scan = || -> (Vec<RawFinding>, Vec<Skipped>) {
        let outcomes: Vec<(Vec<RawFinding>, Vec<Skipped>)> = files
            .par_iter()
            .map(|p| match scan_file(ruleset, p, max_bytes, text_opts, archive_opts) {
                Ok(Some(scanned)) => (scanned.findings, scanned.skipped),
                Ok(None) => (Vec::new(), vec![Skipped::file(p.clone(), SkipReason::TooLarge)]),
                Err(e) => (Vec::new(), vec![Skipped::file(p.clone(), (&e).into())]),
            })
            .collect();
        let mut findings = Vec::new();
        let mut skipped = Vec::new();
        for (f, s) in outcomes {
            findings.extend(f);
            skipped.extend(s);
        }
        (findings, skipped)
    };

    if concurrency == 0 {
        // Use rayon's global pool — no per-call pool construction.
        Ok(do_scan())
    } else {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(concurrency)
            .build()
            .map_err(|e| Error::from_reason(format!("thread pool: {e}")))?;
        Ok(pool.install(do_scan))
    }
}

fn scan_impl(paths: Vec<String>, opts: ScanOptions) -> Result<ScanReport> {
    let roots: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    if roots.is_empty() {
        return Ok(ScanReport::default());
    }
    let ruleset = load_ruleset(&opts)?;
    let redact_secrets = opts.redact.unwrap_or(false);

    let walk_opts = WalkOptions {
        respect_gitignore: opts.respect_gitignore.unwrap_or(true),
        respect_hidden: !opts.include_hidden.unwrap_or(false),
        extra_ignores: opts.extra_ignores.clone().unwrap_or_default(),
        ignore_files: opts.ignore_files.clone().unwrap_or_default().into_iter().map(PathBuf::from).collect(),
        threads: opts.concurrency.unwrap_or(0) as usize,
    };

    let (files, walk_errors) = walk_paths_reporting(&roots, &walk_opts);
    let (findings, mut skipped) = scan_paths(&files, &ruleset, &opts)?;

    skipped.extend(walk_errors);

    Ok(build_report(findings, skipped, &roots, redact_secrets))
}

/// Walk `paths` and scan every file on the rayon pool. `skipped` lists what could not
/// be read (permission denied, unreadable directory, I/O error, larger than
/// `maxFileSize`).
#[napi]
pub async fn scan_detailed(paths: Vec<String>, options: Option<ScanOptions>) -> Result<ScanReport> {
    let opts = options.unwrap_or_default();
    tokio::task::spawn_blocking(move || scan_impl(paths, opts))
        .await
        .map_err(|e| Error::from_reason(format!("join: {e}")))?
}

/// Same as `scanDetailed`. Kept as the plain name the native-binding smoke test loads.
#[napi]
pub async fn scan(paths: Vec<String>, options: Option<ScanOptions>) -> Result<ScanReport> {
    scan_detailed(paths, options).await
}

/// `scanDetailed` on the calling thread.
#[napi]
pub fn scan_sync(paths: Vec<String>, options: Option<ScanOptions>) -> Result<ScanReport> {
    scan_impl(paths, options.unwrap_or_default())
}

/// Scan an in-memory string as if it lived at `file`. Paths are kept as given.
#[napi]
pub fn scan_text_sync(content: String, file: String, options: Option<ScanOptions>) -> Result<ScanReport> {
    let opts = options.unwrap_or_default();
    let redact_secrets = opts.redact.unwrap_or(false);
    let ruleset = load_ruleset(&opts)?;
    let path = PathBuf::from(&file);
    let raw = scan_text_full(&ruleset, &path, &content, text_scan_options(&opts));
    // In-memory scan — no filesystem root, so just dedup + priority (no path rewriting).
    Ok(build_report(raw, Vec::new(), &[], redact_secrets))
}

/// Compile a ruleset and return rules that failed to compile, with their reason.
/// Useful for tooling that wants to validate a custom gitleaks.toml.
#[napi]
pub fn inspect_ruleset(options: Option<ScanOptions>) -> Result<Vec<SkippedRule>> {
    let ruleset = load_ruleset(&options.unwrap_or_default())?;
    Ok(ruleset
        .skipped_rules
        .iter()
        .map(|(id, reason)| SkippedRule { rule_id: id.clone(), reason: reason.clone() })
        .collect())
}

/// Return metadata for every rule compiled from the config.
#[napi]
pub fn list_rules(options: Option<ScanOptions>) -> Result<Vec<RuleInfo>> {
    let ruleset = load_ruleset(&options.unwrap_or_default())?;
    Ok(ruleset
        .rules
        .iter()
        .map(|rule| RuleInfo {
            id: rule.id.clone(),
            description: rule.description.clone(),
            tags: rule.tags.clone(),
            keywords: rule.keywords_lower.clone(),
            entropy: rule.entropy.map(|e| e as f64),
            has_regex: rule.engine.is_some(),
            has_path_filter: rule.path_regex.is_some(),
            always_runs: rule.keywords_lower.is_empty(),
            source: rule.source.clone(),
            confidence: rule.confidence.as_str().to_string(),
        })
        .collect())
}

/// Scan a fixed list of files (e.g. from `git diff --name-only`), bypassing the walker.
/// A listed file that can't be read lands in `skipped`.
#[napi]
pub async fn scan_files_detailed(files: Vec<String>, options: Option<ScanOptions>) -> Result<ScanReport> {
    let opts = options.unwrap_or_default();
    tokio::task::spawn_blocking(move || scan_files_impl(files, opts))
        .await
        .map_err(|e| Error::from_reason(format!("join: {e}")))?
}

fn scan_files_impl(files: Vec<String>, opts: ScanOptions) -> Result<ScanReport> {
    if files.is_empty() {
        return Ok(ScanReport::default());
    }
    let ruleset = load_ruleset(&opts)?;
    let redact_secrets = opts.redact.unwrap_or(false);
    let paths: Vec<PathBuf> = files.into_iter().map(PathBuf::from).collect();
    let (findings, skipped) = scan_paths(&paths, &ruleset, &opts)?;

    // Walker is bypassed here — use cwd as the root so paths normalise relative to it.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    Ok(build_report(findings, skipped, &[cwd], redact_secrets))
}
