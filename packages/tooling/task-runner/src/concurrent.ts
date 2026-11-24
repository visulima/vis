/**
 * Public API for the concurrent process runner.
 *
 * Uses the native Rust addon when available, falling back to
 * a pure JavaScript implementation. Integrates flow controllers
 * (restart, teardown, timings) around the core runner.
 */

import { spawn } from "node:child_process";

import { runConcurrentFallback } from "./concurrent-fallback";
import { detectScriptShell } from "./detect-shell";
import { logTimings } from "./flow-controllers/log-timings";
import { withRestart } from "./flow-controllers/restart-process";
import { runTeardown } from "./flow-controllers/teardown";
import type { NativeProcessEvent } from "./native-binding";
import { loadNativeBindings } from "./native-binding";
import { buildEnhancedPath } from "./path-utils";
import type { ConcurrentCommandConfig, ConcurrentCommandInput, ConcurrentRunnerOptions, ConcurrentRunResult } from "./types";

// ── Native-path signal handling ─────────────────────────────────────────
//
// The native runner installs no process-wide signal handlers: a handler that
// outlives a run changes what a later SIGHUP or Ctrl+C does to the whole host.
// Instead, each run registers SIGINT / SIGTERM listeners for its own lifetime
// and turns them into `abort()` on the run handle, then removes them when the
// run settles, the same way the JS spawner does.
//
// The "exit" listener is a synchronous safety net. It fires even when another
// listener short-circuits the chain by calling `process.exit()` (a TUI's own
// SIGINT handler, say), when the event loop will never run the abort. Children
// are spawned in their own process group, so signalling `-pid` takes the whole
// group in one syscall, before the parent dies.

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
 * Normalize command inputs to ConcurrentCommandConfig objects.
 */
const normalizeCommands = (inputs: ConcurrentCommandInput[]): ConcurrentCommandConfig[] =>
    inputs.map((input) => {
        if (typeof input === "string") {
            return { command: input };
        }

        return input;
    });

/**
 * Returns a shallow clone of `configs` with each command's env
 * extended so PATH includes the workspace's `node_modules/.bin`
 * chain. Matches the behaviour of `npm run` / `pnpm run` so
 * package.json scripts can reference bare binary names (eslint,
 * vitest, packem, …) without the caller having to route through
 * `pnpm exec` first. The cwd-nearest `.bin` wins, so a per-package
 * binary shadows a workspace-root one.
 *
 * Honours an explicit `env.PATH` (or Windows `env.Path`) on the
 * caller's config — we prepend, not replace. Setting one without
 * the other previously left them disagreeing on Windows; we now
 * mirror the merged value into both keys when the alias is present.
 *
 * Non-mutating: caller-provided config objects are not modified
 * (`runConcurrently` is part of the public API and callers may
 * reuse the configs they pass in).
 */
const withEnhancedPathConfigs = (configs: ConcurrentCommandConfig[]): ConcurrentCommandConfig[] =>
    configs.map((config) => {
        const cwd = config.cwd ?? process.cwd();
        const enhanced = buildEnhancedPath(cwd, config.env);
        const nextEnv: Record<string, string> = { ...config.env };

        // Strip any aliased `Path` / `path` keys so Node's
        // last-write-wins env serialisation can't pick the
        // pre-enhanced value. Previously, a caller spreading
        // `process.env` on Windows (which exposes `Path`) into config
        // ended up with both `PATH` and `Path` set; the spawn's
        // effective PATH was non-deterministic depending on object
        // key order, occasionally losing the workspace `.bin` prepend.
        delete nextEnv["Path"];
        delete nextEnv["path"];

        nextEnv["PATH"] = enhanced;

        if (process.platform === "win32") {
            // Some Windows toolchains (older PowerShell, cygwin
            // shims) still read `Path`. Mirror the canonical value
            // so they don't drop the workspace bin chain.
            nextEnv["Path"] = enhanced;

            // Preserve PATHEXT — PowerShell shims (`pnpm.ps1`,
            // `vitest.ps1`) need it to resolve `node.exe` by bare
            // name. A sanitised-env mode that drops PATHEXT used to
            // make every shim invocation fail silently.
            if (!("PATHEXT" in nextEnv) && process.env["PATHEXT"]) {
                nextEnv["PATHEXT"] = process.env["PATHEXT"];
            }
        }

        return { ...config, env: nextEnv };
    });

