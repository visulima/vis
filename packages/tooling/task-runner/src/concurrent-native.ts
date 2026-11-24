/**
 * The concurrent runner on the native addon.
 *
 * Does everything the JS spawner (`runConcurrentFallback`) does for a caller: streams events to `onEvent`
 * (with the `kill`, `write` and `resize` closures on `started`), runs commands with piped stdin or
 * in a pty, honours `inheritEnv`, and turns SIGINT, SIGTERM and process exit into a teardown of the
 * children. The addon itself installs no signal handlers and decides nothing about colour: both
 * are owned here, per run, so one run's listeners never outlive it.
 */

import { spawn } from "node:child_process";

import { forceColorFor } from "./force-color";
import type { NativeConcurrentCommandConfig, NativeConcurrentRun, NativeProcessEvent, NativeProcessEventBatch } from "./native-binding";
import { loadNativeBindings } from "./native-binding";
import type { ConcurrentCommandConfig, ConcurrentRunnerOptions, ConcurrentRunResult, ProcessEvent } from "./types";

// ── Signal handling ─────────────────────────────────────────────────────
//
// Each run registers SIGINT / SIGTERM listeners for its own lifetime and turns them into `abort()`
// on the run handle, then removes them when the run settles, the same way the JS spawner does.
//
// The "exit" listener is a synchronous safety net. It fires even when another listener
// short-circuits the chain by calling `process.exit()` (a TUI's own SIGINT handler, say), when the
// event loop will never run the abort. Children are spawned in their own process group, so
// signalling `-pid` takes the whole group in one syscall, before the parent dies.

const killTrackedTree = (pid: number, signal: NodeJS.Signals): void => {
    try {
        if (process.platform === "win32") {
            // taskkill /T tears down the whole tree.
            spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
        } else {
            process.kill(-pid, signal);
        }
    } catch {
        // Process may already be dead; nothing to do.
    }
};

/**
 * The environment overlay the addon applies to a command: the caller's `env`, the terminal type a
 * pty needs, and the `FORCE_COLOR` the colour policy resolves. The addon adds the parent
 * environment underneath unless `inheritEnv` is false.
 */
const resolveEnv = (config: ConcurrentCommandConfig): Record<string, string> => {
    const extras: Record<string, string> = config.stdin === "pty" ? { TERM: "xterm-256color" } : {};
    const env: Record<string, string> = { ...config.env, ...extras };
    const forceColor = forceColorFor(config.env, extras, config.inheritEnv);

    if (forceColor !== undefined) {
        env["FORCE_COLOR"] = forceColor;
    }

    return env;
};

/**
 * A terminal dimension the addon accepts, or the default. Callers pass `process.stdout.columns`,
 * which some terminals report as 0; node-pty took that as it came, and the addon refuses it, which
 * would fail the whole run over a cosmetic size.
 */
const terminalSize = (size: { cols: number; rows: number } | undefined): { cols: number; rows: number } | undefined => {
    if (!size) {
        return undefined;
    }

    const valid = (value: number, fallback: number): number => (Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback);

    return { cols: valid(size.cols, 80), rows: valid(size.rows, 24) };
};

const toNativeCommand = (config: ConcurrentCommandConfig): NativeConcurrentCommandConfig => {
    return {
        command: config.command,
        cwd: config.cwd,
        env: resolveEnv(config),
        inheritEnv: config.inheritEnv,
        name: config.name,
        ptySize: terminalSize(config.ptySize),
        shell: config.shell,
        stdin: config.stdin,
    };
};

/**
 * Turn a native event into the `ProcessEvent` callers get, giving `started` the closures that
 * steer the command through the run handle. They are the same ones the JS spawner provides:
 * `kill` everywhere, `write` where there is a stdin to write to, `resize` for a pty. Each ignores
 * a failure, as the JS spawner's do when the process is already gone.
 */
