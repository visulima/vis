import type { Toolbox } from "@visulima/cerebro";
import type { LogMode, Task, TaskGraph, TaskResults } from "@visulima/task-runner";
import { CompositeLifeCycle, createLogReporter, defaultTaskRunner, generateRunSummary, writeRunSummary } from "@visulima/task-runner";

import { compareDuration, formatTimingSummary, loadRunSummaries } from "../../report/run-report";
import { StaticOutputLifeCycle } from "../../tui/static-life-cycle";
import { getVisWorkspaceDataDir } from "../../util/vis-paths";
import { collectTrackedWatchTargets, createTrackedFileFilter, startWatcher } from "../../watch/watch";
import { applyProjectFilter } from "../../watch/watch-filter";
import type { KeybindHandle } from "../../watch/watch-keybinds";
import { installKeybinds, writeHelp } from "../../watch/watch-keybinds";
import type { MutexPool } from "./executor";
import { createConcurrentExecutor } from "./executor";
import type { RunOptions } from "./index";
import { runPersistentTasks } from "./persistent-tasks";
import type { DiscoveredWorkspace, RunLogger, RunProjectGraph } from "./run-context";
import type { RunRuntime } from "./run-runtime";
import { logRegistryServiceHint, reportRunOutcome } from "./run-summary";
import type { ServiceEventBridge } from "./service-event-bridge";
import { resolveTaskSpawn } from "./task-env";

/**
 * Runs the regular graph once in static (log) output mode. In `--watch` mode
 * it keeps rerunning on file changes and handles the keybinds until quit.
 * Otherwise it reports flakiness and failures, runs persistent tasks and
 * returns.
 */
