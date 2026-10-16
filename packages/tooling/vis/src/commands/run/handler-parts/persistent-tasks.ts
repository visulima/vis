import { readFileSync, removeSync } from "@visulima/fs";
import type { LifeCycleInterface, ProcessEvent, Task } from "@visulima/task-runner";
import { runConcurrently, TerminalBuffer } from "@visulima/task-runner";

import { decidePty } from "../../../task/pty-decision";
import type { VisTargetOptions } from "../../../task/target-options";
import { detectCurrentOs, resolveTaskCwd } from "../../../task/target-options";
import type { TaskStore } from "../../../tui/components/task-store";
import type { StdinEntry } from "../../../tui/types";
import type { TaskSpawnContext } from "../task-env";
import { resolveTaskSpawn } from "../task-env";
import { MAX_OUTPUT_BYTES } from "./output";
import { resolveTaskCommand } from "./shell";

/**
 * Per-service readiness re-check budget for the auto-attach probe.
 * Short on purpose — we run this once per registered service on every
 * `vis run`, so a slow probe would tax interactive workflows. If the
 * service can't respond inside this budget, treat it as unhealthy and
 * tell the operator to restart.
 */
export const SERVICE_PROBE_TIMEOUT_MS = 2000;

interface PersistentTasksLifecycleHooks {
    /** Resolves when the TUI exits (user pressed `q`/Ctrl+C); triggers an abort. */
    abortSignal?: Promise<void>;
    lifeCycle: LifeCycleInterface;
    /** Registry of writable stdin entries keyed by task ID, for interactive PTY input. */
    stdinRegistry?: Map<string, StdinEntry>;
    store: TaskStore;
}

/**
 * Runs persistent tasks (dev servers, watch mode) as a concurrent batch.
 * Persistent tasks never cache and never return a "result" — they run
 * until interrupted or until all of them exit.
 *
 * When invoked from the TTY path, `lifecycleHooks` is supplied so output
 * streams into the dynamic TUI store and the `done` state is suspended
 * until the persistent tasks exit. Without it, an `onEvent` no-op still
 * forces the JS fallback in `runConcurrently` (the variant with
 * hardened SIGINT/SIGTERM/exit cleanup).
 */
