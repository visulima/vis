//! `fspy_seccomp` — Linux file-access tracker via `seccomp_unotify`.
//!
//! ## Architecture (helper-binary pattern)
//!
//! The fork-from-multithreaded hazard rules out installing the
//! seccomp filter in a `pre_exec` hook when the parent is something
//! like Node (multi-threaded: V8 + libuv + tokio workers). The
//! supervisor would inherit allocator + libseccomp locks held by
//! sibling threads at fork time and could deadlock between fork
//! and execve.
//!
//! Architecture, instead:
//!
//! ```text
//! parent (Node + .node addon)
//! ┌──────────────────────────────┐
//! │ create Unix socket listener  │
//! │ at $TMPDIR/fspy-XXXX.sock    │
//! │                              │
//! │ Command::spawn(              │   ┌────────────────────────────┐
//! │   "fspy-seccomp-helper",     │   │ helper (fresh single-      │
//! │   argv=[target_cmd, args],   │──►│ threaded process)          │
//! │   env={FSPY_SOCK=<path>})    │   │  1. PR_SET_NO_NEW_PRIVS    │
//! │   (posix_spawn under hood —  │   │  2. seccomp_load -> fd     │
//! │    no pre_exec hook)         │   │  3. connect to FSPY_SOCK   │
//! │                              │   │  4. send fd via SCM_RIGHTS │
//! │ accept connection            │◄──│  5. execve(target)         │
//! │ recv notify_fd via SCM_RIGHTS│◄──│                            │
//! │                              │   └────────────────────────────┘
//! │ supervisor thread:           │
//! │   seccomp_notify_receive     │
//! │   -> classify(notif, pid)    │
//! │   -> CONTINUE                │
//! │ drain stdout/stderr pipes    │
//! │ wait(child)                  │
//! └──────────────────────────────┘
//! ```
//!
//! `Command::spawn` without a `pre_exec` hook uses `posix_spawn`
//! under the hood — multi-thread-safe (vfork+exec internally). The
//! helper is a single-threaded process when it does the seccomp
//! install; no fork-in-multithreaded exposure anywhere.

#![cfg(target_os = "linux")]
#![deny(unused_must_use)]

use std::io::{self, IoSliceMut, Read};
use std::os::fd::AsFd;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use nix::cmsg_space;
use nix::fcntl::OFlag;
use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
use nix::sys::socket::{
    accept4, bind, listen, recvmsg, socket, AddressFamily, Backlog, ControlMessageOwned, MsgFlags, SockFlag, SockType,
    UnixAddr,
};
use nix::unistd::pipe2;

use crate::supervisor::{Exit, FdSource, Observed};

pub mod filter;
pub mod peer;
pub mod supervisor;
pub mod syscalls;

