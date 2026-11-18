//! The task-runner and secret-scanner engines are plain Rust crates that this
//! (napi-free) workspace can link and call directly.

use secret_scanner_core::{scan_text, ScanOptions};
use task_runner_core::{get_dependent_tasks, hash_string, TaskGraph};

#[test]
fn task_runner_core_hashes_and_walks_a_graph() {
    let graph = TaskGraph {
        task_ids: vec!["lib:build".into(), "app:build".into()],
        edges: vec![vec!["app:build".into(), "lib:build".into()]],
    };

    assert_eq!(hash_string("vis").len(), 32);
    assert_eq!(get_dependent_tasks(&graph, "lib:build"), ["app:build"]);
}

#[test]
fn secret_scanner_core_scans_text() {
    let options = ScanOptions {
        config: Some(
            serde_json::json!({ "rules": [{ "id": "demo", "regex": "demo_[a-z0-9]{8}", "keywords": ["demo_"] }] }),
        ),
        ..Default::default()
    };
    let report = scan_text("key = demo_abcd1234", "x.env", &options).unwrap();

    assert_eq!(report.findings.len(), 1);
}
