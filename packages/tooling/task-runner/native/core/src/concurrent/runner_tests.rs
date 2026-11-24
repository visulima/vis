#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;

    use crate::concurrent::completion::SuccessCondition;
    use crate::concurrent::runner::ConcurrentRunner;
    use crate::concurrent::types::{
        ConcurrentCommandConfig, ConcurrentRunResult, ConcurrentRunnerOptions, KillOthers, ProcessEvent, StdinMode,
    };

    /// Run all commands and collect results without streaming events.
    async fn run_batch(runner: &ConcurrentRunner) -> ConcurrentRunResult {
        let (event_tx, _event_rx) = mpsc::unbounded_channel();

        runner.run(event_tx).await
    }

    fn make_config(command: &str, name: Option<&str>) -> ConcurrentCommandConfig {
        ConcurrentCommandConfig {
            command: command.to_string(),
            name: name.map(|s| s.to_string()),
            ..Default::default()
        }
    }

    fn default_options() -> ConcurrentRunnerOptions {
        ConcurrentRunnerOptions::default()
    }

    #[tokio::test]
    async fn test_single_echo_command() {
        let commands = vec![make_config("echo hello", Some("greeter"))];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();

        let result = runner.run(event_tx).await;

        assert!(result.success);
        assert_eq!(result.close_events.len(), 1);
        assert_eq!(result.close_events[0].exit_code, 0);
        assert_eq!(result.close_events[0].name.as_deref(), Some("greeter"));

        // Collect events -- should have at least one stdout and one close
        let mut stdout_count = 0;
        let mut close_count = 0;
        while let Ok(event) = event_rx.try_recv() {
            match event {
                ProcessEvent::Stdout { text, .. } => {
                    stdout_count += 1;
                    assert_eq!(text, "hello");
                }
                ProcessEvent::Close { .. } => close_count += 1,
                _ => {}
            }
        }
        assert!(stdout_count >= 1, "expected at least one stdout event");
        assert_eq!(close_count, 1, "expected exactly one close event");
    }

    #[tokio::test]
    async fn test_started_event_carries_pid() {
        // Single command -- we expect exactly one "started" event with a
        // populated pid before any close event arrives.
        let commands = vec![make_config("echo hello", Some("greeter"))];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let _ = runner.run(event_tx).await;

        let mut started: Vec<(u32, Option<u32>)> = Vec::new();
        let mut close_seen_before_started = false;
        let mut close_seen = false;
        while let Ok(event) = event_rx.try_recv() {
            match event {
                ProcessEvent::Started { index, pid } => {
                    if close_seen {
                        close_seen_before_started = true;
                    }
                    started.push((index, pid));
                }
                ProcessEvent::Close { .. } => close_seen = true,
                _ => {}
            }
        }

        assert_eq!(started.len(), 1, "expected exactly one started event");
        assert_eq!(started[0].0, 0);
        assert!(started[0].1.is_some(), "started event should carry a pid");
        assert!(started[0].1.unwrap() > 0, "pid should be a positive integer");
        assert!(!close_seen_before_started, "started event must arrive before close event");
    }

    #[tokio::test]
    async fn test_multiple_commands() {
        let commands = vec![
            make_config("echo one", Some("first")),
            make_config("echo two", Some("second")),
            make_config("echo three", Some("third")),
        ];
        let runner = ConcurrentRunner::new(commands, &default_options());
        let result = run_batch(&runner).await;

        assert!(result.success);
        assert_eq!(result.close_events.len(), 3);
        for event in &result.close_events {
            assert_eq!(event.exit_code, 0);
        }
    }

    #[tokio::test]
    async fn test_failing_command() {
        let commands = vec![make_config("exit 42", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());
        let result = run_batch(&runner).await;

        assert!(!result.success);
        assert_eq!(result.close_events.len(), 1);
        assert_eq!(result.close_events[0].exit_code, 42);
    }

    #[tokio::test]
    async fn test_mixed_success_and_failure() {
        let commands = vec![make_config("echo ok", Some("good")), make_config("exit 1", Some("bad"))];
        let runner = ConcurrentRunner::new(commands, &default_options());
        let result = run_batch(&runner).await;

        assert!(!result.success); // default is "all" -- one failed
        assert_eq!(result.close_events.len(), 2);
    }

    #[tokio::test]
    async fn test_success_condition_first() {
        let commands = vec![make_config("echo ok", Some("fast")), make_config("sleep 0.1 && exit 1", Some("slow"))];
        let mut opts = default_options();
        opts.success_condition = SuccessCondition::First;
        let runner = ConcurrentRunner::new(commands, &opts);
        let result = run_batch(&runner).await;

        // First to complete should be "echo ok" (instant)
        assert!(result.success);
    }

    #[tokio::test]
    async fn test_max_processes_queuing() {
        // With maxProcesses=1, commands run sequentially
        let commands =
            vec![make_config("echo one", None), make_config("echo two", None), make_config("echo three", None)];
        let mut opts = default_options();
        opts.max_processes = Some(1);
        let runner = ConcurrentRunner::new(commands, &opts);
        let result = run_batch(&runner).await;

        assert!(result.success);
        assert_eq!(result.close_events.len(), 3);
        // With max_processes=1, they should complete in order
        assert_eq!(result.close_events[0].index, 0);
        assert_eq!(result.close_events[1].index, 1);
        assert_eq!(result.close_events[2].index, 2);
    }

    #[tokio::test]
    async fn test_kill_others_on_failure() {
        let commands = vec![make_config("exit 1", Some("fails-fast")), make_config("sleep 10", Some("long-running"))];
        let mut opts = default_options();
        opts.kill_others = vec![KillOthers::Failure];
        opts.kill_timeout = Some(1000);
        let runner = ConcurrentRunner::new(commands, &opts);

        let start = std::time::Instant::now();
        let result = run_batch(&runner).await;
        let elapsed = start.elapsed();

        assert!(!result.success);
        assert_eq!(result.close_events.len(), 2);
        // Should complete much faster than 10 seconds
        assert!(elapsed.as_secs() < 5, "kill-others should have killed the long-running process, took {:?}", elapsed);
    }

    #[tokio::test]
    async fn test_stderr_output() {
        let commands = vec![make_config("echo error >&2", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        assert!(result.success);

        let mut has_stderr = false;
        while let Ok(event) = event_rx.try_recv() {
            if let ProcessEvent::Stderr { text, .. } = event {
                has_stderr = true;
                assert_eq!(text, "error");
            }
        }
        assert!(has_stderr, "expected stderr event");
    }

    #[tokio::test]
    async fn test_environment_variables() {
        let mut env = std::collections::HashMap::new();
        env.insert("TEST_VAR".to_string(), "hello_from_rust".to_string());

        let commands = vec![ConcurrentCommandConfig {
            command: "echo $TEST_VAR".to_string(),
            name: None,
            cwd: None,
            env: Some(env),
            shell: None,
            stdin: StdinMode::Null,
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        assert!(result.success);

        let mut found = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text == "hello_from_rust") {
                found = true;
            }
        }
        assert!(found, "expected env var to be passed to child process");
    }

    #[tokio::test]
    async fn test_spawn_nonexistent_command() {
        let commands = vec![make_config("nonexistent_command_that_does_not_exist_xyz", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, _event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        // The shell will report the error, exit code should be non-zero
        assert!(!result.success);
        assert_eq!(result.close_events.len(), 1);
        assert_ne!(result.close_events[0].exit_code, 0);
    }

    #[tokio::test]
    async fn test_empty_commands() {
        let commands = vec![];
        let runner = ConcurrentRunner::new(commands, &default_options());
        let result = run_batch(&runner).await;

        assert!(result.success);
        assert!(result.close_events.is_empty());
    }

    #[tokio::test]
    async fn test_multiline_output_ordering() {
        // Verify that all stdout lines arrive before the close event
        let commands = vec![make_config("echo line1 && echo line2 && echo line3", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        assert!(result.success);

        let mut events: Vec<ProcessEvent> = Vec::new();
        while let Ok(event) = event_rx.try_recv() {
            events.push(event);
        }

        // Find the close event index
        let close_idx = events.iter().position(|e| matches!(e, ProcessEvent::Close { .. }));
        let stdout_events: Vec<_> = events.iter().filter(|e| matches!(e, ProcessEvent::Stdout { .. })).collect();

        assert!(close_idx.is_some(), "expected a close event");
        assert_eq!(stdout_events.len(), 3, "expected 3 stdout lines");

        // All stdout events must come before the close event
        for (i, event) in events.iter().enumerate() {
            if matches!(event, ProcessEvent::Stdout { .. }) {
                assert!(
                    i < close_idx.unwrap(),
                    "stdout event at index {} came after close event at index {}",
                    i,
                    close_idx.unwrap()
                );
            }
        }
    }

    #[tokio::test]
    async fn test_close_event_has_duration() {
        let commands = vec![make_config("sleep 0.1", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());
        let result = run_batch(&runner).await;

        assert!(result.success);
        assert!(
            result.close_events[0].duration_ms >= 50.0,
            "expected duration >= 50ms, got {}",
            result.close_events[0].duration_ms
        );
    }

    #[tokio::test]
    async fn test_success_condition_command_by_name() {
        let commands = vec![make_config("exit 1", Some("irrelevant")), make_config("echo ok", Some("important"))];
        let mut opts = default_options();
        opts.success_condition = SuccessCondition::Command("important".to_string());
        let runner = ConcurrentRunner::new(commands, &opts);
        let result = run_batch(&runner).await;

        // Only "important" needs to succeed
        assert!(result.success);
    }

    #[tokio::test]
    async fn test_working_directory() {
        let commands = vec![ConcurrentCommandConfig {
            command: "pwd".to_string(),
            name: None,
            cwd: Some("/tmp".to_string()),
            env: None,
            shell: None,
            stdin: StdinMode::Null,
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        assert!(result.success);

        let mut found_tmp = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text.contains("tmp")) {
                found_tmp = true;
            }
        }
        assert!(found_tmp, "expected /tmp in pwd output");
    }

    #[tokio::test]
    async fn test_direct_execution_without_shell() {
        let commands = vec![ConcurrentCommandConfig {
            command: "echo direct-mode".to_string(),
            name: None,
            cwd: None,
            env: None,
            shell: Some(false),
            stdin: StdinMode::Null,
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        assert!(result.success);

        let mut found = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text == "direct-mode") {
                found = true;
            }
        }
        assert!(found, "expected 'direct-mode' in output");
    }

    #[tokio::test]
    async fn test_shell_true_supports_pipes() {
        // Pipes require shell execution
        let commands = vec![ConcurrentCommandConfig {
            command: "echo piped | cat".to_string(),
            name: None,
            cwd: None,
            env: None,
            shell: Some(true),
            stdin: StdinMode::Null,
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        assert!(result.success);

        let mut found = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text == "piped") {
                found = true;
            }
        }
        assert!(found, "expected 'piped' in output from shell pipe");
    }

    #[tokio::test]
    async fn test_stdin_null_is_default() {
        // Command that tries to read stdin should get EOF immediately
        let commands = vec![ConcurrentCommandConfig {
            command: "cat".to_string(),
            name: None,
            cwd: None,
            env: None,
            shell: Some(true),
            stdin: StdinMode::Null,
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());
        let result = run_batch(&runner).await;

        // cat with no stdin should exit 0 (reads EOF)
        assert!(result.success);
        assert_eq!(result.close_events[0].exit_code, 0);
    }

    #[tokio::test]
    async fn test_stdin_pipe_mode() {
        // echo doesn't read stdin, so pipe mode doesn't block
        let commands = vec![ConcurrentCommandConfig {
            command: "echo pipe-test".to_string(),
            name: None,
            cwd: None,
            env: None,
            shell: Some(true),
            stdin: StdinMode::Pipe,
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        assert!(result.success);

        let mut found = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text == "pipe-test") {
                found = true;
            }
        }
        assert!(found, "expected 'pipe-test' in output");
    }

    #[tokio::test]
    async fn test_custom_shell_path() {
        // Use /bin/bash explicitly as shell_path
        let commands = vec![make_config("echo custom-shell", None)];
        let mut opts = default_options();
        opts.shell_path = Some("/bin/bash".to_string());
        let runner = ConcurrentRunner::new(commands, &opts);

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx).await;

        assert!(result.success);

        let mut found = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text == "custom-shell") {
                found = true;
            }
        }
        assert!(found, "expected 'custom-shell' in output via /bin/bash");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_signalled_child_exit_code_is_128_plus_signal() {
        let commands = vec![make_config("kill -TERM $$", None), make_config("kill -KILL $$", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());
        let result = run_batch(&runner).await;

        let by_index = |i: u32| result.close_events.iter().find(|e| e.index == i).unwrap();

        assert_eq!(by_index(0).exit_code, 143);
        assert!(by_index(0).killed, "a signalled child is reported as killed");
        assert_eq!(by_index(1).exit_code, 137);
        assert!(by_index(1).killed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_descendant_holding_pipes_does_not_hang_the_run() {
        // `sleep 5 &` inherits the stdout/stderr pipes and outlives the shell.
        let commands = vec![make_config("sleep 5 &", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let start = std::time::Instant::now();
        let result = tokio::time::timeout(std::time::Duration::from_secs(4), run_batch(&runner))
            .await
            .expect("run must finish once the drain grace has passed");

        assert!(result.success);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(3),
            "expected completion within the 2s drain grace + 1s, took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn test_kill_signal_parses_node_and_bare_names_in_any_case() {
        use crate::concurrent::types::KillSignal;

        for (input, expected) in [
            ("SIGTERM", KillSignal::Term),
            ("sigkill", KillSignal::Kill),
            ("INT", KillSignal::Int),
            ("SIGHUP", KillSignal::Hup),
            ("SIGQUIT", KillSignal::Quit),
            ("SIGUSR1", KillSignal::Usr1),
            ("SIGUSR2", KillSignal::Usr2),
            ("SIGABRT", KillSignal::Abrt),
            ("SIGALRM", KillSignal::Alrm),
        ] {
            assert_eq!(input.parse::<KillSignal>().unwrap(), expected, "{input}");
        }
    }

    #[test]
    fn test_unknown_option_values_are_errors_that_name_the_value() {
        use crate::concurrent::types::{KillOthers, KillSignal};

        let signal = "SIGBOGUS".parse::<KillSignal>().unwrap_err();
        assert_eq!((signal.option, signal.value.as_str()), ("killSignal", "SIGBOGUS"));

        let stdin = "telepathy".parse::<StdinMode>().unwrap_err();
        assert_eq!((stdin.option, stdin.value.as_str()), ("stdin", "telepathy"));

        let kill_others = "maybe".parse::<KillOthers>().unwrap_err();
        assert_eq!((kill_others.option, kill_others.value.as_str()), ("killOthers", "maybe"));
        assert!(kill_others.to_string().contains("\"maybe\""));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_kill_signal_other_than_the_default_is_the_one_sent() {
        use crate::concurrent::types::KillSignal;

        // The child exits with 70 only if it receives SIGUSR1; SIGTERM would give 143.
        let commands = vec![
            make_config("trap 'exit 70' USR1; sleep 0.3 & wait", Some("trapper")),
            make_config("sleep 0.1; exit 1", Some("fails")),
        ];
        let mut opts = default_options();
        opts.kill_others = vec![KillOthers::Failure];
        opts.kill_signal = KillSignal::Usr1;
        let runner = ConcurrentRunner::new(commands, &opts);
        let result = run_batch(&runner).await;

        let trapper = result.close_events.iter().find(|e| e.index == 0).unwrap();
        assert_eq!(trapper.exit_code, 70);
        assert!(trapper.killed);
    }
}
