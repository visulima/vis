//! Handing a run to the Node CLI, and the facts about the Node process the native commands share.

use std::env;
use std::ffi::{OsStr, OsString};
use std::process::{exit, Command, ExitStatus};

/// `EX_SOFTWARE` from sysexits.h — internal error (cannot delegate).
const EX_SOFTWARE: i32 = 70;

/// The Node executable the launcher named in `VIS_NODE`, or `node` from `PATH` when it is unset or empty (a binary run
/// directly, without the launcher).
pub(crate) fn node_program() -> OsString {
    node_program_from(env::var_os("VIS_NODE"))
}

fn node_program_from(value: Option<OsString>) -> OsString {
    value.filter(|value| !value.is_empty()).unwrap_or_else(|| OsString::from("node"))
}

/// [`delegate`], after naming the gate that declined the run on stderr when `VIS_DEBUG_DECLINE` is set (to
/// anything but `0` or the empty string). Nothing is printed otherwise, so the delegated run's stderr stays
/// Node's alone.
pub(crate) fn delegate_because<S: AsRef<OsStr>>(reason: &str, args: &[S]) -> ! {
    if env::var_os("VIS_DEBUG_DECLINE").is_some_and(|value| !value.is_empty() && value != "0") {
        eprintln!("vis: handing the run to Node: {reason}");
    }

    delegate(args)
}

/// Hand the full argv off to the Node CLI, inheriting stdio and forwarding the
/// child's exit status. Never returns.
pub(crate) fn delegate<S: AsRef<OsStr>>(args: &[S]) -> ! {
    let node = node_program();

    let entry = match env::var("VIS_FALLBACK_ENTRY") {
        Ok(path) => path,
        Err(_) => {
            eprintln!("vis: VIS_FALLBACK_ENTRY is not set; cannot delegate to the Node CLI.");
            exit(EX_SOFTWARE);
        }
    };

    // stdio is inherited by default, so the child shares the controlling
    // terminal and process group — Ctrl-C / SIGINT reach it directly.
    let mut command = Command::new(&node);

    command.arg(&entry).args(args);

    let error = run_in_place(&mut command);

    eprintln!("vis: failed to launch Node CLI ('{}'): {error}", node.to_string_lossy());
    exit(EX_SOFTWARE);
}

/// Run `command` so that its process is the one the caller is waiting on, and
/// never returns on success. On Unix this replaces this process with the child
/// (`exec`), so a timeout or signal sent to the `vis` PID reaches the Node CLI
/// itself; a parent that kills only the launcher would otherwise leave Node
/// running with the caller's output pipes open. Elsewhere the child is spawned,
/// waited for, and its status forwarded. Only returns the error if the child
/// could not be started.
pub(crate) fn run_in_place(command: &mut Command) -> std::io::Error {
    use std::io::Write;

    // `exec` skips Rust's stdio flush, so anything still buffered would be lost.
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        command.exec()
    }

    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => exit(node_exit_code(status)),
            Err(error) => error,
        }
    }
}

/// The exit code Node ends with for a child it ran with `spawnSync`: the child's own status, and 1 for one
/// that was killed by a signal (`result.status ?? 1`). The commands that mirror a Node handler use this.
pub(crate) fn node_exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

#[cfg(test)]
mod program_tests {
    use super::*;

    #[test]
    fn the_launchers_node_is_used_and_an_unset_or_empty_one_is_node_from_path() {
        assert_eq!(node_program_from(Some("/opt/node/bin/node".into())), "/opt/node/bin/node");
        assert_eq!(node_program_from(None), "node");
        assert_eq!(node_program_from(Some(OsString::new())), "node");
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_unicode_is_kept() {
        use std::os::unix::ffi::OsStringExt;

        let path = OsString::from_vec(b"/opt/n\xffde/node".to_vec());

        assert_eq!(node_program_from(Some(path.clone())), path);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    use super::*;

    #[test]
    fn a_child_ends_with_its_status_and_a_killed_child_with_one() {
        assert_eq!(node_exit_code(ExitStatus::from_raw(3 << 8)), 3);
        assert_eq!(node_exit_code(ExitStatus::from_raw(0)), 0);
        // Killed by SIGKILL: Node's `result.status` is null, which its handlers turn into 1.
        assert_eq!(node_exit_code(ExitStatus::from_raw(9)), 1);
    }
}
