use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::{mpsc, watch};

use task_runner_core::concurrent::types::{ControlMessage, ProcessEvent as CoreProcessEvent};
use task_runner_core::ConcurrentRunner;

use super::types::{ConcurrentCommandConfig, ConcurrentRunResult, ConcurrentRunnerOptions, ProcessEvent};

/// A JS event callback. It is declared with `CalleeHandled = false`, so JS receives
/// the event itself as its first argument rather than the Node-style `(error, event)`.
type EventCallback = ThreadsafeFunction<ProcessEvent, (), ProcessEvent, Status, false>;

/// Parse the JS-side configuration once; an unknown option value is an error.
fn new_runner(commands: Vec<ConcurrentCommandConfig>, options: ConcurrentRunnerOptions) -> Result<ConcurrentRunner> {
    let commands = commands.into_iter().map(TryInto::try_into).collect::<Result<Vec<_>>>()?;

    Ok(ConcurrentRunner::new(commands, &options.try_into()?))
}

/// What a running run hands back: a way to steer it and a way to wait for it.
struct Launched {
    control: mpsc::UnboundedSender<ControlMessage>,
    result: watch::Receiver<Option<ConcurrentRunResult>>,
}

/// Start `runner` on the async runtime and forward its events to `on_event`.
///
/// With `with_output` false only the low-frequency lifecycle events ("started", "close",
/// "error") are forwarded, never per-line stdout/stderr, so callers can track child PIDs
/// for cleanup without paying for streaming every output line through NAPI.
///
/// The callback lives in the forwarding task and is dropped when the run ends, so it never
/// keeps Node alive after the result is available.
fn launch(runner: ConcurrentRunner, on_event: Option<EventCallback>, with_output: bool) -> Launched {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<CoreProcessEvent>();
    let (control, control_rx) = mpsc::unbounded_channel();
    let (result_tx, result) = watch::channel(None);

    // Drain events on a background task so the runner's unbounded channel never backs up,
    // even without a callback: the runner sends every event, stdout and stderr included.
    let forwarder = spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let Some(callback) = on_event.as_ref() else {
                continue;
            };

            if with_output || !matches!(event, CoreProcessEvent::Stdout { .. } | CoreProcessEvent::Stderr { .. }) {
                callback.call(event.into(), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    });

    spawn(async move {
        let outcome = runner.run(event_tx, control_rx).await;

        // `run` has dropped its event sender, so the forwarder ends once the queue is empty.
        let _ = forwarder.await;
        let _ = result_tx.send(Some(outcome.into()));
    });

    Launched { control, result }
}

/// Wait for the result of a launched run. May be called any number of times.
async fn wait_for_result(mut result: watch::Receiver<Option<ConcurrentRunResult>>) -> Result<ConcurrentRunResult> {
    let ready = result
        .wait_for(Option::is_some)
        .await
        .map_err(|_| Error::new(Status::GenericFailure, "the concurrent run ended without a result"))?;

    Ok(ready.clone().expect("wait_for only returns once the result is set"))
}

/// Run commands concurrently with real-time event streaming.
///
/// Each stdout/stderr line and process lifecycle event is sent to the
/// `on_event` callback as it occurs. The function resolves with the
/// final result after all processes have completed.
///
/// Commands originate from package.json scripts (trusted input).
#[napi]
pub async fn run_concurrent(
    commands: Vec<ConcurrentCommandConfig>,
    options: ConcurrentRunnerOptions,
    #[napi(ts_arg_type = "(event: ProcessEvent) => void")] on_event: EventCallback,
) -> Result<ConcurrentRunResult> {
    let launched = launch(new_runner(commands, options)?, Some(on_event), true);

    wait_for_result(launched.result).await
}

/// Run commands concurrently without per-line event streaming.
///
/// Collects all output internally and returns the final result. The
/// optional `on_lifecycle` callback receives only low-frequency
/// lifecycle events ("started", "close", "error") — never per-line
/// stdout/stderr — so callers can track child PIDs for SIGINT cleanup
/// without paying the throughput cost (and platform flakiness) of
/// streaming every output line back through NAPI.
///
/// Commands originate from package.json scripts (trusted input).
#[napi]
pub async fn run_concurrent_batch(
    commands: Vec<ConcurrentCommandConfig>,
    options: ConcurrentRunnerOptions,
    #[napi(ts_arg_type = "((event: ProcessEvent) => void) | undefined | null")] on_lifecycle: Option<EventCallback>,
) -> Result<ConcurrentRunResult> {
    let launched = launch(new_runner(commands, options)?, on_lifecycle, false);

    wait_for_result(launched.result).await
}

/// A concurrent run that is already in progress.
///
/// The addon installs no signal handlers: the host decides which signals mean "stop" and calls
/// `abort`. A run whose handle is dropped keeps going until its commands finish.
#[napi]
pub struct ConcurrentRun {
    control: mpsc::UnboundedSender<ControlMessage>,
    result: watch::Receiver<Option<ConcurrentRunResult>>,
}

/// Start commands concurrently and return a handle to the run.
///
/// Like `runConcurrentBatch`, `onLifecycle` receives only "started", "close" and "error" events.
/// An unknown option value throws before anything is spawned.
///
/// Commands originate from package.json scripts (trusted input).
#[napi(
    ts_args_type = "commands: ConcurrentCommandConfig[], options: ConcurrentRunnerOptions, onLifecycle?: ((event: ProcessEvent) => void) | undefined | null"
)]
pub fn start_concurrent(
    commands: Vec<ConcurrentCommandConfig>,
    options: ConcurrentRunnerOptions,
    on_lifecycle: Option<EventCallback>,
) -> Result<ConcurrentRun> {
    let Launched { control, result } = launch(new_runner(commands, options)?, on_lifecycle, false);

    Ok(ConcurrentRun { control, result })
}

#[napi]
impl ConcurrentRun {
    /// Stop the run: kill every running command and start no queued one.
    ///
    /// `"interrupt"` is a user interrupt (Ctrl+C): every command then closes with exit code 0 and
    /// `killed: true`, because cancelling is not a failure. `"terminate"` (the default) keeps the
    /// commands' exit codes. Calling it again, or after the run has finished, does nothing.
    #[napi(ts_args_type = "mode?: 'interrupt' | 'terminate'")]
    pub fn abort(&self, mode: Option<String>) -> Result<()> {
        let graceful = match mode.as_deref() {
            Some("interrupt") => true,
            Some("terminate") | None => false,
            Some(other) => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("invalid abort mode {other:?}: expected \"interrupt\" or \"terminate\""),
                ))
            }
        };

        let _ = self.control.send(ControlMessage::Abort { graceful });

        Ok(())
    }

    /// Signal one command's process tree (`signal` defaults to the run's `killSignal`).
    /// Returns false when the run has already finished; a command that is not running is ignored.
    #[napi]
    pub fn kill(&self, index: u32, signal: Option<String>) -> Result<bool> {
        let signal = signal.as_deref().map(str::parse).transpose().map_err(
            |error: task_runner_core::concurrent::types::InvalidOption| {
                Error::new(Status::InvalidArg, error.to_string())
            },
        )?;

        Ok(self.control.send(ControlMessage::Kill { index, signal }).is_ok())
    }

    /// Resolves with the result once every command has finished. May be awaited more than once.
    #[napi]
    pub fn done<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ConcurrentRunResult>> {
        env.spawn_future(wait_for_result(self.result.clone()))
    }
}
