import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import type { ProcessEvent, TaskResults } from "@visulima/task-runner";
import { runConcurrently, TerminalBuffer } from "@visulima/task-runner";

import { buildProjectGraph, discoverWorkspace, loadVisTaskConfigsForWorkspace } from "../../config/workspace";
import { resolveCommandRuntime } from "../../runtime/command-runtime";
import { cleanupLegacyTaskRunnerLayout } from "../../util/vis-paths";
import type { RunOptions } from "./index";
import { MAX_OUTPUT_BYTES } from "./output";
import { renderLastRunSummary } from "./parse";
import { createRunCleanup } from "./run-cleanup";
import { printDryRunPlan } from "./run-dry-run";
import { createInteractiveSession, runInteractiveRerun, waitForInteractiveAction } from "./run-interactive";
import { runStartupPreflights } from "./run-preflight";
import { createRunRuntime } from "./run-runtime";
import { resolveRunSelection } from "./run-selection";
import { wireRunServices } from "./run-services";
import { runStaticMode } from "./run-static";
import { logRegistryServiceHint } from "./run-summary";
import { finalizeRunTaskGraph } from "./run-task-graph";
import { buildRunTasks } from "./run-tasks";
import { resolveTaskCommand } from "./shell";
import { resolveRetrySpawn } from "./task-env";

