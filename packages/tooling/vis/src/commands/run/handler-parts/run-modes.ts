import type { LogMode, ProcessEvent, TaskResults } from "@visulima/task-runner";
import { CompositeLifeCycle, createLogReporter, defaultTaskRunner, generateRunSummary, runConcurrently, TerminalBuffer, writeRunSummary } from "@visulima/task-runner";

import { VisUserError } from "../../../errors/vis-user-error";
import { analyzeFlakiness, formatFlakinessTable } from "../../../report/flakiness";
import { compareDuration, formatTimingSummary, loadRunSummaries } from "../../../report/run-report";
import { createDynamicOutputRenderer } from "../../../tui/dynamic-life-cycle";
import { StaticOutputLifeCycle } from "../../../tui/static-life-cycle";
import type { StdinEntry } from "../../../tui/types";
import { getVisWorkspaceDataDir } from "../../../util/vis-paths";
import { collectTrackedWatchTargets, createTrackedFileFilter, startWatcher } from "../../../watch/watch";
import { applyProjectFilter } from "../../../watch/watch-filter";
import type { KeybindHandle } from "../../../watch/watch-keybinds";
import { installKeybinds, writeHelp } from "../../../watch/watch-keybinds";
import { resolveRetrySpawn, resolveTaskSpawn } from "../task-env";
import type { RunContext } from "./run-context";
import type { MutexPool } from "./run-executor";
import { createConcurrentExecutor } from "./run-executor";
import { MAX_OUTPUT_BYTES } from "./run-output";
import { runPersistentTasks } from "./run-persistent-tasks";
import type { RunRuntime } from "./run-runtime";
import { resolveTaskCommand } from "./run-shell";

/**
 * Interactive (TTY) run: the dynamic renderer drives reruns, retries and quit
 * through the store, so the whole loop stays in one function.
 */
