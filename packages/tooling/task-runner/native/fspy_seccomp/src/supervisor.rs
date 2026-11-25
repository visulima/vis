//! In-process supervisor that consumes events off the kernel's
//! seccomp notify fd and folds them into a `Vec<FileAccess>`.
//!
//! Runs as a thread inside whichever process called `track_command`
//! — Node holds the resulting handle via NAPI. There is no separate
//! supervisor binary; an out-of-process design adds IPC and
//! packaging cost we don't yet need.
//!
//! Loop shape ([`drive`]):
//! 1. Wait until the notify fd is readable, hung up, or the caller asks
//!    the loop to stop.
//! 2. Only when the fd reports `POLLIN`, `ioctl(fd, SECCOMP_IOCTL_NOTIF_RECV)`.
//!    A hang-up without `POLLIN` means every task using the filter is gone:
//!    the listener is drained and the loop ends. Calling RECV then would
//!    block forever on kernels that report `POLLHUP` but still wait for a
//!    request in the receive ioctl.
//! 3. Classify the request, then `ioctl(fd, SECCOMP_IOCTL_NOTIF_SEND)` with
//!    `SECCOMP_USER_NOTIF_FLAG_CONTINUE` so the child runs the real
//!    syscall — we observe, never block. What the request contributed to
//!    the trace is committed only once the response was accepted.
//!
//! The loop talks to the kernel through [`Source`], so the state machine is
//! tested with a scripted fake and no kernel.

use std::io;
use std::mem;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::time::{Duration, Instant};

use libc::{
    seccomp_notif, seccomp_notif_resp, SECCOMP_IOCTL_NOTIF_RECV, SECCOMP_IOCTL_NOTIF_SEND,
    SECCOMP_USER_NOTIF_FLAG_CONTINUE,
};
use nix::poll::{poll, PollFd, PollFlags, PollTimeout};

use crate::filter::{is_native_call, NATIVE_ABI};
use crate::syscalls::{self, Classified};
use crate::FileAccess;

/// What a [`Source::wait`] found.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Wake {
    /// The caller asked the loop to stop (cancel pipe, or deadline reached).
    pub stop: bool,
    /// A notification is pending (`POLLIN`): RECV will not block.
    pub readable: bool,
    /// No task uses the filter any more (`POLLHUP`), or the fd is unusable
    /// (`POLLERR` / `POLLNVAL`).
    pub hangup: bool,
}

impl Wake {
    /// Interprets the `revents` of the notify fd and of the stop pipe.
    pub(crate) fn from_revents(notify: PollFlags, stop: Option<PollFlags>) -> Self {
        Self {
            stop: stop.is_some_and(|flags| !flags.is_empty()),
            readable: notify.contains(PollFlags::POLLIN),
            hangup: notify.intersects(PollFlags::POLLHUP | PollFlags::POLLERR | PollFlags::POLLNVAL),
        }
    }
}

/// How [`drive`] ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Exit {
    /// The listener hung up: the tracked process tree is gone.
    Drained,
    /// The caller asked to stop while the filter was still in use.
    Stopped,
}

/// What the loop gathered.
#[derive(Debug)]
pub(crate) struct Observed {
    pub accesses: Vec<FileAccess>,
    /// See [`Classified::incomplete`].
    pub incomplete: bool,
    pub exit: Exit,
}

/// The kernel side of the loop: readiness, receive, respond.
pub(crate) trait Source {
    /// Blocks until the notify fd is readable or hung up, or a stop is
    /// requested. `EINTR` is retried inside.
    fn wait(&mut self) -> io::Result<Wake>;
    /// Receives the next pending request into `req`.
    fn recv(&mut self, req: &mut seccomp_notif) -> io::Result<()>;
    /// Answers request `id` with "run the real syscall".
    fn respond_continue(&mut self, id: u64) -> io::Result<()>;
}

