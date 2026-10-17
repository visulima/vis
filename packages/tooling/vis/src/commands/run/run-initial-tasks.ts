import type { OutputSpec, Task, TaskTarget } from "@visulima/task-runner";
import { expandTokensInString, parsePartition, TaskScheduler } from "@visulima/task-runner";

import { describeMisplacedTargetKeys, findMisplacedTargetKeys } from "../../task/misplaced-options";
import type { VisTargetConfiguration, VisTargetOptions } from "../../task/target-options";
import type { RunOptions } from "./index";
import { parseHashMode } from "./parse";
import type { DiscoveredWorkspace, RunLogger } from "./run-context";
import { FORWARDED_ARGS_KEY } from "./shell";
import { getTaskOptions, TASK_ARG_ENV_KEY } from "./task-env";

/**
 * Builds the directly-requested tasks, one per selected project, and splits
 * off the persistent ones. Applies `--partition`. Returns `undefined` when the
 * partition leaves no task for this shard.
 */
export const buildInitialTasks = ({
    affectedFiles,
    forwardedArgs,
    logger,
    options,
    projectsWithTarget,
    projectTargetIndex,
    target,
    taskArgumentEnvVars,
    workspace,
}: {
    affectedFiles: string[] | undefined;
    forwardedArgs: string[];
    logger: RunLogger;
    options: RunOptions;
    projectsWithTarget: string[];
    projectTargetIndex: Map<string, VisTargetConfiguration>;
    target: string;
    taskArgumentEnvVars: Record<string, string>;
    workspace: DiscoveredWorkspace["workspace"];
}): { initialTasks: Task[]; persistentTasks: Task[] } | undefined => {
    const ptyFlag = options.pty;

    // `--hash-mode` overrides how the directly-run target is hashed for
    // this run; when unset, the target's configured `hashMode` (if any)
    // still applies. Validated early so a bad value fails before any task
    // is scheduled. Dependency tasks keep their own configured hashMode.
    const hashModeOverride = parseHashMode(options.hashMode);

    let initialTasks: Task[] = projectsWithTarget.map((projectName) => {
        const project = workspace.projects[projectName];
        const visTarget = projectTargetIndex.get(projectName)!;
        const taskTarget: TaskTarget = { project: projectName, target };
        const taskId = `${projectName}:${target}`;
        // The --pty flag flips all tasks into PTY mode; per-target config
        // still wins when the target explicitly opts out.
        const mergedOptions: VisTargetOptions | undefined = ptyFlag ? { ...visTarget.options, pty: visTarget.options?.pty ?? true } : visTarget.options;

        // Expand `${affected.files}` / `${changed_files | flag '...'}`
        // tokens here so the resolved paths land in `overrides.command`
        // before task-runner's hasher reads it. Hashing the raw form
        // would let two runs with different affected-file sets but the
        // same workspace file hashes collide on the cache key — the
        // executor would replay a stale result that "linted" a different
        // subset. Persistent tasks and the watch-retry path also read
        // `overrides.command` directly, so doing this once at build time
        // keeps every consumer in sync.
        const expandedCommand = visTarget.command ? expandTokensInString(visTarget.command, { affectedFiles, projectRoot: project?.root }) : visTarget.command;

        // Expand `{projectRoot}`/`{projectName}` tokens in outputs (string
        // entries only; `{ auto: true }` passes through). Unexpanded, the
        // task-runner treats `{projectRoot}/dist` as a literal glob whose braces
        // match nothing, so output caching captures nothing. An empty project
        // root maps to `.` so the path stays a workspace-relative `./dist`
        // instead of an escaping `/dist`. Idempotent if already expanded.
        const outputsProjectRoot = project?.root && project.root.length > 0 ? project.root : ".";
        // OutputSpec is a `string | { auto: true }` union, so the two
        // branches legitimately return different runtime shapes — the
        // `{ auto: true }` sentinel passes through, strings get expanded.
        // eslint-disable-next-line sonarjs/function-return-type -- OutputSpec union; non-string sentinel passes through, strings are expanded
        const expandedOutputs = (visTarget.outputs ?? []).map((output): OutputSpec => {
            if (typeof output !== "string") {
                return output;
            }

            return output.replaceAll("{projectRoot}", outputsProjectRoot).replaceAll("{projectName}", projectName);
        });

        const misplacedKeys = findMisplacedTargetKeys(visTarget.options);

        if (misplacedKeys.length > 0) {
            logger.warn(describeMisplacedTargetKeys(taskId, misplacedKeys));
        }

        return {
            cache: visTarget.cache,
            // Mirrors the task-runner graph builder. Without it a traced target
            // that declares inputs is treated as declaring none, so the declared
            // fallback never runs for the directly-run target.
            declaresInputs: visTarget.inputs !== undefined,
            fingerprintEnv: visTarget.fingerprintEnv,
            hashMode: hashModeOverride ?? visTarget.hashMode,
            id: taskId,
            outputs: expandedOutputs,
            overrides: {
                command: expandedCommand,
                ...(forwardedArgs.length > 0 ? { [FORWARDED_ARGS_KEY]: forwardedArgs } : {}),
                ...(Object.keys(taskArgumentEnvVars).length > 0 ? { [TASK_ARG_ENV_KEY]: taskArgumentEnvVars } : {}),
                ...(mergedOptions ? { visOptions: mergedOptions } : {}),
            },
            parallelism: visTarget.parallelism,
            projectRoot: project?.root,
            splitCompound: visTarget.splitCompound,
            target: taskTarget,
            untrackedEnv: visTarget.untrackedEnv,
        };
    });

    const persistentTasks: Task[] = [];
    const regularTasks: Task[] = [];

    for (const task of initialTasks) {
        const opts = getTaskOptions(task);

        if (opts?.persistent) {
            task.cache = false;
            persistentTasks.push(task);
        } else {
            regularTasks.push(task);
        }
    }

    initialTasks = regularTasks;

    const partition = parsePartition(options.partition);

    if (partition) {
        initialTasks = TaskScheduler.partitionTasks(initialTasks, partition);

        logger.info(`Partition ${partition.index}/${partition.total}: running ${initialTasks.length} task(s)`);

        if (initialTasks.length === 0) {
            logger.info("No tasks assigned to this partition.");

            return undefined;
        }
    }

    return { initialTasks, persistentTasks };
};