export const runInteractiveMode = async (ctx: RunContext, runtime: RunRuntime): Promise<void> => {
    const { currentOs, logger, options, projectGraph, workspaceRoot } = ctx;
    const { childEnvPolicyFor, failureLogLifeCycle, hookLifeCycle, hooks, lifecycleOptions, maybeWriteProfile, outputStyle, preTraceCheck, resolveCommand, runnerOptions, sharedRetryBudget, spawnContext } = runtime;
    // Snapshots of service state that is final before this phase; const so the callbacks below narrow.
    const { serviceEventBridge } = ctx;
    const { serviceDockStore } = ctx;

    const stdinRegistry = new Map<string, StdinEntry>();
    const dynamic = createDynamicOutputRenderer({
        ...lifecycleOptions,
        onRetryService: serviceEventBridge ? (id) => serviceEventBridge.retry(id) : undefined,
        outputStyle,
        serviceDockStore,
        stdinRegistry,
    });
    const { lifeCycle: uiLifeCycle, store } = dynamic;
    // Fan lifecycle events out to both the UI renderer and the
    // plugin hook layer so subscribers see the same events
    // without adding another renderer.
    const lifeCycle = new CompositeLifeCycle([uiLifeCycle, hookLifeCycle, failureLogLifeCycle]);
    const mutexPool: MutexPool = new Map();
    const taskExecutor = createConcurrentExecutor({
        hooks,
        lifeCycle,
        mutexPool,
        onOutput: (taskId, text) => {
            if (serviceEventBridge && ctx.injectedServiceIdSet.has(taskId)) {
                serviceEventBridge.onTaskOutput(taskId, text);
            } else {
                store.addOutput(taskId, text);
            }
        },
        onOutputReplace: (taskId, fullContent) => {
            store.setOutput(taskId, fullContent);
        },
        resolveCommand,
        retryBudget: sharedRetryBudget,
        serviceEventBridge: serviceEventBridge ?? undefined,
        spawnContext,
        stdinRegistry,
        strictEnvFailure: runtime.strictEnvFailure,
        workspaceRoot,
    });

    let loopAction: "quit" | "rerun" | "retry" = "rerun";
    let retryTaskId: string | null = null;

    let lastResults: TaskResults = new Map();

    while (loopAction !== "quit") {
        if (loopAction === "rerun") {
            lastResults = await defaultTaskRunner(ctx.initialTasks, runnerOptions, {
                childEnvPolicy: childEnvPolicyFor,
                lifeCycle,
                preTraceCheck,
                projectGraph,
                resolveChildEnv: (task, spawnOptions) => resolveTaskSpawn(spawnContext, task, spawnOptions),
                resolveCommand,
                taskExecutor,
                taskGraph: ctx.taskGraph,
                workspaceRoot,
            });

            // Persistent tasks (servers, watchers) start AFTER the
            // regular graph completes but BEFORE the loop awaits
            // user input — that's the only way the dynamic TUI
            // can show their spinners and stream their output.
            // The abortSignal kills them when the user signals
            // rerun/retry/quit so the outer loop can react.
            if (ctx.persistentTasks.length > 0 && !options.failFast) {
                const abortSignal = new Promise<void>((resolve) => {
                    const unsubscribe = store.subscribe(() => {
                        const s = store.getSnapshot();

                        if (s.rerunRequested || s.retryTaskId) {
                            unsubscribe();
                            resolve();
                        }
                    });

                    dynamic.renderIsDone
                        .then(() => {
                            unsubscribe();
                            resolve();

                            return undefined;
                        })
                        .catch(() => {
                            unsubscribe();
                            resolve();
                        });
                });

                await runPersistentTasks(ctx.persistentTasks, spawnContext, {
                    abortSignal,
                    lifeCycle,
                    stdinRegistry,
                    store,
                });
            }
        } else if (loopAction === "retry" && retryTaskId) {
            // A split target retries by segment id, which only the graph knows.
            const task = ctx.taskGraph.tasks[retryTaskId] ?? ctx.initialTasks.find((t) => t.id === retryTaskId);
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

        loopAction = await new Promise<"quit" | "rerun" | "retry">((resolve) => {
            const unsubscribe = store.subscribe(() => {
                const s = store.getSnapshot();

                if (s.rerunRequested) {
                    store.acknowledgeRerun();
                    unsubscribe();
                    resolve("rerun");
                }

                if (s.retryTaskId) {
                    retryTaskId = store.acknowledgeRetry();
                    unsubscribe();
                    resolve("retry");
                }
            });

            dynamic.renderIsDone
                .then(() => {
                    unsubscribe();
                    resolve("quit");

                    return undefined;
                })
                .catch(() => {
                    unsubscribe();
                    resolve("quit");
                });
        });
    }

    await dynamic.renderIsDone;
    await runtime.hooks.callHook("run:after", lastResults);
    await maybeWriteProfile(lastResults);

    if (ctx.registryStartedCount > 0) {
        logger.info("");

        if (options.stopServices) {
            logger.info(`${String(ctx.registryStartedCount)} service(s) stopped (--stop-services).`);
        } else {
            logger.info(`${String(ctx.registryStartedCount)} service(s) started in the background. Run \`vis service stop --all\` to clean up.`);
        }
    }
};

type RunOnceResult = { hasFailure: boolean; results: TaskResults; runHistory: Awaited<ReturnType<typeof loadRunSummaries>> };

/**
 * Non-interactive (CI / piped) run: one pass, then the failure report. With
 * `--watch` it hands over to the file watcher instead.
 */
export const runStaticMode = async (ctx: RunContext, runtime: RunRuntime): Promise<void> => {
    const { logger, options, visConfig, workspaceRoot } = ctx;
    const { childEnvPolicyFor, failureLogLifeCycle, hookLifeCycle, hooks, lifecycleOptions, maybeWriteProfile, outputStyle, preTraceCheck, resolveCommand, runnerOptions, sharedRetryBudget, spawnContext, startTime } = runtime;

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
        serviceEventBridge: ctx.serviceEventBridge ?? undefined,
        spawnContext,
        strictEnvFailure: runtime.strictEnvFailure,
        workspaceRoot,
    });

    const runOnce = async (): Promise<RunOnceResult> => {
        const runStart = Date.now();

        const results = await defaultTaskRunner(ctx.initialTasks, runnerOptions, {
            childEnvPolicy: childEnvPolicyFor,
            lifeCycle,
            preTraceCheck,
            projectGraph: ctx.projectGraph,
            resolveChildEnv: (task, spawnOptions) => resolveTaskSpawn(spawnContext, task, spawnOptions),
            resolveCommand,
            taskExecutor,
            taskGraph: ctx.taskGraph,
            workspaceRoot,
        });

        const durationMs = Date.now() - runStart;

        if (options.summarize) {
            const summary = generateRunSummary(results, ctx.taskGraph, startTime);

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
        await runWatchMode(ctx, runOnce, firstRun.results);

        return;
    }

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

    if (ctx.persistentTasks.length > 0 && !options.failFast) {
        await runPersistentTasks(ctx.persistentTasks, spawnContext, undefined);
    }

    if (ctx.registryStartedCount > 0) {
        logger.info("");

        if (options.stopServices) {
            logger.info(`${String(ctx.registryStartedCount)} service(s) stopped (--stop-services).`);
        } else {
            logger.info(`${String(ctx.registryStartedCount)} service(s) started in the background. Run \`vis service stop --all\` to clean up.`);
        }
    }
};

/**
 * `--watch`: rerun on file change and handle the keybinds until quit. Returns
 * when the user quits.
 */
const runWatchMode = async (ctx: RunContext, runOnce: () => Promise<RunOnceResult>, initialResults: TaskResults): Promise<void> => {
    const { logger, workspaceRoot } = ctx;

    const absoluteRoots = ctx.projectsWithTarget
        .map((name) => {
            const project = ctx.workspace.projects[name];
            const root = project?.root;

            if (!root) {
                return undefined;
            }

            return root.startsWith("/") ? root : `${workspaceRoot}/${root}`;
        })
        .filter((p): p is string => p !== undefined);

    // Snapshot the post-partition task set so `a` (clear filter)
    // can return to it after `p` narrowed the run.
    const baseTasks = ctx.initialTasks;
    let projectFilter: string | undefined;

    const applyFilter = (filter: string | undefined): number => {
        const result = applyProjectFilter(baseTasks, filter);

        projectFilter = result.filter;
        ctx.initialTasks = result.tasks;

        return result.tasks.length;
    };

    let running = false;
    let lastResults = initialResults;

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
            if (ctx.initialTasks.length === 0) {
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
};
