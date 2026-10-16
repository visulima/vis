import type { LifeCycleInterface, ProcessEvent, Task } from "@visulima/task-runner";
import { runConcurrently, TerminalBuffer } from "@visulima/task-runner";
import type { Hookable } from "hookable";

import { resolveTaskCwd } from "../../task/target-options";
import type { StdinEntry } from "../../tui/types";
import type { VisHooks } from "../../util/hooks";
import { scheduleTimeoutKill } from "../../util/signal-escalation";
import { MAX_OUTPUT_BYTES, OutputRingBuffer } from "./output";
import type { ServiceEventBridge } from "./service-event-bridge";
import type { TaskSpawnContext } from "./task-env";
import { getTaskOptions, resolveTaskSpawn } from "./task-env";

/**
 * Serializes tasks that share a mutex name. Keyed by mutex name, each
 * entry is the tail of a promise chain — a task acquires the mutex by
 * awaiting the current tail, then replaces it with its own completion
 * promise.
 */
export type MutexPool = Map<string, Promise<void>>;

const withMutex = async <T>(pool: MutexPool, name: string | undefined, run: () => Promise<T>): Promise<T> => {
    if (!name) {
        return run();
    }

    const previous = pool.get(name) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
        release = resolve;
    });
    const chained = previous.then(() => next);

    pool.set(name, chained);

    await previous;

    try {
        return await run();
    } finally {
        release();

        // Only clear the pool entry if we are still the tail — another
        // task may have enqueued itself after us.
        if (pool.get(name) === chained) {
            pool.delete(name);
        }
    }
};

/**
 * Shared counter for the global `--retry-budget` flag. Tasks consult
 * `claim(requested)` at launch to grab up to `requested` retries; the
 * budget is decremented conservatively by the claim (not by actual
 * retries consumed) to keep the bound simple to reason about. Once
 * the budget is exhausted, subsequent tasks run with no retries —
 * surfacing flakiness instead of silently burning CI time.
 */
export interface RetryBudget {
    claim: (requested: number) => number;
    readonly remaining: number;
}

export const createRetryBudget = (limit: number): RetryBudget => {
    let remaining = Math.max(0, Math.floor(limit));

    return {
        claim(requested) {
            const granted = Math.max(0, Math.min(requested, remaining));

            remaining -= granted;

            return granted;
        },
        get remaining() {
            return remaining;
        },
    };
};

interface ExecutorDependencies {
    /**
     * Plugin hook bus. Used by the executor to fire `task:retry` before
     * each restart attempt — bridged from task-runner's per-attempt
     * `onRetry` callback. Optional so tests that exercise the executor
     * directly don't need to construct a hookable.
     */
    hooks?: Hookable<VisHooks>;

    /**
     * Optional task-runner lifecycle to receive streaming stdout/stderr
     * chunks. Plumbed so plugin authors get live output without having
     * to wait for the buffered dump at task-end.
     */
    lifeCycle?: LifeCycleInterface;

    mutexPool?: MutexPool;
    onOutput?: (taskId: string, text: string) => void;
    onOutputReplace?: (taskId: string, fullContent: string) => void;
    /** The shell command one task spawns. Shared with the traced run. */
    resolveCommand: (task: Task) => string | undefined;

    /** Optional global retry budget applied across all tasks in the run. */
    retryBudget?: RetryBudget;

    /**
     * Set when auto-start is active. The executor calls
     * `onRegistryTaskStarted` / `onRegistryTaskClosed` on the bridge for
     * any task that was injected as a service so the dock can transition
     * from `starting → ready` (or `failed`) using the wrapper's lifecycle
     * events. Ephemeral entries are no-ops in those calls — they get
     * boot-phase events through the stdout marker channel instead.
     */
    serviceEventBridge?: ServiceEventBridge;

    /**
     * The run's spawn context: child-env policy, invocation directory, service env,
     * granted parallelism and the env-file cache. Every spawn reads its environment
     * through resolveTaskSpawn with it.
     */
    spawnContext: TaskSpawnContext;
    stdinRegistry?: Map<string, StdinEntry>;

    /**
     * The strict-env failure for one spawn, or `undefined` when the command may run.
     * Built once per run from the run's `--strict-env` / `vis.config.ts strictEnv` setting.
     */
    strictEnvFailure: (task: Task, command: string, execOptions: { cwd?: string }) => string | undefined;

    workspaceRoot: string;
}

