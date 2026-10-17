import type { Toolbox } from "@visulima/cerebro";
import type { Task, TaskGraph } from "@visulima/task-runner";

import type { discoverWorkspace } from "../../config/workspace";
import type { RunOptions } from "./index";

/**
 * Prints the `--dry-run` execution plan: one line per task in dependency
 * order, annotated with its cache, trace and split-segment state.
 */
export const printDryRunPlan = ({
    config,
    logger,
    persistentTasks,
    taskGraph,
}: Pick<ReturnType<typeof discoverWorkspace>, "config"> & {
    logger: Toolbox<Console, RunOptions>["logger"];
    persistentTasks: Task[];
    taskGraph: TaskGraph;
}): void => {
    const taskCount = Object.keys(taskGraph.tasks).length;
    const rootCount = taskGraph.roots.length;

    logger.info(`Execution plan (${String(taskCount)} task(s), ${String(rootCount)} root(s)):`);
    logger.info("");

    const visited = new Set<string>();
    const walkPlan = (id: string, depth: number): void => {
        if (visited.has(id)) {
            return;
        }

        visited.add(id);

        for (const dep of taskGraph.dependencies[id] ?? []) {
            walkPlan(dep, depth + 1);
        }

        const task = taskGraph.tasks[id];
        const indent = "  ".repeat(depth + 1);
        const segmentNote = task?.segment ? ` (segment ${String(task.segment.index)}/${String(task.segment.count)}: ${String(task.overrides["command"])})` : "";
        // The engine traces every task under the workspace switch, so it is annotated like a per-target trace.
        const traced = task?.hashMode === "trace" || config.taskRunner?.autoFingerprint === true;
        const annotations = `${task?.cache === false ? " (no-cache)" : ""}${traced ? " (trace)" : ""}${segmentNote}`;

        logger.info(`${indent}${id}${annotations}`);
    };

    for (const root of taskGraph.roots) {
        walkPlan(root, 0);
    }

    // Visit any tasks not reachable from `roots`. Two cases hit
    // this: disconnected graph components, and reversed graphs
    // where reverse-roots don't reach the original-leaves through
    // outbound `dependencies` (the printer recurses into deps,
    // and original-leaves are reverse-dependents — so we'd
    // otherwise drop them silently from the plan).
    for (const taskId of Object.keys(taskGraph.tasks)) {
        walkPlan(taskId, 0);
    }

    if (persistentTasks.length > 0) {
        logger.info("");
        logger.info(`  + ${String(persistentTasks.length)} persistent task(s) (run after graph completes)`);
    }

    logger.info("");
};
