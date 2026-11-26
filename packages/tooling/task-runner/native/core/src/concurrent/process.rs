use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::events::EventSink;
use super::process_group;
use super::types::{ConcurrentCloseEvent, ConcurrentCommandConfig, KillSignal, ProcessEvent, StdinMode};

/// Spawn a child process and stream its output.
///
/// SAFETY: Commands executed here originate from package.json scripts,
/// not from untrusted user input. Shell execution is required to support
/// shell features (pipes, redirects, env expansion) that package scripts rely on.
///
/// This function spawns the process, starts async tasks for reading stdout/stderr,
/// and spawns a task that waits for both I/O streams to drain AND the process to
/// exit before sending a `CompletionMessage` on the provided channel.
/// This guarantees all stdout/stderr events arrive before the close event.
pub(crate) fn spawn_process(
    index: u32,
    config: &ConcurrentCommandConfig,
    sink: &EventSink,
    completion_tx: mpsc::UnboundedSender<CompletionMessage>,
    shell_path: Option<&str>,
    giving_up: &Arc<AtomicBool>,
) -> Result<ProcessInfo, std::io::Error> {
    if config.stdin == StdinMode::Pty {
        return super::pty::spawn_pty(index, config, sink, completion_tx, shell_path, giving_up);
    }

    let (mut child, streams) = start(config, shell_path)?;
    let start_time = Instant::now();

    let pid = child.id();

    // Surface the pid to the consumer before any output streams,
    // so JS-side signal handlers can register the child for cleanup
    // before it has a chance to emit anything.
    sink.send(ProcessEvent::Started { index, pid });

    // Readers that wait for the consumer (see `EventSink`) report it here, so the drain grace
    // below does not mistake a slow consumer for a descendant that holds the pipes.
    let parked = Arc::new(AtomicUsize::new(0));
    let output = sink.counting_parked(Arc::clone(&parked));
    let giving_up = Arc::clone(giving_up);

    // Spawn stdout reader -- returns JoinHandle so we can wait for it
    let mut stdout_handle: Option<JoinHandle<()>> =
        streams.stdout.map(|stdout| tokio::spawn(stream_output(stdout, output.clone(), index, false)));

    // Spawn stderr reader -- returns JoinHandle so we can wait for it
    let mut stderr_handle: Option<JoinHandle<()>> =
        streams.stderr.map(|stderr| tokio::spawn(stream_output(stderr, output.clone(), index, true)));

    // The child's stdin goes to a task of its own: `Child::wait` would drop it, which the child
    // sees as EOF, and a write to a child that is not reading must never block the runner.
    let input = streams.stdin.map(InputHandle::pipe);

    // Shared flag the runner's force-kill timer checks before issuing
    // SIGKILL. Without it, a kill_timeout of 5s is plenty of room for
    // the child to exit cleanly AND for the kernel to recycle the PID
    // for an unrelated process, which the timer would then SIGKILL.
    let terminated = Arc::new(AtomicBool::new(false));
    let terminated_completion = Arc::clone(&terminated);

    // Spawn completion waiter -- waits for BOTH I/O drain AND process exit
    // This ensures all stdout/stderr events arrive before the close event.
    let command_str = config.command.clone();
    let name = config.name.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        let duration = start_time.elapsed();
        let duration_ms = duration.as_secs_f64() * 1000.0;

        // Wait for the stdout/stderr readers to finish draining, but only for
        // a grace period. A descendant that outlives the child (`server &`, a
        // leaked worker) keeps the inherited pipes open, and waiting for EOF
        // would hold the run open for as long as it lives.
        let drained = drain_within_grace(
            async {
                if let Some(handle) = stdout_handle.as_mut() {
                    let _ = handle.await;
                }
                if let Some(handle) = stderr_handle.as_mut() {
                    let _ = handle.await;
                }
            },
            &parked,
            &giving_up,
        )
        .await;

        if !drained {
            // Reap the group and drop the readers so nothing keeps the pipes alive.
            if let Some(pid) = pid {
                let _ = process_group::kill_tree(pid, KillSignal::Kill);
            }
            for handle in [&stdout_handle, &stderr_handle].into_iter().flatten() {
                handle.abort();
            }
        }

        let (exit_code, signalled) = match status {
            Ok(s) => exit_code_of(s),
            Err(_) => (-1, false),
        };

        // Mark this process as terminated *before* we send the completion
        // message. The force-kill timer reads this flag with Acquire
        // ordering and skips pids that have already exited, eliminating
        // the PID-recycling race window.
        terminated_completion.store(true, Ordering::Release);

        let close_event = ConcurrentCloseEvent {
            index,
            command: command_str,
            name,
            exit_code,
            killed: signalled, // The runner also sets it when it aborts the run.
            duration_ms,
        };

        let _ = completion_tx.send(CompletionMessage { index, close_event });
    });

    // Windows: create Job Object and assign the child process for tree killing.
    //
    // KNOWN LIMITATION: the child is already running by the time we
    // create + assign the Job Object. A wrapper that immediately
    // re-`exec`s another binary (very common with `cmd.exe /s /c`)
    // can fork a grandchild *before* AssignProcessToJobObject runs;
    // that grandchild is outside the Job and so isn't terminated by
    // `TerminateJobObject` or by `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
    // The correct fix is `CreateProcessW(CREATE_SUSPENDED)` → assign
    // → `ResumeThread`, which requires bypassing tokio's `Command`
    // and using raw Win32 (tokio doesn't expose the primary thread
    // handle). Deferred until we have a Windows test runtime to
    // validate against; the `kill_on_drop(true)` + Job Object combo
    // covers the common case, and the wider blast radius is bounded
    // by Job Object cleanup on process exit.
    #[cfg(windows)]
    let job = {
        let job = process_group::JobObject::new().ok();
        if let (Some(ref j), Some(p)) = (&job, pid) {
            let _ = j.assign_process_by_pid(p);
        }
        job
    };

    Ok(ProcessInfo {
        index,
        pid,
        terminated,
        input,
        pty: None,
        #[cfg(windows)]
        job,
    })
}

