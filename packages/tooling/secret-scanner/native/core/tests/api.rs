//! The public scan API as the napi addon and native callers use it.

use std::fs;

use secret_scanner_core::{inspect_ruleset, list_rules, scan_dirs, scan_files, scan_text, ScanError, ScanOptions};
use serde_json::json;

fn options() -> ScanOptions {
    ScanOptions {
        config: Some(json!({
            "rules": [{ "id": "demo-token", "description": "demo", "regex": "demo_[a-z0-9]{12}", "keywords": ["demo_"] }]
        })),
        ..Default::default()
    }
}

#[test]
fn scan_text_reports_the_match_with_its_position() {
    let report = scan_text("token = demo_abcdef123456\n", "a.env", &options()).unwrap();

    assert_eq!(report.findings.len(), 1);
    assert_eq!(report.findings[0].rule_id, "demo-token");
    assert_eq!(report.findings[0].file, "a.env");
    assert_eq!(report.findings[0].start_line, 1);
}

#[test]
fn scan_text_redacts_on_request() {
    let opts = ScanOptions { redact: Some(true), ..options() };
    let report = scan_text("demo_abcdef123456", "a.env", &opts).unwrap();

    assert_eq!(report.findings[0].secret, "dem***********456");
}

#[test]
fn scan_dirs_and_scan_files_find_the_same_file() {
    let dir = std::env::temp_dir().join(format!("secret-scanner-core-api-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("leak.txt");
    fs::write(&file, "demo_abcdef123456").unwrap();

    let walked = scan_dirs(vec![dir.to_string_lossy().into_owned()], &options()).unwrap();
    let listed = scan_files(vec![file.to_string_lossy().into_owned()], &options()).unwrap();
    let _ = fs::remove_dir_all(&dir);

    assert_eq!(walked.findings.len(), 1);
    assert_eq!(listed.findings.len(), 1);
    assert!(walked.skipped.is_empty() && listed.skipped.is_empty());
}

#[test]
fn profiling_is_opt_in_and_reports_phases_rules_and_files() {
    let plain = scan_text("demo_abcdef123456", "a.env", &options()).unwrap();
    assert!(plain.profile.is_none());

    let opts = ScanOptions { profile: Some(true), ..options() };
    let profiled = scan_text("demo_abcdef123456", "a.env", &opts).unwrap();
    let profile = profiled.profile.unwrap();

    assert!(profile.total_ms >= 0.0);
    assert!(profile.phases.iter().any(|p| p.name == "detect"));
    assert!(profile.phases.iter().any(|p| p.name == "finalize"));
    assert_eq!(profile.rules[0].rule_id, "demo-token");
    assert_eq!(profile.rules[0].pattern.as_deref(), Some("demo_[a-z0-9]{12}"));
    assert!(profile.rules[0].count >= 1);
    assert_eq!(profile.files[0].file, "a.env");
}

#[test]
fn profile_file_paths_are_relative_to_the_scan_root() {
    let dir =
        std::env::temp_dir().join(format!("ss-profile-{}", std::process::id())).join("a").join("deeply").join("nested");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.env");
    fs::write(&file, "demo_abcdef123456").unwrap();
    let root = dir.parent().unwrap().parent().unwrap().to_path_buf();
    let opts = ScanOptions { profile: Some(true), ..options() };

    let walked = scan_dirs(vec![root.to_string_lossy().into_owned()], &opts).unwrap();
    let _ = fs::remove_dir_all(root.parent().unwrap());

    let profile = walked.profile.unwrap();
    assert_eq!(profile.files.len(), 1);
    assert_eq!(profile.files[0].file, "deeply/nested/a.env");
    assert_eq!(walked.findings[0].file, profile.files[0].file);
}

#[test]
fn empty_inputs_return_an_empty_report_without_needing_a_config() {
    assert!(scan_dirs(Vec::new(), &ScanOptions::default()).unwrap().findings.is_empty());
    assert!(scan_files(Vec::new(), &ScanOptions::default()).unwrap().findings.is_empty());
}

#[test]
fn list_rules_and_inspect_ruleset_describe_the_config() {
    let rules = list_rules(&options()).unwrap();

    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].id, "demo-token");
    assert!(rules[0].has_regex && !rules[0].always_runs);
    assert!(inspect_ruleset(&options()).unwrap().is_empty());
}

#[test]
fn errors_keep_the_messages_the_js_side_has_always_shown() {
    let missing = scan_text("x", "a", &ScanOptions::default()).unwrap_err();
    let floor = ScanOptions { min_confidence: Some("max".into()), ..options() };
    let bad_floor = scan_text("x", "a", &floor).unwrap_err();
    let bad_shape = ScanOptions { config: Some(json!({ "rules": 5 })), ..Default::default() };

    assert!(matches!(missing, ScanError::MissingConfig));
    assert_eq!(missing.to_string(), "ScanOptions.config is required (pass a parsed gitleaks-shaped object)");
    assert_eq!(bad_floor.to_string(), "min_confidence must be one of 'low' | 'medium' | 'high', got \"max\"");
    assert!(scan_text("x", "a", &bad_shape).unwrap_err().to_string().starts_with("config shape: "));
}
