use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::mpsc;

use task_runner_core::concurrent::types::ProcessEvent as CoreProcessEvent;
use task_runner_core::ConcurrentRunner;

use super::types::{ConcurrentCommandConfig, ConcurrentRunResult, ConcurrentRunnerOptions, ProcessEvent};

/// Parse the JS-side configuration once; an unknown option value is an error.
fn new_runner(commands: Vec<ConcurrentCommandConfig>, options: ConcurrentRunnerOptions) -> Result<ConcurrentRunner> {
    let commands = commands.into_iter().map(TryInto::try_into).collect::<Result<Vec<_>>>()?;

    Ok(ConcurrentRunner::new(commands, &options.try_into()?))
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
    #[napi(ts_arg_type = "(event: ProcessEvent) => void")] on_event: ThreadsafeFunction<ProcessEvent>,
) -> Result<ConcurrentRunResult> {
    let runner = new_runner(commands, options)?;

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<CoreProcessEvent>();

    // Spawn a task to forward events from the channel to the JS callback
    let forward_handle = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            on_event.call(Ok(event.into()), ThreadsafeFunctionCallMode::NonBlocking);
        }
    });

    let result = runner.run(event_tx).await;

    // Wait for all events to be forwarded
    let _ = forward_handle.await;

    Ok(result.into())
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
    #[napi(ts_arg_type = "((event: ProcessEvent) => void) | undefined | null")] on_lifecycle: Option<
        ThreadsafeFunction<ProcessEvent>,
    >,
) -> Result<ConcurrentRunResult> {
    let runner = new_runner(commands, options)?;

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<CoreProcessEvent>();

    // Drain (and optionally forward) events on a background task so the
    // runner's unbounded channel never backs up. We always drain — even
    // without a callback — because the runner itself sends every event
    // (including stdout/stderr) into this channel.
    let forward_handle = tokio::spawn(async move {
        match on_lifecycle {
            Some(cb) => {
                while let Some(event) = event_rx.recv().await {
                    // Filter to lifecycle-only. stdout/stderr are
                    // intentionally dropped here — batch mode doesn't
                    // expose them, and callers that need them should
                    // use `runConcurrent` instead.
                    if !matches!(event, CoreProcessEvent::Stdout { .. } | CoreProcessEvent::Stderr { .. }) {
                        cb.call(Ok(event.into()), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
            }
            None => while event_rx.recv().await.is_some() {},
        }
    });

    let result = runner.run(event_tx).await;

    let _ = forward_handle.await;

    Ok(result.into())
}