/**
 * Core runner function that dispatches to native or JS fallback.
 * This is the inner runner without flow controller wrappers.
 */
const coreRun = async (rawConfigs: ConcurrentCommandConfig[], options: ConcurrentRunnerOptions): Promise<ConcurrentRunResult> => {
    // Resolve shell: explicit option > npm script-shell config > platform default
    const shellPath = options.shellPath ?? detectScriptShell();

    // Prepend each cwd's `node_modules/.bin` ancestry to PATH so
    // bare binary names from package.json scripts resolve without
    // forcing callers through `pnpm exec`. Done once here (instead
    // of inside the native + JS spawners) so both code paths stay
    // in lock-step.
    const configs = withEnhancedPathConfigs(rawConfigs);

    const native = loadNativeBindings();

    // Fall back to the JS runner when:
    // - any command needs stdin piping or PTY (native addon can't do those)
    // - onEvent streaming is requested (native addon's NAPI callback can emit
    //   null events on some platforms/CI, making it unreliable for streaming)
    // - a command opts out of parent-env inheritance (`inheritEnv: false`):
    //   the native addon always copies the parent environment, so only the JS
    //   spawner can give the child exactly the env it was handed
    const needsJsFallback = configs.some((c) => c.stdin === "pipe" || c.stdin === "pty" || c.inheritEnv === false) || !!options.onEvent;

    if (native && !needsJsFallback) {
        const nativeOptions = {
            killOthers: options.killOthers,
            killSignal: options.killSignal,
            killTimeout: options.killTimeout,
            maxProcesses: options.maxProcesses,
            shellPath,
            successCondition: options.successCondition,
        };

        const nativeCommands = configs.map((c) => {
            return {
                command: c.command,
                cwd: c.cwd,
                env: c.env,
                name: c.name,
                shell: c.shell,
                stdin: c.stdin,
            };
        });

        // PIDs of *this* run keyed by command index. An exited child's pid is dropped on
        // close/error so a later signal can't hit a pid the kernel has recycled.
        const indexToPid = new Map<number, number>();

        const onLifecycle = (event: NativeProcessEvent): void => {
            if (event.kind === "started" && typeof event.pid === "number") {
                indexToPid.set(event.index, event.pid);

                return;
            }

            if (event.kind === "close" || event.kind === "error") {
                indexToPid.delete(event.index);
            }
        };

        const run = native.startConcurrent(nativeCommands, nativeOptions, onLifecycle);

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
            return await run.done();
        } finally {
            process.removeListener("SIGINT", onSigint);
            process.removeListener("SIGTERM", onSigterm);
            process.removeListener("exit", onExit);
            process.setMaxListeners(Math.max(0, process.getMaxListeners() - 3));
        }
    }

    return runConcurrentFallback(configs, { ...options, shellPath });
};

/**
 * Run commands concurrently with output streaming and process management.
 *
 * Automatically uses the native Rust addon for performance when available,
 * falling back to a pure JavaScript implementation.
 *
 * Supports flow controllers:
 * - `restart`: retry failed commands with configurable delay/backoff
 * - `teardown`: run cleanup commands after all processes complete
 * - `timings`: print a timing summary table
 * @param commands Array of command strings or config objects
 * @param options Runner options (maxProcesses, killOthers, restart, teardown, etc.)
 * @returns Promise resolving to the run result with close events and success status
 */
export const runConcurrently = async (commands: ConcurrentCommandInput[], options: ConcurrentRunnerOptions = {}): Promise<ConcurrentRunResult> => {
    const configs = normalizeCommands(commands);

    if (configs.length === 0) {
        return { closeEvents: [], success: true };
    }

    // Run with or without restart wrapper
    let result: ConcurrentRunResult;

    if (options.restart && options.restart.tries !== 0) {
        result = await withRestart((cmds, options_) => coreRun(cmds, options_), configs, options, {
            delay: options.restart.delay ?? 0,
            onRetry: options.restart.onRetry,
            tries: options.restart.tries,
        });
    } else {
        result = await coreRun(configs, options);
    }

    // Print timing summary if requested
    if (options.timings) {
        logTimings(result.closeEvents);
    }

    // Run teardown commands if provided
    if (options.teardown && options.teardown.length > 0) {
        await runTeardown({
            commands: options.teardown,
            cwd: options.teardownCwd,
        });
    }

    return result;
};
