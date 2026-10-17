import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import { buildRunGraph, printDryRunPlan, runPreflightChecks, shapeTaskGraph } from "./handler-parts/run-graph";
import { runInteractiveMode, runStaticMode } from "./handler-parts/run-modes";
import { armRunCleanup, prepareRunRuntime, teardownRun } from "./handler-parts/run-runtime";
import { buildInitialTasks, loadRunWorkspace, selectProjectsWithTarget, selectRunProjects } from "./handler-parts/run-select";
import { attachRegisteredServices, finalizeServiceGraph, injectMissingServices } from "./handler-parts/run-services";
import type { RunOptions } from "./index";

/**
 * `vis run TARGET`: select projects, build and preflight the task graph,
 * attach or boot services, then run the tasks (interactive, static, or watch).
 * Each phase lives in `./handler-parts/run-*.ts`; a phase returning `true`
 * (or `undefined` from the workspace load) ends the run early.
 */
const execute = async ({ argument, logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, RunOptions>): Promise<void> => {
    if (!wsRoot) {
        throw new Error("Could not determine workspace root. Run this command inside a monorepo.");
    }

    const ctx = await loadRunWorkspace({ argument, logger, options, visConfig, workspaceRoot: wsRoot });

    if (!ctx) {
        return;
    }

    if (await selectRunProjects(ctx)) {
        return;
    }

    if (selectProjectsWithTarget(ctx)) {
        return;
    }

    if (buildInitialTasks(ctx)) {
        return;
    }

    buildRunGraph(ctx);
    await runPreflightChecks(ctx);

    const serviceResult = await attachRegisteredServices(ctx);

    injectMissingServices(ctx, serviceResult);
    finalizeServiceGraph(ctx, serviceResult);

    // Arm before anything that can throw: services may already be booted by
    // now, so a failure in shaping, the runtime hooks or the modes must still
    // tear them down.
    const cleanup = armRunCleanup(ctx);

    try {
        shapeTaskGraph(ctx);

        if (printDryRunPlan(ctx)) {
            return;
        }

        const runtime = await prepareRunRuntime(ctx, serviceResult);

        await (runtime.isTTY ? runInteractiveMode(ctx, runtime) : runStaticMode(ctx, runtime));
    } finally {
        await teardownRun(ctx, cleanup);
    }
};

export default execute as CommandExecute<Toolbox>;
