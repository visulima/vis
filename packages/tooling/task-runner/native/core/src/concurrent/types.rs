use std::collections::HashMap;

/// Configuration for a single command to run concurrently.
#[derive(Debug, Clone)]
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
    /// Stdin mode: "null" (default), "pipe", or "inherit".
    pub stdin: Option<String>,
}

/// Options controlling the concurrent runner behavior.
#[derive(Debug, Clone)]
pub struct ConcurrentRunnerOptions {
    /// Maximum number of processes to run simultaneously.
    /// 0 or absent means unlimited.
    pub max_processes: Option<u32>,
    /// Signal to send when killing processes (default: "SIGTERM").
    pub kill_signal: Option<String>,
    /// Conditions under which to kill other processes.
    /// Values: "success", "failure". Empty = never kill others.
    pub kill_others: Option<Vec<String>>,
    /// Success condition: "first", "last", "all", or "command-<name|index>".
    pub success_condition: Option<String>,
    /// Milliseconds to wait after sending kill signal before sending SIGKILL.
    pub kill_timeout: Option<u32>,
    /// Custom shell path for command execution (e.g., from npm script-shell config).
    /// When set, used instead of the platform default (/bin/sh or cmd.exe).
    /// Format: "/path/to/shell" — args are always ["-c", command].
    pub shell_path: Option<String>,
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
