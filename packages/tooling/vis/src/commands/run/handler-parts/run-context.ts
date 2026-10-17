import type { Toolbox } from "@visulima/cerebro";
import type { Task, TaskGraph } from "@visulima/task-runner";

import type { buildProjectGraph, discoverWorkspace } from "../../../config/workspace";
import type { VisTargetConfiguration } from "../../../task/target-options";
import { detectCurrentOs } from "../../../task/target-options";
import type { ServiceDockStore } from "../../../tui/components/service-dock/service-dock-store";
import type { RunOptions } from "../index";
import type { ServiceEventBridge } from "../service-event-bridge";

export type RunToolbox = Toolbox<Console, RunOptions>;

type Discovered = ReturnType<typeof discoverWorkspace>;

/**
 * State shared by the phases of one `vis run`. Every local that a later phase
 * reads or reassigns lives here; nothing is copied into a phase's parameters.
 * Fields a phase sets are initialised to the value the original `let` had
 * before that point, so reading one early is harmless.
 */
export interface RunContext {
    /** Changed files from `--affected`, or undefined when not affected-scoped. */
    affectedChangedFiles: string[] | undefined;
    affectedFiles: string[] | undefined;
    /** Positional arguments: the target selector, then forwarded task args. */
    argument: RunToolbox["argument"];
    config: Discovered["config"];
    currentOs: ReturnType<typeof detectCurrentOs>;
    /** Services booted by this run (ephemeral pid files, scratch dir, registry starts). */
    ephemeralPidFiles: string[];
    fileOwners: Discovered["fileOwners"];
    forwardedArgs: string[];
    initialTasks: Task[];
    injectedServiceIds: string[];
    injectedServiceIdSet: Set<string>;
    invocationCwd: string;

    logger: RunToolbox["logger"];
    options: RunOptions;
    packageJsons: Discovered["packageJsons"];
    persistentTasks: Task[];
    projectGraph: ReturnType<typeof buildProjectGraph>;
    projectNames: string[];
    projectOptions: Discovered["projectOptions"];
    projectsWithTarget: string[];
    projectTargetIndex: Map<string, VisTargetConfiguration>;
    registryStartedCount: number;
    registryStartedIds: string[];

    registryStartedPids: Map<string, number>;
    serviceDockStore: ServiceDockStore | null;
    serviceEventBridge: ServiceEventBridge | null;
    serviceRunDir: string | undefined;
    /** Target name after alias resolution. */
    target: string;
    taskGraph: TaskGraph;
    visConfig: RunToolbox["visConfig"];
    workspace: Discovered["workspace"];
    workspaceRoot: string;
}

/**
 * Builds the context from the command inputs. Phase-owned fields start at the
 * same values the original locals had before their first assignment.
 */
export const createRunContext = (inputs: {
    argument: RunToolbox["argument"];
    config: Discovered["config"];
    fileOwners: Discovered["fileOwners"];
    invocationCwd: string;
    logger: RunToolbox["logger"];
    options: RunOptions;
    packageJsons: Discovered["packageJsons"];
    projectGraph: RunContext["projectGraph"];
    projectOptions: Discovered["projectOptions"];
    visConfig: RunToolbox["visConfig"];
    workspace: Discovered["workspace"];
    workspaceRoot: string;
}): RunContext => {
    return {
        ...inputs,
        affectedChangedFiles: undefined,
        affectedFiles: undefined,
        currentOs: detectCurrentOs(),
        ephemeralPidFiles: [],
        forwardedArgs: [],
        initialTasks: [],
        injectedServiceIds: [],
        injectedServiceIdSet: new Set<string>(),
        persistentTasks: [],
        projectNames: [],
        projectsWithTarget: [],
        projectTargetIndex: new Map<string, VisTargetConfiguration>(),
        registryStartedCount: 0,
        registryStartedIds: [],
        registryStartedPids: new Map<string, number>(),
        serviceDockStore: null,
        serviceEventBridge: null,
        serviceRunDir: undefined,
        target: "",
        taskGraph: { dependencies: {}, roots: [], tasks: {} },
    };
};
