import type { TaskFingerprint } from "@visulima/task-runner";
import { Cache, getLastRunSummaryPath, readLastRunSummary } from "@visulima/task-runner";

import { pail } from "../../io/logger";
import { findTaskInSummary, readRunSummaryById } from "../../report/run-summary-utils";
import { getVisRunsDir, getVisWorkspaceDataDir } from "../../util/vis-paths";

/**
 * Hashes are long opaque blobs; show enough prefix to be diff-grep-able
 * but not so much that columns wrap. The trailing `…` is load-bearing —
 * without it the user can't tell whether two truncated values are
 * equal or just share a prefix.
 */
const HASH_DISPLAY_PREFIX = 16;

const truncateHash = (value: string): string => (value.length > HASH_DISPLAY_PREFIX ? `${value.slice(0, HASH_DISPLAY_PREFIX)}…` : value);

const renderHashDetailsBucket = (label: string, bucket: Record<string, string> | undefined, logger: Console): void => {
    const entries = Object.entries(bucket ?? {});

    if (entries.length === 0) {
        return;
    }

    logger.info(`  ${label}:`);
    entries.sort(([a], [b]) => a.localeCompare(b));

    for (const [key, value] of entries) {
        logger.info(`    ${key.padEnd(40)}  ${truncateHash(value)}`);
    }
};

interface RunHashOptions {
    /** Cache roots to read a trace-mode fingerprint from, in lookup order. */
    cacheDirectories?: string[];
    format: string;
    runId: string | undefined;
    workspaceRoot: string;
}

/**
 * Trace-mode tasks have no declared hash details; their tracked inputs live in
 * the cache entry keyed by the run's hash.
 */
const readTrackedFingerprint = async (hash: string | undefined, cacheDirectories: string[], workspaceRoot: string): Promise<TaskFingerprint | undefined> => {
    if (hash === undefined) {
        return undefined;
    }

    for (const cacheDirectory of cacheDirectories) {
        const entry = await new Cache({ cacheDirectory, workspaceRoot }).get(hash);

        if (entry?.fingerprint) {
            return entry.fingerprint;
        }
    }

    return undefined;
};

const renderTrackedFingerprint = (fingerprint: TaskFingerprint, logger: Console): void => {
    renderHashDetailsBucket("tracked files", fingerprint.fileHashes, logger);
    renderHashDetailsBucket("tracked env", fingerprint.envHashes, logger);
    renderHashDetailsBucket("missing files", Object.fromEntries(fingerprint.missingFiles.map((path) => [path, "absent"])), logger);
};

export const runHash = async (taskId: string, options: RunHashOptions, logger: Console): Promise<void> => {
    const { format, runId, workspaceRoot } = options;

    const summary
        = runId === undefined
            ? await readLastRunSummary(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) })
            : await readRunSummaryById(workspaceRoot, runId);

    if (!summary) {
        if (format === "json") {
            process.stdout.write(`${JSON.stringify({ error: "no-summary", runId: runId ?? null, taskId }, undefined, 2)}\n`);
            process.exitCode = 1;

            return;
        }

        if (runId === undefined) {
            pail.error(
                `No previous run summary found. Run a task first to populate \`${getLastRunSummaryPath(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) })}\`.`,
            );
        } else {
            pail.error(`Run summary "${runId}" not found in ${getVisRunsDir(workspaceRoot)}/.`);
        }

        process.exitCode = 1;

        return;
    }

    const task = findTaskInSummary(summary, taskId);

    if (!task) {
        if (format === "json") {
            process.stdout.write(`${JSON.stringify({ error: "task-not-in-summary", runId: summary.id, taskId }, undefined, 2)}\n`);
            process.exitCode = 1;

            return;
        }

        pail.error(`Task "${taskId}" was not part of run ${summary.id}.`);
        process.exitCode = 1;

        return;
    }

    const trackedFingerprint = task.hashDetails === undefined ? await readTrackedFingerprint(task.hash, options.cacheDirectories ?? [], workspaceRoot) : undefined;

    if (format === "json") {
        process.stdout.write(
            `${JSON.stringify(
                {
                    cacheStatus: task.cacheStatus,
                    hash: task.hash ?? null,
                    hashDetails: task.hashDetails ?? null,
                    hashSource: task.hashSource ?? null,
                    runId: summary.id,
                    taskId: task.taskId,
                    trackedFingerprint: trackedFingerprint ?? null,
                },
                undefined,
                2,
            )}\n`,
        );

        return;
    }

    pail.info(`Hash for ${taskId} (run ${summary.id})`);
    logger.info("");
    logger.info(`  status:  ${task.cacheStatus}`);
    logger.info(`  hash:    ${task.hash ?? "(none)"}`);

    if (task.hashSource === "declared-fallback") {
        logger.info("  key:     declared-fallback (no files were tracked; the entry is keyed on the declared inputs below)");
    }

    if (task.hashDetails) {
        logger.info("");
        logger.info(`  command: ${truncateHash(task.hashDetails.command)}`);
        renderHashDetailsBucket("nodes", task.hashDetails.nodes, logger);
        renderHashDetailsBucket("runtime", task.hashDetails.runtime, logger);
        renderHashDetailsBucket("implicitDeps", task.hashDetails.implicitDeps, logger);
    } else if (trackedFingerprint) {
        logger.info("");
        renderTrackedFingerprint(trackedFingerprint, logger);
    } else {
        logger.info("");
        pail.info("No hash details recorded for this task.");
    }
};