/// A started command, whichever way it was started.
enum Running {
    Tokio(tokio::process::Child),
    #[cfg(target_os = "macos")]
    Posix(super::posix_spawn::Child),
}

impl Running {
    fn id(&self) -> Option<u32> {
        match self {
            Self::Tokio(child) => child.id(),
            #[cfg(target_os = "macos")]
            Self::Posix(child) => Some(child.id()),
        }
    }

    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        match self {
            Self::Tokio(child) => child.wait().await,
            #[cfg(target_os = "macos")]
            Self::Posix(child) => child.wait().await,
        }
    }
}

/// The parent's ends of a started command's pipes.
struct Streams {
    stdin: Option<Box<dyn AsyncWrite + Send + Unpin>>,
    stdout: Option<Box<dyn AsyncRead + Send + Unpin>>,
    stderr: Option<Box<dyn AsyncRead + Send + Unpin>>,
}

/// Start the process for `config` in a session of its own, with its output piped.
///
/// macOS starts it with `posix_spawn` (see `posix_spawn`): the `fork` that the standard library
/// needs to run a `setsid` hook costs milliseconds per command there. Everywhere else, and where
/// `posix_spawn` cannot be used, the standard library's own `Command` is used.
fn start(config: &ConcurrentCommandConfig, shell_path: Option<&str>) -> Result<(Running, Streams), std::io::Error> {
    #[cfg(target_os = "macos")]
    if super::posix_spawn::available() {
        let (program, args) = launch_parts(config, shell_path, false);
        let args: Vec<String> = args.into_iter().map(ShellArg::into_string).collect();
        let (child, pipes) = super::posix_spawn::spawn(&program, &args, config)?;
        let streams = Streams {
            stdin: pipes.stdin.map(|stdin| Box::new(stdin) as Box<dyn AsyncWrite + Send + Unpin>),
            stdout: Some(Box::new(pipes.stdout)),
            stderr: Some(Box::new(pipes.stderr)),
        };

        return Ok((Running::Posix(child), streams));
    }

    let mut cmd = build_command(config, shell_path);
    // If the runtime is torn down mid-run (Node shutdown), its task tree is
    // dropped: the completion-waiter task is aborted and the owned `Child` is
    // dropped. With the default `kill_on_drop = false` that would leave the
    // OS-level process running as an orphan re-parented to PID 1. Force-killing
    // on drop ensures the JS side can never abandon spawned children.
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn()?;
    let streams = Streams {
        stdin: child.stdin.take().map(|stdin| Box::new(stdin) as Box<dyn AsyncWrite + Send + Unpin>),
        stdout: child.stdout.take().map(|stdout| Box::new(stdout) as Box<dyn AsyncRead + Send + Unpin>),
        stderr: child.stderr.take().map(|stderr| Box::new(stderr) as Box<dyn AsyncRead + Send + Unpin>),
    };

    Ok((Running::Tokio(child), streams))
}

