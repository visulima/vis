//! Commands that run in a pseudo-terminal (`stdin: "pty"`).
//!
//! The command sees a terminal on all three standard streams, so it colours its output, prompts and
//! draws progress bars the way it would in a user's shell. The terminal merges stdout and stderr,
//! and its output is delivered as raw chunks (`Stdout` events), not lines: escape sequences and
//! carriage returns reach the consumer exactly as written, for a terminal emulator to interpret.
//!
//! The terminal itself comes from `portable-pty` (openpty on Unix, ConPTY on Windows). It only
//! offers blocking reads, writes and waits, so each runs on a thread of its own and reports back
//! through channels the async runner can wait on; the runner's loop never blocks on a terminal.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};

use super::events::EventSink;
use super::process::{drain_within_grace, is_cmd_exe, CompletionMessage, InputHandle, ProcessInfo};
use super::process_group;
use super::types::{ConcurrentCloseEvent, ConcurrentCommandConfig, KillSignal, ProcessEvent, PtySize};

/// Read size for the terminal's output.
const READ_CHUNK: usize = 8192;

/// What the runner can do to a running pty command beyond signalling it.
pub(crate) struct PtyControl {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pid: Option<u32>,
    terminated: Arc<AtomicBool>,
}

impl PtyControl {
    /// Change the terminal's size. The command gets SIGWINCH.
    pub(crate) fn resize(&self, size: PtySize) {
        if let Ok(master) = self.master.lock() {
            let _ = master.resize(portable_size(size));
        }
    }
}

impl Drop for PtyControl {
    /// A run that is dropped with a command still alive (the runtime is shutting down) must not
    /// leave it behind on a terminal nobody reads any more.
    fn drop(&mut self) {
        if let (Some(pid), false) = (self.pid, self.terminated.load(Ordering::Acquire)) {
            let _ = process_group::kill_tree(pid, KillSignal::Kill);
        }
    }
}

fn portable_size(size: PtySize) -> portable_pty::PtySize {
    portable_pty::PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 }
}

/// Decodes a stream of bytes into text without splitting a character that straddles two reads.
#[derive(Default)]
struct Utf8Chunker {
    /// The start of a character whose end has not arrived yet (at most 3 bytes).
    carry: Vec<u8>,
}

impl Utf8Chunker {
    /// The text that is complete so far. Invalid bytes become U+FFFD.
    fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);

        let keep = incomplete_tail(&self.carry);
        let complete = self.carry.len() - keep;
        let text = String::from_utf8_lossy(&self.carry[..complete]).into_owned();

        self.carry.drain(..complete);

        text
    }

    /// Whatever is left once the stream has ended.
    fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.carry).into_owned();

        self.carry.clear();

        text
    }
}

/// How many bytes at the end of `bytes` start a UTF-8 sequence that is not finished.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=3.min(bytes.len()) {
        let byte = bytes[bytes.len() - back];

        // A continuation byte belongs to a sequence that starts earlier.
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }

        let length = match byte {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => return 0,
        };

        return if length > back { back } else { 0 };
    }

    0
}

/// The program and arguments that run `command` in a terminal.
///
/// A pty command always goes through a shell, whatever `shell` says: that is what the JS spawner
/// does, and a terminal program is a shell command more often than not. `windows` selects the
/// Windows rules so they can be tested on any host.
fn shell_command(command: &str, shell_path: Option<&str>, windows: bool) -> (String, Vec<String>) {
    let cmd_exe = |program: &str| (program.to_string(), ["/d", "/s", "/c", command].map(String::from).to_vec());

    match shell_path {
        Some(custom) if windows && is_cmd_exe(custom) => cmd_exe(custom),
        Some(custom) => (custom.to_string(), vec!["-c".to_string(), command.to_string()]),
        None if windows => cmd_exe("cmd.exe"),
        None => ("/bin/sh".to_string(), vec!["-c".to_string(), command.to_string()]),
    }
}

/// `program` and `args` run under `env -u SHELL`, which removes the variable `portable-pty` sets on
/// every command. A caller that wants only its own variables (`inheritEnv: false`) must not find
/// one it did not pass; one it did pass is kept (see `spawn_pty`).
#[cfg(unix)]
fn without_shell_variable(program: String, args: Vec<String>) -> (String, Vec<String>) {
    let wrapped = ["-u", "SHELL", &program].map(String::from).into_iter().chain(args).collect();

    ("/usr/bin/env".to_string(), wrapped)
}

