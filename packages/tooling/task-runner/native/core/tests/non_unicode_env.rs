//! A non-Unicode variable in the parent environment must not break a run.
//!
//! Lives in its own integration-test binary so the variable never leaks into
//! the unit tests, which run in a different process.

#![cfg(unix)]

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;

use task_runner_core::concurrent::types::{ConcurrentCommandConfig, ConcurrentRunnerOptions};
use task_runner_core::ConcurrentRunner;
use tokio::sync::mpsc;

#[tokio::test]
async fn a_non_unicode_parent_variable_does_not_panic_the_run() {
    std::env::set_var("TASK_RUNNER_NON_UNICODE", OsStr::from_bytes(b"caf\xe9"));

    let commands = vec![ConcurrentCommandConfig {
        command: "echo ok".to_string(),
        name: None,
        cwd: None,
        env: None,
        shell: None,
        stdin: None,
    }];
    let options = ConcurrentRunnerOptions {
        max_processes: None,
        kill_signal: None,
        kill_others: None,
        success_condition: None,
        kill_timeout: None,
        shell_path: None,
    };
    let runner = ConcurrentRunner::new(commands, &options);
    let (event_tx, _event_rx) = mpsc::unbounded_channel();

    let result = runner.run(event_tx).await;

    assert!(result.success);
    assert_eq!(result.close_events[0].exit_code, 0);
}
