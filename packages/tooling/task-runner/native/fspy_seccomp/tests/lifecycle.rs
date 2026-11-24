//! Whole-run behaviour on a real kernel: the run ends promptly once the
//! tracked tree is gone, and descendants that outlive the main target keep
//! working.

#![cfg(target_os = "linux")]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use fspy_seccomp::{track_command, SpawnOptions};

fn helper_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fspy-seccomp-helper"))
}

fn sh(script: &str) -> Vec<String> {
    vec!["sh".to_string(), "-c".to_string(), script.to_string()]
}

/// Kernels that raise `POLLHUP` on the notify fd once the last task is gone but
/// still wait for a request in the receive ioctl used to leave the supervisor
/// blocked there, so a command that had already exited never returned.
#[test]
fn a_finished_command_returns_promptly_with_a_complete_trace() {
    let started = Instant::now();
    let result = track_command(&sh("true"), &helper_path(), &SpawnOptions::default(), None).expect("track_command");

    assert_eq!(result.exit_code, 0);
    assert!(!result.incomplete, "an ordinary command has a complete trace");
    // The grace window (2 s) is only for lingering descendants; a plain exit drains at once.
    assert!(started.elapsed() < Duration::from_millis(1500), "took {:?}", started.elapsed());
}

/// After the grace window the run is over for the caller, but a descendant that is
/// still running must not start failing its tracked syscalls: the listener used to be
/// closed then, and the kernel answers every later tracked syscall with ENOSYS.
#[test]
fn a_descendant_outliving_the_grace_window_keeps_working() {
    let dir = std::env::temp_dir().join(format!("fspy-lifecycle-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let input = dir.join("in.txt");
    let output = dir.join("out.txt");

    std::fs::write(&input, b"payload").unwrap();

    let script = format!("( sleep 3; cat {} > {} ) >/dev/null 2>&1 & exit 0", input.display(), output.display());
    let result = track_command(&sh(&script), &helper_path(), &SpawnOptions::default(), None).expect("track_command");

    assert_eq!(result.exit_code, 0);

    // The background job opens its files at ~3 s, after track_command returned (~2 s).
    let deadline = Instant::now() + Duration::from_secs(8);

    while Instant::now() < deadline && std::fs::read(&output).map(|b| b.is_empty()).unwrap_or(true) {
        std::thread::sleep(Duration::from_millis(100));
    }

    let written = std::fs::read(&output).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(written, b"payload", "the descendant's tracked syscalls must not fail once the run was handed back");
}