/// One observed file access. Mirrors the TypeScript-side
/// `FileAccess` interface in `src/file-access-tracker.ts`.
#[derive(Debug, Clone)]
pub struct FileAccess {
    pub path: PathBuf,
    pub kind: AccessKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessKind {
    Read,
    ReadDir,
    Stat,
    Write,
    Missing,
}

/// Result of tracking a single command invocation. `stdout` /
/// `stderr` are captured separately so the orchestrator can present
/// each stream independently (UI parity with the strace path).
#[derive(Debug, Default)]
pub struct TrackingResult {
    pub accesses: Vec<FileAccess>,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Some file accesses of the tracked tree could not be recorded: a syscall
    /// argument could not be read from the target, or a process ran under an
    /// ABI the syscall table does not describe (i386, AArch32, x32). `accesses`
    /// is then a lower bound; callers must not cache on it as if it were
    /// the complete set of inputs.
    pub incomplete: bool,
}

/// Optional spawn settings for the tracked command. `None` fields
/// fall through to parent-process inheritance.
#[derive(Debug, Default, Clone)]
pub struct SpawnOptions {
    pub cwd: Option<PathBuf>,
    /// Extra env vars merged on top of the parent's. Use this for
    /// per-command overrides (e.g. enhanced PATH, NODE_OPTIONS).
    pub env: Vec<(String, String)>,
}

/// Spawn `cmd` under seccomp tracking. The parent listens on a
/// Unix socket; `Command::spawn` invokes `helper_path` with the
/// socket path as `FSPY_SOCK`; the helper sends the notify fd back
/// via SCM_RIGHTS and execves the target.
///
/// `cmd[0]` is the target program path (resolved via `$PATH` by
/// the helper's `execvp`); `cmd[1..]` are its arguments.
///
/// `helper_path` must point at a `fspy-seccomp-helper` binary
/// shipping alongside this library (typically packaged with the
/// `.node` addon).
///
/// `on_started` (when present) is invoked once with the helper PID
/// as soon as the spawn succeeds. The PID is the same one that
/// becomes the target process post-`execve`, so callers can register
/// it for SIGTERM-on-abort cleanup. The callback runs synchronously
/// on the calling thread before `accept_and_recv_fd` blocks.
pub fn track_command(
    cmd: &[String],
    helper_path: &Path,
    opts: &SpawnOptions,
    on_started: Option<&mut dyn FnMut(u32)>,
) -> io::Result<TrackingResult> {
    if cmd.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "track_command requires at least the program path"));
    }

    let sock_path = mk_socket_path();
    let listener = bind_listener(&sock_path)?;
    // Remove the socket file even on early-return paths.
    let _socket_cleanup = SocketCleanup(sock_path.clone());

    // Spawn the helper via std::process::Command. Without a
    // pre_exec hook configured Rust uses posix_spawn under the hood
    // (multi-thread-safe — uses vfork+exec internally), so the
    // fork-in-multithreaded hazard that breaks the strace-style
    // pre_exec install doesn't apply. Stdio::piped lets us capture
    // the target's output for the orchestrator.
    let mut command = Command::new(helper_path);
    command.arg(&cmd[0]);
    command.args(&cmd[1..]);
    command.env(ENV_SOCK, &sock_path);
    if let Some(cwd) = &opts.cwd {
        command.current_dir(cwd);
    }
    for (k, v) in &opts.env {
        command.env(k, v);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let child = command.spawn()?;

    // The guard owns the helper from here to the end of the run and kills +
    // reaps it on every early return, so an error anywhere below (accept,
    // cancel pipe, thread spawn, a failing wait) cannot leave the helper — or
    // the target it execs, blocked on its first trapped syscall with nobody
    // serving the listener — running.
    let mut guard = ChildGuard::new(child);

    // Surface the PID immediately so callers can register the
    // helper for kill-on-abort. The PID survives the helper→target
    // execve, so a future SIGTERM hits the actual target.
    if let Some(cb) = on_started {
        cb(guard.child().id());
    }

    // Accept the helper's connection (with a watchdog: if the helper
    // dies before connecting we'd otherwise block forever in accept).
    // The helper hands off once and execves; we never accept a
    // second connection.
    let notify_fd = accept_and_recv_fd(&listener, &mut guard)?;

    // A self-pipe used to wake the supervisor and the stdio drains once the
    // main target has exited, so a lingering descendant can't pin the run open
    // forever. Created while the guard is still armed: a failure here must
    // not leave the target stuck behind an unserved listener.
    let cancel = CancelPipe::new()?;

    collect_run(&mut guard, notify_fd, &cancel)
}

/// Environment variable that carries the parent's listener socket path to the
/// helper (`bin/helper.rs`), which sends the notify fd back over it.
pub const ENV_SOCK: &str = "FSPY_SOCK";

/// `poll(2)` timeout meaning "wait until an fd is ready".
const POLL_FOREVER: libc::c_int = -1;

/// How long after the main target exits the supervisor may keep collecting
/// accesses from descendants that exit promptly.
const SUPERVISOR_GRACE: Duration = Duration::from_millis(2000);

/// How long the supervisor gets to answer a cancel. It only waits in `poll`
/// and receives when `POLLIN` is set, so it answers at once; the bound exists
/// so a supervisor wedged in the kernel can never hang the run.
const SUPERVISOR_STOP_BOUND: Duration = Duration::from_secs(5);

/// After the grace window, how long the detached supervisor thread keeps
/// answering the syscalls of descendants that are still running before it gives
/// the listener up (the kernel then fails their tracked syscalls with `ENOSYS`).
/// Ends sooner, at once, when the last task using the filter exits.
const PASSTHROUGH_MAX: Duration = Duration::from_secs(10 * 60);

