import type { Toolbox } from "@visulima/cerebro";
import type { RunSummary, TaskSummary } from "@visulima/task-runner";
import { describeCacheMissReason, getLastRunSummaryPath, readLastRunSummary } from "@visulima/task-runner";

import { pail } from "../../io/logger";
import { diffHashDetails, findTaskInSummary, readPreviousRunSummary, readRunSummaryById } from "../../report/run-summary-utils";
import type { HashDetailsDiff } from "../../report/types";
import { getVisRunsDir, getVisWorkspaceDataDir } from "../../util/vis-paths";
import type { CacheWhyOptions } from "./index";
import { resolveWorkspaceRoot } from "./shared";

/**
 * Hashes are long opaque blobs; show enough prefix to be diff-grep-able
 * but not so much that columns wrap. The trailing `…` is load-bearing —
 * without it the user can't tell whether two truncated values are
 * equal or just share a prefix.
 */
const HASH_DISPLAY_PREFIX = 16;

export const truncateHash = (value: string): string => (value.length > HASH_DISPLAY_PREFIX ? `${value.slice(0, HASH_DISPLAY_PREFIX)}…` : value);

export const renderHashDetailsBucket = (label: string, bucket: Record<string, string> | undefined, logger: Console): void => {
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

interface RunWhyOptions {
    format: string;
    runId: string | undefined;
    workspaceRoot: string;
}

export const writeJsonLine = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`);
};

const reportWhyMissingSummary = (format: string, taskId: string, runId: string | undefined, workspaceRoot: string): void => {
    if (format === "json") {
        writeJsonLine({ error: "no-summary", runId: runId ?? null, taskId });
    } else if (runId === undefined) {
        pail.error(
            `No previous run summary found. Run a task first to populate \`${getLastRunSummaryPath(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) })}\`.`,
        );
    } else {
        pail.error(`Run summary "${runId}" not found in ${getVisRunsDir(workspaceRoot)}/.`);
    }

    process.exitCode = 1;
};

const reportWhyTaskNotInSummary = (format: string, taskId: string, summary: RunSummary): void => {
    if (format === "json") {
        writeJsonLine({ error: "task-not-in-summary", runId: summary.id, taskId });
    } else {
        pail.error(`Task "${taskId}" was not part of run ${summary.id}.`);
        pail.info(`Tasks in this run: ${summary.tasks.map((t) => t.taskId).join(", ") || "(none)"}`);
    }

    process.exitCode = 1;
};

const buildWhyJson = (
    summary: RunSummary,
    task: TaskSummary,
    previousSummary: RunSummary | undefined,
    previousTask: TaskSummary | undefined,
    diff: HashDetailsDiff,
): Record<string, unknown> => {
    return {
        diff,
        previousRunId: previousSummary?.id ?? null,
        previousTask: previousTask
            ? {
                cacheStatus: previousTask.cacheStatus,
                hash: previousTask.hash ?? null,
                hashDetails: previousTask.hashDetails ?? null,
            }
            : null,
        runId: summary.id,
        task: {
            cacheMissReasons: task.cacheMissReasons ?? null,
            cacheStatus: task.cacheStatus,
            hash: task.hash ?? null,
            hashDetails: task.hashDetails ?? null,
            hashSource: task.hashSource ?? null,
            taskId: task.taskId,
        },
    };
};

const printWhyHeader = (
    taskId: string,
    summary: RunSummary,
    task: TaskSummary,
    previousSummary: RunSummary | undefined,
    previousTask: TaskSummary | undefined,
    logger: Console,
): void => {
    pail.info(`Why ${taskId}? (run ${summary.id})`);
    logger.info("");
    logger.info(`  status:  ${task.cacheStatus}`);
    logger.info(`  hash:    ${task.hash ?? "(none)"}`);

    if (task.hashSource === "declared-fallback") {
        logger.info("  key:     declared-fallback (tracker observed no workspace access; keyed on declared inputs)");
    }

    if (previousTask) {
        logger.info(`  prev:    ${previousTask.hash ?? "(none)"}  [run ${previousSummary?.id ?? "?"}]`);
    } else {
        logger.info(`  prev:    (no prior run found)`);
    }

    logger.info("");
};

