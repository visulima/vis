//! Writing a command's output the way Node does: a closed pipe ends the run quietly, any other failure is the wrapper's
//! write error.

use std::io::{self, Write};

use crate::error::WrapperError;

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
