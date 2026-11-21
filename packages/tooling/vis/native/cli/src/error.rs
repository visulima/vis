//! One error type for the wrapper paths that print `vis <command>: <message>` and exit.
//!
//! `Display` renders the exact stderr line (without the trailing newline) and
//! [`WrapperError::exit_code`] the exit status the process ends with, so a command
//! reports a failure by returning it and letting [`finish`] print and exit once, or
//! calls [`WrapperError::exit`] where the failure is not returned.
//!
//! Not every failure goes through here: lines without the `vis <command>:` prefix
//! (`vis: …`, the hook runner's `Error: …`) and the exits that carry no message keep
//! their own handling. The bare `x` usage line is [`WrapperError::bare_usage`].

use std::fmt;
use std::io;
use std::process::exit;

/// Exit status when the command's input is wrong or its output cannot be written.
const EXIT_FAILURE: i32 = 1;

/// Exit status when the program the command wraps cannot be started (`127`, the
/// shell's "command not found").
const EXIT_NOT_RUNNABLE: i32 = 127;

/// A failure to report on stderr and exit with. The line is `vis <command>: <message>`, or just
/// the message when no command prefix applies.
#[derive(Debug)]
pub(crate) struct WrapperError {
    command: Option<String>,
    message: String,
    exit_code: i32,
}

impl WrapperError {
    fn new(command: Option<&str>, message: String, exit_code: i32) -> Self {
        Self { command: command.map(str::to_owned), message, exit_code }
    }

    /// A rejected invocation or a resolver failure: `vis <command>: <message>`, exit 1.
    pub(crate) fn usage(command: &str, message: impl Into<String>) -> Self {
        Self::new(Some(command), message.into(), EXIT_FAILURE)
    }

    /// A usage line the command prints without the `vis <command>:` prefix, exit 1.
    pub(crate) fn bare_usage(message: impl Into<String>) -> Self {
        Self::new(None, message.into(), EXIT_FAILURE)
    }

    /// A required binary is missing: `vis <command>: <message>`, exit 127.
    pub(crate) fn unavailable(command: &str, message: impl Into<String>) -> Self {
        Self::new(Some(command), message.into(), EXIT_NOT_RUNNABLE)
    }

    /// The resolved program could not be spawned: `vis <command>: failed to run '<program>': <source>`, exit 127.
    pub(crate) fn spawn(command: &str, program: &str, source: io::Error) -> Self {
        Self::new(Some(command), format!("failed to run '{program}': {source}"), EXIT_NOT_RUNNABLE)
    }

    /// The runtime could not be launched: `vis <command>: failed to launch <target>: <source>`, exit 127.
    pub(crate) fn launch(command: &str, target: &str, source: io::Error) -> Self {
        Self::new(Some(command), format!("failed to launch {target}: {source}"), EXIT_NOT_RUNNABLE)
    }

    /// Writing the command's output failed: `vis <command>: failed to write <what>: <source>`, exit 1.
    pub(crate) fn write(command: &str, what: &str, source: io::Error) -> Self {
        Self::new(Some(command), format!("failed to write {what}: {source}"), EXIT_FAILURE)
    }

    /// Print the error to stderr and exit with its status. Never returns.
    pub(crate) fn exit(self) -> ! {
        eprintln!("{self}");
        exit(self.exit_code)
    }
}

impl fmt::Display for WrapperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.command {
            Some(command) => write!(f, "vis {command}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

/// Exit with `Ok`'s status, or print the error to stderr and exit with its status. Never returns.
pub(crate) fn finish(result: Result<i32, WrapperError>) -> ! {
    match result {
        Ok(code) => exit(code),
        Err(error) => error.exit(),
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
        assert_eq!(error.exit_code, 1);
    }

    #[test]
    fn spawn_names_the_program_and_exits_127() {
        let error = WrapperError::spawn("pm", "pnpm", io_error());

        assert_eq!(error.to_string(), "vis pm: failed to run 'pnpm': boom");
        assert_eq!(error.exit_code, 127);
    }

    #[test]
    fn launch_names_the_target_and_exits_127() {
        let error = WrapperError::launch("x", "bun", io_error());

        assert_eq!(error.to_string(), "vis x: failed to launch bun: boom");
        assert_eq!(error.exit_code, 127);
    }

    #[test]
    fn unavailable_renders_the_message_and_exits_127() {
        let error = WrapperError::unavailable("x", "runtime is bun but the `bun` binary is not on PATH.");

        assert_eq!(error.to_string(), "vis x: runtime is bun but the `bun` binary is not on PATH.");
        assert_eq!(error.exit_code, 127);
    }

    #[test]
    fn bare_usage_has_no_command_prefix_and_exits_one() {
        let error = WrapperError::bare_usage("No file specified. Usage: vis x <file> [args...]");

        assert_eq!(error.to_string(), "No file specified. Usage: vis x <file> [args...]");
        assert_eq!(error.exit_code, 1);
    }

    #[test]
    fn write_names_the_output_and_exits_one() {
        let error = WrapperError::write("clean", "the output", io_error());

        assert_eq!(error.to_string(), "vis clean: failed to write the output: boom");
        assert_eq!(error.exit_code, 1);
    }
}
