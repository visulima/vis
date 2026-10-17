import { getLastRunSummaryPath, readLastRunSummary } from "@visulima/task-runner";

import { getVisWorkspaceDataDir } from "../../util/vis-paths";

/**
 * Parses the `VIS_RUN_CONCURRENCY_LIMIT` env var into a positive
 * integer. Returns `{ value: N }` on success, `undefined` when the
 * env is unset or empty (silent fallthrough), or `{ invalid: raw }`
 * when the value is set but unparseable — callers surface the
 * invalid case via a warn so misconfigurations aren't silent.
 * Floors fractional values so `VIS_RUN_CONCURRENCY_LIMIT=2.5` is
 * treated as 2 rather than rejected.
 */
export const parseEnvConcurrency = (raw: string | undefined): { invalid: string } | { value: number } | undefined => {
    if (!raw || raw.trim().length === 0) {
        return undefined;
    }

    const value = Number.parseFloat(raw);

    if (!Number.isFinite(value) || value <= 0) {
        return { invalid: raw };
    }

    return { value: Math.floor(value) };
};

/**
 * Renders `.vis/last-summary.json` as a compact stats block.
 *
 * Keeps the format simple on purpose — users who want the full JSON
 * can `cat .vis/last-summary.json` directly. This view is the
 * "glance at what happened" companion to `vis run --last-details`.
 */
export const renderLastRunSummary = async (
    workspaceRoot: string,
    logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<void> => {
    const summary = await readLastRunSummary(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) });

    if (!summary) {
        logger.warn(
            `No previous run recorded yet. Run a task at least once to populate ${getLastRunSummaryPath(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) })}.`,
        );

        return;
    }

    const seconds = (summary.duration / 1000).toFixed(2);

    logger.info("");
    logger.info(`Last run — ${summary.startTime} (${seconds}s)`);
    logger.info("");
    logger.info(`  Total:     ${String(summary.stats.total)}`);
    logger.info(`  Succeeded: ${String(summary.stats.succeeded)}`);
    logger.info(`  Cached:    ${String(summary.stats.cached)}`);
    logger.info(`  Failed:    ${String(summary.stats.failed)}`);
    logger.info(`  Skipped:   ${String(summary.stats.skipped)}`);
    logger.info("");

    if (summary.stats.failed > 0) {
        const failedTasks = summary.tasks.filter((t) => t.exitCode !== undefined && t.exitCode !== 0);

        logger.info("Failed tasks:");

        for (const task of failedTasks) {
            const durationMs = task.duration ?? 0;

            logger.info(`  × ${task.taskId}  (exit ${String(task.exitCode ?? -1)}, ${durationMs}ms)`);
        }

        logger.info("");
    }

    // Slowest 5 — useful for spotting where wall-clock time actually went.
    const slowest = [...summary.tasks]
        .filter((t) => typeof t.duration === "number")
        .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
        .slice(0, 5);

    if (slowest.length > 0) {
        logger.info("Slowest tasks:");

        for (const task of slowest) {
            logger.info(`  ${task.taskId.padEnd(40)}  ${String(task.duration ?? 0).padStart(6)}ms  [${task.cacheStatus}]`);
        }

        logger.info("");
    }
};

export const parseCacheMode = (value: string | undefined): "read" | "readwrite" | "write" | undefined => {
    if (value === undefined || value === "") {
        return undefined;
    }

    if (value !== "read" && value !== "write" && value !== "readwrite") {
        throw new Error(`--cache-mode must be one of: read, write, readwrite (received "${value}")`);
    }

    return value;
};

export const parseCacheBackend = (value: string | undefined): "http" | "reapi" | undefined => {
    if (value === undefined || value === "") {
        return undefined;
    }

    if (value !== "http" && value !== "reapi") {
        throw new Error(`--cache-backend must be one of: http, reapi (received "${value}")`);
    }

    return value;
};

export const parseHashMode = (value: string | undefined): "declared" | "trace" | undefined => {
    if (value === undefined || value === "") {
        return undefined;
    }

    if (value !== "declared" && value !== "trace") {
        throw new Error(`--hash-mode must be one of: declared, trace (received "${value}")`);
    }

    return value;
};