/// Runs the supervisor and the stdio drains until the target exits, then
/// collects them. Takes the guard by reference so the helper stays covered by
/// it until `wait` has returned.
fn collect_run(guard: &mut ChildGuard, notify_fd: OwnedFd, cancel: &CancelPipe) -> io::Result<TrackingResult> {
    // The supervisor runs in a thread so we can simultaneously read stdio +
    // wait on the child without deadlocking. It owns the notify fd and its own
    // dup of the cancel pipe, so a thread that outlives this call never polls
    // a closed (or reused) fd number.
    let (tx, rx) = sync_channel::<io::Result<Observed>>(1);
    let supervisor_stop = cancel.reader()?;

    thread::Builder::new().name("fspy-supervisor".into()).spawn(move || supervise(notify_fd, supervisor_stop, &tx))?;

    // Drain stdout/stderr on dedicated threads. Reading inline would
    // deadlock if the child wrote enough to fill the pipe buffer
    // (~64 KiB) while we waited on the supervisor. The drain is bounded by
    // the cancel pipe: a descendant that inherited (and keeps open) the
    // captured pipes would otherwise block `read_to_end` on EOF forever.
    let stdout_thread = spawn_drain("fspy-stdout", guard.child_mut().stdout.take(), cancel.reader()?)?;
    let stderr_thread = spawn_drain("fspy-stderr", guard.child_mut().stderr.take(), cancel.reader()?)?;

    let status = guard.child_mut().wait();

    if status.is_err() {
        // Waiting failed, so we no longer know whether the target runs. Do not
        // wait out the grace window for a tree that may never exit.
        guard.kill();
    }

    // Give the supervisor a short grace window to flush accesses from
    // descendants that exit promptly, then stop waiting — a lingering descendant
    // (an orphaned browser from a vitest-browser-mode test, a backgrounded `&`
    // job, …) would otherwise keep the seccomp notify fd alive and block here
    // forever. The supervisor thread then keeps those descendants running
    // (see `supervise`); we never hang the run.
    let supervised = await_supervisor(&rx, cancel, SUPERVISOR_GRACE, SUPERVISOR_STOP_BOUND);

    // Unblock the stdio drains too (harmless if they already hit EOF), then
    // collect them. Runs on every path, including a failed wait.
    cancel.signal();

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();

    let status = status?;
    let observed = supervised?;
    let exit_code = status.code().or_else(|| status.signal().map(|s| 128 + s)).unwrap_or(-1);

    Ok(TrackingResult { accesses: observed.accesses, exit_code, stdout, stderr, incomplete: observed.incomplete })
}

/// Body of the supervisor thread: record accesses, report them over `tx`, and
/// — when it was told to stop while the tracked tree still ran — keep
/// answering without recording.
///
/// Closing the listener at that point would make the kernel fail every later
/// tracked syscall of the still-running descendants with `ENOSYS`, so the
/// thread keeps the fd, answers CONTINUE, and ends when the last task using
/// the filter exits (or after [`PASSTHROUGH_MAX`]).
fn supervise(notify_fd: OwnedFd, stop: OwnedFd, tx: &SyncSender<io::Result<Observed>>) {
    let mut source = FdSource::new(notify_fd, stop);
    let observed = supervisor::observe(&mut source);
    let still_running = matches!(&observed, Ok(o) if o.exit == Exit::Stopped);

    // A closed channel (the caller gave up) is not an error here.
    let _ = tx.send(observed);

    if still_running {
        let mut source = source.until(Instant::now() + PASSTHROUGH_MAX);

        let _ = supervisor::passthrough(&mut source);
    }
}

/// Waits for the supervisor's result. The channel is the source of truth: a
/// supervisor that panicked, died, or does not stop is an error — never an
/// empty list of accesses, which a caching consumer would read as "this task
/// read nothing".
///
/// Waits up to `grace` for a result, then signals `cancel` and waits up to
/// `stop_bound` more.
fn await_supervisor(
    rx: &Receiver<io::Result<Observed>>,
    cancel: &CancelPipe,
    grace: Duration,
    stop_bound: Duration,
) -> io::Result<Observed> {
    match rx.recv_timeout(grace) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            // Grace elapsed with a descendant still alive. Wake every consumer (the
            // supervisor's poll and both stdio drains share this pipe).
            cancel.signal();

            match rx.recv_timeout(stop_bound) {
                Ok(result) => result,
                Err(RecvTimeoutError::Timeout) => {
                    Err(io::Error::new(io::ErrorKind::TimedOut, "fspy supervisor did not stop after cancel"))
                }
                Err(RecvTimeoutError::Disconnected) => Err(supervisor_died()),
            }
        }
        Err(RecvTimeoutError::Disconnected) => Err(supervisor_died()),
    }
}

fn supervisor_died() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "fspy supervisor thread ended without reporting a result")
}

