//! Scan entry points of the plain-Rust API: ruleset loading (with an in-process
//! cache), directory and file-list scans, in-memory text scans, and ruleset
//! introspection. The napi addon wraps these.

use std::collections::hash_map::DefaultHasher;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use rayon::prelude::*;

use crate::archive::{self, ArchiveOptions};
use crate::config::Config;
use crate::decode::{self, DecodeOptions};
use crate::detector::{DetectOptions, RawFinding};
use crate::finalize::build_report;
use crate::rules::{CompiledRuleset, Confidence};
use crate::scanner::{scan_file, scan_text_full, TextScanOptions};
use crate::skip::{SkipReason, Skipped};
use crate::types::{RuleInfo, ScanOptions, ScanReport, SkippedRule};
use crate::walker::{walk_paths_reporting, WalkOptions};

/// Why a scan could not start. `Display` carries the text the JS side has always
/// shown (the napi wrapper forwards it as the error reason).
#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("ScanOptions.config is required (pass a parsed gitleaks-shaped object)")]
    MissingConfig,
    #[error("config shape: {0}")]
    ConfigShape(serde_json::Error),
    #[error("min_confidence must be one of 'low' | 'medium' | 'high', got {0:?}")]
    InvalidMinConfidence(String),
    #[error("compile rules: {0}")]
    CompileRules(String),
    #[error("thread pool: {0}")]
    ThreadPool(rayon::ThreadPoolBuildError),
}

/// Capacity of the compiled-ruleset cache. Four is enough to cover the
/// common matrix: `gitleaks` vs `kingfisher` vs `combined` × optional
/// `min_confidence` / user preset layering.
const RULESET_CACHE_CAPACITY: usize = 4;

/// Cached rulesets, oldest first, keyed by [`hash_ruleset_key`].
type RulesetCache = VecDeque<(u64, Arc<CompiledRuleset>)>;

/// FIFO cache keyed by a content hash of `(config JSON, min_confidence)`.
/// Eliminates the per-scan 5-9s compile cost when the same config is reused
/// across `scan()` / `scanFiles()` / `listRules()` / repeat CLI invocations
/// within the same process. FIFO is sufficient at cap 4; a true LRU would
/// need an extra dep without measurable benefit at this size.
static RULESET_CACHE: Lazy<Mutex<RulesetCache>> =
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

fn load_ruleset(opts: &ScanOptions) -> Result<Arc<CompiledRuleset>, ScanError> {
    let Some(value) = opts.config.as_ref() else {
        return Err(ScanError::MissingConfig);
    };

    let min_conf_str = opts.min_confidence.as_deref();
    let cache_key = hash_ruleset_key(value, min_conf_str);

    if let Ok(cache) = RULESET_CACHE.lock() {
        if let Some((_, arc)) = cache.iter().find(|(k, _)| *k == cache_key) {
            return Ok(Arc::clone(arc));
        }
    }

    let mut cfg: Config = serde_json::from_value(value.clone()).map_err(ScanError::ConfigShape)?;

    if let Some(floor) = min_conf_str {
        let floor = Confidence::parse(floor).ok_or_else(|| ScanError::InvalidMinConfidence(floor.to_owned()))?;

        cfg.rules.retain(|raw| raw.confidence.as_deref().and_then(Confidence::parse).unwrap_or_default() >= floor);
    }

    let ruleset = CompiledRuleset::compile(&cfg).map_err(|e| ScanError::CompileRules(e.to_string()))?;
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
) -> Result<(Vec<RawFinding>, Vec<Skipped>), ScanError> {
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
        let pool = rayon::ThreadPoolBuilder::new().num_threads(concurrency).build().map_err(ScanError::ThreadPool)?;
        Ok(pool.install(do_scan))
    }
}

/// Walk `paths` and scan every file on the rayon pool (`opts.concurrency` sizes it).
/// `skipped` in the report lists what could not be read (permission denied,
/// unreadable directory, I/O error, larger than `max_file_size`).
pub fn scan_dirs(paths: Vec<String>, opts: &ScanOptions) -> Result<ScanReport, ScanError> {
    let roots: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    if roots.is_empty() {
        return Ok(ScanReport::default());
    }
    let ruleset = load_ruleset(opts)?;
    let redact_secrets = opts.redact.unwrap_or(false);

    let walk_opts = WalkOptions {
        respect_gitignore: opts.respect_gitignore.unwrap_or(true),
        respect_hidden: !opts.include_hidden.unwrap_or(false),
        extra_ignores: opts.extra_ignores.clone().unwrap_or_default(),
        ignore_files: opts.ignore_files.clone().unwrap_or_default().into_iter().map(PathBuf::from).collect(),
        threads: opts.concurrency.unwrap_or(0) as usize,
    };

    let (files, walk_errors) = walk_paths_reporting(&roots, &walk_opts);
    let (findings, mut skipped) = scan_paths(&files, &ruleset, opts)?;

    skipped.extend(walk_errors);

    Ok(build_report(findings, skipped, &roots, redact_secrets))
}

/// Scan an in-memory string as if it lived at `file`. Paths are kept as given.
pub fn scan_text(content: &str, file: &str, opts: &ScanOptions) -> Result<ScanReport, ScanError> {
    let redact_secrets = opts.redact.unwrap_or(false);
    let ruleset = load_ruleset(opts)?;
    let path = PathBuf::from(file);
    let raw = scan_text_full(&ruleset, &path, content, text_scan_options(opts));
    // In-memory scan — no filesystem root, so just dedup + priority (no path rewriting).
    Ok(build_report(raw, Vec::new(), &[], redact_secrets))
}

/// Compile a ruleset and return rules that failed to compile, with their reason.
/// Useful for tooling that wants to validate a custom gitleaks.toml.
pub fn inspect_ruleset(opts: &ScanOptions) -> Result<Vec<SkippedRule>, ScanError> {
    let ruleset = load_ruleset(opts)?;
    Ok(ruleset
        .skipped_rules
        .iter()
        .map(|(id, reason)| SkippedRule { rule_id: id.clone(), reason: reason.clone() })
        .collect())
}

/// Return metadata for every rule compiled from the config.
pub fn list_rules(opts: &ScanOptions) -> Result<Vec<RuleInfo>, ScanError> {
    let ruleset = load_ruleset(opts)?;
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
pub fn scan_files(files: Vec<String>, opts: &ScanOptions) -> Result<ScanReport, ScanError> {
    if files.is_empty() {
        return Ok(ScanReport::default());
    }
    let ruleset = load_ruleset(opts)?;
    let redact_secrets = opts.redact.unwrap_or(false);
    let paths: Vec<PathBuf> = files.into_iter().map(PathBuf::from).collect();
    let (findings, skipped) = scan_paths(&paths, &ruleset, opts)?;

    // Walker is bypassed here — use cwd as the root so paths normalise relative to it.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    Ok(build_report(findings, skipped, &[cwd], redact_secrets))
}