const printTraceModeWhy = (taskId: string, summary: RunSummary, task: TaskSummary, logger: Console): void => {
    // Trace-mode tasks keep no declared hash inputs, so the diff is empty by
    // construction. Their explanation is the recorded miss reason.
    if (task.cacheMissReasons && task.cacheMissReasons.length > 0) {
        logger.info("Cache miss reasons (trace-mode fingerprint):");

        for (const reason of task.cacheMissReasons) {
            logger.info(`  - ${describeCacheMissReason(reason)}`);
        }
    } else {
        pail.info("No hash inputs recorded for this run (trace-mode tasks record a miss reason only when the cache misses).");
    }

    logger.info("");
    pail.info(`Tracked files and env of this run: vis cache hash ${taskId} --run ${summary.id}`);
};

const hasNoHashChanges = (diff: HashDetailsDiff): boolean =>
    !diff.commandChanged
    && [diff.nodes, diff.runtime, diff.implicitDeps].every((bucket) => bucket.added.length === 0 && bucket.changed.length === 0 && bucket.removed.length === 0);

const printHashInputChanges = (diff: HashDetailsDiff, logger: Console): void => {
    logger.info("Hash inputs that changed since the previous run:");
    logger.info("");

    if (diff.commandChanged) {
        logger.info("  command:  changed");
    }

    for (const bucket of ["nodes", "runtime", "implicitDeps"] as const) {
        const bucketDiff = diff[bucket];

        if (bucketDiff.added.length === 0 && bucketDiff.changed.length === 0 && bucketDiff.removed.length === 0) {
            continue;
        }

        logger.info(`  ${bucket}:`);

        for (const key of bucketDiff.added) {
            logger.info(`    + ${key}`);
        }

        for (const key of bucketDiff.changed) {
            logger.info(`    ~ ${key}`);
        }

        for (const key of bucketDiff.removed) {
            logger.info(`    - ${key}`);
        }
    }
};

export const runWhy = async (taskId: string, options: RunWhyOptions, logger: Console): Promise<void> => {
    const { format, runId, workspaceRoot } = options;

    const summary
        = runId === undefined
            ? await readLastRunSummary(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) })
            : await readRunSummaryById(workspaceRoot, runId);

    if (!summary) {
        reportWhyMissingSummary(format, taskId, runId, workspaceRoot);

        return;
    }

    const task = findTaskInSummary(summary, taskId);

    if (!task) {
        reportWhyTaskNotInSummary(format, taskId, summary);

        return;
    }

    const previousSummary = await readPreviousRunSummary(workspaceRoot, summary.id);
    const previousTask = previousSummary ? findTaskInSummary(previousSummary, taskId) : undefined;
    const diff = diffHashDetails(task.hashDetails, previousTask?.hashDetails);

    if (format === "json") {
        writeJsonLine(buildWhyJson(summary, task, previousSummary, previousTask, diff));

        return;
    }

    printWhyHeader(taskId, summary, task, previousSummary, previousTask, logger);

    if (task.hashDetails === undefined) {
        printTraceModeWhy(taskId, summary, task, logger);

        return;
    }

    if (!previousTask) {
        pail.info("No previous run to diff against — first time this task was recorded.");

        return;
    }

    if (hasNoHashChanges(diff)) {
        pail.success("No hash inputs changed since the previous run.");

        return;
    }

    printHashInputChanges(diff, logger);
    logger.info("");
    pail.info(`Last summary file: ${getLastRunSummaryPath(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) })}`);
};

export const cacheWhyExecute = async ({ argument, logger, options, workspaceRoot: wsRoot }: Toolbox<Console, CacheWhyOptions>): Promise<void> => {
    const taskId = argument[0];

    if (!taskId) {
        pail.error("No task ID specified. Usage: vis cache why <project>:<target>");
        process.exitCode = 1;

        return;
    }

    await runWhy(
        taskId,
        {
            format: options.format ?? "table",
            runId: options.run,
            workspaceRoot: resolveWorkspaceRoot(wsRoot),
        },
        logger,
    );
};
