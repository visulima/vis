//! Own test binary: it inspects the descriptors a child inherits from this process, so no
//! other test may run beside it.

#![cfg(target_os = "linux")]

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use fspy_seccomp::{track_command, SpawnOptions};

fn helper_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fspy-seccomp-helper"))
}

/// The descriptors a freshly spawned child (here `ls`) has open.
fn inherited_fds() -> Vec<String> {
    let out = Command::new("ls").arg("/proc/self/fd").output().expect("ls");
    let mut fds: Vec<String> = String::from_utf8_lossy(&out.stdout).split_whitespace().map(str::to_string).collect();

    fds.sort();
    fds
}

/// Two tracked tasks can run at once in one process. A child spawned while another
/// task is mid-run must not inherit that task's seccomp listener or cancel pipe: an
/// outside copy keeps the listener alive and the descendants of a finished run blocked.
#[test]
fn a_child_spawned_during_a_tracked_run_inherits_no_listener_or_cancel_fds() {
    let before = inherited_fds();

    let tracked = std::thread::spawn(|| {
        track_command(&["sleep".to_string(), "1".to_string()], &helper_path(), &SpawnOptions::default(), None)
            .expect("track_command")
    });

    // Past the handshake: the listener fd and the cancel pipe exist now.
    std::thread::sleep(Duration::from_millis(500));
    let during = inherited_fds();

    tracked.join().unwrap();

    assert_eq!(during, before, "a tracked run leaked descriptors into an unrelated child");
}
