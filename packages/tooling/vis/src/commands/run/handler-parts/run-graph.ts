import type { TargetConfiguration } from "@visulima/task-runner";
import { createTaskGraph, expandTokensInString, reverseTaskGraph, splitCompoundTasks } from "@visulima/task-runner";
import isInCi from "is-in-ci";

import { runLockfilePreflight } from "../../../preflight/lockfile";
import { maybePromptViteClientOverride } from "../../../preflight/vite-client-override";
import { runToolchainPreflight } from "../../../runtime/toolchain";
import { resolveSkipCachePatterns } from "../../../task/skip-cache";
import { resolveTargetShell } from "../../../task/target-options";
import type { RunContext } from "./run-context";

/**
 * Phase 4: build the task graph from the selected tasks, hydrate dependency
 * tasks with their vis options and command, and apply `--skip-cache`.
 */
export const buildRunGraph = (ctx: RunContext): void => {
    const { config, logger, options, projectGraph, projectOptions, workspace } = ctx;

    // User-requested task ids (post-partition), so the dependency-hydration
    // pass below can tell a `dependsOn`-added task apart from one the user
    // asked for directly and only warn about missing commands on the former.
    const requestedTaskIds = new Set([...ctx.initialTasks, ...ctx.persistentTasks].map((task) => task.id));

    // Include persistent tasks in the graph so their `dependsOn` chain
    // (especially service deps like `web:serve → api:db`) is walked by
    // `applyServiceRegistry`. Without this, persistent tasks are split
    // out before graph construction and their service deps go undiscovered,
    // so preflight never auto-starts them. The persistent task ids are
    // stripped from the graph again after preflight injection so the
    // regular runner doesn't execute them — they run via `runPersistentTasks`.
    ctx.taskGraph = createTaskGraph([...ctx.initialTasks, ...ctx.persistentTasks], {
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
    for (const [taskId, task] of Object.entries(ctx.taskGraph.tasks)) {
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
            nextOverrides["command"] = expandTokensInString(visTarget.command, { affectedFiles: ctx.affectedFiles, projectRoot: project?.root });
            mutated = true;
        }

        if (mutated) {
            task.overrides = nextOverrides;
            ctx.taskGraph.tasks[taskId] = task;
        }
    }

    // Per-task cache bypass via --skip-cache=<patterns>. Unlike the
    // global --no-cache (which drops the runner's `skipNxCache` switch
    // and bypasses cache for every task), this only flips
    // `task.cache = false` on tasks whose ID matches a user-supplied
    // pattern. The dry-run plan printer already surfaces this as
    // `(no-cache)` next to the matched task IDs. We skip the work
    // entirely when --no-cache is set since the runner-level switch
    // already disables caching for the whole run.
    if (typeof options.skipCache === "string" && options.skipCache.trim() !== "") {
        if (options.cache) {
            const skipResolution = resolveSkipCachePatterns(options.skipCache, workspace, Object.keys(ctx.taskGraph.tasks));

            for (const id of skipResolution.skipTaskIds) {
                const task = ctx.taskGraph.tasks[id];

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
};

/**
 * Phase 5: toolchain pin check, lockfile drift check, and the one-time Vite
 * client override prompt. Runs before service auto-attach and task execution.
 */
export const runPreflightChecks = async (ctx: RunContext): Promise<void> => {
    const { config, logger, options, packageJsons, workspaceRoot } = ctx;

    // Pre-flight: if a workspace tool pin doesn't match the running
    // version and `toolchain.autoInstall` is on (default when a
    // manager is detected), install via the right manager and let
    // subsequent task subprocesses pick up the new version. We
    // never block on failure — surface a warning, keep going,
    // and let the existing runtime-check warnings do their job.
    //
    // Runs before service auto-attach so the right Node/PM is in
    // place when the probe runs, and before the dry-run short-circuit
    // so `--dry-run` still surfaces toolchain drift.
    await runToolchainPreflight(
        workspaceRoot,
        config.toolchain,
        {
            error: (message) => {
                logger.error(message);
            },
            info: (message) => {
                logger.info(message);
            },
            warn: (message) => {
                logger.warn(message);
            },
        },
        Boolean(options.skipToolchain),
    );

    // Lockfile/install drift check. Fires after toolchain (so the
    // suggested install command runs against the right Node) and
    // before service auto-attach + task execution. CLI flag wins over
    // config; both default to on. The helper logs the warn line itself
    // in TTY; in CI it stays silent and we throw with `formattedMessage`
    // so the user sees the detail exactly once.
    const preflightEnabled = options.preflight !== false && config.preflight?.lockfile !== false;
    const lockfilePreflight = runLockfilePreflight(
        workspaceRoot,
        isInCi,
        {
            warn: (message) => {
                logger.warn(message);
            },
        },
        { skip: !preflightEnabled },
    );

    if (!lockfilePreflight.shouldContinue) {
        throw new Error(`${lockfilePreflight.formattedMessage ?? "preflight: lockfile drift detected"} (pass --no-preflight to bypass)`);
    }

    // One-time offer to alias @voidzero-dev/vite-task-client to our
    // drop-in client so its cache hints reach the runner. TTY-only and
    // remembers a decline, so CI and repeat runs are never blocked.
    if (preflightEnabled && !isInCi && process.stdin.isTTY && process.stdout.isTTY) {
        await maybePromptViteClientOverride(workspaceRoot, {
            interactive: true,
            logger: {
                info: (message) => {
                    logger.info(message);
                },
                warn: (message) => {
                    logger.warn(message);
                },
            },
            // Scan every discovered project manifest, not just the root —
            // a tool depending on the vite client may live in a sub-package.
            projectManifests: [...packageJsons.values()],
        });
    }
};

/**
 * Phase 7a: flip the graph for teardown targets, mark splitCompound tasks,
 * and expand them into their segment chain.
 */
export const shapeTaskGraph = (ctx: RunContext): void => {
    const { logger, options, projectOptions } = ctx;

    // Flip the task graph for teardown targets (CDK/Pulumi `destroy`,
    // `undeploy`, etc.) where dependents must run before the things
    // they depend on. Runs after service auto-attach so service
    // detection still uses the natural graph; runs before the
    // dry-run walk and scheduler so both reflect the reversed order.
    // `reverseTaskGraph` recomputes `roots` from the flipped edges,
    // so the dry-run printer and `TaskScheduler` need no further
    // changes — they already walk topologically over `dependencies`.
    if (options.reverse) {
        ctx.taskGraph = reverseTaskGraph(ctx.taskGraph);
        logger.debug?.(`Reversed task graph: ${String(ctx.taskGraph.roots.length)} new root(s) (originally leaves)`);
    }

    // `splitCompound` splits a POSIX shell line, so a target with a custom
    // shell runs its command in another language and stays whole.
    for (const task of Object.values(ctx.taskGraph.tasks)) {
        const shellOptions = projectOptions.get(task.target.project)?.[task.target.target]?.options;

        if (task.splitCompound && resolveTargetShell(shellOptions) !== undefined) {
            logger.warn(`splitCompound ignored for ${task.id}: it uses a custom shell. Running the command as one unit.`);
            task.splitCompound = undefined;
        }
    }

    // Split `splitCompound` targets into chained segment tasks before the
    // dry-run plan and the scheduler read the graph. The runner's own split
    // pass then finds nothing left to do.
    ctx.taskGraph = splitCompoundTasks(ctx.taskGraph, {
        commandOf: (task) => task.overrides["command"] as string | undefined,
        onDiagnostic: (_taskId, message) => {
            logger.warn(message);
        },
    });
};

/**
 * Phase 7b: `--dry-run` prints the execution plan and stops. Returns `true`
 * when the run must stop here.
 */
export const printDryRunPlan = (ctx: RunContext): boolean => {
    const { config, logger, options } = ctx;

    if (options.dryRun) {
        const taskCount = Object.keys(ctx.taskGraph.tasks).length;
        const rootCount = ctx.taskGraph.roots.length;

        logger.info(`Execution plan (${String(taskCount)} task(s), ${String(rootCount)} root(s)):`);
        logger.info("");

        const visited = new Set<string>();
        const walkPlan = (id: string, depth: number): void => {
            if (visited.has(id)) {
                return;
            }

            visited.add(id);

            for (const dep of ctx.taskGraph.dependencies[id] ?? []) {
                walkPlan(dep, depth + 1);
            }

            const task = ctx.taskGraph.tasks[id];
            const indent = "  ".repeat(depth + 1);
            const segmentNote = task?.segment ? ` (segment ${String(task.segment.index)}/${String(task.segment.count)}: ${String(task.overrides["command"])})` : "";
            // The engine traces every task under the workspace switch, so it is annotated like a per-target trace.
            const traced = task?.hashMode === "trace" || config.taskRunner?.autoFingerprint === true;
            const annotations = `${task?.cache === false ? " (no-cache)" : ""}${traced ? " (trace)" : ""}${segmentNote}`;

            logger.info(`${indent}${id}${annotations}`);
        };

        for (const root of ctx.taskGraph.roots) {
            walkPlan(root, 0);
        }

        // Visit any tasks not reachable from `roots`. Two cases hit
        // this: disconnected graph components, and reversed graphs
        // where reverse-roots don't reach the original-leaves through
        // outbound `dependencies` (the printer recurses into deps,
        // and original-leaves are reverse-dependents — so we'd
        // otherwise drop them silently from the plan).
        for (const taskId of Object.keys(ctx.taskGraph.tasks)) {
            walkPlan(taskId, 0);
        }

        if (ctx.persistentTasks.length > 0) {
            logger.info("");
            logger.info(`  + ${String(ctx.persistentTasks.length)} persistent task(s) (run after graph completes)`);
        }

        logger.info("");

        return true;
    }

    return false;
};