export const runPersistentTasks = async (tasks: Task[], spawnContext: TaskSpawnContext, lifecycleHooks: PersistentTasksLifecycleHooks | undefined): Promise<void> => {
    const { workspaceRoot } = spawnContext;

    const commands = tasks
        .map((task) => {
            // The same command the executor and the traced run spawn: tokens expanded, forwarded
            // arguments and `affectedFiles: "args"` appended, custom shell applied.
            const command = resolveTaskCommand(task, spawnContext.affectedFiles, detectCurrentOs());

            if (!command) {
                return undefined;
            }

            const visOptions = task.overrides["visOptions"] as VisTargetOptions | undefined;
            const cwd = resolveTaskCwd(workspaceRoot, task.projectRoot, Boolean(visOptions?.runFromWorkspaceRoot));

            // Persistent tasks are dev servers / watchers. Under the live
            // TUI run them through a PTY by default so TTY-aware CLIs
            // (convex, vite, next, …) emit their full interactive output
            // instead of detecting a pipe and going quiet — only the first
            // unconditional line would otherwise reach us. Opt out with
            // `visOptions.pty: false`. The non-TUI path keeps pipe mode:
            // there's no terminal to emulate and output is line-oriented.
            //
            // Per-target `task.pty` (carried over from
            // TargetConfiguration.pty) wins over both workspace toggles —
            // a single target can force PTY (e.g. vitest, prettier with
            // colors) or suppress it (`pty: false`) regardless of the
            // ambient TUI state. See `task/pty-decision.ts` for the
            // shared resolution logic.
            const usePty = decidePty({
                interactive: Boolean(lifecycleHooks),
                taskPty: task.pty,
                workspacePty: visOptions?.pty,
            });

            // The same spawn as the executor and the traced run, so the three cannot drift.
            const spawn = resolveTaskSpawn(spawnContext, task);

            return {
                command,
                cwd,
                env: spawn.env,
                inheritEnv: spawn.inheritEnv,
                name: task.id,
                ...(usePty
                    ? {
                        ptySize: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
                        stdin: "pty" as const,
                    }
                    : {}),
            };
        })
        .filter((c): c is NonNullable<typeof c> => c !== undefined);

    if (commands.length === 0) {
        return;
    }

    if (!lifecycleHooks) {
        await runConcurrently(commands, {
            killOthers: ["failure"],
            onEvent: () => {
                // No-op — presence forces the JS fallback path, which is
                // the one with the hardened signal cleanup.
            },
        });

        return;
    }

    const { abortSignal, lifeCycle, stdinRegistry, store } = lifecycleHooks;
    // Map runConcurrently's positional `index` back to the originating
    // Task — runConcurrently doesn't echo `name` on stdout/stderr/started
    // events, only on `close`. Keeping a parallel array preserves the
    // ordering invariant without trusting per-event metadata.
    const runnableTasks = commands.map((c) => tasks.find((t) => t.id === c.name)!).filter(Boolean);

    // PTY tasks emit raw ANSI (cursor moves, in-place spinner redraws) as a
    // single merged stdout stream. Feed each through its own TerminalBuffer
    // so `toString()` yields a normalized frame, then REPLACE the stored
    // output (`setOutput`) rather than appending — the buffer already holds
    // the full accumulated frame. Pipe-mode tasks keep the line-append path.
    const isPtyIndex = (index: number): boolean => (commands[index] as { stdin?: string } | undefined)?.stdin === "pty";
    const termBuffers = new Map<number, TerminalBuffer>();
    const getTermBuffer = (index: number): TerminalBuffer | undefined => {
        if (!isPtyIndex(index)) {
            return undefined;
        }

        let buf = termBuffers.get(index);

        if (!buf) {
            buf = new TerminalBuffer(MAX_OUTPUT_BYTES);
            termBuffers.set(index, buf);
        }

        return buf;
    };

    // The orchestrator already called endCommand() → markDone() on the
    // store; reverse it so the TUI keeps the task table visible while
    // the persistent tasks run. markDone() runs again in the finally
    // block so the post-exit summary surfaces normally.
    store.unmarkDone();
    lifeCycle.startTasks?.(runnableTasks);

    const startTimeById = new Map<string, number>();
    const killHandles = new Map<number, (signal?: string) => void>();
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const killAll = (): void => {
        for (const kill of killHandles.values()) {
            try {
                kill("SIGTERM");
            } catch {
                // Process already gone.
            }
        }

        // Some dev servers ignore SIGTERM (or have child workers that
        // outlive the parent). Escalate to SIGKILL after a grace period
        // so `q` actually exits without forcing the user to Ctrl+C.
        // Don't clear handles synchronously — we still need them for the
        // SIGKILL pass.
        if (!escalationTimer) {
            escalationTimer = setTimeout(() => {
                for (const kill of killHandles.values()) {
                    try {
                        kill("SIGKILL");
                    } catch {
                        // Process already gone.
                    }
                }

                killHandles.clear();
            }, 2000);
            escalationTimer.unref?.();
        }
    };

    // When the TUI unmounts (`q` or Ctrl+C inside the React app), the
    // promise resolves before runConcurrently's signal handlers fire —
    // explicitly kill so the persistent run doesn't outlive the UI.
    let abortListener: (() => void) | undefined;

    if (abortSignal) {
        abortListener = (): void => {
            killAll();
        };

        abortSignal
            .then(() => {
                abortListener?.();

                return undefined;
            })
            .catch(() => {
                abortListener?.();
            });
    }

    try {
        await runConcurrently(commands, {
            killOthers: ["failure"],
            onEvent: (event: ProcessEvent) => {
                const task = runnableTasks[event.index];

                if (!task) {
                    return;
                }

                switch (event.kind) {
                    case "close": {
                        const startTime = startTimeById.get(task.id) ?? Date.now();
                        // A killed persistent task (Ctrl+C, `q`, killOthers
                        // cascade) is the expected exit path — render it
                        // as `success` so the row shows a tick instead of
                        // a misleading red cross.
                        const status = event.killed || event.exitCode === 0 ? "success" : "failure";

                        lifeCycle.endTasks?.([
                            {
                                code: event.exitCode ?? 0,
                                endTime: Date.now(),
                                startTime,
                                status,
                                task,
                                terminalOutput: store.getSnapshot().outputs.get(task.id) ?? "",
                            },
                        ]);
                        killHandles.delete(event.index);
                        stdinRegistry?.delete(task.id);
                        break;
                    }
                    case "error": {
                        if (event.message) {
                            const buf = getTermBuffer(event.index);

                            if (buf) {
                                buf.write(`${event.message}\n`);
                                store.setOutput(task.id, buf.toString());
                            } else {
                                store.addOutput(task.id, `${event.message}\n`);
                            }
                        }

                        break;
                    }
                    case "started": {
                        startTimeById.set(task.id, Date.now());

                        if (event.kill) {
                            killHandles.set(event.index, event.kill);
                        }

                        // PTY tasks expose write/resize so the user can
                        // type into the dev server (e.g. vite's `r` to
                        // restart) once the task panel is focused.
                        if (event.write && stdinRegistry) {
                            stdinRegistry.set(task.id, { kill: event.kill, resize: event.resize, write: event.write });
                        }

                        break;
                    }
                    case "stderr":
                    case "stdout": {
                        if (event.text) {
                            const buf = getTermBuffer(event.index);

                            if (buf) {
                                buf.write(event.text);
                                store.setOutput(task.id, buf.toString());
                            } else {
                                store.addOutput(task.id, `${event.text}\n`);
                            }
                        }

                        break;
                    }
                    default:
                    // ignore
                }
            },
        });
    } finally {
        if (escalationTimer) {
            clearTimeout(escalationTimer);
            escalationTimer = undefined;
        }

        store.markDone();
    }
};

