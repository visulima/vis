use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

use super::completion::SuccessCondition;

/// An option value the runner does not recognise.
///
/// Options reach the runner as text from JavaScript. Each one is parsed once, at
/// the boundary, into one of the enums below; an unknown value is reported to
/// the caller instead of silently meaning something else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidOption {
    /// JS-side option name, e.g. `killSignal`.
    pub option: &'static str,
    /// The value that was rejected.
    pub value: String,
    /// What would have been accepted.
    pub expected: &'static str,
}

impl fmt::Display for InvalidOption {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid {} {:?}: expected {}", self.option, self.value, self.expected)
    }
}

impl std::error::Error for InvalidOption {}

/// How a command's standard input is wired.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StdinMode {
    /// Closed (`/dev/null`). The default.
    #[default]
    Null,
    /// A pipe to the child.
    Pipe,
    /// The runner's own stdin.
    Inherit,
}

impl FromStr for StdinMode {
    type Err = InvalidOption;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "null" => Ok(Self::Null),
            "pipe" => Ok(Self::Pipe),
            "inherit" => Ok(Self::Inherit),
            _ => Err(InvalidOption {
                option: "stdin",
                value: value.to_string(),
                expected: "\"null\", \"pipe\" or \"inherit\"",
            }),
        }
    }
}

/// Signal sent to a command's process group when it is killed.
///
/// Windows has no signals; there the choice is ignored and the tree is
/// terminated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KillSignal {
    Abrt,
    Alrm,
    Hup,
    Int,
    Kill,
    Quit,
    #[default]
    Term,
    Usr1,
    Usr2,
}

impl FromStr for KillSignal {
    type Err = InvalidOption;

    /// Accepts the Node.js spelling (`SIGTERM`), and the bare name (`TERM`), in any case.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let upper = value.to_ascii_uppercase();

        match upper.strip_prefix("SIG").unwrap_or(&upper) {
            "ABRT" => Ok(Self::Abrt),
            "ALRM" => Ok(Self::Alrm),
            "HUP" => Ok(Self::Hup),
            "INT" => Ok(Self::Int),
            "KILL" => Ok(Self::Kill),
            "QUIT" => Ok(Self::Quit),
            "TERM" => Ok(Self::Term),
            "USR1" => Ok(Self::Usr1),
            "USR2" => Ok(Self::Usr2),
            _ => Err(InvalidOption {
                option: "killSignal",
                value: value.to_string(),
                expected: "one of SIGABRT, SIGALRM, SIGHUP, SIGINT, SIGKILL, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2",
            }),
        }
    }
}

/// A command outcome that makes the runner kill the commands still running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillOthers {
    /// A command exited with code 0.
    Success,
    /// A command exited with a non-zero code.
    Failure,
}

impl FromStr for KillOthers {
    type Err = InvalidOption;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "success" => Ok(Self::Success),
            "failure" => Ok(Self::Failure),
            _ => Err(InvalidOption {
                option: "killOthers",
                value: value.to_string(),
                expected: "\"success\" or \"failure\"",
            }),
        }
    }
}

/// Configuration for a single command to run concurrently.
#[derive(Debug, Clone, Default)]
pub struct ConcurrentCommandConfig {
    /// The command string to execute (passed to shell).
    pub command: String,
    /// Human-readable name for this command (used in prefixes/logs).
    pub name: Option<String>,
    /// Working directory for the command.
    pub cwd: Option<String>,
    /// Additional environment variables merged with process env.
    pub env: Option<HashMap<String, String>>,
    /// Whether to use shell execution (default: true).
    pub shell: Option<bool>,
    /// How standard input is wired (default: closed).
    pub stdin: StdinMode,
}

/// Options controlling the concurrent runner behavior.
#[derive(Debug, Clone, Default)]
pub struct ConcurrentRunnerOptions {
    /// Maximum number of processes to run simultaneously.
    /// 0 or absent means unlimited.
    pub max_processes: Option<u32>,
    /// Signal to send when killing processes (default: SIGTERM).
    pub kill_signal: KillSignal,
    /// Outcomes that kill the other commands. Empty = never kill others.
    pub kill_others: Vec<KillOthers>,
    /// What makes the run succeed (default: every command exits 0).
    pub success_condition: SuccessCondition,
    /// Milliseconds to wait after sending kill signal before sending SIGKILL.
    pub kill_timeout: Option<u32>,
    /// Custom shell path for command execution (e.g., from npm script-shell config).
    /// When set, used instead of the platform default (/bin/sh or cmd.exe).
    /// Format: "/path/to/shell" — args are always ["-c", command].
    pub shell_path: Option<String>,
}

/// A request from the caller to a running `ConcurrentRunner`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlMessage {
    /// Stop the run: kill every running command and spawn no more.
    ///
    /// `graceful` marks a user interrupt (Ctrl+C): on Windows the commands get
    /// `CTRL_BREAK_EVENT` first, and every close is reported with exit code 0
    /// and `killed`, because cancelling is not a failure. Otherwise the
    /// commands are terminated and keep their exit codes.
    Abort { graceful: bool },
    /// Signal one running command's process tree. `None` uses the runner's
    /// `kill_signal`. Does nothing if the command is not running.
    Kill { index: u32, signal: Option<KillSignal> },
}

/// An event emitted during concurrent execution.
#[derive(Debug, Clone, PartialEq)]
pub enum ProcessEvent {
    /// Emitted exactly once per command, immediately after the child process
    /// has been spawned. `pid` is the OS pid, or `None` if the platform could
    /// not return one. Consumers use it to register children for cleanup.
    Started { index: u32, pid: Option<u32> },
    /// One line of standard output.
    Stdout { index: u32, text: String },
    /// One line of standard error.
    Stderr { index: u32, text: String },
    /// The command finished. A signalled child has exit code `128 + signal`.
    Close { index: u32, exit_code: i32, killed: bool, command_name: Option<String>, duration_ms: f64 },
    /// The command could not be spawned.
    Error { index: u32, message: String },
}

impl ProcessEvent {
    /// Index of the command that produced this event.
    pub fn index(&self) -> u32 {
        match self {
            Self::Started { index, .. }
            | Self::Stdout { index, .. }
            | Self::Stderr { index, .. }
            | Self::Close { index, .. }
            | Self::Error { index, .. } => *index,
        }
    }

    /// Name of the event type as the JS API spells it.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Started { .. } => "started",
            Self::Stdout { .. } => "stdout",
            Self::Stderr { .. } => "stderr",
            Self::Close { .. } => "close",
            Self::Error { .. } => "error",
        }
    }
}

/// Result of a close event for a single command.
#[derive(Debug, Clone)]
pub struct ConcurrentCloseEvent {
    /// Index of the command.
    pub index: u32,
    /// The command string that was executed.
    pub command: String,
    /// The command name (if provided).
    pub name: Option<String>,
    /// Exit code; `128 + signal` if a signal ended the process.
    pub exit_code: i32,
    /// Whether the process was forcefully killed.
    pub killed: bool,
    /// Duration in milliseconds.
    pub duration_ms: f64,
}

/// Overall result of a concurrent run.
#[derive(Debug, Clone)]
pub struct ConcurrentRunResult {
    /// Close events for all commands, in completion order.
    pub close_events: Vec<ConcurrentCloseEvent>,
    /// Whether the run succeeded according to the success condition.
    pub success: bool,
}
