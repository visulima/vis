use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

use super::completion::SuccessCondition;
use super::events::EventSink;
use super::process::{spawn_process, CompletionMessage, ProcessInfo};
use super::types::{
    ConcurrentCloseEvent, ConcurrentCommandConfig, ConcurrentRunResult, ConcurrentRunnerOptions, ControlMessage,
    KillOthers, KillSignal, ProcessEvent,
};

/// Orchestrates concurrent execution of multiple commands.
pub struct ConcurrentRunner {
    commands: Vec<ConcurrentCommandConfig>,
    max_processes: usize,
    kill_signal: KillSignal,
    kill_others: Vec<KillOthers>,
    success_condition: SuccessCondition,
    kill_timeout_ms: u64,
    shell_path: Option<String>,
}

impl ConcurrentRunner {
    pub fn new(commands: Vec<ConcurrentCommandConfig>, options: &ConcurrentRunnerOptions) -> Self {
        let max_processes = options.max_processes.unwrap_or(0) as usize;
        let max_processes = if max_processes == 0 { commands.len() } else { max_processes };

        Self {
            commands,
            max_processes,
            kill_signal: options.kill_signal,
            kill_others: options.kill_others.clone(),
            success_condition: options.success_condition.clone(),
            kill_timeout_ms: options.kill_timeout.unwrap_or(5000) as u64,
            shell_path: options.shell_path.clone(),
        }
    }

    /// Run all commands concurrently with real-time event streaming.
    ///
    /// Events are sent to `events` as they occur: a bare unbounded channel sender, or the sink of
    /// an [`event_channel`](super::events::event_channel) when the consumer should be able to
    /// slow the commands down. `control_rx` carries
    /// requests from the caller to stop the run, kill one command or feed its stdin; the runner
    /// installs no signal handlers of its own, so whoever embeds it decides
    /// which signals mean "abort" and forwards them here. Dropping the sender
    /// does not stop the run.
    ///
    /// Returns the final result after all processes complete.
    pub async fn run(
        &self,
        events: impl Into<EventSink>,
        mut control_rx: mpsc::UnboundedReceiver<ControlMessage>,
    ) -> ConcurrentRunResult {
        // Channel for process completion notifications
        let (completion_tx, mut completion_rx) = mpsc::unbounded_channel::<CompletionMessage>();

        let mut run = RunState {
            runner: self,
            events: events.into(),
            completion_tx,
            pending: (0..self.commands.len()).collect(),
            active: Vec::with_capacity(self.max_processes),
            close_events: Vec::with_capacity(self.commands.len()),
            aborting: false,
            interrupted: false,
            giving_up: Arc::new(AtomicBool::new(false)),
        };

        // An abort that was requested before the run started means nothing is spawned.
        while let Ok(message) = control_rx.try_recv() {
            run.handle_control(message);
        }

        run.spawn_batch();

        let mut control_open = true;

        while !run.active.is_empty() {
            tokio::select! {
                Some(message) = completion_rx.recv() => {
                    run.active.retain(|process| process.index != message.index);
                    run.record_close(message.close_event);

                    if !run.aborting {
                        run.spawn_batch();
                    }
                }
                message = control_rx.recv(), if control_open => match message {
                    Some(message) => run.handle_control(message),
                    None => control_open = false,
                },
            }
        }

        let success = self.success_condition.evaluate(&run.close_events);

        ConcurrentRunResult { close_events: run.close_events, success }
    }

    /// Send termination signals to every process in `active`.
    ///
    /// `graceful = true` is reserved for user-initiated Ctrl+C / SIGINT —
    /// on Windows it routes through `CTRL_BREAK_EVENT` so well-behaved CLIs
    /// can clean up before the Job Object force-kill fires. The kill-others
    /// path passes `false` for an immediate hard kill.
    fn kill_all_with(&self, active: &[ProcessInfo], graceful: bool) {
        for info in active {
            #[cfg(windows)]
            {
                if graceful {
                    // Send CTRL_BREAK_EVENT to the child's process group
                    // (which we created via CREATE_NEW_PROCESS_GROUP at spawn).
                    // The Job Object stays alive as a backstop — escalation
                    // below will TerminateJobObject if the child doesn't exit.
                    if let Some(pid) = info.pid {
                        let _ = super::process_group::graceful_shutdown(pid);
                    }
                    continue;
                }
            }

            #[cfg(unix)]
            let _ = graceful;

            self.signal_process(info, self.kill_signal);
        }

        // Schedule force-kill after timeout.
        //
        // On Windows the graceful path's final backstop is implicit:
        // every child has a Job Object configured with
        // `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so when its `ProcessInfo`
        // is dropped (after the completion event arrives), the kernel
        // tears down any surviving descendants. The `kill_tree` call
        // here covers the window between escalation and that drop —
        // missing grandchildren are caught by the Job Object close.
        //
        // Each entry carries the per-process `terminated` flag so the
        // timer skips pids whose child already exited cleanly. Without
        // this check, a 5s default kill_timeout is plenty of time for
        // the kernel to recycle the PID for an unrelated process,
        // which we would then SIGKILL.
        let kill_timeout = self.kill_timeout_ms;
        let targets: Vec<(u32, Arc<AtomicBool>)> =
            active.iter().filter_map(|p| p.pid.map(|pid| (pid, Arc::clone(&p.terminated)))).collect();
        if !targets.is_empty() {
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(kill_timeout)).await;
                for (pid, terminated) in targets {
                    if terminated.load(Ordering::Acquire) {
                        continue;
                    }
                    let _ = super::process_group::kill_tree(pid, KillSignal::Kill);
                }
            });
        }
    }

    /// Terminate one process tree. Unix signals the process group with `signal`;
    /// Windows ignores the signal and terminates the Job Object, or falls back to
    /// `taskkill /F /T` when no Job Object could be created at spawn time.
    fn signal_process(&self, info: &ProcessInfo, signal: KillSignal) {
        #[cfg(windows)]
        {
            if let Some(ref job) = info.job {
                let _ = job.terminate(1);
                return;
            }
        }

        if let Some(pid) = info.pid {
            let _ = super::process_group::kill_tree(pid, signal);
        }
    }

    fn should_kill_others(&self, event: &ConcurrentCloseEvent) -> bool {
        self.kill_others.iter().any(|condition| match condition {
            KillOthers::Failure => event.exit_code != 0,
            KillOthers::Success => event.exit_code == 0,
        })
    }
}