/** Liveness check: true if the pid (or its group) is still in the process table. */
const isPidAlive = (pid: number): boolean => {
    try {
        process.kill(-pid, 0);

        return true;
    } catch {
        try {
            process.kill(pid, 0);

            return true;
        } catch {
            return false;
        }
    }
};

/** Synchronous sleep using Atomics.wait on a private SharedArrayBuffer. */
const sleepSyncMs = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Run-end cleanup for ephemeral services started via `injectServiceTasks`,
 * and (when `--stop-services` is set) registry-mode services this run
 * started. Each ephemeral pid file holds the pid of a process group
 * leader the bootstrap spawned and `unref`d. We SIGTERM the whole group
 * (so the shell wrapper AND the actual server die) and then drop the
 * scratch directory. Any file/process that's already gone is silently
 * ignored — the goal is to leave nothing behind, not to assert what we
 * found.
 *
 * Synchronous on purpose: a SIGINT handler can call this inline before
 * the process exits. The SIGKILL escalation polls liveness with
 * `Atomics.wait` so it actually fires on the exit path — an unref'd
 * timer would be cancelled when `process.exit` runs immediately after.
 *
 * Registry entries for `extraPids` are NOT removed here (sync FS work in
 * a signal handler is risky); `vis service list --prune` and `pruneDead`
 * tidy them up. The entries point at dead pids by then so subsequent
 * runs treat them as missing.
 */
export const cleanupEphemeralServices = (params: { extraPids?: ReadonlyArray<number>; pidFiles: string[]; runDir: string | undefined }): void => {
    const { extraPids = [], pidFiles, runDir } = params;
    const pids: number[] = [];

    const sendSigterm = (pid: number): void => {
        try {
            // The bootstrap spawned with `detached: true`, so the child
            // is its own process-group leader. Negate the pid to signal
            // the whole group — kills both the shell wrapper and the
            // service binary it forked.
            process.kill(-pid, "SIGTERM");
        } catch {
            try {
                process.kill(pid, "SIGTERM");
            } catch {
                // Already gone.
            }
        }
    };

    for (const pidFile of pidFiles) {
        let pid: number | undefined;

        try {
            const text = readFileSync(pidFile);
            const parsed = Number.parseInt(text.trim(), 10);

            pid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        } catch {
            continue;
        }

        if (pid === undefined) {
            continue;
        }

        pids.push(pid);
        sendSigterm(pid);
    }

    for (const pid of extraPids) {
        if (!Number.isFinite(pid) || pid <= 0) {
            continue;
        }

        pids.push(pid);
        sendSigterm(pid);
    }

    // Some services (postgres, custom node servers) ignore SIGTERM until
    // they finish in-flight work. Poll liveness for up to ~1.5s — most
    // well-behaved services exit within a few hundred ms — and SIGKILL
    // anything still standing. Synchronous waits are required: this can
    // be invoked from a signal handler immediately followed by
    // `process.exit`, which would cancel any unref'd timer.
    if (pids.length > 0) {
        const grace = 1500;
        const step = 100;
        const deadline = Date.now() + grace;

        while (Date.now() < deadline) {
            let allDead = true;

            for (const pid of pids) {
                if (isPidAlive(pid)) {
                    allDead = false;
                    break;
                }
            }

            if (allDead) {
                break;
            }

            sleepSyncMs(step);
        }

        for (const pid of pids) {
            if (!isPidAlive(pid)) {
                continue;
            }

            try {
                process.kill(-pid, "SIGKILL");
            } catch {
                try {
                    process.kill(pid, "SIGKILL");
                } catch {
                    // Already gone.
                }
            }
        }
    }

    if (runDir) {
        removeSync(runDir);
    }
};
