import type { Task, TaskGraph } from "@visulima/task-runner";
import { parsePartition } from "@visulima/task-runner";

import { VisUserError } from "../../errors/vis-user-error";
import { reachableFrom } from "../../util/reachable";
import type { RunOptions } from "./index";
import type { RunLogger } from "./run-context";
import { getVisOptions } from "./vis-options";

/**
 * Which slice of a run's task graph to execute.
 *
 * - `deps-only`: what the requested tasks depend on, but not the requested
 *   tasks themselves.
 * - `skip-deps`: the requested tasks; their dependencies are assumed to have
 *   run already (by an earlier `--deps-only` run in the same job).
 *
 * Together they let a CI job run the shared dependency closure once and then
 * fan the requested tasks out across concurrent processes (GitHub Actions
 * `parallel:` steps, `--partition` shards) without two processes building or
 * restoring the same dependency outputs at the same time.
 */
export type TaskGraphScope = "deps-only" | "skip-deps";

/**
 * A task is "requested" when it runs the requested target on one of the
 * selected projects. That covers the selected tasks themselves plus any
 * segment of the same project/target that `createTaskGraph` adds, while a
 * `^target` edge to another project's task of the same name stays a
 * dependency.
 */
const isRequested = (task: Task, target: string, selectedProjects: ReadonlySet<string>): boolean =>
    task.target.target === target && selectedProjects.has(task.target.project);

/**
 * Narrows `taskGraph` to one side of the requested/dependency split.
 *
 * - `deps-only` keeps the dependency closure of the requested tasks, minus
 *   service tasks: a service has to run alongside its dependents, not ahead
 *   of them in a separate step. Tasks that are not dependencies at all, such
 *   as `always` tasks that run after the requested ones, are left out. The
 *   closure is complete downwards, so every kept task keeps all its edges.
 * - `skip-deps` keeps the whole graph the requested tasks need but marks
 *   their non-service dependencies {@link Task.satisfied}: those are hashed
 *   (a task's cache key folds its dependencies' hashes, so they must stay in
 *   the graph) but neither executed nor restored. Services still start, and
 *   `always` tasks outside the closure (the requested tasks' finally-tasks)
 *   still run.
 */
export const scopeTaskGraph = (
    taskGraph: TaskGraph,
    initialTasks: ReadonlyArray<Task>,
    target: string,
    scope: TaskGraphScope,
    isService: (task: Task) => boolean,
): { initialTasks: Task[]; taskGraph: TaskGraph } => {
    const selectedProjects = new Set(initialTasks.map((task) => task.target.project));
    const requested = new Set(Object.entries(taskGraph.tasks).flatMap(([id, task]) => (isRequested(task, target, selectedProjects) ? [id] : [])));
    const closure = reachableFrom(requested, (id) => taskGraph.dependencies[id]);
    const tasks: Record<string, Task> = {};

    for (const [id, task] of Object.entries(taskGraph.tasks)) {
        const isDependency = closure.has(id) && !requested.has(id);

        if (scope === "deps-only") {
            if (isDependency && !isService(task)) {
                tasks[id] = task;
            }
        } else if (isDependency) {
            tasks[id] = isService(task) ? task : { ...task, satisfied: true };
        } else if (requested.has(id) || task.always === true) {
            tasks[id] = task;
        }
    }

    const dependencies: Record<string, string[]> = {};
    const dependedOn = new Set<string>();

    for (const id of Object.keys(tasks)) {
        const kept = (taskGraph.dependencies[id] ?? []).filter((dependency) => dependency in tasks);

        dependencies[id] = kept;

        for (const dependency of kept) {
            dependedOn.add(dependency);
        }
    }

    const rootTasks = Object.values(tasks).filter((task) => !dependedOn.has(task.id));

    return {
        initialTasks: scope === "skip-deps" ? initialTasks.filter((task) => task.id in tasks) : rootTasks,
        taskGraph: { dependencies, roots: rootTasks.map((task) => task.id), tasks },
    };
};

/**
 * Reads `--deps-only` / `--skip-deps`. The two are opposites, and
 * `--deps-only` with `--partition` would build only a shard's share of the
 * dependencies while later `--skip-deps` shards expect all of them, so both
 * combinations are rejected rather than half-honoured.
 */
export const resolveGraphScope = (options: RunOptions): TaskGraphScope | undefined => {
    if (options.depsOnly && options.skipDeps) {
        throw new VisUserError("--deps-only and --skip-deps are opposites; pass one of them.");
    }

    if (options.depsOnly && parsePartition(options.partition) !== undefined) {
        throw new VisUserError(
            "--deps-only cannot be combined with --partition (or VIS_PARTITION): run the dependencies once unpartitioned, then partition the --skip-deps runs.",
        );
    }

    if (options.depsOnly) {
        return "deps-only";
    }

    return options.skipDeps ? "skip-deps" : undefined;
};

/**
 * Applies a `--deps-only` / `--skip-deps` scope to a built run. Returns
 * `undefined` (after a notice) when the scope leaves nothing to run.
 */
export const applyGraphScope = (
    built: { initialTasks: Task[]; persistentTasks: Task[]; taskGraph: TaskGraph },
    { logger, partitioned, scope, target }: { logger: RunLogger; partitioned: boolean; scope: TaskGraphScope; target: string },
): { initialTasks: Task[]; persistentTasks: Task[]; taskGraph: TaskGraph } | undefined => {
    if (built.persistentTasks.length > 0) {
        throw new VisUserError(
            `--deps-only / --skip-deps split a finite run across CI steps; ${target} is a persistent (long-running) target, so run it without them.`,
        );
    }

    const scoped = scopeTaskGraph(built.taskGraph, built.initialTasks, target, scope, (task) => Boolean(getVisOptions(task)?.service));

    // With `^<target>`, a shard's tasks depend on the same target in other projects. Those tasks
    // may sit in another shard, which --deps-only did not build for this one, so the shard would
    // treat a task that is still running (or not yet run) as done.
    const crossShard = partitioned
        ? Object.values(scoped.taskGraph.tasks).find((task) => task.satisfied === true && task.target.target === target)
        : undefined;

    if (crossShard) {
        throw new VisUserError(
            `--skip-deps cannot partition ${target}: ${crossShard.id} is a ${target} task another shard runs, and this shard's tasks depend on it. Run ${target} unpartitioned.`,
        );
    }

    if (Object.keys(scoped.taskGraph.tasks).length === 0) {
        logger.info(scope === "deps-only" ? `▸ No dependencies to run for ${target}.` : `▸ No ${target} tasks to run.`);

        return undefined;
    }

    return { ...scoped, persistentTasks: built.persistentTasks };
};