/// Wait for `drain` (the readers reaching EOF) for at most `STDIO_DRAIN_GRACE` of the time they
/// spend waiting on the pipe. False when the grace ran out: something still holds the pipes open.
///
/// A reader that is parked waiting for the consumer is not waiting on the pipe, so the clock
/// restarts for as long as one is. Without that, a consumer slower than the grace would have its
/// output cut off. Once the run is being torn down (`giving_up`) the output has no reader to wait
/// for, and the plain grace applies, so an abort never waits for a consumer that has stalled.
pub(crate) async fn drain_within_grace(
    drain: impl std::future::Future<Output = ()>,
    parked: &AtomicUsize,
    giving_up: &AtomicBool,
) -> bool {
    tokio::pin!(drain);

    loop {
        match timeout(STDIO_DRAIN_GRACE, &mut drain).await {
            Ok(()) => return true,
            Err(_) if parked.load(Ordering::Acquire) > 0 && !giving_up.load(Ordering::Acquire) => continue,
            Err(_) => return false,
        }
    }
}

/// Where bytes for a running command's stdin are queued.
///
/// The bytes are written by a task (or thread) of their own, so the runner never waits for a
/// child that is not reading. Dropping the handle ends the writer, which closes the child's stdin.
pub(crate) struct InputHandle {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Stops a pipe writer that is blocked on a child that never reads.
    task: Option<JoinHandle<()>>,
}

impl InputHandle {
    fn pipe(mut stdin: Box<dyn AsyncWrite + Send + Unpin>) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let task = tokio::spawn(async move {
            while let Some(data) = rx.recv().await {
                if stdin.write_all(&data).await.is_err() {
                    break;
                }
            }
        });

        Self { tx, task: Some(task) }
    }

    /// Wrap a sender whose receiving end is owned by a writer thread.
    pub(crate) fn from_sender(tx: mpsc::UnboundedSender<Vec<u8>>) -> Self {
        Self { tx, task: None }
    }

    /// Queue `data` for the child. False when the writer has already gone.
    pub(crate) fn write(&self, data: Vec<u8>) -> bool {
        self.tx.send(data).is_ok()
    }
}

