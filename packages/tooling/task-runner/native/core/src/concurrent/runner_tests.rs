#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;

    use crate::concurrent::completion::SuccessCondition;
    use crate::concurrent::runner::ConcurrentRunner;
    use crate::concurrent::types::{
        ConcurrentCommandConfig, ConcurrentRunResult, ConcurrentRunnerOptions, ControlMessage, KillOthers,
        ProcessEvent, StdinMode,
    };

    /// A control channel nobody holds the sender of: the runner must carry on without it.
    fn no_control() -> mpsc::UnboundedReceiver<ControlMessage> {
        mpsc::unbounded_channel().1
    }

    /// Run all commands and collect results without streaming events.
    async fn run_batch(runner: &ConcurrentRunner) -> ConcurrentRunResult {
        let (event_tx, _event_rx) = mpsc::unbounded_channel();

        runner.run(event_tx, no_control()).await
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

        let result = runner.run(event_tx, no_control()).await;

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
        let _ = runner.run(event_tx, no_control()).await;

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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    // `cmd.exe` keeps the space before `>&2` in the text it echoes.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_stderr_output() {
        let commands = vec![make_config("echo error >&2", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx, no_control()).await;

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

    #[cfg(unix)]
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
            ..Default::default()
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx, no_control()).await;

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
        let result = runner.run(event_tx, no_control()).await;

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

    #[cfg(unix)]
    #[tokio::test]
    async fn test_multiline_output_ordering() {
        // Verify that all stdout lines arrive before the close event
        let commands = vec![make_config("echo line1 && echo line2 && echo line3", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx, no_control()).await;

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

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[tokio::test]
    async fn test_working_directory() {
        let commands = vec![ConcurrentCommandConfig {
            command: "pwd".to_string(),
            name: None,
            cwd: Some("/tmp".to_string()),
            env: None,
            shell: None,
            stdin: StdinMode::Null,
            ..Default::default()
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx, no_control()).await;

        assert!(result.success);

        let mut found_tmp = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text.contains("tmp")) {
                found_tmp = true;
            }
        }
        assert!(found_tmp, "expected /tmp in pwd output");
    }

    // `echo` is a shell builtin on Windows, so there is no program to run directly.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_direct_execution_without_shell() {
        let commands = vec![ConcurrentCommandConfig {
            command: "echo direct-mode".to_string(),
            name: None,
            cwd: None,
            env: None,
            shell: Some(false),
            stdin: StdinMode::Null,
            ..Default::default()
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx, no_control()).await;

        assert!(result.success);

        let mut found = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text == "direct-mode") {
                found = true;
            }
        }
        assert!(found, "expected 'direct-mode' in output");
    }

    /// Run one command and return its stdout lines, its error messages and its exit code.
    #[cfg(unix)]
    async fn run_one(config: ConcurrentCommandConfig) -> (Vec<String>, Vec<String>, i32) {
        let (event_tx, mut events) = mpsc::unbounded_channel::<ProcessEvent>();
        let runner = ConcurrentRunner::new(vec![config], &default_options());
        let result = runner.run(event_tx, no_control()).await;

        let (mut lines, mut errors) = (Vec::new(), Vec::new());
        while let Ok(event) = events.try_recv() {
            match event {
                ProcessEvent::Stdout { text, .. } => lines.push(text),
                ProcessEvent::Error { message, .. } => errors.push(message),
                _ => {}
            }
        }

        (lines, errors, result.close_events[0].exit_code)
    }

    /// A directory of its own under the system temp directory.
    #[cfg(unix)]
    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("task-runner-{name}-{}", std::process::id()));

        std::fs::create_dir_all(&dir).unwrap();

        dir
    }

    #[cfg(unix)]
    fn write_script(path: &std::path::Path, body: &str, mode: u32) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_command_leads_a_session_of_its_own() {
        // No controlling terminal, and `kill(-pid)` reaches its whole group: the child is the
        // leader of a session, so its session id is its own pid.
        let config = make_config(
            "sid=$(python3 -c 'import os; print(os.getsid(0))'); [ \"$sid\" = \"$$\" ] && echo leader || echo \"not a leader: $sid $$\"",
            None,
        );

        assert_eq!(run_one(config).await, (vec!["leader".to_string()], vec![], 0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_direct_command_is_found_on_the_path_the_command_runs_with() {
        // `PATH` in the command's own environment decides where `shell: false` looks, not this process's.
        let dir = scratch_dir("path-lookup");
        write_script(&dir.join("runner-test-tool"), "#!/bin/sh\necho found-on-path\n", 0o755);

        let mut config = make_config("runner-test-tool", None);
        config.shell = Some(false);
        config.env = Some([("PATH".to_string(), format!("{}:/usr/bin:/bin", dir.display()))].into());

        assert_eq!(run_one(config).await, (vec!["found-on-path".to_string()], vec![], 0));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_direct_command_that_is_not_a_binary_and_has_no_shebang_runs_through_the_shell() {
        let dir = scratch_dir("no-shebang");
        let script = dir.join("plain.sh");
        write_script(&script, "echo ran-by-sh\n", 0o755);

        let mut config = make_config(&script.display().to_string(), None);
        config.shell = Some(false);

        assert_eq!(run_one(config).await, (vec!["ran-by-sh".to_string()], vec![], 0));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_direct_command_that_does_not_exist_fails_to_start() {
        let mut config = make_config("runner-test-no-such-program --flag", None);
        config.shell = Some(false);

        let (lines, errors, exit_code) = run_one(config).await;

        assert!(lines.is_empty());
        assert_eq!(errors.len(), 1);
        assert!(errors[0].starts_with("Failed to spawn: "), "{errors:?}");
        assert_eq!(exit_code, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_direct_command_without_execute_permission_fails_to_start() {
        let dir = scratch_dir("not-executable");
        let script = dir.join("locked");
        write_script(&script, "#!/bin/sh\necho nope\n", 0o644);

        let mut config = make_config(&script.display().to_string(), None);
        config.shell = Some(false);

        let (lines, errors, exit_code) = run_one(config).await;

        assert!(lines.is_empty());
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(exit_code, 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_the_command_runs_in_its_cwd_and_a_missing_one_fails_to_start() {
        let dir = scratch_dir("cwd").canonicalize().unwrap();

        let mut config = make_config("pwd", None);
        config.cwd = Some(dir.display().to_string());

        assert_eq!(run_one(config).await, (vec![dir.display().to_string()], vec![], 0));

        let mut missing = make_config("pwd", None);
        missing.cwd = Some(dir.join("does-not-exist").display().to_string());

        let (_, errors, exit_code) = run_one(missing).await;

        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(exit_code, 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_the_command_does_not_inherit_a_blocked_sigpipe_or_signal_mask() {
        // Whatever the host process blocked or ignored, a command starts with the defaults: a
        // writer to a closed pipe is ended by SIGPIPE (141), as in a terminal.
        let (lines, _, exit_code) =
            run_one(make_config("exec 3>&1; { yes; echo \"[$?]\" >&3; } | head -n 1", None)).await;

        assert_eq!(lines, vec!["y".to_string(), "[141]".to_string()]);
        assert_eq!(exit_code, 0);
    }

    #[cfg(unix)]
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
            ..Default::default()
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx, no_control()).await;

        assert!(result.success);

        let mut found = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text == "piped") {
                found = true;
            }
        }
        assert!(found, "expected 'piped' in output from shell pipe");
    }

    #[cfg(unix)]
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
            ..Default::default()
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
            ..Default::default()
        }];
        let runner = ConcurrentRunner::new(commands, &default_options());

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx, no_control()).await;

        assert!(result.success);

        let mut found = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(&event, ProcessEvent::Stdout { text, .. } if text == "pipe-test") {
                found = true;
            }
        }
        assert!(found, "expected 'pipe-test' in output");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_custom_shell_path() {
        // Use /bin/bash explicitly as shell_path
        let commands = vec![make_config("echo custom-shell", None)];
        let mut opts = default_options();
        opts.shell_path = Some("/bin/bash".to_string());
        let runner = ConcurrentRunner::new(commands, &opts);

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ProcessEvent>();
        let result = runner.run(event_tx, no_control()).await;

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
            ("SIGCONT", KillSignal::Cont),
            ("sigwinch", KillSignal::Winch),
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
            make_config("trap 'exit 70' USR1; sleep 30 & wait", Some("trapper")),
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

    /// A run driven on its own task, with handles to steer and observe it.
    #[cfg(unix)]
    struct LiveRun {
        events: mpsc::UnboundedReceiver<ProcessEvent>,
        control: mpsc::UnboundedSender<ControlMessage>,
        result: tokio::task::JoinHandle<ConcurrentRunResult>,
    }

    #[cfg(unix)]
    fn start(commands: Vec<ConcurrentCommandConfig>, options: &ConcurrentRunnerOptions) -> LiveRun {
        let runner = ConcurrentRunner::new(commands, options);
        let (event_tx, events) = mpsc::unbounded_channel();
        let (control, control_rx) = mpsc::unbounded_channel();
        let result = tokio::spawn(async move { runner.run(event_tx, control_rx).await });

        LiveRun { events, control, result }
    }

    #[cfg(unix)]
    impl LiveRun {
        /// Wait until `count` commands have started; returns their pids by index.
        async fn wait_for_started(&mut self, count: usize) -> Vec<(u32, u32)> {
            let mut started = Vec::new();

            while started.len() < count {
                match tokio::time::timeout(std::time::Duration::from_secs(5), self.events.recv()).await {
                    Ok(Some(ProcessEvent::Started { index, pid })) => started.push((index, pid.unwrap())),
                    Ok(Some(_)) => {}
                    other => panic!("expected {count} started events, got {started:?} then {other:?}"),
                }
            }

            started
        }

        async fn finish(self) -> (ConcurrentRunResult, Vec<ProcessEvent>) {
            let LiveRun { mut events, control, result } = self;
            let result = tokio::time::timeout(std::time::Duration::from_secs(10), result)
                .await
                .expect("the run must end")
                .unwrap();
            drop(control);

            let mut all = Vec::new();
            while let Ok(event) = events.try_recv() {
                all.push(event);
            }

            (result, all)
        }
    }

    /// Assert that no process of the group led by `pid` is left. A killed
    /// descendant may take a moment to be reaped, so allow it a short while.
    #[cfg(unix)]
    async fn assert_group_gone(pid: u32) {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

        for _ in 0..30 {
            if kill(Pid::from_raw(-(pid as i32)), None).is_err() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        panic!("process group {pid} is still alive");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_graceful_abort_reports_zero_and_spawns_no_queued_command() {
        let commands = vec![
            make_config("sleep 30", Some("a")),
            make_config("sleep 30", Some("b")),
            make_config("echo queued", Some("c")),
        ];
        let mut options = default_options();
        options.max_processes = Some(2);
        let mut run = start(commands, &options);

        let started = run.wait_for_started(2).await;
        run.control.send(ControlMessage::Abort { graceful: true }).unwrap();

        let (result, events) = run.finish().await;

        assert_eq!(result.close_events.len(), 2, "the queued command never starts");
        for close in &result.close_events {
            assert_eq!(close.exit_code, 0, "a user interrupt is not a failure");
            assert!(close.killed);
        }
        assert!(result.success);
        assert!(!events.iter().any(|e| e.index() == 2), "no event for the queued command: {events:?}");
        for (_, pid) in started {
            assert_group_gone(pid).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_graceful_abort_close_event_keeps_the_raw_exit_code_while_the_result_says_zero() {
        let mut run = start(vec![make_config("sleep 30", None)], &default_options());

        run.wait_for_started(1).await;
        run.control.send(ControlMessage::Abort { graceful: true }).unwrap();

        let (result, events) = run.finish().await;
        let close = events.iter().find_map(|e| match e {
            ProcessEvent::Close { exit_code, killed, .. } => Some((*exit_code, *killed)),
            _ => None,
        });

        // The event is what the command did; the result is what an interrupt means for the run.
        assert_eq!(close, Some((143, true)));
        assert_eq!((result.close_events[0].exit_code, result.close_events[0].killed), (0, true));
        assert!(result.success);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_terminating_abort_keeps_the_exit_codes() {
        let mut run = start(vec![make_config("sleep 30", None)], &default_options());

        let started = run.wait_for_started(1).await;
        run.control.send(ControlMessage::Abort { graceful: false }).unwrap();

        let (result, _) = run.finish().await;

        assert_eq!(result.close_events[0].exit_code, 143);
        assert!(result.close_events[0].killed);
        assert!(!result.success);
        assert_group_gone(started[0].1).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_second_abort_is_ignored() {
        let mut run = start(vec![make_config("sleep 30", None)], &default_options());

        run.wait_for_started(1).await;
        run.control.send(ControlMessage::Abort { graceful: true }).unwrap();
        run.control.send(ControlMessage::Abort { graceful: false }).unwrap();

        let (result, _) = run.finish().await;

        assert_eq!(result.close_events.len(), 1);
        assert_eq!(result.close_events[0].exit_code, 0, "the first abort decides how closes are reported");
    }

    #[tokio::test]
    async fn test_an_abort_requested_before_the_run_starts_spawns_nothing() {
        let runner = ConcurrentRunner::new(vec![make_config("echo never", None)], &default_options());
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let (control, control_rx) = mpsc::unbounded_channel();
        control.send(ControlMessage::Abort { graceful: true }).unwrap();

        let result = runner.run(event_tx, control_rx).await;

        assert!(result.close_events.is_empty());
        assert!(events.try_recv().is_err(), "no event at all");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_kill_signals_one_command_and_leaves_the_others() {
        use crate::concurrent::types::KillSignal;

        let commands =
            vec![make_config("sleep 30", Some("victim")), make_config("sleep 0.4; echo done", Some("bystander"))];
        let mut run = start(commands, &default_options());

        let started = run.wait_for_started(2).await;
        run.control.send(ControlMessage::Kill { index: 0, signal: Some(KillSignal::Kill) }).unwrap();

        let (result, _) = run.finish().await;
        let by_index = |i: u32| result.close_events.iter().find(|e| e.index == i).unwrap();

        assert_eq!(by_index(0).exit_code, 137);
        assert!(by_index(0).killed);
        assert_eq!(by_index(1).exit_code, 0);
        assert!(!by_index(1).killed);
        assert_group_gone(started[0].1).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_kill_without_a_signal_uses_the_runners_signal() {
        let mut run = start(vec![make_config("sleep 30", None)], &default_options());

        run.wait_for_started(1).await;
        run.control.send(ControlMessage::Kill { index: 0, signal: None }).unwrap();

        let (result, _) = run.finish().await;

        assert_eq!(result.close_events[0].exit_code, 143);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_kill_of_a_command_that_is_not_running_is_a_no_op() {
        let mut run = start(vec![make_config("exit 0", None), make_config("sleep 0.5", None)], &default_options());

        run.wait_for_started(2).await;
        // Index 0 has most likely closed already; 7 never existed.
        run.control.send(ControlMessage::Kill { index: 0, signal: None }).unwrap();
        run.control.send(ControlMessage::Kill { index: 7, signal: None }).unwrap();

        let (result, _) = run.finish().await;

        assert_eq!(result.close_events.len(), 2);
        assert!(result.close_events.iter().find(|e| e.index == 1).is_some_and(|e| e.exit_code == 0));
    }

    fn unspawnable(name: &str) -> ConcurrentCommandConfig {
        ConcurrentCommandConfig {
            command: "echo never".to_string(),
            name: Some(name.to_string()),
            cwd: Some("/nonexistent/directory/for/the/runner/test".to_string()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn test_a_spawn_failure_does_not_take_a_slot() {
        let mut options = default_options();
        options.max_processes = Some(1);
        let runner = ConcurrentRunner::new(vec![unspawnable("bad"), make_config("echo ok", Some("good"))], &options);
        let (event_tx, mut events) = mpsc::unbounded_channel();

        let result = runner.run(event_tx, no_control()).await;

        assert_eq!(result.close_events.len(), 2);
        assert_eq!(result.close_events[0].index, 0);
        assert_eq!(result.close_events[0].exit_code, 1);
        assert_eq!(result.close_events[1].exit_code, 0);
        assert!(!result.success);

        let mut kinds = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.index() == 0 {
                if let ProcessEvent::Started { pid, .. } = &event {
                    assert_eq!(*pid, None, "nothing was spawned, so there is no pid");
                }
                kinds.push(event.kind());
            }
        }
        // `started` comes first, as it does for a command that runs, so a consumer that tracks
        // commands from `started` to `close` sees this one too.
        assert_eq!(kinds, ["started", "error", "close"]);
    }

    #[tokio::test]
    async fn test_a_spawn_failure_triggers_kill_others_and_stops_spawning() {
        let mut options = default_options();
        options.max_processes = Some(1);
        options.kill_others = vec![KillOthers::Failure];
        let runner = ConcurrentRunner::new(vec![unspawnable("bad"), make_config("sleep 30", Some("queued"))], &options);

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runner.run(mpsc::unbounded_channel().0, no_control()),
        )
        .await
        .expect("the queued command must not be started");

        assert_eq!(result.close_events.len(), 1);
        assert_eq!(result.close_events[0].exit_code, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_spawn_failure_kills_the_running_commands_under_kill_others() {
        let mut options = default_options();
        options.kill_others = vec![KillOthers::Failure];
        let runner =
            ConcurrentRunner::new(vec![make_config("sleep 30", Some("running")), unspawnable("bad")], &options);

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runner.run(mpsc::unbounded_channel().0, no_control()),
        )
        .await
        .expect("kill-others must stop the running command");

        assert_eq!(result.close_events.len(), 2);
        assert!(result.close_events.iter().any(|e| e.index == 0 && e.killed));
    }

    /// The command line reaches the shell intact when it contains double quotes. On Windows this
    /// is the `cmd.exe /d /s /c "..."` construction; elsewhere it passes through `sh -c`.
    #[tokio::test]
    async fn test_quoted_arguments_survive_the_default_shell() {
        let commands = vec![make_config("node -e \"console.log('a b')\"", None)];
        let runner = ConcurrentRunner::new(commands, &default_options());
        let (event_tx, mut events) = mpsc::unbounded_channel::<ProcessEvent>();

        let result = runner.run(event_tx, no_control()).await;

        assert!(result.success, "{:?}", result.close_events);

        let mut lines = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let ProcessEvent::Stdout { text, .. } = event {
                lines.push(text);
            }
        }
        assert_eq!(lines, vec!["a b".to_string()]);
    }

    // ── stdin pipe, environment and event backpressure ──────────────────────────

    #[cfg(unix)]
    #[tokio::test]
    async fn test_piped_stdin_stays_open_and_takes_writes() {
        // `read` blocks until a line arrives; before the handle existed a piped
        // stdin was closed at once, so this saw EOF and printed nothing.
        let mut config = make_config("read line; echo got:$line", None);
        config.stdin = StdinMode::Pipe;
        let mut run = start(vec![config], &default_options());

        run.wait_for_started(1).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!run.result.is_finished(), "a piped stdin must stay open until the command is done with it");

        run.control.send(ControlMessage::Write { index: 0, data: b"hello\n".to_vec() }).unwrap();

        let (result, events) = run.finish().await;

        assert!(result.success);
        assert!(
            events.iter().any(|e| matches!(e, ProcessEvent::Stdout { text, .. } if text == "got:hello")),
            "{events:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_write_to_a_command_without_a_pipe_is_ignored() {
        let mut run = start(vec![make_config("sleep 0.3; echo done", None)], &default_options());

        run.wait_for_started(1).await;
        run.control.send(ControlMessage::Write { index: 0, data: b"ignored\n".to_vec() }).unwrap();
        run.control.send(ControlMessage::Write { index: 7, data: b"nobody\n".to_vec() }).unwrap();

        let (result, events) = run.finish().await;

        assert!(result.success);
        assert!(events.iter().any(|e| matches!(e, ProcessEvent::Stdout { text, .. } if text == "done")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_slow_write_does_not_stall_the_control_loop() {
        // The child never reads its stdin, so the pipe fills up and a blocking write would hang
        // the run loop; an abort sent afterwards must still be honoured.
        let mut config = make_config("sleep 30", None);
        config.stdin = StdinMode::Pipe;
        let mut run = start(vec![config], &default_options());

        run.wait_for_started(1).await;

        for _ in 0..64 {
            run.control.send(ControlMessage::Write { index: 0, data: vec![b'x'; 64 * 1024] }).unwrap();
        }
        run.control.send(ControlMessage::Abort { graceful: false }).unwrap();

        let (result, _) = run.finish().await;

        assert!(result.close_events[0].killed);
    }

    #[cfg(unix)]
    async fn run_env_probe(inherit_env: Option<bool>) -> String {
        std::env::set_var("RUNNER_TEST_PARENT_ONLY", "from-parent");

        let mut env = std::collections::HashMap::new();
        env.insert("RUNNER_TEST_OVERLAY".to_string(), "from-overlay".to_string());

        let mut config = make_config("echo \"[$RUNNER_TEST_PARENT_ONLY][$RUNNER_TEST_OVERLAY]\"", None);
        config.env = Some(env);
        config.inherit_env = inherit_env;

        let (event_tx, mut events) = mpsc::unbounded_channel::<ProcessEvent>();
        let runner = ConcurrentRunner::new(vec![config], &default_options());
        let result = runner.run(event_tx, no_control()).await;

        assert!(result.success);

        let mut texts = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let ProcessEvent::Stdout { text, .. } = event {
                texts.push(text);
            }
        }

        texts.join("\n")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_the_environment_is_inherited_by_default() {
        assert_eq!(run_env_probe(None).await, "[from-parent][from-overlay]");
        assert_eq!(run_env_probe(Some(true)).await, "[from-parent][from-overlay]");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_inherit_env_false_gives_the_command_only_its_own_variables() {
        assert_eq!(run_env_probe(Some(false)).await, "[][from-overlay]");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_the_runner_does_not_set_force_color_itself() {
        // Colour is the caller's decision (resolved into `env` on the JS side); the core must not
        // second-guess it, whether or not this process has a terminal.
        std::env::remove_var("FORCE_COLOR");

        let mut config = make_config("echo \"[${FORCE_COLOR-unset}]\"", None);
        config.env = Some(std::collections::HashMap::new());
        let (event_tx, mut events) = mpsc::unbounded_channel::<ProcessEvent>();
        let runner = ConcurrentRunner::new(vec![config], &default_options());

        runner.run(event_tx, no_control()).await;

        let mut seen = None;
        while let Ok(event) = events.try_recv() {
            if let ProcessEvent::Stdout { text, .. } = event {
                seen = Some(text);
            }
        }

        assert_eq!(seen.as_deref(), Some("[unset]"));
    }

    /// A run on a stream that holds `capacity` output events at a time, with nobody reading it yet.
    #[cfg(unix)]
    struct BoundedRun {
        stream: crate::concurrent::events::EventStream,
        result: tokio::task::JoinHandle<ConcurrentRunResult>,
        _control: mpsc::UnboundedSender<ControlMessage>,
    }

    #[cfg(unix)]
    fn start_bounded(commands: Vec<ConcurrentCommandConfig>, capacity: usize) -> BoundedRun {
        let runner = ConcurrentRunner::new(commands, &default_options());
        let (sink, stream) = crate::concurrent::events::event_channel(capacity);
        let (control, control_rx) = mpsc::unbounded_channel();
        let result = tokio::spawn(async move { runner.run(sink, control_rx).await });

        BoundedRun { stream, result, _control: control }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_consumer_that_does_not_read_stalls_the_child_instead_of_filling_memory() {
        // 200,000 lines of about 11 bytes is far more than a pipe and the channel can hold.
        let mut run = start_bounded(vec![make_config("seq 1 200000", None)], 8);

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Nobody has read anything: the run cannot be done, and at most `capacity` lines are queued.
        assert!(!run.result.is_finished(), "the child must be blocked on its full pipe");

        let first = run.stream.try_next_batch(usize::MAX).expect("something is queued");
        let queued = first.events.iter().filter(|e| matches!(e, ProcessEvent::Stdout { .. })).count();

        assert!(queued <= 8, "{queued} lines queued with a capacity of 8");
        drop(first);

        // Draining it all, in order, lets the run finish without losing a line.
        let mut next = 1 + queued;
        let mut closed = false;

        while !closed {
            let batch = tokio::time::timeout(std::time::Duration::from_secs(10), run.stream.next_batch(64))
                .await
                .expect("the run must keep producing while it is drained")
                .expect("the stream stays open until the close");

            for event in &batch.events {
                match event {
                    ProcessEvent::Stdout { text, .. } => {
                        assert_eq!(text, &next.to_string());
                        next += 1;
                    }
                    ProcessEvent::Close { exit_code, .. } => {
                        assert_eq!(*exit_code, 0);
                        closed = true;
                    }
                    _ => {}
                }
            }
        }

        assert_eq!(next, 200_001);
        assert!(run.result.await.unwrap().success);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_slow_consumer_does_not_lose_output_to_the_drain_grace() {
        // The command exits at once with more output than the channel holds. A consumer that waits
        // longer than the 2 s pipe-drain grace must still get every line: time spent waiting for a
        // credit is not time a descendant spent holding the pipe.
        let mut run = start_bounded(vec![make_config("seq 1 5000", None)], 4);

        tokio::time::sleep(std::time::Duration::from_millis(2600)).await;

        let mut seen = 0;
        let mut exit_code = None;

        while exit_code.is_none() {
            let batch = tokio::time::timeout(std::time::Duration::from_secs(10), run.stream.next_batch(64))
                .await
                .expect("the run must finish")
                .expect("the stream stays open until the close");

            for event in &batch.events {
                match event {
                    ProcessEvent::Stdout { .. } => seen += 1,
                    ProcessEvent::Close { exit_code: code, .. } => exit_code = Some(*code),
                    _ => {}
                }
            }
        }

        assert_eq!(seen, 5000, "no line may be dropped while the consumer was slow");
        assert_eq!(exit_code, Some(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_an_abort_is_honoured_while_the_consumer_is_not_reading() {
        let mut run = start_bounded(vec![make_config("yes", None)], 4);

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!run.result.is_finished());

        run._control.send(ControlMessage::Abort { graceful: false }).unwrap();

        // The stream is full and nobody reads it; the run must still wind down on its own.
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), &mut run.result)
            .await
            .expect("an abort must not wait for the consumer")
            .unwrap();

        assert!(result.close_events[0].killed);
    }

    // ── pty ─────────────────────────────────────────────────────────────────────

    #[cfg(unix)]
    fn pty_config(command: &str) -> ConcurrentCommandConfig {
        let mut config = make_config(command, None);
        config.stdin = StdinMode::Pty;
        config
    }

    #[cfg(unix)]
    fn stdout_of(events: &[ProcessEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                ProcessEvent::Stdout { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_sees_a_terminal_and_the_default_size() {
        let mut run =
            start(vec![pty_config("test -t 0 && test -t 1 && test -t 2 && echo tty; stty size")], &default_options());

        run.wait_for_started(1).await;

        let (result, events) = run.finish().await;
        let out = stdout_of(&events);

        assert!(result.success, "{result:?} {events:?}");
        assert!(out.contains("tty"), "{out:?}");
        assert!(out.contains("24 80"), "{out:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_starts_at_the_requested_size() {
        let mut config = pty_config("stty size");
        config.pty_size = Some(crate::concurrent::types::PtySize { cols: 100, rows: 30 });
        let mut run = start(vec![config], &default_options());

        run.wait_for_started(1).await;

        let (_, events) = run.finish().await;

        assert!(stdout_of(&events).contains("30 100"), "{events:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_resize_reaches_the_running_command() {
        let mut run = start(vec![pty_config("sleep 1; stty size")], &default_options());

        run.wait_for_started(1).await;
        run.control
            .send(ControlMessage::Resize { index: 0, size: crate::concurrent::types::PtySize { cols: 120, rows: 40 } })
            .unwrap();

        let (_, events) = run.finish().await;

        assert!(stdout_of(&events).contains("40 120"), "{events:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_reads_what_is_written_to_it() {
        let mut run = start(vec![pty_config("read line; echo got:$line")], &default_options());

        run.wait_for_started(1).await;
        run.control.send(ControlMessage::Write { index: 0, data: b"hello\n".to_vec() }).unwrap();

        let (result, events) = run.finish().await;

        assert!(result.success);
        assert!(stdout_of(&events).contains("got:hello"), "{events:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_reports_its_exit_code_and_the_signal_that_ended_it() {
        let mut options = default_options();
        options.max_processes = Some(0);
        let mut run =
            start(vec![pty_config("exit 3"), pty_config("kill -TERM $$"), pty_config("kill -KILL $$")], &options);

        run.wait_for_started(3).await;

        let (result, _) = run.finish().await;
        let by_index = |index: u32| result.close_events.iter().find(|event| event.index == index).unwrap();

        assert_eq!((by_index(0).exit_code, by_index(0).killed), (3, false));
        assert_eq!((by_index(1).exit_code, by_index(1).killed), (143, true));
        assert_eq!((by_index(2).exit_code, by_index(2).killed), (137, true));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_is_killed_with_its_whole_process_group() {
        let mut run = start(vec![pty_config("sleep 30 & sleep 30")], &default_options());
        let started = run.wait_for_started(1).await;

        run.control.send(ControlMessage::Abort { graceful: false }).unwrap();

        let (result, _) = run.finish().await;

        assert!(result.close_events[0].killed);
        assert_group_gone(started[0].1).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_honours_inherit_env_false() {
        std::env::set_var("RUNNER_TEST_PARENT_ONLY", "from-parent");

        let mut config = pty_config("echo \"[$RUNNER_TEST_PARENT_ONLY][$RUNNER_TEST_OVERLAY]\"");
        config.inherit_env = Some(false);
        config.env = Some([("RUNNER_TEST_OVERLAY".to_string(), "from-overlay".to_string())].into());
        let mut run = start(vec![config], &default_options());

        run.wait_for_started(1).await;

        let (_, events) = run.finish().await;

        assert!(stdout_of(&events).contains("[][from-overlay]"), "{events:?}");
    }

    #[cfg(unix)]
    async fn pty_shell_variable(env: &[(&str, &str)]) -> String {
        // `env` lists what the command was given; the shell's own `$SHELL` is not that.
        let mut config = pty_config("/usr/bin/env | /usr/bin/grep '^SHELL=' || echo unset");
        config.inherit_env = Some(false);
        config.env = Some(env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        let run = start(vec![config], &default_options());

        let (result, events) = run.finish().await;

        assert!(result.success, "{events:?}");

        stdout_of(&events).trim().to_string()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_with_inherit_env_false_gets_no_shell_variable() {
        // `portable-pty` sets SHELL on every command; the caller asked for only its own variables.
        assert_eq!(pty_shell_variable(&[("PATH", "/usr/bin:/bin")]).await, "unset");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_with_inherit_env_false_keeps_a_shell_variable_the_caller_passes() {
        assert_eq!(
            pty_shell_variable(&[("PATH", "/usr/bin:/bin"), ("SHELL", "/custom/shell")]).await,
            "SHELL=/custom/shell"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_in_a_missing_directory_is_a_spawn_failure_not_the_home_directory() {
        let mut config = pty_config("pwd");
        config.cwd = Some("/nonexistent/directory/for/the/runner/test".to_string());
        let run = start(vec![config], &default_options());

        let (result, events) = run.finish().await;

        assert_eq!(result.close_events[0].exit_code, 1);
        assert!(events.iter().any(|e| matches!(e, ProcessEvent::Error { .. })), "{events:?}");
        let kinds: Vec<_> = events.iter().map(ProcessEvent::kind).collect();
        assert_eq!(kinds, ["started", "error", "close"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_pty_command_ignores_shell_false_and_still_goes_through_the_shell() {
        let mut config = pty_config("echo one && echo two");
        config.shell = Some(false);
        let run = start(vec![config], &default_options());

        let (result, events) = run.finish().await;

        assert!(result.success, "{events:?}");
        assert!(stdout_of(&events).contains("two"), "{events:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_a_descendant_holding_the_pty_does_not_hang_the_run() {
        let run = start(vec![pty_config("sleep 5 &")], &default_options());

        let started = std::time::Instant::now();
        let (result, _) = run.finish().await;

        assert!(result.success);
        assert!(started.elapsed() < std::time::Duration::from_secs(4), "took {:?}", started.elapsed());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_pty_output_waits_for_the_consumer_like_pipe_output_does() {
        // Raw chunks, so the number of events is not the number of lines; what matters is that
        // a stalled consumer stalls the child and loses nothing.
        let mut run = start_bounded(vec![pty_config("seq 1 20000")], 2);

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(!run.result.is_finished(), "the child must be blocked on the pty");

        let mut text = String::new();
        let mut closed = false;

        while !closed {
            let batch = tokio::time::timeout(std::time::Duration::from_secs(20), run.stream.next_batch(16))
                .await
                .expect("the run must keep producing while it is drained")
                .expect("the stream stays open until the close");

            for event in &batch.events {
                match event {
                    ProcessEvent::Stdout { text: chunk, .. } => text.push_str(chunk),
                    ProcessEvent::Close { .. } => closed = true,
                    _ => {}
                }
            }
        }

        let numbers: Vec<u32> = text.lines().filter_map(|line| line.trim().parse().ok()).collect();

        assert_eq!(numbers, (1..=20000).collect::<Vec<u32>>());
    }
}