/// Mutable state of one `run`.
struct RunState<'a> {
    runner: &'a ConcurrentRunner,
    events: EventSink,
    completion_tx: mpsc::UnboundedSender<CompletionMessage>,
    /// Indices of the commands not yet spawned.
    pending: VecDeque<usize>,
    /// Processes that have been spawned and have not completed.
    active: Vec<ProcessInfo>,
    /// Close events in completion order.
    close_events: Vec<ConcurrentCloseEvent>,
    /// Whether the run is being torn down (abort or kill-others); nothing more is spawned.
    aborting: bool,
    /// Whether the abort was a user interrupt, which turns exit codes into 0.
    interrupted: bool,
    /// Set once the run is torn down: commands stop waiting for a consumer that is not reading.
    giving_up: Arc<AtomicBool>,
}

impl RunState<'_> {
    fn handle_control(&mut self, message: ControlMessage) {
        match message {
            ControlMessage::Abort { graceful } => {
                if !self.aborting {
                    self.runner.kill_all_with(&self.active, graceful);
                    self.aborting = true;
                    self.giving_up.store(true, Ordering::Release);
                    // A user interrupt is a cancellation, not a failure: closes report 0.
                    self.interrupted = graceful;
                }
            }
            ControlMessage::Kill { index, signal } => {
                if let Some(info) = self.running(index) {
                    self.runner.signal_process(info, signal.unwrap_or(self.runner.kill_signal));
                }
            }
            // Both only queue work for a thread of their own: the loop never waits for a child.
            ControlMessage::Write { index, data } => {
                if let Some(input) = self.running(index).and_then(|info| info.input.as_ref()) {
                    input.write(data);
                }
            }
            ControlMessage::Resize { index, size } => {
                if let Some(pty) = self.running(index).and_then(|info| info.pty.as_ref()) {
                    pty.resize(size);
                }
            }
        }
    }

    fn running(&self, index: u32) -> Option<&ProcessInfo> {
        self.active.iter().find(|process| process.index == index)
    }

    /// Spawn queued commands until `max_processes` are running. A command that
    /// cannot be spawned is closed on the spot, without taking a slot.
    fn spawn_batch(&mut self) {
        while !self.aborting && self.active.len() < self.runner.max_processes {
            let Some(index) = self.pending.pop_front() else {
                break;
            };
            let config = &self.runner.commands[index];

            match spawn_process(
                index as u32,
                config,
                &self.events,
                self.completion_tx.clone(),
                self.runner.shell_path.as_deref(),
                &self.giving_up,
            ) {
                Ok(info) => self.active.push(info),
                Err(error) => {
                    self.events.send(ProcessEvent::Error {
                        index: index as u32,
                        message: format!("Failed to spawn: {error}"),
                    });

                    // The command still appears in the results.
                    self.record_close(ConcurrentCloseEvent {
                        index: index as u32,
                        command: config.command.clone(),
                        name: config.name.clone(),
                        exit_code: 1,
                        killed: false,
                        duration_ms: 0.0,
                    });
                }
            }
        }
    }

    /// Account for a command that has finished: report it, apply kill-others,
    /// and keep it for the result.
    fn record_close(&mut self, mut close_event: ConcurrentCloseEvent) {
        if self.aborting {
            close_event.killed = true;

            if self.interrupted {
                close_event.exit_code = 0;
            }
        }

        self.events.send(ProcessEvent::Close {
            index: close_event.index,
            exit_code: close_event.exit_code,
            killed: close_event.killed,
            command_name: close_event.name.clone(),
            duration_ms: close_event.duration_ms,
        });

        // Hard-kill: this is a peer-induced abort, not a user Ctrl+C.
        if !self.aborting && self.runner.should_kill_others(&close_event) {
            self.runner.kill_all_with(&self.active, false);
            self.aborting = true;
            self.giving_up.store(true, Ordering::Release);
        }

        self.close_events.push(close_event);
    }
}