impl Drop for InputHandle {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Message sent when a process completes (after all I/O is drained).
pub(crate) struct CompletionMessage {
    pub(crate) index: u32,
    pub(crate) close_event: ConcurrentCloseEvent,
}

/// Info about a spawned process (for tracking/killing).
pub(crate) struct ProcessInfo {
    pub(crate) index: u32,
    pub(crate) pid: Option<u32>,
    /// Set to `true` by the completion waiter once the child has exited
    /// and its event has been dispatched. The force-kill timer checks
    /// this with Acquire ordering before issuing SIGKILL so it can't
    /// hit a PID the kernel has already recycled for another process.
    pub(crate) terminated: Arc<AtomicBool>,
    /// The command's stdin, when it is a pipe or a pty.
    pub(crate) input: Option<InputHandle>,
    /// The command's terminal, when it runs in a pty.
    pub(crate) pty: Option<super::pty::PtyControl>,
    /// Windows: Job Object that owns the process tree.
    /// When terminated or dropped, kills all child processes.
    #[cfg(windows)]
    pub(crate) job: Option<process_group::JobObject>,
}

/// Idle interval after which a partial (non-newline-terminated) line is
/// flushed as its own event. Mirrors the JS fallback's 100ms flush timer
/// so spinners, progress bars, and interactive prompts surface promptly
/// instead of being withheld until the next `\n` or process exit (EOF).
const PARTIAL_FLUSH: Duration = Duration::from_millis(100);

/// How long to wait after a child exits for its stdout/stderr pipes to reach
/// EOF before giving up on them.
pub(crate) const STDIO_DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Exit code of a finished child and whether a signal ended it. A signalled
/// child reports `128 + signal`, the shell convention, so callers see 137 or 143
/// regardless of which spawner ran it.
#[cfg(unix)]
fn exit_code_of(status: std::process::ExitStatus) -> (i32, bool) {
    use std::os::unix::process::ExitStatusExt;

    match (status.code(), status.signal()) {
        (Some(code), _) => (code, false),
        (None, Some(signal)) => (128 + signal, true),
        (None, None) => (-1, false),
    }
}

#[cfg(windows)]
fn exit_code_of(status: std::process::ExitStatus) -> (i32, bool) {
    (status.code().unwrap_or(-1), false)
}

/// Longest line the reader buffers before emitting it as its own event.
const MAX_LINE_BYTES: usize = 1 << 20;

/// Read size for a single `read()`: the 64 KiB a Node stream reads at a time, so a burst of output
/// is a few reads and a few wake-ups, not one per 8 KiB. The buffer lives on the heap, once per reader.
const READ_CHUNK: usize = 65536;

/// Strip a single trailing `\r` so Windows CRLF endings don't leak a
/// carriage return into the emitted text. Matches the JS fallback's
/// `/\r$/` replace (one trailing `\r`, not all of them).
fn strip_trailing_cr(line: &[u8]) -> String {
    let end = if line.last() == Some(&b'\r') { line.len() - 1 } else { line.len() };

    lossy_string(&line[..end])
}

/// `bytes` as an owned string, invalid sequences replaced by U+FFFD. `from_utf8` checks a valid
/// line (the usual case) far faster than the char-by-char walk `from_utf8_lossy` does.
fn lossy_string(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Emit the longest valid-UTF-8 prefix of a line that reached the cap, keeping an
/// incomplete trailing sequence for the next event so no character is split.
fn take_capped_prefix(pending: &mut Vec<u8>) -> String {
    let cut = match std::str::from_utf8(pending) {
        Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 => error.valid_up_to(),
        _ => pending.len(),
    };
    let text = String::from_utf8_lossy(&pending[..cut]).into_owned();

    pending.drain(..cut);

    text
}

/// Stream a child's stdout/stderr to `tx`, emitting one event per `\n`-
/// terminated line AND flushing any partial line after `PARTIAL_FLUSH` of
/// idle time (or at EOF). Unlike `BufReader::lines()` / `next_line()`,
/// which only yields on a newline or EOF, this surfaces spinner/progress/
/// prompt output that a long-running process emits without a trailing
/// newline. `is_stderr` selects the event variant; otherwise the two
/// streams are handled identically.
///
/// Only the newly read bytes are scanned for a newline, and a line without one
/// is emitted in pieces of at most `MAX_LINE_BYTES`, so memory and time stay
/// linear in the output however long a line is.
async fn stream_output<R>(mut reader: R, sink: EventSink, index: u32, is_stderr: bool)
where
    R: AsyncRead + Unpin,
{
    let event = |text: String| {
        if is_stderr {
            ProcessEvent::Stderr { index, text }
        } else {
            ProcessEvent::Stdout { index, text }
        }
    };

    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    // Lines completed by the last read, sent once it has been fully scanned.
    let mut lines: Vec<String> = Vec::new();

    loop {
        // With a partial line buffered, bound the read so an idle stream
        // still flushes it; with nothing pending, block until more data.
        let read = if pending.is_empty() {
            reader.read(&mut chunk).await
        } else {
            match timeout(PARTIAL_FLUSH, reader.read(&mut chunk)).await {
                Ok(result) => result,
                Err(_) => {
                    lines.push(strip_trailing_cr(&pending));
                    pending.clear();
                    send_lines(&sink, &mut lines, &event).await;
                    continue;
                }
            }
        };

        match read {
            // EOF or read error: flush any trailing partial line, then stop.
            Ok(0) | Err(_) => {
                if !pending.is_empty() {
                    lines.push(strip_trailing_cr(&pending));
                }

                send_lines(&sink, &mut lines, &event).await;

                break;
            }
            Ok(n) => {
                let mut rest = &chunk[..n];

                while let Some(position) = memchr::memchr(b'\n', rest) {
                    if pending.is_empty() && position <= MAX_LINE_BYTES {
                        // The whole line is in this read: no need to stage it in `pending`.
                        lines.push(strip_trailing_cr(&rest[..position]));
                    } else {
                        append_capped(&mut pending, &rest[..position], &mut lines);
                        lines.push(strip_trailing_cr(&pending));
                        pending.clear();
                    }

                    rest = &rest[position + 1..];
                }

                append_capped(&mut pending, rest, &mut lines);

                // The reader stops here while the consumer is behind, which stops it reading the
                // pipe, which makes the child block on its next write.
                if !send_lines(&sink, &mut lines, &event).await {
                    break;
                }
            }
        }
    }
}

/// Send the completed lines in order. False when the stream was closed and the reader should stop.
async fn send_lines(sink: &EventSink, lines: &mut Vec<String>, event: &impl Fn(String) -> ProcessEvent) -> bool {
    if lines.is_empty() {
        return true;
    }

    sink.send_output_many(lines.drain(..).map(event).collect()).await
}

/// Append `bytes` to the pending line, completing the buffered part first whenever
/// it is already at the cap and more of the same line follows.
fn append_capped(pending: &mut Vec<u8>, mut bytes: &[u8], completed: &mut Vec<String>) {
    while !bytes.is_empty() {
        if pending.len() >= MAX_LINE_BYTES {
            completed.push(take_capped_prefix(pending));
        }

        let take = (MAX_LINE_BYTES - pending.len()).min(bytes.len());

        pending.extend_from_slice(&bytes[..take]);
        bytes = &bytes[take..];
    }
}

/// Build a tokio Command configured for execution.
///
/// When `shell` is true (default), wraps the command in a shell invocation.
/// When `shell` is false, splits the command string and executes directly.
/// If `shell_path` is provided, it overrides the platform default shell.
/// Commands are sourced from package.json scripts (trusted input).
fn build_command(config: &ConcurrentCommandConfig, shell_path: Option<&str>) -> Command {
    let (program, args) = launch_parts(config, shell_path, cfg!(windows));

    let mut cmd = Command::new(&program);
    for arg in args {
        match arg {
            ShellArg::Plain(value) => {
                cmd.arg(value);
            }
            // `Raw` only comes out of the Windows branch of `shell_invocation`.
            #[cfg(windows)]
            ShellArg::Raw(value) => {
                cmd.raw_arg(value);
            }
            #[cfg(not(windows))]
            ShellArg::Raw(value) => {
                cmd.arg(value);
            }
        }
    }

    if let Some(ref cwd) = config.cwd {
        cmd.current_dir(cwd);
    }

    // The child inherits this process's environment unless the caller opted out; then the
    // overlay is all it gets. Colour (`FORCE_COLOR`) is the caller's decision, already in the overlay.
    if config.inherit_env == Some(false) {
        cmd.env_clear();
    }

    if let Some(ref env) = config.env {
        cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }

    // Pipe stdout/stderr for capture
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    cmd.stdin(match config.stdin {
        StdinMode::Pipe => std::process::Stdio::piped(),
        StdinMode::Inherit => std::process::Stdio::inherit(),
        StdinMode::Null | StdinMode::Pty => std::process::Stdio::null(),
    });

    // Unix: create new process group via setsid
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| process_group::pre_exec_setsid());
    }