/// A self-pipe whose read end becomes readable once [`CancelPipe::signal`] is
/// called (or hung up once the pipe is dropped), waking every poller that
/// holds a [`CancelPipe::reader`]. Close-on-exec, so concurrently tracked
/// tasks in one process never inherit each other's pipe. Both ends are owned:
/// they close when the last owner is gone, on every path.
struct CancelPipe {
    read: OwnedFd,
    write: OwnedFd,
}

impl CancelPipe {
    fn new() -> io::Result<Self> {
        let (read, write) = pipe2(OFlag::O_CLOEXEC).map_err(to_io)?;

        Ok(Self { read, write })
    }

    /// An independent handle on the read end for one thread to own.
    fn reader(&self) -> io::Result<OwnedFd> {
        self.read.try_clone()
    }

    /// Best-effort one-byte write to wake every `poll` watching the pipe.
    fn signal(&self) {
        let _ = nix::unistd::write(&self.write, &[1_u8]);
    }
}

/// Spawns the thread that drains one captured stdio stream (an absent stream drains to nothing).
fn spawn_drain<R: Read + AsRawFd + Send + 'static>(
    name: &str,
    stream: Option<R>,
    stop: OwnedFd,
) -> io::Result<JoinHandle<Vec<u8>>> {
    thread::Builder::new().name(name.into()).spawn(move || stream.map(|s| drain_bounded(s, &stop)).unwrap_or_default())
}

/// Read `reader` to EOF, but stop early once `cancel` becomes readable.
/// Used for the captured stdout/stderr so a descendant that inherited (and
/// keeps open) the pipe can't block the drain on EOF forever. On cancel the
/// bytes read so far are returned; errors are swallowed (partial output beats
/// a hung run).
fn drain_bounded<R: Read + AsRawFd>(mut reader: R, cancel: &OwnedFd) -> Vec<u8> {
    let raw = reader.as_raw_fd();
    let cancel_fd = cancel.as_raw_fd();

    // Non-blocking so `read` returns WouldBlock rather than parking if poll
    // raced us or reports POLLHUP without pending data.
    //
    // SAFETY: plain `fcntl` calls on `raw`, which `reader` keeps open.
    unsafe {
        let flags = libc::fcntl(raw, libc::F_GETFL);
        if flags >= 0 {
            libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }

    let mut buf = Vec::new();
    let mut chunk = [0_u8; 8192];

    loop {
        let mut fds = [
            libc::pollfd { fd: raw, events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: cancel_fd, events: libc::POLLIN, revents: 0 },
        ];

        // SAFETY: `fds` is a live array of two `pollfd` and the count passed is its length.
        let prc = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, POLL_FOREVER) };

        if prc < 0 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }

            break;
        }

        // Always prefer draining pending stdout/stderr before honoring cancel:
        // a fast command (`echo hello`) exits and we signal the cancel pipe almost
        // immediately, so the pipe data and the cancel byte race. Reading the
        // pipe first means a racing cancel can't drop already-buffered output.
        if fds[0].revents != 0 {
            match reader.read(&mut chunk) {
                Ok(0) => break, // EOF: all writers closed the pipe.
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);

                    continue;
                }
                // Nothing pending right now (POLLHUP without data, or a raced
                // poll); fall through to the cancel check below.
                Err(ref e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => {}
                Err(_) => break,
            }
        }

        // Cancelled and no more pending pipe data: a lingering descendant that
        // inherited the pipe is keeping it open past the main child's exit.
        // Sweep any last immediately-available bytes (non-blocking) so we don't
        // truncate output, then stop instead of blocking on an EOF that may
        // never come.
        if fds[1].revents != 0 {
            loop {
                match reader.read(&mut chunk) {
                    Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                    _ => break,
                }
            }

            break;
        }
    }

    buf
}

fn mk_socket_path() -> PathBuf {
    let pid = std::process::id();
    // Counter for the rare case of N trackers in the same process
    // within the same nanosecond — pid alone isn't unique enough.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("fspy-{pid}-{seq}.sock"))
}

struct SocketCleanup(PathBuf);
impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Bind a Unix-stream listener at `path`. Unlinks any stale file
/// at the same path first — a previous crashed run sharing our pid
/// could otherwise make `bind` fail with `EADDRINUSE`. Path-length
/// bounds checking is done by `UnixAddr::new`.
fn bind_listener(path: &Path) -> io::Result<OwnedFd> {
    // Best-effort unlink. If the file doesn't exist (the normal
    // case) we get ENOENT and ignore it. Any other error will surface
    // again from bind() with a more useful message.
    let _ = std::fs::remove_file(path);

    let fd = socket(AddressFamily::Unix, SockType::Stream, SockFlag::SOCK_CLOEXEC, None).map_err(to_io)?;

    let addr = UnixAddr::new(path).map_err(to_io)?;
    bind(fd.as_raw_fd(), &addr).map_err(to_io)?;
    listen(&fd, Backlog::new(1).unwrap()).map_err(to_io)?;

    Ok(fd)
}