/// Start `config.command` in a terminal and stream its output.
///
/// Like `spawn_process`, this returns once the command is running; the close is reported through
/// `completion_tx` after the terminal has drained, or after the grace period if a descendant keeps
/// the terminal open.
pub(crate) fn spawn_pty(
    index: u32,
    config: &ConcurrentCommandConfig,
    sink: &EventSink,
    completion_tx: mpsc::UnboundedSender<CompletionMessage>,
    shell_path: Option<&str>,
    giving_up: &Arc<AtomicBool>,
) -> Result<ProcessInfo, std::io::Error> {
    let cwd = match &config.cwd {
        // `portable-pty` would quietly start the command in the home directory instead.
        Some(cwd) if !Path::new(cwd).is_dir() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("working directory {cwd:?} is not a directory"),
            ))
        }
        Some(cwd) => Path::new(cwd).to_path_buf(),
        None => std::env::current_dir()?,
    };

    let (program, args) = shell_command(&config.command, shell_path, cfg!(windows));

    // `portable-pty` adds SHELL to every command, so a clean environment needs it taken out again,
    // unless the caller set it, in which case the caller's value is what the command gets.
    #[cfg(unix)]
    let (program, args) =
        if config.inherit_env == Some(false) && !config.env.iter().flatten().any(|(key, _)| key == "SHELL") {
            without_shell_variable(program, args)
        } else {
            (program, args)
        };

    let mut builder = CommandBuilder::new(program);

    builder.args(args);
    builder.cwd(cwd);

    // The terminal command inherits this process's environment unless the caller opted out.
    if config.inherit_env == Some(false) {
        builder.env_clear();
    }

    for (key, value) in config.env.iter().flatten() {
        builder.env(key, value);
    }

    let pair = native_pty_system()
        .openpty(portable_size(config.pty_size.unwrap_or_default()))
        .map_err(std::io::Error::other)?;
    let child = pair.slave.spawn_command(builder).map_err(std::io::Error::other)?;
    let start_time = Instant::now();
    let pid = child.process_id();

    // The command holds the slave end now; if this process kept it too, the terminal would
    // never report the end of the output.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(std::io::Error::other)?;
    let writer = pair.master.take_writer().map_err(std::io::Error::other)?;

    sink.send(ProcessEvent::Started { index, pid });

    let parked = Arc::new(AtomicUsize::new(0));
    let output = sink.counting_parked(Arc::clone(&parked));
    let abandoned = Arc::new(AtomicBool::new(false));
    let runtime = Handle::current();

    let (output_done_tx, output_done_rx) = oneshot::channel::<()>();

    std::thread::spawn({
        let abandoned = Arc::clone(&abandoned);

        move || {
            read_output(reader, &output, &runtime, index, &abandoned);

            let _ = output_done_tx.send(());
        }
    });

    let (input_tx, input_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    std::thread::spawn(move || write_input(writer, input_rx));

    let (exit_tx, exit_rx) = oneshot::channel::<(i32, bool)>();

    std::thread::spawn(move || {
        let _ = exit_tx.send(wait_for_exit(child, pid));
    });

    let terminated = Arc::new(AtomicBool::new(false));
    let terminated_completion = Arc::clone(&terminated);
    let giving_up = Arc::clone(giving_up);
    let command = config.command.clone();
    let name = config.name.clone();

    tokio::spawn(async move {
        let (exit_code, signalled) = exit_rx.await.unwrap_or((-1, false));
        let duration_ms = start_time.elapsed().as_secs_f64() * 1000.0;

        // A descendant that outlives the command keeps the terminal open, and the output would
        // never end: give it the same grace the pipes get, then reap the group.
        let drained = drain_within_grace(
            async {
                let _ = output_done_rx.await;
            },
            &parked,
            &giving_up,
        )
        .await;

        if !drained {
            abandoned.store(true, Ordering::Release);

            if let Some(pid) = pid {
                let _ = process_group::kill_tree(pid, KillSignal::Kill);
            }
        }

        terminated_completion.store(true, Ordering::Release);

        let close_event = ConcurrentCloseEvent { index, command, name, exit_code, killed: signalled, duration_ms };

        let _ = completion_tx.send(CompletionMessage { index, close_event });
    });

    // Windows: the Job Object is what a kill takes down, as for a pipe command.
    #[cfg(windows)]
    let job = {
        let job = process_group::JobObject::new().ok();

        if let (Some(job), Some(pid)) = (&job, pid) {
            let _ = job.assign_process_by_pid(pid);
        }

        job
    };

    Ok(ProcessInfo {
        index,
        pid,
        terminated: Arc::clone(&terminated),
        input: Some(InputHandle::from_sender(input_tx)),
        pty: Some(PtyControl { master: Arc::new(Mutex::new(pair.master)), pid, terminated }),
        #[cfg(windows)]
        job,
    })
}

/// Read the terminal until it ends, sending each chunk as an output event. Runs on its own thread.
fn read_output(
    mut reader: Box<dyn Read + Send>,
    sink: &EventSink,
    runtime: &Handle,
    index: u32,
    abandoned: &AtomicBool,
) {
    let mut chunker = Utf8Chunker::default();
    let mut buffer = [0u8; READ_CHUNK];

    // A read error is how a terminal reports the end of its output on some platforms (EIO on
    // Linux when the last slave descriptor closes), so it ends the stream like EOF does.
    while let Ok(count @ 1..) = reader.read(&mut buffer) {
        let text = chunker.push(&buffer[..count]);

        if abandoned.load(Ordering::Acquire) {
            return;
        }

        if !text.is_empty() && !sink.send_output_blocking(runtime, ProcessEvent::Stdout { index, text }) {
            return;
        }
    }

    let text = chunker.finish();

    if !text.is_empty() && !abandoned.load(Ordering::Acquire) {
        sink.send_output_blocking(runtime, ProcessEvent::Stdout { index, text });
    }
}

