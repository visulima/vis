//! Opt-in scan profiling.
//!
//! Everything here is inert unless `ScanOptions.profile` is set: no profiler is
//! allocated, no clock is read, and reports carry no profile. Workers time rules
//! into a thread-local [`Local`] and merge it into the shared [`Profiler`] once
//! per file, so the shared lock is taken per file rather than per rule.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::finalize::relative_profile_paths;
use crate::rules::CompiledRule;

/// A coarse scan phase (ruleset load, walk, detect, finalize, …).
#[derive(Clone, Debug)]
pub struct ProfilePhase {
    /// How many times this phase ran (one per scan unless it is per-file).
    pub count: u64,
    /// Total milliseconds spent in the phase.
    pub ms: f64,
    /// Stable phase name.
    pub name: String,
}

/// Time spent in one rule's matcher, aggregated across every file and pass.
#[derive(Clone, Debug)]
pub struct ProfileRule {
    /// How many times the rule's matcher ran.
    pub count: u64,
    /// Total milliseconds spent in the rule.
    pub ms: f64,
    /// The rule's main regex, when it has one.
    pub pattern: Option<String>,
    pub rule_id: String,
}

/// Wall-clock cost of scanning one file.
#[derive(Clone, Debug)]
pub struct ProfileFile {
    pub file: String,
    pub ms: f64,
}

/// The payload attached to `ScanReport.profile`.
#[derive(Clone, Debug, Default)]
pub struct ProfileReport {
    pub files: Vec<ProfileFile>,
    pub phases: Vec<ProfilePhase>,
    pub rules: Vec<ProfileRule>,
    /// Total wall-clock of the native scan, in milliseconds.
    pub total_ms: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct RuleStat {
    count: u64,
    elapsed: Duration,
}

/// Rule timings of the work done on the current thread, indexed by rule position.
#[derive(Debug, Default)]
struct Local {
    rules: Vec<RuleStat>,
}

thread_local! {
    static CURRENT: RefCell<Option<Local>> = const { RefCell::new(None) };
}

/// Run `f` with a fresh thread-local collector and return what it gathered. The
/// previous collector is restored, so nested scans cannot clobber each other.
fn collect<R>(f: impl FnOnce() -> R) -> (R, Local) {
    let previous = CURRENT.with(|current| current.borrow_mut().replace(Local::default()));
    let result = f();
    let local = CURRENT.with(|current| std::mem::replace(&mut *current.borrow_mut(), previous));
    (result, local.unwrap_or_default())
}

/// Whether the current thread is collecting rule timings. The detector reads it
/// once per call, so profiling off costs one thread-local check per detection.
pub fn is_active() -> bool {
    CURRENT.with(|current| current.borrow().is_some())
}

/// Times one rule's matcher and records it on drop. A `continue` out of the
/// candidate loop drops the guard just like a normal return, so every active
/// rule is accounted for.
pub struct RuleScope {
    index: usize,
    start: Instant,
}

impl RuleScope {
    pub fn start(index: usize) -> Self {
        Self { index, start: Instant::now() }
    }
}

impl Drop for RuleScope {
    fn drop(&mut self) {
        let elapsed = self.start.elapsed();
        CURRENT.with(|current| {
            if let Some(local) = current.borrow_mut().as_mut() {
                if local.rules.len() <= self.index {
                    local.rules.resize(self.index + 1, RuleStat::default());
                }
                let stat = &mut local.rules[self.index];
                stat.count += 1;
                stat.elapsed += elapsed;
            }
        });
    }
}

#[derive(Debug, Default)]
struct Inner {
    phases: HashMap<&'static str, (Duration, u64)>,
    rules: Vec<RuleStat>,
    files: Vec<(String, Duration)>,
}

/// Shared accumulator of one scan.
#[derive(Debug)]
pub struct Profiler {
    inner: Mutex<Inner>,
    started: Instant,
}

impl Profiler {
    /// A profiler when `enabled`, so callers hold an `Option` that is `None` when off.
    pub fn new(enabled: Option<bool>) -> Option<Self> {
        enabled.unwrap_or(false).then(|| Self { inner: Mutex::new(Inner::default()), started: Instant::now() })
    }

    fn add_phase(&self, name: &'static str, elapsed: Duration) {
        if let Ok(mut inner) = self.inner.lock() {
            let entry = inner.phases.entry(name).or_default();
            entry.0 += elapsed;
            entry.1 += 1;
        }
    }

    fn add_file(&self, file: &Path, elapsed: Duration, local: &Local) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.files.push((file.to_string_lossy().into_owned(), elapsed));
            if inner.rules.len() < local.rules.len() {
                inner.rules.resize(local.rules.len(), RuleStat::default());
            }
            for (total, stat) in inner.rules.iter_mut().zip(&local.rules) {
                total.count += stat.count;
                total.elapsed += stat.elapsed;
            }
        }
    }

    /// Drain the accumulator into the report. File paths are made relative to
    /// `roots` exactly like findings; `rules` names the indices the detector timed.
    pub fn finish(&self, rules: &[CompiledRule], roots: &[PathBuf]) -> ProfileReport {
        let inner = self.inner.lock().map(|mut guard| std::mem::take(&mut *guard)).unwrap_or_default();
        let ms = |elapsed: Duration| elapsed.as_secs_f64() * 1000.0;

        let mut phases: Vec<ProfilePhase> = inner
            .phases
            .into_iter()
            .map(|(name, (elapsed, count))| ProfilePhase { count, ms: ms(elapsed), name: name.to_owned() })
            .collect();
        phases.sort_by(|a, b| b.ms.total_cmp(&a.ms).then_with(|| a.name.cmp(&b.name)));

        let mut rule_rows: Vec<ProfileRule> = inner
            .rules
            .iter()
            .zip(rules)
            .filter(|(stat, _)| stat.count > 0)
            .map(|(stat, rule)| ProfileRule {
                count: stat.count,
                ms: ms(stat.elapsed),
                pattern: rule.pattern.clone(),
                rule_id: rule.id.clone(),
            })
            .collect();
        rule_rows.sort_by(|a, b| b.ms.total_cmp(&a.ms).then_with(|| a.rule_id.cmp(&b.rule_id)));

        let mut files: Vec<ProfileFile> =
            inner.files.into_iter().map(|(file, elapsed)| ProfileFile { file, ms: ms(elapsed) }).collect();
        relative_profile_paths(&mut files, roots);
        files.sort_by(|a, b| b.ms.total_cmp(&a.ms).then_with(|| a.file.cmp(&b.file)));

        ProfileReport { files, phases, rules: rule_rows, total_ms: ms(self.started.elapsed()) }
    }
}

/// Time `f` as the named phase when profiling; a plain call otherwise.
pub fn phase<R>(profiler: Option<&Profiler>, name: &'static str, f: impl FnOnce() -> R) -> R {
    let Some(profiler) = profiler else { return f() };
    let start = Instant::now();
    let result = f();
    profiler.add_phase(name, start.elapsed());
    result
}

/// Run the scan of one file. With profiling on, its wall clock and rule timings
/// are merged into the profiler once, after the file is done.
pub fn file<R>(profiler: Option<&Profiler>, path: &Path, f: impl FnOnce() -> R) -> R {
    let Some(profiler) = profiler else { return f() };
    let start = Instant::now();
    let (result, local) = collect(f);
    profiler.add_file(path, start.elapsed(), &local);
    result
}
