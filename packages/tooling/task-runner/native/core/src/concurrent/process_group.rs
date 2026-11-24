//! Platform-specific process tree management.
//!
//! Unix: spawn children in new process groups via `setsid`, kill via `killpg`.
//! Windows: assign children to Job Objects, terminate via `TerminateJobObject`.

use super::types::KillSignal;

#[cfg(unix)]
mod unix {
    use std::io;

    use nix::libc;
    use nix::sys::signal::{self, Signal};
    use nix::unistd::Pid;

    use crate::concurrent::types::KillSignal;

    /// Pre-exec hook: call `setsid()` to create a new session/process group.
    ///
    /// # Safety
    ///
    /// Must be called inside `Command::pre_exec` (unsafe).
    pub(crate) unsafe fn pre_exec_setsid() -> io::Result<()> {
        if libc::setsid() == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Kill an entire process group by PID.
    /// The PID is used as the PGID (since we called setsid).
    ///
    /// Caveat: a child that itself calls `setpgid`/`setsid` after our
    /// `pre_exec_setsid` will have moved out of the group we recorded.
    /// On a busy system the kernel could even re-assign that PGID to
    /// an unrelated process group before our signal lands. Realistic
    /// package.json scripts (shells, node, vitest, packem) don't do
    /// this, but it's worth knowing if a future bug report names a
    /// process being signalled that shouldn't have been.
    pub(crate) fn kill_process_group(pid: u32, signal: KillSignal) -> io::Result<()> {
        let pgid = Pid::from_raw(-(pid as i32));
        signal::kill(pgid, to_signal(signal)).map_err(io::Error::other)
    }

    fn to_signal(signal: KillSignal) -> Signal {
        match signal {
            KillSignal::Abrt => Signal::SIGABRT,
            KillSignal::Alrm => Signal::SIGALRM,
            KillSignal::Bus => Signal::SIGBUS,
            KillSignal::Chld => Signal::SIGCHLD,
            KillSignal::Cont => Signal::SIGCONT,
            KillSignal::Fpe => Signal::SIGFPE,
            KillSignal::Hup => Signal::SIGHUP,
            KillSignal::Ill => Signal::SIGILL,
            KillSignal::Int => Signal::SIGINT,
            KillSignal::Kill => Signal::SIGKILL,
            KillSignal::Pipe => Signal::SIGPIPE,
            KillSignal::Prof => Signal::SIGPROF,
            KillSignal::Quit => Signal::SIGQUIT,
            KillSignal::Segv => Signal::SIGSEGV,
            KillSignal::Stop => Signal::SIGSTOP,
            KillSignal::Sys => Signal::SIGSYS,
            KillSignal::Term => Signal::SIGTERM,
            KillSignal::Trap => Signal::SIGTRAP,
            KillSignal::Tstp => Signal::SIGTSTP,
            KillSignal::Ttin => Signal::SIGTTIN,
            KillSignal::Ttou => Signal::SIGTTOU,
            KillSignal::Urg => Signal::SIGURG,
            KillSignal::Usr1 => Signal::SIGUSR1,
            KillSignal::Usr2 => Signal::SIGUSR2,
            KillSignal::Vtalrm => Signal::SIGVTALRM,
            KillSignal::Winch => Signal::SIGWINCH,
            KillSignal::Xcpu => Signal::SIGXCPU,
            KillSignal::Xfsz => Signal::SIGXFSZ,
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::io;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// Send `CTRL_BREAK_EVENT` to the process group rooted at `pid`.
    ///
    /// Requires the child to have been spawned with `CREATE_NEW_PROCESS_GROUP`
    /// — only then does the child have its own group ID equal to its PID, so a
    /// targeted `GenerateConsoleCtrlEvent` reaches the child + its descendants
    /// without also signalling our parent console.
    ///
    /// Note: `CTRL_C_EVENT` is silently ignored by processes in a new process
    /// group (Microsoft documents this), so we use `CTRL_BREAK_EVENT` for the
    /// graceful path. Well-behaved CLIs handle Ctrl+Break the same as Ctrl+C.
    pub(crate) fn graceful_shutdown(pid: u32) -> io::Result<()> {
        let result = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) };
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// A Windows Job Object handle that ensures child process tree cleanup.
    /// When the Job Object is dropped, all assigned processes are terminated.
    pub(crate) struct JobObject {
        handle: HANDLE,
    }

    impl JobObject {
        pub(crate) fn new() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }

            // Configure: kill all processes when the job object is closed
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let result = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };

            if result == 0 {
                unsafe { CloseHandle(handle) };
                return Err(io::Error::last_os_error());
            }

            Ok(Self { handle })
        }

        /// Assign a process to this Job Object by PID.
        /// Opens the process handle, assigns it, then closes the handle.
        pub(crate) fn assign_process_by_pid(&self, pid: u32) -> io::Result<()> {
            // Minimum permissions needed for Job Object assignment + termination
            let process_handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            // OpenProcess returns NULL on failure per MSDN, not
            // INVALID_HANDLE_VALUE — the redundant comparison the
            // previous code carried was harmless but misleading.
            if process_handle.is_null() {
                return Err(io::Error::last_os_error());
            }

            let result = unsafe { AssignProcessToJobObject(self.handle, process_handle) };
            unsafe { CloseHandle(process_handle) };

            if result == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub(crate) fn terminate(&self, exit_code: u32) -> io::Result<()> {
            let result = unsafe { TerminateJobObject(self.handle, exit_code) };
            if result == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    // SAFETY: The Job Object handle is thread-safe in Windows.
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}
}

/// Kill a process tree by PID with the given signal.
pub(crate) fn kill_tree(pid: u32, signal: KillSignal) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        unix::kill_process_group(pid, signal)
    }

    #[cfg(windows)]
    {
        // On Windows, if we have a Job Object, termination happens via the Job.
        // This fallback kills just the process if no Job Object is available.
        let _ = signal;
        let output = std::process::Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(format!("taskkill failed: {}", String::from_utf8_lossy(&output.stderr))))
        }
    }
}

#[cfg(unix)]
pub(crate) use unix::pre_exec_setsid;

#[cfg(windows)]
pub(crate) use windows::{graceful_shutdown, JobObject};
