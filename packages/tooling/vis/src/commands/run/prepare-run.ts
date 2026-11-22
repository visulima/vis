import type { Toolbox } from "@visulima/cerebro";
import type { Task, TaskGraph } from "@visulima/task-runner";

import { VisUserError } from "../../errors/vis-user-error";
import type { detectCurrentOs } from "../../task/target-options";
import type { RunOptions } from "./index";
import type { DiscoveredWorkspace, RunLogger, RunProjectGraph } from "./run-context";
import { resolveRunSelection } from "./run-selection";
import { buildRunTasks } from "./run-tasks";
import { mergeScopedRuns } from "./scope-task-graph";

/** What a run needs once its target(s) are selected and the task graph is built. */
export interface PreparedRun {
    affectedExternalInputState?: { hashes: Record<string, string>; path: string };
    affectedFiles: string[] | undefined;
    currentOs: ReturnType<typeof detectCurrentOs>;
    initialTasks: Task[];
    persistentTasks: Task[];
    projectsWithTarget: string[];
    /** The targets this run executes, after alias resolution: one, or several for a `--deps-only` list. */
    targets: string[];
    taskGraph: TaskGraph;
}

/**
 * Splits the target argument at commas: `build,test` is two targets. Blank items are dropped and an
 * exact repeat is collapsed, so `build,build` is one. A single target comes back as a one-item list.
 */
export const splitTargetList = (raw: string | undefined): string[] => [
    ...new Set(
        (raw ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
    ),
];

/**
 * A list of targets runs as one task graph, so a task several of them need runs once. That is only
 * defined for the dependency step (`--deps-only`): the requested tasks of each target would otherwise
 * need their own arguments, partition and ordering.
 */
const validateTargetList = (targets: ReadonlyArray<string>, argument: ReadonlyArray<string>, options: RunOptions): void => {
    const list = targets.join(",");

    if (!options.depsOnly) {
        throw new VisUserError(
            `"${list}" lists several targets, which run together only with --deps-only (the shared dependency step of a CI job). `
            + "Run the targets one by one, or use `vis ci <target>,<target>` for the whole pipeline.",
        );
    }

    if (argument.length > 1) {
        throw new VisUserError(`Arguments after the target (${argument.slice(1).join(" ")}) go to a single task, so they cannot follow the list "${list}".`);
    }
};

/**
 * Selects the target (or, with `--deps-only`, a comma-separated list of them) and builds the task
 * graph to run. A list is the union of what each target's own `--deps-only` run would execute, with
 * every task once: shared dependencies, including ones with caching disabled, run a single time.
 * A target with nothing to run is skipped, as `--if-present` or an empty dependency set would skip
 * a single target; `undefined` means no target had anything left to run.
 */
export const prepareRun = async ({
    argument,
    cacheDirectory,
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
}: {
    argument: string[];
    cacheDirectory?: string;
    config: DiscoveredWorkspace["config"];
    fileOwners: DiscoveredWorkspace["fileOwners"];
    logger: RunLogger;
    options: RunOptions;
    packageJsons: DiscoveredWorkspace["packageJsons"];
    projectGraph: RunProjectGraph;
    projectOptions: DiscoveredWorkspace["projectOptions"];
    visConfig: Toolbox<Console, RunOptions>["visConfig"];
    workspace: DiscoveredWorkspace["workspace"];
    workspaceRoot: string;
}): Promise<PreparedRun | undefined> => {
    // `argument` is empty when no target was typed (the interactive picker then asks for one).
    const raw = argument?.[0];
    const listed = splitTargetList(raw);

    if (raw?.includes(",") && listed.length === 0) {
        throw new VisUserError(`"${raw}" names no target. Usage: vis run <target>[,<target>…] --deps-only`);
    }

    if (listed.length > 1) {
        validateTargetList(listed, argument, options);
    }

    // `build,` and `build,build` are one target: run it as such, with the arguments that follow it.
    const singleArgument = raw?.includes(",") && listed.length === 1 ? [listed[0] as string, ...argument.slice(1)] : argument;

    const prepared: PreparedRun[] = [];

    for (const item of listed.length > 1 ? listed : [undefined]) {
        const selection = await resolveRunSelection({
            argument: item === undefined ? singleArgument : [item],
            cacheDirectory,
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
            continue;
        }

        const { forwardedArgs, projectTargetIndex, target } = selection;
        const runTasks = buildRunTasks({
            affectedFiles: selection.affectedFiles,
            config,
            forwardedArgs,
            logger,
            options,
            projectGraph,
            projectOptions,
            projectsWithTarget: selection.projectsWithTarget,
            projectTargetIndex,
            target,
            workspace,
        });

        if (!runTasks) {
            continue;
        }

        prepared.push({
            affectedExternalInputState: selection.affectedExternalInputState,
            affectedFiles: selection.affectedFiles,
            currentOs: selection.currentOs,
            initialTasks: runTasks.initialTasks,
            persistentTasks: runTasks.persistentTasks,
            projectsWithTarget: selection.projectsWithTarget,
            targets: [target],
            taskGraph: runTasks.taskGraph,
        });
    }

    const [first, ...rest] = prepared;

    if (!first) {
        return undefined;
    }

    if (rest.length === 0) {
        return first;
    }

    const merged = mergeScopedRuns(prepared);

    return {
        affectedExternalInputState: prepared.find((entry) => entry.affectedExternalInputState)?.affectedExternalInputState,
        affectedFiles: prepared.find((entry) => entry.affectedFiles)?.affectedFiles,
        currentOs: first.currentOs,
        initialTasks: merged.initialTasks,
        persistentTasks: merged.persistentTasks,
        projectsWithTarget: [...new Set(prepared.flatMap((entry) => entry.projectsWithTarget))],
        targets: [...new Set(prepared.flatMap((entry) => entry.targets))],
        taskGraph: merged.taskGraph,
    };
};