/// The receive/classify/respond loop.
///
/// Ends with [`Exit::Drained`] on a hang-up and [`Exit::Stopped`] when the
/// source asks to stop. Stopping is checked first so a caller that cancels
/// is not held up by a busy tracked tree.
pub(crate) fn drive<S: Source>(
    source: &mut S,
    mut classify: impl FnMut(&seccomp_notif) -> Classified,
) -> io::Result<Observed> {
    let mut accesses = Vec::new();
    let mut incomplete = false;

    loop {
        let wake = source.wait()?;

        if wake.stop {
            return Ok(Observed { accesses, incomplete, exit: Exit::Stopped });
        }

        if !wake.readable {
            if wake.hangup {
                return Ok(Observed { accesses, incomplete, exit: Exit::Drained });
            }

            // Spurious wake-up with nothing on the notify fd.
            continue;
        }

        // Fresh (zeroed) each iteration so stale fields from the previous
        // notification can't leak through if the kernel writes a shorter payload.
        // SAFETY: `seccomp_notif` is a plain-old-data C struct; all-zero is valid.
        let mut req: seccomp_notif = unsafe { mem::zeroed() };

        match source.recv(&mut req) {
            Ok(()) => {}
            Err(err) => match err.raw_os_error() {
                // Interrupted by a signal, or the request was withdrawn (its task was
                // interrupted) between the readiness check and the receive. Neither
                // means the listener is drained — only `POLLHUP` does — so go back to
                // waiting rather than leaving the rest of the run unserved.
                Some(libc::EINTR | libc::ENOENT | libc::ECANCELED) => continue,
                _ => return Err(err),
            },
        }

        let seen = classify(&req);

        // Always respond — leaving a request un-acked stalls the
        // child forever. CONTINUE passes the syscall through to the
        // kernel so observable behaviour is unchanged.
        match source.respond_continue(req.id) {
            Ok(()) => {
                accesses.extend(seen.accesses);
                incomplete |= seen.incomplete;
            }
            // ENOENT: the tracked task disappeared (fatal signal) between receive and
            // respond. Drop this batch — we never confirmed the syscall ran — and keep
            // listening; its gaps are dropped with it, so a killed task does not mark
            // the trace incomplete.
            Err(err) if err.raw_os_error() == Some(libc::ENOENT) => {}
            Err(err) => return Err(err),
        }
    }
}

/// What the supervisor makes of one notification: decode it, unless it was
/// made through an ABI the syscall table does not describe. Such a call is
/// answered like any other but cannot be decoded, so the trace has a gap.
fn classify_notification(req: &seccomp_notif) -> Classified {
    if is_native_call(NATIVE_ABI, req.data.arch, req.data.nr) {
        syscalls::classify(req, req.pid as i32)
    } else {
        Classified { accesses: Vec::new(), incomplete: true }
    }
}

/// Records accesses until the tracked tree exits or `source` asks to stop.
pub(crate) fn observe<S: Source>(source: &mut S) -> io::Result<Observed> {
    drive(source, classify_notification)
}

/// Keeps answering CONTINUE, without decoding or recording, until the tracked
/// tree exits or `source` asks to stop. Used after [`observe`] was stopped
/// with descendants still running: closing the listener at that point would
/// make the kernel fail every later tracked syscall of those descendants
/// with `ENOSYS`.
pub(crate) fn passthrough<S: Source>(source: &mut S) -> io::Result<()> {
    drive(source, |_| Classified::default()).map(|_| ())
}

/// When the stop request comes from.
enum Stop {
    /// A pipe that becomes readable (or hung up) when the run should stop.
    Pipe(OwnedFd),
    /// A point in time.
    Deadline(Instant),
}

/// [`Source`] over the real notify fd. Owns the fds it polls, so a thread
/// that outlives the run can never poll a closed or reused fd number.
pub(crate) struct FdSource {
    notify: OwnedFd,
    stop: Stop,
}