const execute = async ({ argument, logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, RunOptions>): Promise<void> => {
    if (!wsRoot) {
        throw new Error("Could not determine workspace root. Run this command inside a monorepo.");
    }

    const workspaceRoot = wsRoot;

    // Validate the selected runtime (--runtime / VIS_RUNTIME / config). `run`
    // orchestrates tool binaries (tsc, vite, eslint, …) that are runtime-agnostic,
    // so it deliberately does NOT change task execution based on the runtime — and
    // must not inject it into the task env, which would rotate every task's cache
    // hash. We only validate and resolve the runtime, matching the PM verbs.
    // Runtime-specific *execution* lives in `vis x` (file runner) and the PM verbs,
    // not in task orchestration.
    resolveCommandRuntime({ options, visConfig }, workspaceRoot);

    // Vis used to write its run state under `.task-runner/` and the cache
    // under `.task-runner-cache/`. After the cutover to `.vis/` those paths
    // are no longer read, so silently sweep them away on the next run.
    cleanupLegacyTaskRunnerLayout(workspaceRoot);

    // `--last-details` short-circuits execution: render the
    // persisted last-run summary and exit. Handles the common
    // "I ran tests 30s ago, show me what happened" case without
    // re-running and (more importantly) without needing the
    // workspace to be in a runnable state.
    if (options.lastDetails) {
        await renderLastRunSummary(workspaceRoot, logger);

        return;
    }

    // The directory the user invoked `vis` from, captured before any
    // workspace resolution. Propagated as INIT_CWD to every task —
    // matches pnpm/npm/yarn semantics so scripts can resolve paths
    // relative to where the user actually ran the command.
    const invocationCwd = process.cwd();
    const taskConfigs = await loadVisTaskConfigsForWorkspace(workspaceRoot, visConfig);
    const { config, fileOwners, packageJsons, projectOptions, workspace } = discoverWorkspace(workspaceRoot, visConfig, taskConfigs);
    const projectGraph = buildProjectGraph(workspaceRoot, workspace, packageJsons);

    const selection = await resolveRunSelection({
        argument,
        config,
        fileOwners,
        logger,
        options,
        packageJsons,
        projectGraph,
        projectOptions,
        visConfig,
        workspace,
        workspaceRoot,
    });

    if (!selection) {
        return;
    }

    const { affectedFiles, currentOs, forwardedArgs, projectsWithTarget, projectTargetIndex, target } = selection;

    const runTasks = buildRunTasks({
        affectedFiles,
        config,
        forwardedArgs,
        logger,
        options,
        projectGraph,
        projectOptions,
        projectsWithTarget,
        projectTargetIndex,
        target,
        workspace,
    });

    if (!runTasks) {
        return;
    }

    const { persistentTasks } = runTasks;
    let { initialTasks, taskGraph } = runTasks;

    await runStartupPreflights({ config, logger, options, packageJsons, workspaceRoot });

    const services = await wireRunServices({ config, initialTasks, logger, options, persistentTasks, target, taskGraph, workspaceRoot });

    initialTasks = services.initialTasks;
    taskGraph = services.taskGraph;

    const {
        ephemeralPidFiles,
        injectedServiceIdSet,
        registryStartedCount,
        registryStartedIds,
        registryStartedPids,
        serviceDockStore,
        serviceEnvByTaskId,
        serviceEventBridge,
        serviceResult,
        serviceRunDir,
    } = services;

    taskGraph = finalizeRunTaskGraph({ logger, options, projectOptions, taskGraph });

    if (options.dryRun) {
        printDryRunPlan({ config, logger, persistentTasks, taskGraph });

        return;
    }

    const runtime = await createRunRuntime({
        affectedFiles,
        config,
        currentOs,
        initialTasks,
        invocationCwd,
        logger,
        options,
        persistentTasks,
        projectsWithTarget,
        serviceEnvByTaskId,
        serviceResult,
        target,
        taskGraph,
        visConfig,
        workspaceRoot,
    });

    await runtime.hooks.callHook("run:before", { tasks: initialTasks, workspaceRoot });

    const stopServicesOnExit = options.stopServices;
    const cleanup = createRunCleanup({
        ephemeralPidFiles,
        registryStartedIds,
        registryStartedPids,
        serviceEventBridge,
        serviceRunDir,
        stopServicesOnExit,
        workspaceRoot,
    });

    cleanup.install();

    try {
        if (runtime.isTTY) {
            const { spawnContext } = runtime;
            const { dynamic, lifeCycle, stdinRegistry, store, taskExecutor } = createInteractiveSession({
                injectedServiceIdSet,
                runtime,
                serviceDockStore,
                serviceEventBridge,
                workspaceRoot,
            });

            let loopAction: "quit" | "rerun" | "retry" = "rerun";
            let retryTaskId: string | null = null;

            let lastResults: TaskResults = new Map();

            while (loopAction !== "quit") {
                if (loopAction === "rerun") {
                    lastResults = await runInteractiveRerun({
                        dynamic,
                        initialTasks,
                        lifeCycle,
                        options,
                        persistentTasks,
                        projectGraph,
                        runtime,
                        stdinRegistry,
                        store,
                        taskExecutor,
                        taskGraph,
                        workspaceRoot,
                    });
                } else if (loopAction === "retry" && retryTaskId) {
                    // A split target retries by segment id, which only the graph knows.
                    const task = taskGraph.tasks[retryTaskId] ?? initialTasks.find((t) => t.id === retryTaskId);
                    // Same command the first attempt ran, so a retry keeps its forwarded arguments and shell.
                    const command = task ? resolveTaskCommand(task, spawnContext.affectedFiles, currentOs) : undefined;

                    if (task && command) {
                        lifeCycle.startTasks?.([task]);

                        const retryTermBuf = new TerminalBuffer(MAX_OUTPUT_BYTES);

                        // Same cwd and child environment as the first attempt.
                        const retrySpawn = resolveRetrySpawn(spawnContext, task);

                        const retryResult = await runConcurrently(
                            [
                                {
                                    command,
                                    cwd: retrySpawn.cwd,
                                    env: retrySpawn.env,
                                    inheritEnv: retrySpawn.inheritEnv,
                                    name: task.id,
                                    ptySize: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
                                    stdin: "pty",
                                },
                            ],
                            {
                                onEvent: (event: ProcessEvent) => {
                                    if (event.kind === "started" && event.write) {
                                        stdinRegistry.set(task.id, { kill: event.kill, resize: event.resize, write: event.write });
                                    }

                                    if ((event.kind === "stdout" || event.kind === "stderr") && event.text) {
                                        retryTermBuf.write(event.text);
                                        store.setOutput(task.id, retryTermBuf.toString());
                                    }

                                    if (event.kind === "close") {
                                        stdinRegistry.delete(task.id);
                                    }
                                },
                            },
                        );

                        const closeEvent = retryResult.closeEvents[0];

                        lifeCycle.endTasks?.([
                            {
                                code: closeEvent?.exitCode ?? 1,
                                status: closeEvent?.exitCode === 0 ? "success" : "failure",
                                task,
                                terminalOutput: store.getSnapshot().outputs.get(task.id),
                            },
                        ]);
                    } else if (task) {
                        lifeCycle.endTasks?.([
                            {
                                code: 1,
                                status: "failure",
                                task,
                                terminalOutput: `No command configured for ${task.id}`,
                            },
                        ]);
                    }

                    retryTaskId = null;

                    // Mark done after retry so user can rerun/retry again
                    store.markDone();
                }

                const next = await waitForInteractiveAction({ dynamic, store });

                loopAction = next.action;
                retryTaskId = next.retryTaskId;
            }

            await dynamic.renderIsDone;
            await runtime.hooks.callHook("run:after", lastResults);
            await runtime.maybeWriteProfile(lastResults);

            logRegistryServiceHint({ logger, registryStartedCount, stopServicesOnExit });
        } else {
            await runStaticMode({
                initialTasks,
                logger,
                options,
                persistentTasks,
                projectGraph,
                projectsWithTarget,
                registryStartedCount,
                runtime,
                serviceEventBridge,
                stopServicesOnExit,
                taskGraph,
                visConfig,
                workspace,
                workspaceRoot,
            });
        }
    } finally {
        await cleanup.finish();
    }
};

export default execute as CommandExecute<Toolbox>;
