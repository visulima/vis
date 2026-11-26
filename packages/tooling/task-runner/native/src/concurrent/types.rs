use std::collections::HashMap;

use napi_derive::napi;
use task_runner_core::concurrent::grouping::Delivered;
use task_runner_core::concurrent::types as core;

/// Configuration for a single command to run concurrently.
#[napi(object)]
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
    /// Stdin mode: "null" (default), "pipe", "inherit" or "pty"; anything else is an error.
    pub stdin: Option<String>,
    /// Whether the command inherits this process's environment under `env` (default: true).
    /// `false` gives it no variables but `env`.
    pub inherit_env: Option<bool>,
    /// Initial terminal size for `stdin: "pty"` (default: 80x24).
    pub pty_size: Option<PtySize>,
}

/// Size of a pseudo-terminal, in character cells.
#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct PtySize {
    pub cols: u32,
    pub rows: u32,
}

impl PtySize {
    /// A size the terminal can represent: at least one cell each way, and no more than 65535.
    pub fn parse(cols: u32, rows: u32) -> napi::Result<core::PtySize> {
        match (u16::try_from(cols), u16::try_from(rows)) {
            (Ok(cols @ 1..), Ok(rows @ 1..)) => Ok(core::PtySize { cols, rows }),
            _ => Err(napi::Error::new(
                napi::Status::InvalidArg,
                format!("invalid pty size {cols}x{rows}: columns and rows must each be between 1 and 65535"),
            )),
        }
    }
}

/// An unknown option value is reported to the caller as an invalid argument.
fn invalid_arg(error: core::InvalidOption) -> napi::Error {
    napi::Error::new(napi::Status::InvalidArg, error.to_string())
}

impl TryFrom<ConcurrentCommandConfig> for core::ConcurrentCommandConfig {
    type Error = napi::Error;

    fn try_from(v: ConcurrentCommandConfig) -> napi::Result<Self> {
        let stdin = v.stdin.as_deref().map(str::parse).transpose().map_err(invalid_arg)?.unwrap_or_default();

        let pty_size = v.pty_size.map(|size| PtySize::parse(size.cols, size.rows)).transpose()?;

        Ok(Self {
            command: v.command,
            name: v.name,
            cwd: v.cwd,
            env: v.env,
            shell: v.shell,
            stdin,
            inherit_env: v.inherit_env,
            pty_size,
        })
    }
}

/// Options controlling the concurrent runner behavior.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ConcurrentRunnerOptions {
    /// Maximum number of processes to run simultaneously.
    /// 0 or absent means unlimited.
    pub max_processes: Option<u32>,
    /// Signal to send when killing processes (default: "SIGTERM"). An unknown name is an error.
    pub kill_signal: Option<String>,
    /// Conditions under which to kill other processes.
    /// Values: "success", "failure" (anything else is an error). Empty = never kill others.
    pub kill_others: Option<Vec<String>>,
    /// Success condition: "first", "last", "all", or "command-<name|index>" (an optional leading "!"
    /// negates the command form). Anything else is an error.
    pub success_condition: Option<String>,
    /// Milliseconds to wait after sending kill signal before sending SIGKILL.
    pub kill_timeout: Option<u32>,
    /// Custom shell path for command execution (e.g., from npm script-shell config).
    /// When set, used instead of the platform default (/bin/sh or cmd.exe).
    /// Format: "/path/to/shell" — args are always ["-c", command].
    pub shell_path: Option<String>,
    /// Whether `startConcurrent` reports `stdout` and `stderr` events (default: false, only
    /// "started", "close" and "error"). Ignored by the other entry points.
    pub stream_output: Option<bool>,
}

impl TryFrom<ConcurrentRunnerOptions> for core::ConcurrentRunnerOptions {
    type Error = napi::Error;

    fn try_from(v: ConcurrentRunnerOptions) -> napi::Result<Self> {
        Ok(Self {
            max_processes: v.max_processes,
            kill_signal: v.kill_signal.as_deref().map(str::parse).transpose().map_err(invalid_arg)?.unwrap_or_default(),
            kill_others: v
                .kill_others
                .unwrap_or_default()
                .iter()
                .map(|condition| condition.parse())
                .collect::<Result<_, _>>()
                .map_err(invalid_arg)?,
            success_condition: v
                .success_condition
                .as_deref()
                .map(str::parse)
                .transpose()
                .map_err(invalid_arg)?
                .unwrap_or_default(),
            kill_timeout: v.kill_timeout,
            shell_path: v.shell_path,
        })
    }
}