/// Write queued input to the terminal until the command is done with it. Runs on its own thread,
/// so a command that is not reading cannot stall anything but this thread.
///
/// The writer is kept until the command has exited: dropping it makes `portable-pty` type an
/// end-of-file into the terminal.
fn write_input(mut writer: Box<dyn Write + Send>, mut input: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(data) = input.blocking_recv() {
        if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
            return;
        }
    }
}

/// Wait for the command to exit: its exit code, and whether a signal ended it (`128 + signal`).
#[cfg(unix)]
fn wait_for_exit(child: Box<dyn portable_pty::Child + Send + Sync>, pid: Option<u32>) -> (i32, bool) {
    use nix::errno::Errno;
    use nix::sys::wait::{waitpid, WaitStatus};
    use nix::unistd::Pid;

    // `portable-pty` reports a signalled child as exit code 1 plus the signal's description, which
    // cannot be turned back into a number, so the child is reaped here instead of through it.
    // Dropping its handle neither waits for nor kills the child.
    drop(child);

    let Some(pid) = pid else {
        return (-1, false);
    };

    loop {
        match waitpid(Pid::from_raw(pid as i32), None) {
            Ok(WaitStatus::Exited(_, code)) => return (code, false),
            Ok(WaitStatus::Signaled(_, signal, _)) => return (128 + signal as i32, true),
            Ok(_) | Err(Errno::EINTR) => {}
            Err(_) => return (-1, false),
        }
    }
}

#[cfg(windows)]
fn wait_for_exit(mut child: Box<dyn portable_pty::Child + Send + Sync>, _pid: Option<u32>) -> (i32, bool) {
    match child.wait() {
        Ok(status) => (status.exit_code() as i32, false),
        Err(_) => (-1, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(chunks: &[&[u8]]) -> Vec<String> {
        let mut chunker = Utf8Chunker::default();
        let mut out: Vec<String> = chunks.iter().map(|chunk| chunker.push(chunk)).collect();

        out.push(chunker.finish());

        out
    }

    #[test]
    fn a_character_split_across_reads_is_decoded_once() {
        let euro = "€".as_bytes(); // E2 82 AC

        assert_eq!(decode(&[&euro[..1], &euro[1..]]), ["", "€", ""]);
        assert_eq!(decode(&[&euro[..2], &euro[2..]]), ["", "€", ""]);
        assert_eq!(decode(&[b"a\xE2", b"\x82\xACb"]), ["a", "€b", ""]);
    }

    #[test]
    fn a_four_byte_character_can_arrive_one_byte_at_a_time() {
        let grin = "😀".as_bytes();
        let chunks: Vec<&[u8]> = grin.chunks(1).collect();

        assert_eq!(decode(&chunks).concat(), "😀");
    }

    #[test]
    fn invalid_bytes_become_replacement_characters_and_do_not_wait_for_more() {
        assert_eq!(decode(&[b"a\xFFb"]), ["a\u{FFFD}b", ""]);
        // A lone lead byte at the end of the stream is flushed as a replacement character.
        assert_eq!(decode(&[b"a\xE2"]), ["a", "\u{FFFD}"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_shell_variable_is_removed_by_running_the_command_under_env() {
        assert_eq!(
            without_shell_variable("/bin/sh".to_string(), vec!["-c".to_string(), "echo hi".to_string()]),
            ("/usr/bin/env".to_string(), ["-u", "SHELL", "/bin/sh", "-c", "echo hi"].map(String::from).to_vec())
        );
    }

    #[test]
    fn the_shell_is_always_used() {
        assert_eq!(
            shell_command("echo hi", None, false),
            ("/bin/sh".to_string(), vec!["-c".to_string(), "echo hi".to_string()])
        );
        assert_eq!(
            shell_command("echo hi", Some("/opt/bin/bash"), false),
            ("/opt/bin/bash".to_string(), vec!["-c".to_string(), "echo hi".to_string()])
        );
    }

    #[test]
    fn windows_runs_cmd_with_the_command_as_its_own_argument() {
        let expected = vec!["/d".to_string(), "/s".to_string(), "/c".to_string(), "echo hi".to_string()];

        assert_eq!(shell_command("echo hi", None, true), ("cmd.exe".to_string(), expected.clone()));
        assert_eq!(
            shell_command("echo hi", Some("C:\\Windows\\System32\\cmd.exe"), true),
            ("C:\\Windows\\System32\\cmd.exe".to_string(), expected)
        );
        assert_eq!(
            shell_command("echo hi", Some("C:\\Git\\bin\\bash.exe"), true),
            ("C:\\Git\\bin\\bash.exe".to_string(), vec!["-c".to_string(), "echo hi".to_string()])
        );
    }
}