/// Accept the helper's connection and receive the seccomp notify fd
/// via `SCM_RIGHTS`. Polls the listener with the helper's exit as a
/// watchdog: if the helper dies before connecting we surface the
/// failure instead of hanging in `accept` forever.
fn accept_and_recv_fd(listener: &OwnedFd, guard: &mut ChildGuard) -> io::Result<OwnedFd> {
    // Total time we'll wait for the helper to do prctl + seccomp_load
    // + connect. Generous enough for a slow/cold CI box.
    const ACCEPT_DEADLINE: Duration = Duration::from_secs(5);
    // Poll in short ticks and re-check the helper's liveness each one.
    // A single 5s poll would block the full timeout when the helper
    // dies at seccomp_load (common in sandboxes that disallow the
    // user-notif filter) — it exits *before* connecting, so the
    // listener never becomes readable. Ticking lets us notice the
    // exit within ~one tick and fail fast so the caller can fall back
    // to strace / no-tracking instead of hanging.
    let tick = PollTimeout::from(100u16);
    let mut poll_fds = [PollFd::new(listener.as_fd(), PollFlags::POLLIN)];
    let start = Instant::now();

    loop {
        match poll(&mut poll_fds, tick) {
            Ok(0) => {
                // Tick elapsed with no connection. If the helper has
                // exited, surface that immediately (it failed before
                // the handshake — e.g. seccomp_load denied).
                if let Some(status) = guard.try_check_exit()? {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        format!("fspy helper exited before connecting (status: {status:?})"),
                    ));
                }

                if start.elapsed() >= ACCEPT_DEADLINE {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("fspy helper did not connect within {}s", ACCEPT_DEADLINE.as_secs()),
                    ));
                }

                continue;
            }
            Ok(_) => break,
            Err(nix::errno::Errno::EINTR) => continue,
            Err(e) => return Err(to_io(e)),
        }
    }

    // Close-on-exec: another tracked task spawning concurrently must not inherit
    // this connection.
    let conn = accept4(listener.as_raw_fd(), SockFlag::SOCK_CLOEXEC).map_err(to_io)?;
    // SAFETY: accept4 returns an owned fd on success.
    let conn_owned = unsafe { OwnedFd::from_raw_fd(conn) };

    // recvmsg with a single SCM_RIGHTS-sized cmsg buffer. nix
    // handles the buffer alignment + cmsg framing for us — the
    // cmsg_space! macro sizes it correctly for one RawFd payload.
    let mut iov_buf = [0u8; 1];
    let mut iov = [IoSliceMut::new(&mut iov_buf)];
    let mut cmsg = cmsg_space!(RawFd);

    // MSG_CMSG_CLOEXEC: the received listener fd must be close-on-exec, or a helper
    // or child spawned meanwhile by another tracked task in this process inherits
    // it and keeps this run's listener alive after we close it.
    let msg: nix::sys::socket::RecvMsg<'_, '_, ()> =
        recvmsg(conn_owned.as_raw_fd(), &mut iov, Some(&mut cmsg), MsgFlags::MSG_CMSG_CLOEXEC).map_err(to_io)?;

    if msg.bytes == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "helper closed connection before sending notify fd"));
    }

    let mut received = None;

    for cmsg in msg.cmsgs().map_err(to_io)? {
        if let ControlMessageOwned::ScmRights(fds) = cmsg {
            for fd in fds {
                // SAFETY: SCM_RIGHTS installed `fd` in our table; nothing else owns it.
                let fd = unsafe { OwnedFd::from_raw_fd(fd) };

                // Keep the first; any extra is closed by the drop.
                received.get_or_insert(fd);
            }
        }
    }

    if let Some(fd) = received {
        return Ok(fd);
    }

    Err(io::Error::new(io::ErrorKind::InvalidData, "no SCM_RIGHTS fd in helper's message"))
}

fn to_io(e: nix::errno::Errno) -> io::Error {
    io::Error::from_raw_os_error(e as i32)
}