    // Windows: create the child as the leader of a new process group so
    // we can later target it with `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)`
    // for graceful shutdown without also signalling our own console.
    //
    // Note: tokio's `creation_flags` always ORs `CREATE_UNICODE_ENVIRONMENT`
    // into the final flag set, so we don't lose unicode env support by
    // setting only `CREATE_NEW_PROCESS_GROUP` here.
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    cmd
}

/// The program and arguments that run `config.command`: through a shell by default, or split
/// on whitespace and run directly when `shell` is false.
fn launch_parts(config: &ConcurrentCommandConfig, shell_path: Option<&str>, windows: bool) -> (String, Vec<ShellArg>) {
    if config.shell.unwrap_or(true) {
        shell_invocation(&config.command, shell_path, windows)
    } else {
        let (program, args) = direct_command(&config.command);

        (program, args.into_iter().map(ShellArg::Plain).collect())
    }
}

/// One argument of a shell invocation.
#[derive(Debug, PartialEq, Eq)]
enum ShellArg {
    /// Passed through the platform's normal argument quoting.
    Plain(String),
    /// Appended to the Windows command line exactly as given. `cmd.exe` does not
    /// undo the `\"` escaping Rust applies to a normal argument, so a command
    /// containing quotes has to be quoted by hand.
    Raw(String),
}