/**
 * Creates an async task executor using the concurrent process runner.
 *
 * Uses the native Rust addon (setsid/killpg process groups, tokio I/O)
 * when available, falling back to a JS implementation.
 * Commands originate from package.json scripts (trusted input).
 *
 * Output is collected in a ring buffer capped at MAX_OUTPUT_BYTES to
 * prevent unbounded memory growth with long-running tasks like dev servers.
 *
 * The executor also honors vis-specific target options carried on the task:
 * `envFile`, `runFromWorkspaceRoot`, `retryCount`/`retryDelay`, `mutex`,
 * `affectedFiles`, and per-target `shell`/`unixShell`/`windowsShell`.
 */
export const createConcurrentExecutor = (deps: ExecutorDependencies) => async (task: Task, execOptions: { cwd?: string; env?: Record<string, string> }) => {
    const {
        hooks,
        lifeCycle,
        mutexPool,
        onOutput,
        onOutputReplace,
        resolveCommand,
        retryBudget,
        serviceEventBridge: bridge,
        spawnContext,
        stdinRegistry,
        strictEnvFailure,
        workspaceRoot,
    } = deps;

    const visOptions = getTaskOptions(task);

    const resolvedCwd = resolveTaskCwd(workspaceRoot, execOptions.cwd ?? task.projectRoot, visOptions?.runFromWorkspaceRoot === true);

    // The spawned command comes from the resolver the traced run also uses,
    // so both paths run the same string.
    const command = resolveCommand(task);

    if (!command) {
        return { code: 0, terminalOutput: `No command configured for ${task.target.project}:${task.target.target}` };
    }

    // Clean mode builds the complete child environment, so the child sees only
    // the policy's parent names plus the injected entries, and the spawn does not
    // inherit the parent env. Inherit mode keeps the spawner's default.
    const spawn = resolveTaskSpawn(spawnContext, task, execOptions);

    const strictFailure = strictEnvFailure(task, command, execOptions);

    if (strictFailure !== undefined) {
        lifeCycle?.onTaskStderr?.(task, strictFailure);

        return { code: 1, terminalOutput: strictFailure };
    }

    // PTY stdio is enabled when either an interactive stdin registry is
    // present (live TUI dev tasks) or the target config opts in via
    // `options.pty`. In both cases output flows through TerminalBuffer,
    // which normalizes ANSI escapes into a deterministic final frame.
    //
    // Per-target `task.pty` (from TargetConfiguration.pty) overrides
    // both workspace-level signals so individual targets can opt in
    // or out independent of the ambient setup. Subtly different from
    // the pre-spawn builder: here a TUI stdin registry forces PTY
    // even when `visOptions.pty === false` (the user needs to pass
    // input through), so we don't gate `ptyInteractive` on the
    // workspace toggle.
    const ptyOptIn = visOptions?.pty === true;
    const ptyInteractive = Boolean(stdinRegistry);
    const isPty = task.pty === true ? true : task.pty === false ? false : ptyInteractive || ptyOptIn;

    if (isPty) {
        task.cache = false;
    }

    const output = isPty ? undefined : new OutputRingBuffer(MAX_OUTPUT_BYTES);
    const termBuf = isPty ? new TerminalBuffer(MAX_OUTPUT_BYTES) : undefined;

    // Held across the runOnce lifetime so the timeout watchdog can
    // SIGTERM the child process when the wall-clock budget is exceeded.
    let killCurrentProcess: ((signal?: string) => void) | undefined;

    const onEvent = (event: ProcessEvent): void => {
        if (event.kind === "started") {
            killCurrentProcess = event.kill;

            if (event.write && stdinRegistry) {
                stdinRegistry.set(task.id, { kill: event.kill, resize: event.resize, write: event.write });
            }

            // Registry-mode service tasks: the wrapper (`vis service
            // start <id>`) just spawned. The bridge transitions the
            // dock row to `starting`. Ephemeral entries no-op here —
            // they receive boot events from the stdout marker channel.
            bridge?.onRegistryTaskStarted(task.id);
        }

        if ((event.kind === "stdout" || event.kind === "stderr") && event.text !== undefined) {
            // Stream the raw chunk to the lifecycle first so plugins
            // (notifiers, metrics, log shippers) see output as it
            // arrives — before we store it in a buffer for the
            // buffered `printTaskTerminalOutput` at task-end.
            if (event.kind === "stdout") {
                lifeCycle?.onTaskStdout?.(task, event.text);
            } else {
                lifeCycle?.onTaskStderr?.(task, event.text);
            }

            if (termBuf) {
                termBuf.write(event.text);

                // Stream to the live TUI only when a stdin registry is
                // wired up; non-interactive PTY tasks are captured and
                // flushed at task completion via terminalOutput.
                if (ptyInteractive) {
                    onOutputReplace?.(task.id, termBuf.toString());
                }

                // Service-task wrappers run in PTY mode like everything
                // else, but their `[[VIS_BOOT]]…` markers must also reach
                // the bridge's parser — without this, the dock stays on
                // "booting…" while the wrapper completes happily and the
                // regular task list shows the row as ✓.
                if (bridge) {
                    bridge.onTaskOutput(task.id, event.text);
                }
            } else {
                const line = `${event.text}\n`;

                output!.append(line);
                onOutput?.(task.id, line);
            }
        }

        if (event.kind === "close") {
            if (stdinRegistry) {
                stdinRegistry.delete(task.id);
            }

            // Registry-mode: the wrapper exited. On success, the
            // bridge reads the registry entry to surface pid/logFile,
            // then transitions the dock to `ready` and starts the
            // running-phase log tail. On non-zero exit, transitions
            // to `failed`. Awaiting isn't needed here — the call is
            // fire-and-forget; the dock updates asynchronously via
            // its store.
            if (bridge) {
                bridge.onRegistryTaskClosed(task.id, event.exitCode ?? 0, Boolean(event.killed)).catch(() => {});
            }
        }
    };

    const runOnce = async (): Promise<{ code: number; retryAttempts: number; terminalOutput: string }> => {
        const requestedRetries = visOptions?.retryCount ?? 0;
        const retryDelay = visOptions?.retryDelay;
        // Global retry budget caps per-task retries from above. The budget
        // grants up to the requested amount; when it's exhausted, tasks
        // run with retries disabled so a single flaky task can't eat the
        // entire CI wall clock.
        const retryCount = retryBudget ? retryBudget.claim(requestedRetries) : requestedRetries;

        const timeoutMs = typeof visOptions?.timeout === "number" && visOptions.timeout > 0 ? visOptions.timeout : 0;
        const killGracePeriodMs
            = typeof visOptions?.killGracePeriodMs === "number" && visOptions.killGracePeriodMs >= 0 ? visOptions.killGracePeriodMs : 5000;
        let timedOut = false;
        let retryAttempts = 0;

        const timeoutKill = scheduleTimeoutKill({
            killGracePeriodMs,
            onTimeout: () => {
                timedOut = true;
            },
            sendSignal: (signal) => {
                killCurrentProcess?.(signal);
            },
            timeoutMs,
        });

        let result: Awaited<ReturnType<typeof runConcurrently>>;

        try {
            result = await runConcurrently(
                [
                    {
                        command,
                        cwd: resolvedCwd,
                        env: spawn.env,
                        inheritEnv: spawn.inheritEnv,
                        name: task.id,
                        ...(isPty
                            ? {
                                ptySize: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
                                stdin: "pty" as const,
                            }
                            : {}),
                    },
                ],
                {
                    killOthers: ["failure"],
                    onEvent,
                    ...(retryCount > 0
                        ? {
                            restart: {
                                delay: retryDelay ?? "exponential",
                                // Bridge task-runner's per-attempt callback into the
                                // typed task:retry hook. Throwing from a plugin
                                // handler aborts the retry — task-runner unwraps
                                // the rejection and surfaces it as a failure.
                                onRetry: async (attempt, _commandIndex, prevExitCode) => {
                                    retryAttempts = attempt;

                                    if (hooks) {
                                        await hooks.callHook("task:retry", task, attempt, prevExitCode);
                                    }
                                },
                                tries: retryCount,
                            },
                        }
                        : {}),
                },
            );
        } finally {
            timeoutKill.cancel();
        }

        const closeEvent = result.closeEvents[0];
        const buffered = termBuf ? termBuf.toString() : output!.toString();

        if (timedOut) {
            // Mark the result with a distinctive prefix so reporters and
            // CI log grep can surface timeouts separately from ordinary
            // failures. Exit code 124 mirrors GNU `timeout(1)` convention.
            return {
                code: 124,
                retryAttempts,
                terminalOutput: `${buffered}\n[timeout] Task "${task.id}" exceeded ${timeoutMs}ms budget.\n`,
            };
        }

        return {
            code: closeEvent?.exitCode ?? 1,
            retryAttempts,
            terminalOutput: buffered,
        };
    };

    return mutexPool ? withMutex(mutexPool, visOptions?.mutex, runOnce) : runOnce();
};
