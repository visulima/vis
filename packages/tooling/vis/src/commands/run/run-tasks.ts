import type { Task, TaskGraph } from "@visulima/task-runner";

import type { VisTargetConfiguration } from "../../task/target-options";
import type { RunOptions } from "./index";
import { resolveRunArguments } from "./run-arguments";
import type { DiscoveredWorkspace, RunLogger, RunProjectGraph } from "./run-context";
import { buildInitialTasks } from "./run-initial-tasks";
import { createRunTaskGraph } from "./run-task-graph";

/**
 * Builds the run's tasks: validates the forwarded arguments, creates the
 * requested tasks (applying `--partition`) and then the dependency graph.
 * Returns `undefined` when `--help` was printed or the partition leaves
 * nothing to run.
 */
export const buildRunTasks = ({
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
}: {
    affectedFiles: string[] | undefined;
    config: DiscoveredWorkspace["config"];
    forwardedArgs: string[];
    logger: RunLogger;
    options: RunOptions;
    projectGraph: RunProjectGraph;
    projectOptions: DiscoveredWorkspace["projectOptions"];
    projectsWithTarget: string[];
    projectTargetIndex: Map<string, VisTargetConfiguration>;
    target: string;
    workspace: DiscoveredWorkspace["workspace"];
}): { initialTasks: Task[]; persistentTasks: Task[]; taskGraph: TaskGraph } | undefined => {
    const taskArguments = resolveRunArguments({ forwardedArgs, logger, projectsWithTarget, projectTargetIndex, target });

    if (!taskArguments) {
        return undefined;
    }

    const initialSelection = buildInitialTasks({
        affectedFiles,
        forwardedArgs,
        logger,
        options,
        projectsWithTarget,
        projectTargetIndex,
        target,
        taskArgumentEnvVars: taskArguments.env,
        workspace,
    });

    if (!initialSelection) {
        return undefined;
    }

    const { persistentTasks } = initialSelection;
    const { initialTasks } = initialSelection;

    const taskGraph = createRunTaskGraph({
        affectedFiles,
        config,
        initialTasks,
        logger,
        options,
        persistentTasks,
        projectGraph,
        projectOptions,
        workspace,
    });

    return { initialTasks, persistentTasks, taskGraph };
};
