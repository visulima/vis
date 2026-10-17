import type { Toolbox } from "@visulima/cerebro";
import type { TaskResults } from "@visulima/task-runner";

import { VisUserError } from "../../errors/vis-user-error";
import { analyzeFlakiness, formatFlakinessTable } from "../../report/flakiness";
import type { loadRunSummaries } from "../../report/run-report";
import type { RunOptions } from "./index";

/**
 * Post-run reporting for a static (non-watch) run: the historical flaky-task
 * table, the `--fail-on-retry` gate, and the thrown failure summary. Throws
 * a VisUserError when the run failed or a retry was not allowed to pass.
 */
export const reportRunOutcome = ({
    firstRun,
    hasFailure,
    logger,
    options,
    workspaceRoot,
}: {
    firstRun: { results: TaskResults; runHistory: ReturnType<typeof loadRunSummaries> };
    hasFailure: boolean;
    logger: Toolbox<Console, RunOptions>["logger"];
    options: RunOptions;
    workspaceRoot: string;
}): void => {
    // Print historical flakiness regardless of this run's outcome —
    // a clean run that masked a flaky task via retries (or one that
    // hasn't tripped the flake yet today) shouldn't hide history
    // that would help the user investigate. Suppressed with
    // `--no-flaky`. Reuses the history already loaded for the
    // timing comparison above — the runs/ directory hasn't
    // changed since this turn of the loop started.
    if (options.flaky) {
        const flakyStats = analyzeFlakiness(workspaceRoot, { minRuns: 2 }, firstRun.runHistory);

        if (flakyStats.length > 0) {
            logger.info("");
            logger.info("Flaky tasks (based on historical runs):");
            logger.info("");

            for (const line of formatFlakinessTable(flakyStats)) {
                logger.info(`  ${line}`);
            }

            logger.info("");
        }
    }

    // `--fail-on-retry` upgrades any retried-but-passed task into a
    // run failure. Lets CI surface flakes that retries would
    // otherwise mask — useful as a periodic "nightly" check that
    // disables the safety net the day-to-day workflow keeps on.
    const retriedTaskIds: string[] = [];

    for (const [taskId, result] of firstRun.results) {
        if (result.retryAttempts && result.retryAttempts > 0) {
            retriedTaskIds.push(taskId);
        }
    }

    const failOnRetry = options.failOnRetry && retriedTaskIds.length > 0;

    if (failOnRetry) {
        // Cap the rendered list so a wide flake (every task retried
        // once) doesn't produce a multi-screen warn line that buries
        // surrounding context in CI logs.
        const MAX_LISTED = 5;
        const listedIds = retriedTaskIds.slice(0, MAX_LISTED);
        const remaining = retriedTaskIds.length - listedIds.length;
        const idsRendered = remaining > 0 ? `${listedIds.join(", ")}, and ${String(remaining)} more` : listedIds.join(", ");

        logger.warn("");
        logger.warn(`--fail-on-retry: ${String(retriedTaskIds.length)} task(s) succeeded only after retry: ${idsRendered}`);
    }

    if (hasFailure || failOnRetry) {
        const headline = failOnRetry && !hasFailure ? "Some tasks succeeded only after retry (--fail-on-retry)." : "Some tasks failed.";

        // Tail the captured terminal output of every failed task into
        // the thrown error so callers (especially programmatic ones
        // like vitest runs that mute the logger) see *why* a task
        // failed, not just *that* one did. Cap each tail so a runaway
        // log doesn't drown the stack trace.
        const TAIL_BYTES = 2000;
        const failureDetails: string[] = [];

        for (const [taskId, result] of firstRun.results) {
            if (result.status !== "failure") {
                continue;
            }

            const output = result.terminalOutput ?? "";
            const tail = output.length > TAIL_BYTES ? `…${output.slice(-TAIL_BYTES)}` : output;
            const code = result.code ?? "?";

            failureDetails.push(
                `  ${taskId} (exit ${String(code)}):\n${tail
                    .split("\n")
                    .map((l) => `    ${l}`)
                    .join("\n")}`,
            );
        }

        // A failed task is the run reporting a result, not vis
        // malfunctioning — a stack here would bury the summary block
        // that actually names the failures.
        throw new VisUserError(failureDetails.length > 0 ? `${headline}\n${failureDetails.join("\n")}` : headline);
    }
};

/**
 * Logs the one-line hint after a run that started registry-mode services:
 * either that they were stopped (`--stop-services`) or how to stop them.
 */
export const logRegistryServiceHint = ({
    logger,
    registryStartedCount,
    stopServicesOnExit,
}: {
    logger: Toolbox<Console, RunOptions>["logger"];
    registryStartedCount: number;
    stopServicesOnExit: boolean | undefined;
}): void => {
    if (registryStartedCount > 0) {
        logger.info("");

        if (stopServicesOnExit) {
            logger.info(`${String(registryStartedCount)} service(s) stopped (--stop-services).`);
        } else {
            logger.info(`${String(registryStartedCount)} service(s) started in the background. Run \`vis service stop --all\` to clean up.`);
        }
    }
};
