//! Writing a command's output the way Node does: a closed pipe ends the run quietly, any other failure is the wrapper's
//! write error.

use std::io::{self, Write};
use std::process::exit;

use crate::error::WrapperError;
use crate::pail::{Layout, Level};

/// What one run prints, split the way pail splits it (the error levels go to stderr), and its exit status.
#[derive(Default)]
pub(crate) struct Output {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit_code: i32,
}

impl Output {
    /// Adds one pail block on the stream pail prints its level on.
    pub(crate) fn say(&mut self, layout: Layout, level: Level, message: &str) {
        let buffer = if level.to_stderr() { &mut self.stderr } else { &mut self.stdout };

        buffer.push_str(&layout.block(level, message));
    }

    /// Writes both streams as [`write_streams`] does and exits with the status.
    pub(crate) fn emit(&self, command: &str) -> ! {
        write_streams(command, &self.stdout, &self.stderr);

        exit(self.exit_code)
    }
}

/// The largest document Node reliably delivers to a pipe or socket. Its stdout is asynchronous there and the process
/// exits right after writing, so what the reader has not yet taken from the pipe's buffer (64 KiB) is lost: a
/// larger document arrives cut short, at a length that depends on how fast the reader is.
pub(crate) const STREAM_LIMIT: usize = 64 * 1024;

/// Whether stdout is a pipe or a socket.
#[cfg(unix)]
fn stdout_is_stream() -> bool {
    // SAFETY: `fstat` only writes the `stat` it is given.
    let mut status: libc::stat = unsafe { std::mem::zeroed() };

    if unsafe { libc::fstat(libc::STDOUT_FILENO, &mut status) } != 0 {
        return true;
    }

    matches!(status.st_mode & libc::S_IFMT, libc::S_IFIFO | libc::S_IFSOCK)
}

#[cfg(not(unix))]
fn stdout_is_stream() -> bool {
    true
}

/// Whether Node would deliver a document of `len` bytes cut short on this stdout (see [`STREAM_LIMIT`]): a command
/// that would print one leaves the run to Node, which then cuts it short itself.
pub(crate) fn node_may_cut_short(len: usize) -> bool {
    len > STREAM_LIMIT && stdout_is_stream()
}

/// Writes `text` to stdout and flushes, ignoring a closed pipe; any other failure ends the run with the
/// wrapper's write error for `command`.
pub(crate) fn write_stdout(command: &str, what: &str, text: impl AsRef<[u8]>) {
    if let Err(error) = io::stdout().lock().write_all(text.as_ref()).and_then(|()| io::stdout().lock().flush()) {
        // A closed pipe is not an error worth reporting.
        if error.kind() != io::ErrorKind::BrokenPipe {
            WrapperError::write(command, what, error).exit();
        }
    }
}

/// Writes `stdout` and `stderr`, each even when the other fails, so a closed stdout does not hide errors; a
/// closed pipe is not reported and any other failure ends the run with the wrapper's write error for `command`.
pub(crate) fn write_streams(command: &str, stdout: &str, stderr: &str) {
    let write = |stream: &mut dyn Write, text: &str| stream.write_all(text.as_bytes()).and_then(|()| stream.flush());
    let results = [write(&mut io::stdout().lock(), stdout), write(&mut io::stderr().lock(), stderr)];

    for result in results {
        match result {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {}
            Err(error) => WrapperError::write(command, "the output", error).exit(),
        }
    }
}

/// Writes `text` to stderr and flushes, ignoring a closed pipe; any other failure ends the run with the wrapper's
/// write error for `command`.
pub(crate) fn write_stderr(command: &str, what: &str, text: impl AsRef<[u8]>) {
    if let Err(error) = io::stderr().lock().write_all(text.as_ref()).and_then(|()| io::stderr().lock().flush()) {
        if error.kind() != io::ErrorKind::BrokenPipe {
            WrapperError::write(command, what, error).exit();
        }
    }
}
