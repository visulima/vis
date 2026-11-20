#![deny(clippy::all)]
//! The secret scanner engine in plain Rust (no napi). Node reaches it through the
//! `secret-scanner-native` addon; native callers use the functions below directly.

mod archive;
mod composite;
mod config;
mod decode;
mod detector;
mod entropy;
mod finalize;
mod lines;
mod profile;
mod rules;
mod scan;
mod scanner;
mod skip;
mod suppression;
mod types;
mod walker;

pub use profile::{ProfileFile, ProfilePhase, ProfileReport, ProfileRule};
pub use scan::{inspect_ruleset, list_rules, scan_dirs, scan_files, scan_text, ScanError};
pub use types::{
    AllowWarning, Finding, RequiredFinding, RuleInfo, ScanOptions, ScanReport, SkippedFile, SkippedRule,
    SuppressedFinding,
};