impl FdSource {
    /// `stop` is the read end of the cancel pipe.
    pub(crate) fn new(notify: OwnedFd, stop: OwnedFd) -> Self {
        Self { notify, stop: Stop::Pipe(stop) }
    }

    /// Switches to answering without recording ([`passthrough`]) and stops at `deadline`.
    /// The cancel pipe is dropped: it is permanently readable once cancelled and
    /// would otherwise make the next poll return immediately forever.
    pub(crate) fn until(self, deadline: Instant) -> Self {
        Self { notify: self.notify, stop: Stop::Deadline(deadline) }
    }
}

impl Source for FdSource {
    fn wait(&mut self) -> io::Result<Wake> {
        loop {
            let timeout = match &self.stop {
                Stop::Pipe(_) => PollTimeout::NONE,
                Stop::Deadline(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());

                    if left.is_zero() {
                        return Ok(Wake { stop: true, ..Wake::default() });
                    }

                    // Capped so the conversion cannot overflow; the loop re-checks.
                    PollTimeout::try_from(left.min(Duration::from_secs(1))).unwrap_or(PollTimeout::NONE)
                }
            };

            let notify = PollFd::new(self.notify.as_fd(), PollFlags::POLLIN);
            let polled = match &self.stop {
                Stop::Pipe(pipe) => {
                    let mut fds = [notify, PollFd::new(pipe.as_fd(), PollFlags::POLLIN)];

                    poll(&mut fds, timeout).map(|ready| (ready, fds[0].revents(), fds[1].revents()))
                }
                Stop::Deadline(_) => {
                    let mut fds = [notify];

                    poll(&mut fds, timeout).map(|ready| (ready, fds[0].revents(), None))
                }
            };

            match polled {
                Ok((0, ..)) => continue,
                Ok((_, notify, stop)) => {
                    return Ok(Wake::from_revents(notify.unwrap_or(PollFlags::empty()), stop));
                }
                Err(nix::errno::Errno::EINTR) => continue,
                Err(errno) => return Err(errno.into()),
            }
        }
    }

    fn recv(&mut self, req: &mut seccomp_notif) -> io::Result<()> {
        // SAFETY: `req` is a valid `seccomp_notif` the kernel fills in.
        let rc = unsafe { libc::ioctl(self.notify.as_raw_fd(), SECCOMP_IOCTL_NOTIF_RECV, req as *mut seccomp_notif) };

        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn respond_continue(&mut self, id: u64) -> io::Result<()> {
        // SAFETY: `seccomp_notif_resp` is a plain-old-data C struct; all-zero is valid.
        let mut resp: seccomp_notif_resp = unsafe { mem::zeroed() };

        resp.id = id;
        resp.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE as u32;

        // SAFETY: `resp` is a valid `seccomp_notif_resp` the kernel reads.
        let rc = unsafe {
            libc::ioctl(self.notify.as_raw_fd(), SECCOMP_IOCTL_NOTIF_SEND, &resp as *const seccomp_notif_resp)
        };

        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::os::fd::FromRawFd;
    use std::path::PathBuf;

    use super::*;
    use crate::filter::AUDIT_ARCH_I386;
    use crate::AccessKind;

    fn errno(code: i32) -> io::Error {
        io::Error::from_raw_os_error(code)
    }

    const READABLE: Wake = Wake { stop: false, readable: true, hangup: false };
    const HANGUP: Wake = Wake { stop: false, readable: false, hangup: true };
    const STOP: Wake = Wake { stop: true, readable: false, hangup: false };

    /// A kernel that follows a script. It panics when the loop asks for more
    /// than the script holds, so a loop that would block forever in the real
    /// receive ioctl (or spin) fails the test instead of hanging it.
    #[derive(Default)]
    struct Script {
        waits: VecDeque<io::Result<Wake>>,
        /// Request id per RECV, or the error it returns.
        recvs: VecDeque<io::Result<u64>>,
        sends: VecDeque<io::Result<()>>,
        responded: Vec<u64>,
        recv_calls: usize,
    }

    impl Script {
        fn new(waits: impl IntoIterator<Item = Wake>) -> Self {
            Self { waits: waits.into_iter().map(Ok).collect(), ..Self::default() }
        }

        fn recvs(mut self, recvs: impl IntoIterator<Item = io::Result<u64>>) -> Self {
            self.recvs = recvs.into_iter().collect();
            self
        }

        fn sends(mut self, sends: impl IntoIterator<Item = io::Result<()>>) -> Self {
            self.sends = sends.into_iter().collect();
            self
        }
    }

    impl Source for Script {
        fn wait(&mut self) -> io::Result<Wake> {
            self.waits.pop_front().expect("loop waited past the end of the script")
        }

        fn recv(&mut self, req: &mut seccomp_notif) -> io::Result<()> {
            self.recv_calls += 1;

            let id = self
                .recvs
                .pop_front()
                .expect("RECV called with no request pending: the real ioctl would block forever")?;

            req.id = id;
            req.pid = 4242;

            Ok(())
        }

        fn respond_continue(&mut self, id: u64) -> io::Result<()> {
            self.responded.push(id);
            self.sends.pop_front().unwrap_or(Ok(()))
        }
    }

    fn read_of(req: &seccomp_notif) -> Classified {
        Classified {
            accesses: vec![FileAccess { path: PathBuf::from(format!("/file/{}", req.id)), kind: AccessKind::Read }],
            incomplete: false,
        }
    }

    fn paths(observed: &Observed) -> Vec<String> {
        observed.accesses.iter().map(|a| a.path.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn hangup_without_pollin_ends_the_loop_without_calling_recv() {
        // Kernels that raise POLLHUP once the last task is gone still block in RECV
        // for a request; the loop must not call it without POLLIN.
        let mut script = Script::new([HANGUP]);
        let observed = drive(&mut script, read_of).unwrap();

        assert_eq!(observed.exit, Exit::Drained);
        assert_eq!(script.recv_calls, 0);
        assert!(observed.accesses.is_empty());
    }

    #[test]
    fn pollin_with_hangup_still_serves_the_pending_request_before_draining() {
        let mut script = Script::new([Wake { readable: true, hangup: true, ..Wake::default() }, HANGUP]).recvs([Ok(1)]);
        let observed = drive(&mut script, read_of).unwrap();

        assert_eq!(observed.exit, Exit::Drained);
        assert_eq!(paths(&observed), ["/file/1"]);
        assert_eq!(script.responded, [1]);
    }

    #[test]
    fn a_spurious_wake_is_ignored() {
        let mut script = Script::new([Wake::default(), HANGUP]);

        assert_eq!(drive(&mut script, read_of).unwrap().exit, Exit::Drained);
        assert_eq!(script.recv_calls, 0);
    }

    #[test]
    fn recv_enoent_keeps_listening_and_only_hangup_ends_the_loop() {
        // A signal between poll and RECV (SIGCHLD, a timer) can leave the request
        // withdrawn: RECV reports ENOENT while the run is still going. Stopping here
        // used to close the listener and fail every later tracked syscall with ENOSYS.
        let mut script = Script::new([READABLE, READABLE, HANGUP]).recvs([Err(errno(libc::ENOENT)), Ok(7)]);
        let observed = drive(&mut script, read_of).unwrap();

        assert_eq!(observed.exit, Exit::Drained);
        assert_eq!(paths(&observed), ["/file/7"]);
        assert_eq!(script.responded, [7]);
    }

    #[test]
    fn recv_eintr_and_ecanceled_keep_listening() {
        let mut script = Script::new([READABLE, READABLE, READABLE, HANGUP]).recvs([
            Err(errno(libc::EINTR)),
            Err(errno(libc::ECANCELED)),
            Ok(3),
        ]);
        let observed = drive(&mut script, read_of).unwrap();

        assert_eq!(paths(&observed), ["/file/3"]);
    }

    #[test]
    fn an_unexpected_recv_error_is_returned() {
        let mut script = Script::new([READABLE]).recvs([Err(errno(libc::EBADF))]);
        let err = drive(&mut script, read_of).unwrap_err();

        assert_eq!(err.raw_os_error(), Some(libc::EBADF));
    }

    #[test]
    fn a_wait_error_is_returned() {
        let mut script = Script::default();

        script.waits.push_back(Err(errno(libc::EBADF)));

        assert_eq!(drive(&mut script, read_of).unwrap_err().raw_os_error(), Some(libc::EBADF));
    }

    #[test]
    fn stop_returns_what_was_gathered_and_wins_over_a_pending_request() {
        let mut script = Script::new([READABLE, Wake { stop: true, readable: true, hangup: false }]).recvs([Ok(1)]);
        let observed = drive(&mut script, read_of).unwrap();

        assert_eq!(observed.exit, Exit::Stopped);
        assert_eq!(paths(&observed), ["/file/1"]);
        assert_eq!(script.recv_calls, 1, "a pending request is left for the passthrough, not received after the stop");
    }

    #[test]
    fn a_dropped_access_marks_the_trace_incomplete_once_the_response_was_accepted() {
        let mut script = Script::new([READABLE, HANGUP]).recvs([Ok(1)]);
        let observed = drive(&mut script, |_| Classified { accesses: Vec::new(), incomplete: true }).unwrap();

        assert!(observed.incomplete);
    }

    #[test]
    fn a_request_whose_task_vanished_before_the_response_contributes_nothing() {
        // The task was killed between RECV and SEND (ENOENT): its gap must not poison the
        // trace, and the loop keeps serving the next request.
        let mut script =
            Script::new([READABLE, READABLE, HANGUP]).recvs([Ok(1), Ok(2)]).sends([Err(errno(libc::ENOENT)), Ok(())]);
        let observed = drive(&mut script, |req| Classified { incomplete: req.id == 1, ..read_of(req) }).unwrap();

        assert!(!observed.incomplete);
        assert_eq!(paths(&observed), ["/file/2"]);
        assert_eq!(script.responded, [1, 2]);
    }

    #[test]
    fn a_failing_response_is_returned() {
        let mut script = Script::new([READABLE]).recvs([Ok(1)]).sends([Err(errno(libc::EBADF))]);

        assert_eq!(drive(&mut script, read_of).unwrap_err().raw_os_error(), Some(libc::EBADF));
    }

    #[test]
    fn passthrough_answers_every_request_without_recording_until_hangup() {
        let mut script = Script::new([READABLE, READABLE, HANGUP]).recvs([Ok(10), Ok(11)]);

        passthrough(&mut script).unwrap();

        assert_eq!(script.responded, [10, 11]);
    }

    #[test]
    fn passthrough_survives_a_withdrawn_request_and_ends_at_the_stop() {
        let mut script = Script::new([READABLE, READABLE, STOP]).recvs([Err(errno(libc::ENOENT)), Ok(5)]);

        passthrough(&mut script).unwrap();

        assert_eq!(script.responded, [5]);
    }

    #[test]
    fn unknown_abi_calls_are_not_decoded_and_flag_the_trace() {
        // A foreign-arch request reaches the supervisor (the filter notifies instead of
        // killing the thread); it is answered, never decoded with the wrong table.
        // SAFETY: `seccomp_notif` is a plain-old-data C struct; all-zero is valid.
        let mut foreign: seccomp_notif = unsafe { mem::zeroed() };

        foreign.data.arch = AUDIT_ARCH_I386;
        foreign.data.nr = 5;

        let got = classify_notification(&foreign);

        assert!(got.accesses.is_empty());
        assert!(got.incomplete);
    }

    /// `_IOWR('!', nr, T)` from <linux/seccomp.h>: dir (read|write = 3) << 30 | size << 16 |
    /// type << 8 | nr, with `SECCOMP_IOC_MAGIC = '!'`. These are the values this module
    /// used to compute by hand. Checked at compile time, so a `cargo check --tests` for a
    /// Linux target covers them.
    const fn iowr(nr: u32, size: usize) -> libc::Ioctl {
        ((3_u32 << 30) | ((size as u32) << 16) | ((b'!' as u32) << 8) | nr) as libc::Ioctl
    }

    const _: () = {
        assert!(mem::size_of::<seccomp_notif>() == 80);
        assert!(mem::size_of::<seccomp_notif_resp>() == 24);
        assert!(SECCOMP_IOCTL_NOTIF_RECV == iowr(0, 80));
        assert!(SECCOMP_IOCTL_NOTIF_SEND == iowr(1, 24));
    };

    #[test]
    fn revents_are_interpreted_like_the_poll_flags_say() {
        assert_eq!(Wake::from_revents(PollFlags::POLLIN, None), READABLE);
        assert_eq!(Wake::from_revents(PollFlags::POLLHUP, None), HANGUP);
        assert_eq!(Wake::from_revents(PollFlags::POLLERR, None), HANGUP);
        assert_eq!(Wake::from_revents(PollFlags::POLLNVAL, None), HANGUP);
        assert_eq!(
            Wake::from_revents(PollFlags::POLLIN | PollFlags::POLLHUP, None),
            Wake { readable: true, hangup: true, stop: false }
        );
        assert_eq!(Wake::from_revents(PollFlags::empty(), Some(PollFlags::POLLIN)), STOP);
        assert_eq!(Wake::from_revents(PollFlags::empty(), Some(PollFlags::POLLHUP)), STOP);
        assert_eq!(Wake::from_revents(PollFlags::empty(), Some(PollFlags::empty())), Wake::default());
    }

    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [0; 2];

        // SAFETY: `pipe2` fills two fresh fds that we then own.
        unsafe {
            assert_eq!(libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC), 0);

            (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1]))
        }
    }

    fn write_byte(fd: &OwnedFd) {
        // SAFETY: writes one byte from a valid buffer to an open fd.
        assert_eq!(unsafe { libc::write(fd.as_raw_fd(), [1_u8].as_ptr().cast(), 1) }, 1);
    }

    #[test]
    fn fd_source_reports_data_hangup_and_stop_from_real_descriptors() {
        let (notify_read, notify_write) = pipe();
        let (stop_read, stop_write) = pipe();
        let mut source = FdSource::new(notify_read, stop_read);

        // Data on the notify fd: readable, no hang-up, no stop.
        write_byte(&notify_write);
        assert_eq!(source.wait().unwrap(), READABLE);

        // Writer gone but data still buffered: POLLIN | POLLHUP.
        drop(notify_write);
        let wake = source.wait().unwrap();

        assert!(wake.readable && wake.hangup && !wake.stop);

        // The stop pipe becoming readable is a stop.
        write_byte(&stop_write);
        assert!(source.wait().unwrap().stop);
    }

    #[test]
    fn fd_source_reports_hangup_alone_once_the_data_is_consumed() {
        let (notify_read, notify_write) = pipe();
        let (stop_read, _stop_write) = pipe();
        let mut source = FdSource::new(notify_read, stop_read);

        drop(notify_write);

        assert_eq!(source.wait().unwrap(), HANGUP);
    }

    #[test]
    fn fd_source_stops_at_the_deadline_and_ignores_the_cancel_pipe_afterwards() {
        let (notify_read, _notify_write) = pipe();
        let (stop_read, stop_write) = pipe();

        // Cancel already signalled, as it is when the grace window has lapsed.
        write_byte(&stop_write);

        let started = Instant::now();
        let mut source = FdSource::new(notify_read, stop_read).until(started + Duration::from_millis(150));
        let wake = source.wait().unwrap();

        assert_eq!(wake, STOP);
        assert!(
            started.elapsed() >= Duration::from_millis(100),
            "the deadline, not the readable cancel pipe, ended the wait"
        );
    }
}