const toProcessEvent = (event: NativeProcessEvent, run: NativeConcurrentRun, commands: ConcurrentCommandConfig[]): ProcessEvent => {
    const { index } = event;

    switch (event.kind) {
        case "close": {
            return {
                commandName: event.commandName,
                durationMs: event.durationMs,
                exitCode: event.exitCode,
                index,
                killed: event.killed,
                kind: "close",
            };
        }

        case "error": {
            return { index, kind: "error", message: event.message };
        }

        case "started": {
            const { stdin } = commands[index] ?? {};

            return {
                index,
                kill: (signal?: string) => {
                    try {
                        run.kill(index, signal ?? "SIGTERM");
                    } catch {
                        // An unknown signal name: the JS spawner's `process.kill` fails the same way, silently.
                    }
                },
                kind: "started",
                pid: event.pid,
                resize:
                    stdin === "pty"
                        ? (cols: number, rows: number) => {
                            try {
                                run.resize(index, cols, rows);
                            } catch {
                                // A size the terminal cannot take.
                            }
                        }
                        : undefined,
                write:
                    stdin === "pipe" || stdin === "pty"
                        ? (data: string) => {
                            run.write(index, data);
                        }
                        : undefined,
            };
        }

        default: {
            return { index, kind: event.kind as "stderr" | "stdout", text: event.text };
        }
    }
};

/**
 * Run `commands` concurrently on the native addon.
 *
 * `options.shellPath` is used as given; resolving a default shell is the caller's job
 * (`runConcurrently` does it), so two runners fed the same inputs run the same shell.
 */
const runNativeConcurrent = async (commands: ConcurrentCommandConfig[], options: ConcurrentRunnerOptions): Promise<ConcurrentRunResult> => {
    if (commands.length === 0) {
        return { closeEvents: [], success: true };
    }

    const native = loadNativeBindings();

    if (typeof native?.startConcurrent !== "function") {
        throw new TypeError(
            "@visulima/task-runner: the native addon is too old to run commands (startConcurrent is missing); rebuild it with `pnpm build:native`.",
        );
    }

    const { onEvent } = options;

    // PIDs of *this* run keyed by command index. An exited child's pid is dropped on
    // close/error so a later signal can't hit a pid the kernel has recycled.
    const indexToPid = new Map<number, number>();
    const started: { run?: NativeConcurrentRun } = {};

    // A batch is a list of events and, in the very last one, the outcome. Every event is handed
    // over before the promise settles, which is what lets a caller read its buffer right after
    // the await.
    const outcome = new Promise<ConcurrentRunResult>((resolve, reject) => {
        started.run = native.startConcurrent(
            commands.map((command) => toNativeCommand(command)),
            {
                killOthers: options.killOthers,
                killSignal: options.killSignal,
                killTimeout: options.killTimeout,
                maxProcesses: options.maxProcesses,
                shellPath: options.shellPath,
                streamOutput: onEvent !== undefined,
                successCondition: options.successCondition,
            },
            (batch: NativeProcessEventBatch): void => {
                for (const event of batch.events) {
                    if (event.kind === "started" && typeof event.pid === "number") {
                        indexToPid.set(event.index, event.pid);
                    } else if (event.kind === "close" || event.kind === "error") {
                        indexToPid.delete(event.index);
                    }

                    if (onEvent && started.run) {
                        onEvent(toProcessEvent(event, started.run, commands));
                    }
                }

                if (batch.error !== undefined) {
                    reject(new Error(batch.error));
                } else if (batch.result) {
                    resolve(batch.result);
                }
            },
        );
    });

    const { run } = started;

    // `startConcurrent` threw (an unknown option value): nothing was spawned, nothing to clean up.
    if (!run) {
        return outcome;
    }

    // Like the JS spawner, SIGINT is a user interrupt (exit codes become 0) and SIGTERM
    // is a plain termination. SIGHUP is deliberately not handled: neither spawner has
    // ever listened for it, and adding a listener would change what a hangup does.
    const onSigint = (): void => {
        run.abort("interrupt");
    };
    const onSigterm = (): void => {
        run.abort("terminate");
    };
    const onExit = (): void => {
        for (const pid of indexToPid.values()) {
            killTrackedTree(pid, "SIGTERM");
        }
    };

    // A host with its own SIGINT/SIGTERM/exit listeners must not trip Node's
    // 10-listener MaxListenersExceeded warning when this run adds three more.
    process.setMaxListeners(process.getMaxListeners() + 3);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("exit", onExit);

    try {
        return await outcome;
    } finally {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.removeListener("exit", onExit);
        process.setMaxListeners(Math.max(0, process.getMaxListeners() - 3));
    }
};

export { runNativeConcurrent };