impl ShellArg {
    #[cfg(target_os = "macos")]
    fn into_string(self) -> String {
        match self {
            Self::Plain(value) | Self::Raw(value) => value,
        }
    }
}

/// Whether `shell` names `cmd.exe`, with or without the extension and on either
/// path separator.
pub(crate) fn is_cmd_exe(shell: &str) -> bool {
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell).to_ascii_lowercase();

    name == "cmd" || name == "cmd.exe"
}

/// Build the program and arguments that run `command` through a shell.
///
/// `windows` selects the Windows rules; it is a parameter so the command line
/// can be unit-tested on any host. With `shell_path` set, that shell is used
/// with a POSIX-style `-c`, unless it is `cmd.exe` on Windows. Otherwise the
/// platform default (`/bin/sh`, or `cmd.exe` on Windows) is used.
///
/// Commands originate from package.json scripts (trusted).
fn shell_invocation(command: &str, shell_path: Option<&str>, windows: bool) -> (String, Vec<ShellArg>) {
    // `cmd.exe /d /s /c "<command>"`, the form Node's `shell: true` builds: `/s`
    // strips exactly one pair of outer quotes, so inner quotes survive.
    let cmd_exe = |program: &str| (program.to_string(), vec![ShellArg::Raw(format!("/d /s /c \"{command}\""))]);

    match shell_path {
        Some(custom) if windows && is_cmd_exe(custom) => cmd_exe(custom),
        Some(custom) => {
            (custom.to_string(), vec![ShellArg::Plain("-c".to_string()), ShellArg::Plain(command.to_string())])
        }
        None if windows => cmd_exe("cmd.exe"),
        None => ("/bin/sh".to_string(), vec![ShellArg::Plain("-c".to_string()), ShellArg::Plain(command.to_string())]),
    }
}

