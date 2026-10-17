import type { TargetConfiguration, Task, TaskGraph } from "@visulima/task-runner";
import { createTaskGraph, expandTokensInString } from "@visulima/task-runner";

import { resolveSkipCachePatterns } from "../../task/skip-cache";
import type { RunOptions } from "./index";
import type { DiscoveredWorkspace, RunLogger, RunProjectGraph } from "./run-context";

/**
 * Builds the task graph for the run: the requested tasks plus their
 * `dependsOn` closure, re-hydrates vis metadata onto dependency tasks, and
 * applies `--skip-cache`.
 */
export const createRunTaskGraph = ({
    affectedFiles,
    config,
    initialTasks,
    logger,
    options,
    persistentTasks,
    projectGraph,
    projectOptions,
    workspace,
}: {
    affectedFiles: string[] | undefined;
    config: DiscoveredWorkspace["config"];
    initialTasks: Task[];
    logger: RunLogger;
    options: RunOptions;
    persistentTasks: Task[];
    projectGraph: RunProjectGraph;
    projectOptions: DiscoveredWorkspace["projectOptions"];
    workspace: DiscoveredWorkspace["workspace"];
}): TaskGraph => {
    // User-requested task ids (post-partition), so the dependency-hydration
    // pass below can tell a `dependsOn`-added task apart from one the user
    // asked for directly and only warn about missing commands on the former.
    const requestedTaskIds = new Set([...initialTasks, ...persistentTasks].map((task) => task.id));

    // Include persistent tasks in the graph so their `dependsOn` chain
    // (especially service deps like `web:serve → api:db`) is walked by
    // `applyServiceRegistry`. Without this, persistent tasks are split
    // out before graph construction and their service deps go undiscovered,
    // so preflight never auto-starts them. The persistent task ids are
    // stripped from the graph again after preflight injection so the
    // regular runner doesn't execute them — they run via `runPersistentTasks`.
    const taskGraph = createTaskGraph([...initialTasks, ...persistentTasks], {
        onCycleBroken: (cycle) => {
            // A dependency cycle that runs only through devDependency edges
            // is tolerated (pnpm does the same) — we break it and warn rather
            // than deadlocking. Cycles with a real (static) edge stay fatal.
            logger.warn(`Ignoring dev-only dependency cycle (build order is ambiguous): ${cycle.join(" → ")}`);
        },
        onUnmatchedProjectSelector: (selector) => {
            // An unmatched `dependsOn.projects` entry produces no edge, so
            // the declared ordering just isn't there. Silence made a typo
            // and a working config indistinguishable.
            logger.warn(`dependsOn.projects entry "${selector}" matched no project — that dependency edge was not created.`);
        },
        projectGraph,
        targetDefaults: config.tasks as unknown as Record<string, Partial<TargetConfiguration>>,
        workspace,
    });

    // task-runner's createTaskGraph copies overrides only from the
    // user-invoked `initialTasks`, so dep tasks added via `dependsOn`
    // arrive without `visOptions` and without `command`. That hides
    // every vis-specific option on dep tasks — most importantly
    // `options.service`, which applyServiceRegistry needs to detect a
    // service dependency it should auto-attach to — and leaves the
    // service-preflight injector with no command to wrap. Re-hydrate
    // both fields for every task in the graph from `projectOptions`
    // so dep tasks carry the same target metadata that user-invoked
    // tasks already carry.
    for (const [taskId, task] of Object.entries(taskGraph.tasks)) {
        const projectName = task.target.project;
        const targetName = task.target.target;
        const visTarget = projectOptions.get(projectName)?.[targetName];

        if (!visTarget) {
            // A `dependsOn`-added dependency that resolves to a target with
            // no configuration anywhere (e.g. `dependsOn: ["codegen"]` but
            // the project has no `codegen` script/target). task-runner keeps
            // it in the graph and the executor runs it as a silent 0-exit
            // no-op, so the missing prerequisite vanishes instead of erroring
            // — the trap that makes such gaps CI-only and hard to find. Warn
            // so the misconfiguration is visible. Tasks the user invoked
            // directly always carry config, so this only fires for deps.
            if (!requestedTaskIds.has(taskId)) {
                logger.warn(`${targetName} required via dependsOn but no command is configured for ${projectName} — skipping (no-op).`);
            }

            continue;
        }

        const project = workspace.projects[projectName];
        let mutated = false;
        const nextOverrides = { ...task.overrides };

        if (nextOverrides["visOptions"] === undefined && visTarget.options) {
            nextOverrides["visOptions"] = visTarget.options;
            mutated = true;
        }

        if (nextOverrides["command"] === undefined && visTarget.command) {
            nextOverrides["command"] = expandTokensInString(visTarget.command, { affectedFiles, projectRoot: project?.root });
            mutated = true;
        }

        if (mutated) {
            task.overrides = nextOverrides;
            taskGraph.tasks[taskId] = task;
        }
    }

    // Per-task cache bypass via --skip-cache=<patterns>. Unlike the
    // global --no-cache (which drops the runner-level cache switch
    // and bypasses cache for every task), this only flips
    // `task.cache = false` on tasks whose ID matches a user-supplied
    // pattern. The dry-run plan printer already surfaces this as
    // `(no-cache)` next to the matched task IDs. We skip the work
    // entirely when --no-cache is set since the runner-level switch
    // already disables caching for the whole run.
    if (typeof options.skipCache === "string" && options.skipCache.trim() !== "") {
        if (options.cache) {
            const skipResolution = resolveSkipCachePatterns(options.skipCache, workspace, Object.keys(taskGraph.tasks));

            for (const id of skipResolution.skipTaskIds) {
                const task = taskGraph.tasks[id];

                if (task !== undefined) {
                    task.cache = false;
                }
            }

            if (skipResolution.unmatchedPatterns.length > 0) {
                logger.warn(`--skip-cache: no tasks matched ${skipResolution.unmatchedPatterns.map((p) => `"${p}"`).join(", ")}`);
            }

            if (skipResolution.skipTaskIds.size > 0) {
                logger.debug?.(`--skip-cache: bypassing cache for ${String(skipResolution.skipTaskIds.size)} task(s)`);
            }
        } else {
            logger.debug?.("--skip-cache ignored: --no-cache already disables caching for the whole run");
        }
    }

    return taskGraph;
};
