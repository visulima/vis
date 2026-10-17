import type { Task, TaskGraph, TaskResults } from "@visulima/task-runner";
import { CompositeLifeCycle, defaultTaskRunner } from "@visulima/task-runner";

import type { ServiceDockStore } from "../../tui/components/service-dock/service-dock-store";
import { createDynamicOutputRenderer } from "../../tui/dynamic-life-cycle";
import type { StdinEntry } from "../../tui/types";
import type { MutexPool } from "./executor";
import { createConcurrentExecutor } from "./executor";
import type { RunOptions } from "./index";
import { runPersistentTasks } from "./persistent-tasks";
import type { RunProjectGraph } from "./run-context";
import type { RunRuntime } from "./run-runtime";
import type { ServiceEventBridge } from "./service-event-bridge";
import { resolveTaskSpawn } from "./task-env";

/**
 * Creates the dynamic TUI renderer, the lifecycle fan-out and the concurrent
 * executor used by every interactive graph run.
 */
export const createInteractiveSession = ({
    injectedServiceIdSet,
    runtime,
    serviceDockStore,
    serviceEventBridge,
    workspaceRoot,
}: {
    injectedServiceIdSet: Set<string>;
    runtime: RunRuntime;
    serviceDockStore: ServiceDockStore | null;
    serviceEventBridge: ServiceEventBridge | null;
    workspaceRoot: string;
}) => {
    const { failureLogLifeCycle, hookLifeCycle, hooks, lifecycleOptions, outputStyle, resolveCommand, sharedRetryBudget, spawnContext, strictEnvFailure } = runtime;

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
            if (serviceEventBridge && injectedServiceIdSet.has(taskId)) {
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
        strictEnvFailure,
        workspaceRoot,
    });

    return { dynamic, lifeCycle, stdinRegistry, store, taskExecutor };
};

/**
 * Runs the regular graph for one interactive pass, then starts the persistent
 * tasks (servers, watchers) so the TUI can show their spinners and output
 * until the user asks for a rerun, a retry or quits.
 */
export const runInteractiveRerun = async ({
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
}: {
    dynamic: ReturnType<typeof createDynamicOutputRenderer>;
    initialTasks: Task[];
    lifeCycle: CompositeLifeCycle;
    options: RunOptions;
    persistentTasks: Task[];
    projectGraph: RunProjectGraph;
    runtime: RunRuntime;
    stdinRegistry: Map<string, StdinEntry>;
    store: ReturnType<typeof createDynamicOutputRenderer>["store"];
    taskExecutor: ReturnType<typeof createConcurrentExecutor>;
    taskGraph: TaskGraph;
    workspaceRoot: string;
}): Promise<TaskResults> => {
    const { childEnvPolicyFor, preTraceCheck, resolveCommand, runnerOptions, spawnContext } = runtime;

    const lastResults = await defaultTaskRunner(initialTasks, runnerOptions, {
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

    // Persistent tasks (servers, watchers) start AFTER the
    // regular graph completes but BEFORE the loop awaits
    // user input — that's the only way the dynamic TUI
    // can show their spinners and stream their output.
    // The abortSignal kills them when the user signals
    // rerun/retry/quit so the outer loop can react.
    if (persistentTasks.length > 0 && !options.failFast) {
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

        await runPersistentTasks(persistentTasks, spawnContext, {
            abortSignal,
            lifeCycle,
            stdinRegistry,
            store,
        });
    }

    return lastResults;
};

/**
 * Waits for the user to request a rerun, a retry or quit in the TUI, or for
 * the renderer to finish. For a retry, returns the task id to retry.
 */
export const waitForInteractiveAction = async ({
    dynamic,
    store,
}: {
    dynamic: ReturnType<typeof createDynamicOutputRenderer>;
    store: ReturnType<typeof createDynamicOutputRenderer>["store"];
}): Promise<{ action: "quit" | "rerun" | "retry"; retryTaskId: string | null }> => {
    let retryTaskId: string | null = null;

    const action = await new Promise<"quit" | "rerun" | "retry">((resolve) => {
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

    return { action, retryTaskId };
};