export const runStaticMode = async ({
    initialTasks: initialTasksIn,
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
}: {
    initialTasks: Task[];
    logger: RunLogger;
    options: RunOptions;
    persistentTasks: Task[];
    projectGraph: RunProjectGraph;
    projectsWithTarget: string[];
    registryStartedCount: number;
    runtime: RunRuntime;
    serviceEventBridge: ServiceEventBridge | null;
    stopServicesOnExit: boolean | undefined;
    taskGraph: TaskGraph;
    visConfig: Toolbox<Console, RunOptions>["visConfig"];
    workspace: DiscoveredWorkspace["workspace"];
    workspaceRoot: string;
}): Promise<void> => {
    const { childEnvPolicyFor, failureLogLifeCycle, hookLifeCycle, hooks, lifecycleOptions, maybeWriteProfile, outputStyle, preTraceCheck, resolveCommand, runnerOptions, sharedRetryBudget, spawnContext, startTime, strictEnvFailure } = runtime;
    let initialTasks = initialTasksIn;

    const mutexPool: MutexPool = new Map();
    const logModeOption = typeof options.log === "string" ? options.log.toLowerCase() : "";
    const logMode: LogMode | undefined
        = logModeOption === "labeled" || logModeOption === "grouped" || logModeOption === "interleaved" ? logModeOption : undefined;
    const logReporter = logMode ? createLogReporter(logMode) : undefined;
    // Composite so plugin hooks see every task boundary event in
    // addition to the CI-style static renderer. Build the
    // lifecycle first so the executor can forward streaming
    // stdout/stderr chunks into it.
    const lifeCycle = new CompositeLifeCycle([
        new StaticOutputLifeCycle({ ...lifecycleOptions, ciGrouping: visConfig?.run?.ciGrouping ?? "auto", logReporter, outputStyle }),
        hookLifeCycle,
        failureLogLifeCycle,
    ]);

    const taskExecutor = createConcurrentExecutor({
        hooks,
        lifeCycle,
        mutexPool,
        resolveCommand,
        retryBudget: sharedRetryBudget,
        serviceEventBridge: serviceEventBridge ?? undefined,
        spawnContext,
        strictEnvFailure,
        workspaceRoot,
    });

    const runOnce = async (): Promise<{ hasFailure: boolean; results: TaskResults; runHistory: Awaited<ReturnType<typeof loadRunSummaries>> }> => {
        const runStart = Date.now();

        const results = await defaultTaskRunner(initialTasks, runnerOptions, {
            childEnvPolicy: childEnvPolicyFor,
            lifeCycle,
            preTraceCheck,
            projectGraph,
            resolveChildEnv: (task, spawnOptions) => resolveTaskSpawn(spawnContext, task, spawnOptions),
            resolveCommand,
            taskExecutor,
            taskGraph,
            workspaceRoot,
        });

        const durationMs = Date.now() - runStart;

        if (options.summarize) {
            const summary = generateRunSummary(results, taskGraph, startTime);

            await writeRunSummary(summary, workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) });
        }

        let hasFailure = false;

        for (const [, result] of results) {
            if (result.status === "failure") {
                hasFailure = true;
            }
        }

        const timingLine = formatTimingSummary(results, durationMs);

        // Load historical summaries once here and share with
        // the flakiness analyzer below — both consumers need
        // the same files and duplicate reads dominate when
        // the runs/ dir has accumulated hundreds of entries.
        const runHistory = loadRunSummaries(workspaceRoot);
        const durationComparison = compareDuration(workspaceRoot, durationMs, runHistory);

        logger.info("");
        logger.info(`  ${timingLine}${durationComparison ? ` ${durationComparison}` : ""}`);

        return { hasFailure, results, runHistory };
    };

    const firstRun = await runOnce();

    await hooks.callHook("run:after", firstRun.results);
    await maybeWriteProfile(firstRun.results);

    const { hasFailure } = firstRun;

    if (options.watch) {
        const absoluteRoots = projectsWithTarget
            .map((name) => {
                const project = workspace.projects[name];
                const root = project?.root;

                if (!root) {
                    return undefined;
                }

                return root.startsWith("/") ? root : `${workspaceRoot}/${root}`;
            })
            .filter((p): p is string => p !== undefined);

        // Snapshot the post-partition task set so `a` (clear filter)
        // can return to it after `p` narrowed the run.
        const baseTasks = initialTasks;
        let projectFilter: string | undefined;

        const applyFilter = (filter: string | undefined): number => {
            const result = applyProjectFilter(baseTasks, filter);

            projectFilter = result.filter;
            initialTasks = result.tasks;

            return result.tasks.length;
        };

        let running = false;
        let lastResults = firstRun.results;

        // Builds a fresh watcher after each run so the watch set
        // reflects the files the latest run actually touched.
        // Falls back to project roots on the first invocation
        // (no prior results) or when no task carries hashDetails.
        const buildHandle = (): { handle: ReturnType<typeof startWatcher>; mode: "tracked" | "roots" } => {
            const targets = collectTrackedWatchTargets(lastResults, workspaceRoot);

            if (targets.directories.length > 0 && targets.files.size > 0) {
                const filter = createTrackedFileFilter(targets.files, workspaceRoot, targets.directories);

                return {
                    handle: startWatcher({
                        filter,
                        onChange: onChangeHandler,
                        paths: targets.directories,
                    }),
                    mode: "tracked",
                };
            }

            return {
                handle: startWatcher({ onChange: onChangeHandler, paths: absoluteRoots }),
                mode: "roots",
            };
        };

        let currentHandle: ReturnType<typeof startWatcher> | undefined;

        const onChangeHandler = async (paths: string[]): Promise<void> => {
            if (running) {
                return;
            }

            running = true;

            try {
                logger.info(`Change detected in ${paths.length} file(s), rerunning…`);

                const nextRun = await runOnce();

                lastResults = nextRun.results;

                // Rebuild the watcher so the next event only
                // fires for files the newest run still cares
                // about. Cheap — under 100ms on typical graphs.
                currentHandle?.close();

                const rebuilt = buildHandle();

                currentHandle = rebuilt.handle;
            } finally {
                running = false;
            }
        };

        const initial = buildHandle();

        currentHandle = initial.handle;

        const scope
            = initial.mode === "tracked"
                ? `Watching ${String(collectTrackedWatchTargets(lastResults, workspaceRoot).files.size)} tracked file(s)`
                : `Watching ${String(absoluteRoots.length)} project root(s)`;

        logger.info(`${scope} — edit a file to rerun, press h for keybinds, q to quit.`);

        const triggerRerun = async (): Promise<void> => {
            if (running) {
                return;
            }

            running = true;

            try {
                if (initialTasks.length === 0) {
                    logger.info("No tasks match the active filter — press a to clear it.");

                    return;
                }

                const nextRun = await runOnce();

                lastResults = nextRun.results;
                currentHandle?.close();

                const rebuilt = buildHandle();

                currentHandle = rebuilt.handle;
            } finally {
                running = false;
            }
        };

        await new Promise<void>((resolve) => {
            let exited = false;
            // Forward declarations so `exit()` can reference both the
            // SIGINT listener and the keybind handle without hitting
            // a TDZ if a future refactor calls exit() synchronously.
            let keybinds: KeybindHandle | undefined;
            const onSigint = (): void => {
                exit();
            };

            const exit = (): void => {
                if (exited) {
                    return;
                }

                exited = true;
                keybinds?.close();
                process.off("SIGINT", onSigint);
                currentHandle?.close();
                resolve();
            };

            process.on("SIGINT", onSigint);

            keybinds = installKeybinds({
                handlers: {
                    onClearFilter: async () => {
                        const total = applyFilter(undefined);

                        logger.info(`Filter cleared — running ${String(total)} task(s).`);
                        await triggerRerun();
                    },
                    onFilter: async (pattern) => {
                        // Capture before mutating — applyFilter() overwrites
                        // projectFilter, so we'd lose the rollback target
                        // otherwise.
                        const previousFilter = projectFilter;
                        const matching = applyFilter(pattern);

                        if (matching === 0) {
                            logger.info(`Filter "${pattern}" matched no projects — keeping previous filter.`);
                            applyFilter(previousFilter);

                            return;
                        }

                        logger.info(`Filter "${pattern}" matched ${String(matching)} task(s).`);
                        await triggerRerun();
                    },
                    onHelp: () => {
                        writeHelp(process.stdout);
                    },
                    onQuit: () => {
                        exit();
                    },
                    onRerun: triggerRerun,
                },
            });
        });

        return;
    }

    reportRunOutcome({ firstRun, hasFailure, logger, options, workspaceRoot });

    if (persistentTasks.length > 0 && !options.failFast) {
        await runPersistentTasks(persistentTasks, spawnContext, undefined);
    }

    logRegistryServiceHint({ logger, registryStartedCount, stopServicesOnExit });
};
