//! One error type for the wrapper paths that print `vis <command>: <message>` and exit.
//!
//! `Display` renders the exact stderr line (without the trailing newline) and
//! [`WrapperError::exit_code`] the exit status the process ends with, so a command
//! reports a failure by returning it and letting [`finish`] print and exit once.
//!
//! Not every failure goes through here: lines without the `vis <command>:` prefix
//! (`vis: …`, the bare `x` usage line, the hook runner's `Error: …`) and the exits
//! that carry no message keep their own handling.

use std::fmt;
use std::io;
use std::process::exit;

/// Exit status when the command's input is wrong or its output cannot be written.
const EXIT_FAILURE: i32 = 1;

/// Exit status when the program the command wraps cannot be started (`127`, the
/// shell's "command not found").
const EXIT_NOT_RUNNABLE: i32 = 127;

#[derive(Debug)]
pub(crate) enum WrapperError {
    /// A rejected invocation or a resolver failure: `vis <command>: <message>`, exit 1.
    Usage { command: String, message: String },
    /// The resolved program could not be spawned: `vis <command>: failed to run '<program>': <source>`, exit 127.
    Spawn { command: String, program: String, source: io::Error },
    /// The runtime could not be launched: `vis <command>: failed to launch <target>: <source>`, exit 127.
    Launch { command: String, target: &'static str, source: io::Error },
    /// A required binary is missing: `vis <command>: <message>`, exit 127.
    Unavailable { command: String, message: String },
    /// Writing the command's output failed: `vis <command>: failed to write <what>: <source>`, exit 1.
    Write { command: String, what: &'static str, source: io::Error },
}

impl WrapperError {
    pub(crate) fn usage(command: &str, message: impl Into<String>) -> Self {
        Self::Usage { command: command.to_owned(), message: message.into() }
    }

    pub(crate) fn spawn(command: &str, program: &str, source: io::Error) -> Self {
        Self::Spawn { command: command.to_owned(), program: program.to_owned(), source }
    }

    pub(crate) fn launch(command: &str, target: &'static str, source: io::Error) -> Self {
        Self::Launch { command: command.to_owned(), target, source }
    }

    pub(crate) fn unavailable(command: &str, message: impl Into<String>) -> Self {
        Self::Unavailable { command: command.to_owned(), message: message.into() }
    }

    pub(crate) fn write(command: &str, what: &'static str, source: io::Error) -> Self {
        Self::Write { command: command.to_owned(), what, source }
    }

    /// The exit status the process ends with after reporting this error.
    pub(crate) fn exit_code(&self) -> i32 {
        match self {
            Self::Usage { .. } | Self::Write { .. } => EXIT_FAILURE,
            Self::Spawn { .. } | Self::Launch { .. } | Self::Unavailable { .. } => EXIT_NOT_RUNNABLE,
        }
    }
}

impl fmt::Display for WrapperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage { command, message } | Self::Unavailable { command, message } => {
                write!(f, "vis {command}: {message}")
            }
            Self::Spawn { command, program, source } => {
                write!(f, "vis {command}: failed to run '{program}': {source}")
            }
            Self::Launch { command, target, source } => {
                write!(f, "vis {command}: failed to launch {target}: {source}")
            }
            Self::Write { command, what, source } => write!(f, "vis {command}: failed to write {what}: {source}"),
        }
    }
}

impl std::error::Error for WrapperError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Spawn { source, .. } | Self::Launch { source, .. } | Self::Write { source, .. } => Some(source),
            Self::Usage { .. } | Self::Unavailable { .. } => None,
        }
    }
}

/// Exit with `Ok`'s status, or print the error to stderr and exit with its status. Never returns.
pub(crate) fn finish(result: Result<i32, WrapperError>) -> ! {
    match result {
        Ok(code) => exit(code),
        Err(error) => {
            eprintln!("{error}");
            exit(error.exit_code());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::WrapperError;

    fn io_error() -> io::Error {
        io::Error::other("boom")
    }

    #[test]
    fn usage_renders_the_prefixed_line_and_exits_one() {
        let error = WrapperError::usage("exec", "--filter requires a value");

        assert_eq!(error.to_string(), "vis exec: --filter requires a value");
        assert_eq!(error.exit_code(), 1);
    }

    #[test]
    fn spawn_names_the_program_and_exits_127() {
        let error = WrapperError::spawn("pm", "pnpm", io_error());

        assert_eq!(error.to_string(), "vis pm: failed to run 'pnpm': boom");
        assert_eq!(error.exit_code(), 127);
    }

    #[test]
    fn launch_names_the_target_and_exits_127() {
        let error = WrapperError::launch("x", "bun", io_error());

        assert_eq!(error.to_string(), "vis x: failed to launch bun: boom");
        assert_eq!(error.exit_code(), 127);
    }

    #[test]
    fn unavailable_renders_the_message_and_exits_127() {
        let error = WrapperError::unavailable("x", "runtime is bun but the `bun` binary is not on PATH.");

        assert_eq!(error.to_string(), "vis x: runtime is bun but the `bun` binary is not on PATH.");
        assert_eq!(error.exit_code(), 127);
    }

    #[test]
    fn write_names_the_output_and_exits_one() {
        let error = WrapperError::write("clean", "the output", io_error());

        assert_eq!(error.to_string(), "vis clean: failed to write the output: boom");
        assert_eq!(error.exit_code(), 1);
    }
}
