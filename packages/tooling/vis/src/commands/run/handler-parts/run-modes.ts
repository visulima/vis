import type { ProcessEvent, TaskResults } from "@visulima/task-runner";
import { CompositeLifeCycle, defaultTaskRunner, runConcurrently, TerminalBuffer } from "@visulima/task-runner";

import { createDynamicOutputRenderer } from "../../../tui/dynamic-life-cycle";
import type { StdinEntry } from "../../../tui/types";
import { resolveRetrySpawn, resolveTaskSpawn } from "../task-env";
import type { MutexPool } from "./executor";
import { createConcurrentExecutor } from "./executor";
import { MAX_OUTPUT_BYTES } from "./output";
import { runPersistentTasks } from "./persistent-tasks";
import type { RunContext } from "./run-context";
import type { RunRuntime } from "./run-runtime";
import { resolveTaskCommand } from "./shell";

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
