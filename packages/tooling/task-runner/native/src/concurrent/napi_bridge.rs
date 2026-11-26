use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use task_runner_core::concurrent::events::{event_channel, EventBatch};
use task_runner_core::concurrent::grouping::group_output;
use task_runner_core::concurrent::types::{ControlMessage, ProcessEvent as CoreProcessEvent};
use task_runner_core::ConcurrentRunner;

use super::types::{
    ConcurrentCommandConfig, ConcurrentRunResult, ConcurrentRunnerOptions, ProcessEvent, ProcessEventBatch, PtySize,
};

/// How many output lines may be waiting for JavaScript at once, queued or being handled.
/// A child that writes faster than the callback consumes blocks on its pipe past this.
const OUTPUT_CREDITS: usize = 4096;

/// The most events handed to JavaScript in one call.
const MAX_BATCH: usize = 512;

/// The callback of `startConcurrent`. `CalleeHandled = false`: JS receives the batch itself.
type BatchCallback = ThreadsafeFunction<ProcessEventBatch, (), ProcessEventBatch, Status, false>;

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

/// Queue one batch for JavaScript. The batch's credits (see `event_channel`) come back when
/// JavaScript has finished with it, not when it was queued, so what is queued or being handled
/// stays bounded while several batches are in flight: the forwarder does not wait for each one,
/// which would cost a round trip to the JavaScript thread per batch. JavaScript runs the calls in
/// the order they were queued. Lines are left out unless `with_output`, and a batch with nothing
/// left is not sent at all. False when there is no callback, or JavaScript can no longer be
/// reached or has thrown (`broken`).
fn deliver(
    callback: Option<&BatchCallback>,
    mut batch: EventBatch,
    with_output: bool,
    broken: &Arc<AtomicBool>,
) -> bool {
    // Adjacent lines of one stream travel as one object: building a JS object per line is what
    // an output-heavy run spends its time on.
    let wanted = std::mem::take(&mut batch.events)
        .into_iter()
        .filter(|event| {
            with_output || !matches!(event, CoreProcessEvent::Stdout { .. } | CoreProcessEvent::Stderr { .. })
        })
        .collect();
    let events: Vec<ProcessEvent> = group_output(wanted).into_iter().map(Into::into).collect();

    let Some(callback) = callback else {
        return false;
    };

    if broken.load(Ordering::Acquire) {
        return false;
    }

    if events.is_empty() {
        return true;
    }

    let flag = Arc::clone(broken);
    let status = callback.call_with_return_value(
        ProcessEventBatch { events, result: None, error: None },
        ThreadsafeFunctionCallMode::NonBlocking,
        move |returned, _env| {
            // Only now, with the callback done, does the batch give its credits back.
            drop(batch);

            if returned.is_err() {
                flag.store(true, Ordering::Release);
            }

            Ok(())
        },
    );

    status == Status::Ok
}

