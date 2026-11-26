/**
 * Public API for the concurrent process runner.
 *
 * Runs on the native Rust addon. The pure JavaScript spawner is only reachable
 * through the `VIS_CONCURRENT_RUNNER=js` escape hatch, which is removed in the
 * next release. Integrates flow controllers (restart, teardown, timings)
 * around the core runner.
 */

import { runConcurrentFallback } from "./concurrent-fallback";
import { runNativeConcurrent } from "./concurrent-native";
import { detectScriptShell } from "./detect-shell";
import { logTimings } from "./flow-controllers/log-timings";
import { withRestart } from "./flow-controllers/restart-process";
import { runTeardown } from "./flow-controllers/teardown";
import { buildEnhancedPath } from "./path-utils";
import { resolveConcurrentRunner } from "./runner-switch";
import type { ConcurrentCommandConfig, ConcurrentCommandInput, ConcurrentRunnerOptions, ConcurrentRunResult } from "./types";

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
 * Core runner function: the native runner, or the JS spawner when `VIS_CONCURRENT_RUNNER=js`.
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

    // The native runner does everything a caller can ask for (event streaming, piped stdin, a PTY,
    // `inheritEnv: false`, restart); the parity suite compares it with the JS spawner. The JS spawner
    // is reached only through the one-release escape hatch `VIS_CONCURRENT_RUNNER=js`.
    if (resolveConcurrentRunner() === "js") {
        return runConcurrentFallback(configs, { ...options, shellPath });
    }

    return runNativeConcurrent(configs, { ...options, shellPath });
};

/**
 * Run commands concurrently with output streaming and process management.
 *
 * Runs on the native Rust addon. Set `VIS_CONCURRENT_RUNNER=js` to use the
 * legacy pure JavaScript implementation instead (an escape hatch kept for one
 * release; the variable and the JS implementation are removed after that).
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