/// An event emitted during concurrent execution.
/// Discriminated by the `kind` field.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ProcessEvent {
    /// Event type: "started", "stdout", "stderr", "close", "error".
    pub kind: String,
    /// Index of the command that produced this event.
    pub index: u32,
    /// Text content (for stdout/stderr events).
    pub text: Option<String>,
    /// Exit code (for close events); `128 + signal` if a signal ended the process.
    pub exit_code: Option<i32>,
    /// Whether the process was killed (for close events).
    pub killed: Option<bool>,
    /// Error message (for error events).
    pub message: Option<String>,
    /// Command name (for close events).
    pub command_name: Option<String>,
    /// Duration in milliseconds (for close events).
    pub duration_ms: Option<f64>,
    /// OS process id (for started events). `None` when the platform
    /// could not provide a pid for the freshly spawned child.
    pub pid: Option<u32>,
    /// Number of lines in `text` (for stdout/stderr events): when present and above 1, `text`
    /// holds that many lines joined with `\n`, and the host splits it. Absent means one line.
    pub count: Option<u32>,
}

impl From<Delivered> for ProcessEvent {
    fn from(item: Delivered) -> Self {
        match item {
            Delivered::Event(event) => event.into(),
            Delivered::Lines { index, stderr, text, count } => Self {
                kind: (if stderr { "stderr" } else { "stdout" }).to_string(),
                index,
                text: Some(text),
                exit_code: None,
                killed: None,
                message: None,
                command_name: None,
                duration_ms: None,
                pid: None,
                count: Some(count),
            },
        }
    }
}

impl From<core::ProcessEvent> for ProcessEvent {
    fn from(event: core::ProcessEvent) -> Self {
        let kind = event.kind().to_string();
        let mut flat = Self {
            kind,
            index: event.index(),
            text: None,
            exit_code: None,
            killed: None,
            message: None,
            command_name: None,
            duration_ms: None,
            pid: None,
            count: None,
        };

        match event {
            core::ProcessEvent::Started { pid, .. } => flat.pid = pid,
            core::ProcessEvent::Stdout { text, .. } | core::ProcessEvent::Stderr { text, .. } => flat.text = Some(text),
            core::ProcessEvent::Close { exit_code, killed, command_name, duration_ms, .. } => {
                flat.exit_code = Some(exit_code);
                flat.killed = Some(killed);
                flat.command_name = command_name;
                flat.duration_ms = Some(duration_ms);
            }
            core::ProcessEvent::Error { message, .. } => flat.message = Some(message),
        }

        flat
    }
}

/// Result of a close event for a single command.
#[napi(object)]
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

impl From<core::ConcurrentCloseEvent> for ConcurrentCloseEvent {
    fn from(v: core::ConcurrentCloseEvent) -> Self {
        let core::ConcurrentCloseEvent { index, command, name, exit_code, killed, duration_ms } = v;
        Self { index, command, name, exit_code, killed, duration_ms }
    }
}

/// Overall result of a concurrent run.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ConcurrentRunResult {
    /// Close events for all commands, in completion order.
    pub close_events: Vec<ConcurrentCloseEvent>,
    /// Whether the run succeeded according to the success condition.
    pub success: bool,
}

impl From<core::ConcurrentRunResult> for ConcurrentRunResult {
    fn from(v: core::ConcurrentRunResult) -> Self {
        let core::ConcurrentRunResult { close_events, success } = v;
        Self { close_events: close_events.into_iter().map(Into::into).collect(), success }
    }
}

/// What `startConcurrent` hands its callback: events in the order they happened, and, as the
/// very last batch, how the run ended.
///
/// Every event of a run is delivered before the batch that carries `result` or `error`, so a
/// caller that settles its promise from that batch has seen everything first.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ProcessEventBatch {
    /// Events in the order they happened; empty in the final batch.
    pub events: Vec<ProcessEvent>,
    /// Present in the final batch only: the outcome of the run.
    pub result: Option<ConcurrentRunResult>,
    /// Present in the final batch only, instead of `result`, if the run itself failed.
    pub error: Option<String>,
}