/// Start `runner` and forward its events to `on_batch`, in batches, ending with the result.
///
/// A batch gives its output credits back when the callback has returned for it (see `deliver`), so
/// the credits (see `event_channel`) measure what JavaScript has not finished with. A child that
/// outpaces the callback blocks on its pipe instead of filling memory.
///
/// The callback lives in the forwarding task and is dropped when the run ends, so it never keeps
/// Node alive after the result has been delivered.
fn launch_stream(runner: ConcurrentRunner, on_batch: Option<BatchCallback>, with_output: bool) -> Launched {
    let (sink, mut stream) = event_channel(OUTPUT_CREDITS);
    let (control, control_rx) = mpsc::unbounded_channel();
    let (result_tx, result) = watch::channel(None);

    spawn(async move {
        let mut run = tokio::spawn(async move { runner.run(sink, control_rx).await });
        let mut callback = on_batch;
        let broken = Arc::new(AtomicBool::new(false));
        let mut outcome = None;

        // Everything the run produced goes out first, in the order it was produced.
        loop {
            tokio::select! {
                batch = stream.next_batch(MAX_BATCH) => match batch {
                    Some(batch) => {
                        if !deliver(callback.as_ref(), batch, with_output, &broken) {
                            callback = None;
                        }
                    }
                    None => break,
                },
                joined = &mut run => {
                    outcome = Some(joined);

                    break;
                }
            }
        }

        let outcome = match outcome {
            Some(outcome) => outcome,
            None => run.await,
        };

        // A reader that was abandoned (a descendant held its pipe) must not add events after this
        // point, or block waiting for a credit that will never come.
        stream.close();

        while let Some(batch) = stream.try_next_batch(MAX_BATCH) {
            if !deliver(callback.as_ref(), batch, with_output, &broken) {
                callback = None;
            }
        }

        let last = match outcome {
            Ok(outcome) => {
                let outcome: ConcurrentRunResult = outcome.into();
                let _ = result_tx.send(Some(outcome.clone()));

                ProcessEventBatch { events: Vec::new(), result: Some(outcome), error: None }
            }
            Err(error) => ProcessEventBatch {
                events: Vec::new(),
                result: None,
                error: Some(format!("the concurrent run ended without a result: {error}")),
            },
        };

        if let Some(callback) = callback {
            let _ = callback.call_async(last).await;
        }
    });

    Launched { control, result }
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
/// `onBatch` receives the events in the order they happened, several at a time, and the outcome
/// of the run as the last batch (`result`, or `error` if the run itself failed); every event is
/// delivered before it. Adjacent "stdout" or "stderr" lines of one command arrive as one event: its
/// `count` is above 1 and its `text` is those lines joined with `\n` (see `ProcessEvent.count`). Only "started", "close" and "error" events are reported unless
/// `options.streamOutput` is set, which adds the "stdout" and "stderr" lines (for a pty, raw chunks).
/// An unknown option value throws before anything is spawned.
///
/// Commands originate from package.json scripts (trusted input).
#[napi(
    ts_args_type = "commands: ConcurrentCommandConfig[], options: ConcurrentRunnerOptions, onBatch?: ((batch: ProcessEventBatch) => void) | undefined | null"
)]
pub fn start_concurrent(
    commands: Vec<ConcurrentCommandConfig>,
    options: ConcurrentRunnerOptions,
    on_batch: Option<BatchCallback>,
) -> Result<ConcurrentRun> {
    let with_output = options.stream_output.unwrap_or(false);
    let Launched { control, result } = launch_stream(new_runner(commands, options)?, on_batch, with_output);

    Ok(ConcurrentRun { control, result })
}

#[napi]
impl ConcurrentRun {
    /// Stop the run: kill every running command and start no queued one.
    ///
    /// `"interrupt"` is a user interrupt (Ctrl+C): every command then closes with exit code 0 and
    /// `killed: true` in the result, because cancelling is not a failure; the `close` events keep
    /// the exit codes the commands really had. `"terminate"` (the default) keeps the exit codes in
    /// the result too. Calling it again, or after the run has finished, does nothing.
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

    /// Write `data` to a running command's stdin (a pipe, or a pty). Returns false when the run
    /// has already finished; a command that is not running, or has neither, is ignored. The write
    /// is queued, never waited for, so a child that does not read cannot block the caller.
    #[napi]
    pub fn write(&self, index: u32, data: String) -> bool {
        self.control.send(ControlMessage::Write { index, data: data.into_bytes() }).is_ok()
    }

    /// Resize a running pty command's terminal. Returns false when the run has already finished;
    /// a command that is not running in a pty is ignored. Throws if a dimension is 0 or above 65535.
    #[napi]
    pub fn resize(&self, index: u32, cols: u32, rows: u32) -> Result<bool> {
        let size = PtySize::parse(cols, rows)?;

        Ok(self.control.send(ControlMessage::Resize { index, size }).is_ok())
    }

    /// Resolves with the result once every command has finished. May be awaited more than once.
    #[napi]
    pub fn done<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ConcurrentRunResult>> {
        env.spawn_future(wait_for_result(self.result.clone()))
    }
}
