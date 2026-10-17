import type { Toolbox } from "@visulima/cerebro";
import isInCi from "is-in-ci";

import type { discoverWorkspace } from "../../config/workspace";
import { runLockfilePreflight } from "../../preflight/lockfile";
import { maybePromptViteClientOverride } from "../../preflight/vite-client-override";
import { runToolchainPreflight } from "../../runtime/toolchain";
import type { RunOptions } from "./index";

/**
 * Startup preflights that run before the task graph is executed: the
 * workspace toolchain pin, the lockfile drift check, and the one-time
 * vite client override prompt. Throws when the lockfile check fails.
 */
export const runStartupPreflights = async ({
    config,
    logger,
    options,
    packageJsons,
    workspaceRoot,
}: Pick<ReturnType<typeof discoverWorkspace>, "config" | "packageJsons"> & {
    logger: Toolbox<Console, RunOptions>["logger"];
    options: RunOptions;
    workspaceRoot: string;
}): Promise<void> => {
    // Pre-flight: if a workspace tool pin doesn't match the running
    // version and `toolchain.autoInstall` is on (default when a
    // manager is detected), install via the right manager and let
    // subsequent task subprocesses pick up the new version. We
    // never block on failure — surface a warning, keep going,
    // and let the existing runtime-check warnings do their job.
    //
    // Runs before service auto-attach so the right Node/PM is in
    // place when the probe runs, and before the dry-run short-circuit
    // so `--dry-run` still surfaces toolchain drift.
    await runToolchainPreflight(
        workspaceRoot,
        config.toolchain,
        {
            error: (message) => {
                logger.error(message);
            },
            info: (message) => {
                logger.info(message);
            },
            warn: (message) => {
                logger.warn(message);
            },
        },
        Boolean(options.skipToolchain),
    );

    // Lockfile/install drift check. Fires after toolchain (so the
    // suggested install command runs against the right Node) and
    // before service auto-attach + task execution. CLI flag wins over
    // config; both default to on. The helper logs the warn line itself
    // in TTY; in CI it stays silent and we throw with `formattedMessage`
    // so the user sees the detail exactly once.
    const preflightEnabled = options.preflight !== false && config.preflight?.lockfile !== false;
    const lockfilePreflight = runLockfilePreflight(
        workspaceRoot,
        isInCi,
        {
            warn: (message) => {
                logger.warn(message);
            },
        },
        { skip: !preflightEnabled },
    );

    if (!lockfilePreflight.shouldContinue) {
        throw new Error(`${lockfilePreflight.formattedMessage ?? "preflight: lockfile drift detected"} (pass --no-preflight to bypass)`);
    }

    // One-time offer to alias @voidzero-dev/vite-task-client to our
    // drop-in client so its cache hints reach the runner. TTY-only and
    // remembers a decline, so CI and repeat runs are never blocked.
    if (preflightEnabled && !isInCi && process.stdin.isTTY && process.stdout.isTTY) {
        await maybePromptViteClientOverride(workspaceRoot, {
            interactive: true,
            logger: {
                info: (message) => {
                    logger.info(message);
                },
                warn: (message) => {
                    logger.warn(message);
                },
            },
            // Scan every discovered project manifest, not just the root —
            // a tool depending on the vite client may live in a sub-package.
            projectManifests: [...packageJsons.values()],
        });
    }
};