/// RAII guard that kills + reaps a helper child unless the caller got to
/// reap it itself. Owns the child for the whole run, so every early return
/// between `Command::spawn` and the final wait leaves no orphaned helper (and
/// no target the helper had exec'd) behind.
struct ChildGuard {
    child: Child,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child }
    }

    fn child(&self) -> &Child {
        &self.child
    }

    fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    fn try_check_exit(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    /// Best-effort kill, for when waiting on the child itself failed.
    fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        // Both are no-ops on a child that was already waited on.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::sync_channel;

    use super::*;

    fn observed(exit: Exit) -> Observed {
        Observed { accesses: Vec::new(), incomplete: false, exit }
    }

    const SHORT: Duration = Duration::from_millis(80);

    fn readable(fd: &OwnedFd) -> bool {
        let mut fds = [PollFd::new(fd.as_fd(), PollFlags::POLLIN)];

        poll(&mut fds, PollTimeout::ZERO).unwrap() > 0
    }

    #[test]
    fn a_result_within_the_grace_window_is_returned_without_cancelling() {
        let (tx, rx) = sync_channel(1);
        let cancel = CancelPipe::new().unwrap();
        let reader = cancel.reader().unwrap();

        tx.send(Ok(observed(Exit::Drained))).unwrap();

        let got = await_supervisor(&rx, &cancel, SHORT, SHORT).unwrap();

        assert_eq!(got.exit, Exit::Drained);
        assert!(!readable(&reader), "the run was not cancelled");
    }

    #[test]
    fn a_supervisor_error_is_passed_on() {
        let (tx, rx) = sync_channel(1);
        let cancel = CancelPipe::new().unwrap();

        tx.send(Err(io::Error::from_raw_os_error(libc::EBADF))).unwrap();

        assert_eq!(await_supervisor(&rx, &cancel, SHORT, SHORT).unwrap_err().raw_os_error(), Some(libc::EBADF));
    }

    #[test]
    fn a_supervisor_that_answers_the_cancel_delivers_its_result() {
        let (tx, rx) = sync_channel(1);
        let cancel = CancelPipe::new().unwrap();
        let reader = cancel.reader().unwrap();

        // Stands in for a supervisor that only reports after it is cancelled.
        let thread = thread::spawn(move || {
            let mut fds = [PollFd::new(reader.as_fd(), PollFlags::POLLIN)];

            poll(&mut fds, PollTimeout::NONE).unwrap();
            tx.send(Ok(observed(Exit::Stopped))).unwrap();
        });

        let got = await_supervisor(&rx, &cancel, SHORT, Duration::from_secs(5)).unwrap();

        assert_eq!(got.exit, Exit::Stopped);
        thread.join().unwrap();
    }

    #[test]
    fn a_wedged_supervisor_is_an_error_after_the_bound_not_a_hang() {
        // The wait after the cancel is bounded: a supervisor stuck in the kernel must not
        // leave the whole task (and the Node promise) pending forever.
        let (tx, rx) = sync_channel::<io::Result<Observed>>(1);
        let cancel = CancelPipe::new().unwrap();
        let reader = cancel.reader().unwrap();
        let started = Instant::now();

        let err = await_supervisor(&rx, &cancel, SHORT, SHORT).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(readable(&reader), "the cancel was signalled before giving up");
        drop(tx);
    }

    #[test]
    fn a_supervisor_that_panicked_is_an_error_not_an_empty_result() {
        let (tx, rx) = sync_channel::<io::Result<Observed>>(1);
        let cancel = CancelPipe::new().unwrap();

        let _ = thread::spawn(move || {
            let _hold = tx;

            panic!("supervisor bug");
        })
        .join();

        let err = await_supervisor(&rx, &cancel, SHORT, SHORT).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn the_cancel_pipe_is_close_on_exec_and_signals_every_reader() {
        let cancel = CancelPipe::new().unwrap();
        let a = cancel.reader().unwrap();
        let b = cancel.reader().unwrap();

        for fd in [&cancel.read, &cancel.write, &a, &b] {
            // SAFETY: F_GETFD on an open fd.
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };

            assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0, "every end must be close-on-exec");
        }

        assert!(!readable(&a));
        cancel.signal();
        assert!(readable(&a) && readable(&b));
    }

    #[test]
    fn dropping_the_guard_kills_and_reaps_the_child() {
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;

        drop(ChildGuard::new(child));

        // Reaped: the pid is gone, not a zombie.
        // SAFETY: signal 0 only probes for existence.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
}