/// Split a command string into program + arguments for direct execution (no shell).
fn direct_command(command: &str) -> (String, Vec<String>) {
    let mut parts = command.split_whitespace();
    let program = parts.next().unwrap_or("").to_string();
    let args: Vec<String> = parts.map(|s| s.to_string()).collect();
    (program, args)
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncWriteExt;
    use tokio::sync::mpsc;
    use tokio::time::{timeout, Duration};

    use super::{stream_output, ShellArg};
    use crate::concurrent::types::ProcessEvent;

    /// Receive the next event's text within `within`, or `None` on timeout/close.
    async fn next_text(rx: &mut mpsc::UnboundedReceiver<ProcessEvent>, within: Duration) -> Option<String> {
        match timeout(within, rx.recv()).await {
            Ok(Some(ProcessEvent::Stdout { text, .. } | ProcessEvent::Stderr { text, .. })) => Some(text),
            _ => None,
        }
    }

    fn text_of(event: ProcessEvent) -> String {
        match event {
            ProcessEvent::Stdout { text, .. } | ProcessEvent::Stderr { text, .. } => text,
            other => panic!("expected an output event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn emits_one_event_per_newline_terminated_line() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(stream_output(reader, tx.into(), 0, false));

        writer.write_all(b"line1\nline2\n").await.unwrap();

        assert_eq!(next_text(&mut rx, Duration::from_secs(1)).await.as_deref(), Some("line1"));
        assert_eq!(next_text(&mut rx, Duration::from_secs(1)).await.as_deref(), Some("line2"));

        drop(writer); // EOF lets the reader task finish.
        handle.await.unwrap();
    }

    /// The regression guard: a partial line with no trailing newline and an
    /// OPEN stream (a spinner / progress bar / prompt) must surface via the
    /// idle flush. `BufReader::lines()` / `next_line()` would withhold it
    /// until the next `\n` or EOF — the bug this fix addresses.
    #[tokio::test]
    async fn flushes_partial_line_while_stream_stays_open() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(stream_output(reader, tx.into(), 0, false));

        writer.write_all(b"spinner-frame").await.unwrap();

        // No newline written and `writer` is still open: the only way this
        // arrives is the idle-timeout flush.
        assert_eq!(
            next_text(&mut rx, Duration::from_millis(500)).await.as_deref(),
            Some("spinner-frame"),
            "partial line should flush on idle timeout, not wait for newline/EOF",
        );

        drop(writer);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn flushes_trailing_partial_line_at_eof() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(stream_output(reader, tx.into(), 0, false));

        writer.write_all(b"tail-no-newline").await.unwrap();
        drop(writer); // Immediate EOF.

        assert_eq!(next_text(&mut rx, Duration::from_secs(1)).await.as_deref(), Some("tail-no-newline"));
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn strips_single_trailing_carriage_return() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(stream_output(reader, tx.into(), 0, false));

        writer.write_all(b"crlf-line\r\n").await.unwrap();

        assert_eq!(next_text(&mut rx, Duration::from_secs(1)).await.as_deref(), Some("crlf-line"));

        drop(writer);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn tags_stderr_events_with_kind_and_index() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(stream_output(reader, tx.into(), 7, true));

        writer.write_all(b"err-line\n").await.unwrap();

        let event = timeout(Duration::from_secs(1), rx.recv()).await.unwrap().unwrap();

        assert_eq!(event, ProcessEvent::Stderr { index: 7, text: "err-line".to_string() });

        drop(writer);
        handle.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn scans_a_50_mib_single_line_in_linear_time() {
        let (mut writer, reader) = tokio::io::duplex(1 << 20);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(stream_output(reader, tx.into(), 0, false));

        let start = std::time::Instant::now();
        let chunk = vec![b'x'; 64 * 1024];
        let writer_task = tokio::spawn(async move {
            for _ in 0..(50 * 1024 * 1024 / chunk.len()) {
                writer.write_all(&chunk).await.unwrap();
            }
            // Dropping the writer is the EOF.
        });

        timeout(Duration::from_secs(10), async {
            writer_task.await.unwrap();
            handle.await.unwrap();
        })
        .await
        .expect("a single 50 MiB line must be consumed in linear time");

        assert!(start.elapsed() < Duration::from_secs(2), "took {:?}", start.elapsed());

        let mut total = 0usize;
        while let Ok(event) = rx.try_recv() {
            total += text_of(event).len();
        }
        assert_eq!(total, 50 * 1024 * 1024, "no byte may be lost to the cap");
    }

    #[tokio::test]
    async fn caps_a_line_without_newline_and_delivers_the_rest_as_its_own_event() {
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(stream_output(reader, tx.into(), 0, false));

        let total = 2 * super::MAX_LINE_BYTES + 10;
        let chunk = vec![b'a'; 64 * 1024];
        let mut written = 0;
        while written < total {
            let n = chunk.len().min(total - written);
            writer.write_all(&chunk[..n]).await.unwrap();
            written += n;
        }
        drop(writer);
        handle.await.unwrap();

        let mut lengths = Vec::new();
        while let Ok(event) = rx.try_recv() {
            lengths.push(text_of(event).len());
        }

        assert!(lengths.iter().all(|&l| l <= super::MAX_LINE_BYTES), "every event stays under the cap: {lengths:?}");
        assert_eq!(lengths.iter().sum::<usize>(), total);
        assert!(lengths.len() >= 3);
    }

    #[tokio::test]
    async fn a_200_kb_line_arrives_in_one_piece() {
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(stream_output(reader, tx.into(), 0, false));

        let mut line = vec![b'b'; 200_000];
        line.push(b'\n');
        writer.write_all(&line).await.unwrap();
        drop(writer);
        handle.await.unwrap();

        let event = rx.try_recv().unwrap();
        assert_eq!(text_of(event).len(), 200_000);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn windows_default_shell_gets_a_raw_quoted_command_line() {
        let (program, args) = super::shell_invocation("node -e \"console.log('a b')\"", None, true);

        assert_eq!(program, "cmd.exe");
        assert_eq!(args, vec![ShellArg::Raw("/d /s /c \"node -e \"console.log('a b')\"\"".to_string())]);
    }

    #[test]
    fn windows_cmd_exe_as_custom_shell_is_quoted_the_same_way() {
        for shell in ["C:\\Windows\\System32\\cmd.exe", "cmd", "CMD.EXE", "C:/Windows/System32/cmd.exe"] {
            let (program, args) = super::shell_invocation("echo \"x y\"", Some(shell), true);

            assert_eq!(program, shell);
            assert_eq!(args, vec![ShellArg::Raw("/d /s /c \"echo \"x y\"\"".to_string())]);
        }
    }

    #[test]
    fn a_posix_custom_shell_gets_dash_c_on_every_platform() {
        for windows in [false, true] {
            let (program, args) =
                super::shell_invocation("echo hi", Some("C:\\Program Files\\Git\\bin\\bash.exe"), windows);

            assert_eq!(program, "C:\\Program Files\\Git\\bin\\bash.exe");
            assert_eq!(args, vec![ShellArg::Plain("-c".to_string()), ShellArg::Plain("echo hi".to_string())]);
        }
    }

    #[test]
    fn cmd_exe_is_only_special_on_windows() {
        let (_, args) = super::shell_invocation("echo hi", Some("cmd.exe"), false);

        assert_eq!(args, vec![ShellArg::Plain("-c".to_string()), ShellArg::Plain("echo hi".to_string())]);
    }

    #[test]
    fn unix_default_shell_is_bin_sh() {
        let (program, args) = super::shell_invocation("echo hi", None, false);

        assert_eq!(program, "/bin/sh");
        assert_eq!(args, vec![ShellArg::Plain("-c".to_string()), ShellArg::Plain("echo hi".to_string())]);
    }
}
