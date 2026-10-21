import type { Toolbox } from "@visulima/cerebro";
import type { ChildEnvOptions, Task, TaskGraph, TaskResults, TaskRunnerOptions } from "@visulima/task-runner";
import { generateRunSummary, pickChildParentEnv, writeChromeTrace } from "@visulima/task-runner";
import isInCi from "is-in-ci";

import { FailureLogLifeCycle } from "../../report/failure-log";
import { checkStrictEnv, formatStrictEnvError } from "../../task/strict-env";
import type { detectCurrentOs } from "../../task/target-options";
import { resolveOutputStyle } from "../../tui/static-life-cycle";
import { createVisHooks, HookableLifeCycle, registerPlugins } from "../../util/hooks";
import { getVisWorkspaceDataDir } from "../../util/vis-paths";
import type { ApplyServiceRegistryResult } from "./apply-service-registry";
import { createRetryBudget } from "./executor";
import type { RunOptions } from "./index";
import { parseEnvConcurrency } from "./parse";
import type { DiscoveredWorkspace, RunLogger } from "./run-context";
import { applyRemoteCacheConfig } from "./run-remote-cache";
import { resolveTaskCommand } from "./shell";
import { createTaskSpawnContext, effectiveChildEnvPolicy, getTaskOptions, resolveTaskSpawn } from "./task-env";

/**
 * Builds everything the task runners share for this run: the hook registry
 * and plugins, the cache directory, concurrency, the runner options, the
 * spawn context and strict-env checks, the lifecycle objects, and the
 * `service:attach` hook. Runs the remote-cache setup and may throw on a bad
 * attestation configuration.
 */
export const createRunRuntime = async ({
    affectedFiles,
    config,
    currentOs,
    initialTasks,
    invocationCwd,
    logger,
    options,
    persistentTasks,
    projectsWithTarget,
    runCacheDirectory,
    serviceEnvByTaskId,
    serviceResult,
    target,
    taskGraph,
    visConfig,
    workspaceRoot,
}: {
    affectedFiles: string[] | undefined;
    config: DiscoveredWorkspace["config"];
    currentOs: ReturnType<typeof detectCurrentOs>;
    initialTasks: Task[];
    invocationCwd: string;
    logger: RunLogger;
    options: RunOptions;
    persistentTasks: Task[];
    projectsWithTarget: string[];
    runCacheDirectory: string;
    serviceEnvByTaskId: ApplyServiceRegistryResult["serviceEnvByTaskId"];
    serviceResult: ApplyServiceRegistryResult;
    target: string;
    taskGraph: TaskGraph;
    visConfig: Toolbox<Console, RunOptions>["visConfig"];
    workspaceRoot: string;
}) => {
    const startTime = Date.now();

    // One typed hook registry per run. Plugins register handlers
    // via `config.plugins`; the HookableLifeCycle forwards lifecycle
    // events from task-runner into the registry so plugin authors
    // see `task:before`/`task:after`/`task:cacheHit` etc. without
    // needing to understand the lower-level LifeCycleInterface.
    const hooks = createVisHooks();

    // Per-run handler, passed into HookableLifeCycle below. No
    // module-level state: concurrent `vis` invocations in the same
    // process (programmatic API, Vitest parallel suites) each get
    // their own channel.
    const onHookError = (hookName: string, error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`Plugin error in ${hookName}: ${message}`);
    };

    await registerPlugins(hooks, config.plugins);

    const profilePath = typeof options.profile === "string" ? options.profile : undefined;
    const maybeWriteProfile = async (results: TaskResults): Promise<void> => {
        if (!profilePath) {
            return;
        }

        const summary = generateRunSummary(results, taskGraph, startTime);

        const resolvedProfilePath = profilePath.startsWith("/") ? profilePath : `${workspaceRoot}/${profilePath}`;

        await writeChromeTrace(summary, resolvedProfilePath);

        logger.info(`Profile written to ${profilePath}`);
    };

    // The handler resolves the cache directory once so affected selection and
    // the runner write external-input state and cache entries to the same
    // location. Other fields keep their existing spread semantics to avoid
    // changing override precedence for parallel/dryRun/etc.
    const configTaskRunner = (config.taskRunner ?? {}) as TaskRunnerOptions & { cacheDirectory?: string };

    // Concurrency resolution order: --parallel CLI flag > VIS_RUN_CONCURRENCY_LIMIT
    // env > built-in default of 3. The env variable lets CI runners set a
    // global limit without passing the flag on every call.
    // An invalid env value surfaces as a warn so misconfigurations
    // aren't silently ignored.
    const parallelEnvParsed = parseEnvConcurrency(process.env["VIS_RUN_CONCURRENCY_LIMIT"]);

    if (parallelEnvParsed && "invalid" in parallelEnvParsed) {
        logger.warn(`VIS_RUN_CONCURRENCY_LIMIT=${parallelEnvParsed.invalid} is not a positive number; falling back to default concurrency.`);
    }

    const parallelFromEnv = parallelEnvParsed && "value" in parallelEnvParsed ? parallelEnvParsed.value : undefined;
    const resolvedParallel = options.parallel ?? parallelFromEnv ?? 3;

    // CLI flag wins over the workspace config; per-target opt-in/out
    // is applied later in the executor against this resolved baseline.
    const resolvedStrictEnv = options.strictEnv ?? config.strictEnv ?? false;

    // One warning per task per run for the "cacheable task, zero input files"
    // diagnostic (see `TaskRunnerOptions.onDiagnostic`) — a config bug usually
    // trips every affected task, so dedupe to keep the output readable.
    const warnedEmptyInputs = new Set<string>();

    const runnerOptions: TaskRunnerOptions = {
        dryRun: options.dryRun ?? false,
        parallel: resolvedParallel,
        skipNxCache: !options.cache,
        summarize: options.summarize ?? false,
        ...configTaskRunner,
        // Applied after the config spread so the user's `--cache-dir` flag
        // wins over a config value and relative paths are normalized
        // against `workspaceRoot` via `resolveCacheDirectory()`.
        cacheDirectory: runCacheDirectory,
        // Forward the vis-owned data directory so run summaries land in
        // `<workspaceRoot>/.vis/` rather than the task-runner default
        // `<workspaceRoot>/.task-runner/`. The config-supplied value
        // (if any) is honoured because the spread above can carry it
        // through; the explicit assignment here guarantees vis-driven
        // runs always co-locate their state under `.vis/`.
        dataDirectory: configTaskRunner.dataDirectory ?? getVisWorkspaceDataDir(workspaceRoot),
        // `namedInputs` lives at the TOP LEVEL of the vis config, not under
        // `taskRunner`, so the `...configTaskRunner` spread above does not carry
        // it. Forward it explicitly: without it the task-runner's hasher gets an
        // empty named-inputs map, so a task whose `inputs` reference a named
        // input (`production`, `default`, …) resolves those names as LITERAL,
        // non-existent directories — contributing zero files to the cache key.
        // The task then false-cache-hits forever and never re-runs on a source
        // change. (Tasks with no `inputs` fall back to `{projectRoot}/**/*`,
        // which is why `lint:types` worked while `build` did not.)
        namedInputs: config.namedInputs,
        // Surface the hasher's "cacheable task resolved 0 input files" diagnostic
        // through the logger — the early-warning for a dropped/misconfigured input
        // that would otherwise silently false-cache-hit forever.
        onDiagnostic: (taskId, message) => {
            if (warnedEmptyInputs.has(taskId)) {
                return;
            }

            warnedEmptyInputs.add(taskId);
            logger.warn(message);
        },
        // Bridge the typed `task:fingerprint` hook into task-runner's
        // `onFingerprint` callback. Placed after the config spread so
        // the plugin pipeline always runs — a config-supplied
        // `onFingerprint` would silently disable every plugin's
        // fingerprint contributions.
        //
        // Errors propagate intentionally: a buggy plugin must fail the
        // task before any cache lookup runs (per the hook's documented
        // contract — see `VisHooks["task:fingerprint"]`).
        onFingerprint: async (task, contributor) => {
            await hooks.callHook("task:fingerprint", task, contributor);
        },
    };

    // Child-environment policy per task: the workspace `taskRunner.env`, unless
    // the target sets its own `options.env`. The executor, the persistent launch
    // and the traced run build the child env with it, and the task hasher keys on
    // the names it lets through.
    const childEnvPolicyFor = (task: Task): Required<ChildEnvOptions> => effectiveChildEnvPolicy(runnerOptions.env, getTaskOptions(task)?.env);

    // Built once per run. Every spawn of a task (executor, persistent launch and
    // traced run) reads its child environment from this context.
    const spawnContext = createTaskSpawnContext({
        affectedFiles,
        childEnvPolicy: childEnvPolicyFor,
        initCwd: invocationCwd,
        serviceEnvByTaskId,
        taskSlots: resolvedParallel,
        workspaceRoot,
    });

    // The command a spawn runs, and the strict-env failure for it. The executor
    // and the traced run both call these, so the two read the same command and
    // the same child environment.
    const resolveCommand = (task: Task): string | undefined => resolveTaskCommand(task, affectedFiles, currentOs);

    const strictEnvFailure = (task: Task, command: string, execOptions: { cwd?: string }): string | undefined => {
        // A per-target setting wins over the workspace flag, so one target can opt out (or in).
        const strictEnvActive = getTaskOptions(task)?.strictEnv ?? resolvedStrictEnv;

        if (!strictEnvActive) {
            return undefined;
        }

        const spawn = resolveTaskSpawn(spawnContext, task, execOptions);
        const childPolicy = spawnContext.childEnvPolicy(task);
        const violation = checkStrictEnv({
            command,
            // A variable the clean child cannot see is unset for the check, so `$VAR` fails the task instead of expanding to "".
            processEnv: childPolicy.mode === "clean" ? pickChildParentEnv(process.env, childPolicy) : process.env,
            taskEnv: spawn.env,
            taskId: task.id,
        });

        return violation ? formatStrictEnvError(violation) : undefined;
    };

    // The traced run's pre-spawn check: the same strict-env failure the executor reports.
    const preTraceCheck = (task: Task, spawnOptions: { cwd: string }): string | undefined => {
        const command = resolveCommand(task);

        return command === undefined ? undefined : strictEnvFailure(task, command, spawnOptions);
    };

    await applyRemoteCacheConfig({ configTaskRunner, logger, options, runnerOptions, workspaceRoot });

    const isTTY = process.stdout.isTTY && !isInCi;
    // Opt-in "quiet on success": suppress successful/cached task output and,
    // in the interactive TUI, auto-close a few seconds after a clean run.
    // Defaults to off; `--output-style` and `tui.autoExit` still override.
    const quietOnSuccess = visConfig?.run?.quietOnSuccess === true;
    // Auto-exit the interactive TUI after a clean run when quietOnSuccess is
    // on (3s countdown). An explicit `tui.autoExit` wins. A failed run never
    // auto-closes — VisTaskRunnerApp only arms the countdown when failed === 0.
    const autoExitConfig = config.tui?.autoExit ?? (quietOnSuccess ? 3 : false);
    // Include persistent tasks in the lifecycle's view so the header
    // ("Running targets serve for 1 project") and summary count them
    // even when the regular task graph is empty (e.g. `vis run serve`
    // for a project whose `serve` target has `preset: "server"`).
    const lifecycleOptions = {
        args: { parallel: runnerOptions.parallel, targets: [target] },
        autoExit: autoExitConfig,
        projectNames: projectsWithTarget,
        // A `splitCompound` target runs as its segments, so list those in its
        // place; the unsplit parent never completes and would show as skipped.
        tasks: [...initialTasks, ...persistentTasks].flatMap((task) => {
            const segments = Object.values(taskGraph.tasks).filter((candidate) => candidate.segment !== undefined && candidate.id.startsWith(`${task.id}#`));

            return segments.length > 0 ? segments : [task];
        }),
        // The table rows above only cover the directly-requested tasks. The
        // executor also runs every `dependsOn` dependency in `taskGraph`, and
        // those count toward the succeeded/failed/cached tallies. Pass the
        // full graph size so the "N total" label shares that scope instead of
        // under-reporting at the row count.
        totalTaskCount: Object.keys(taskGraph.tasks).length + persistentTasks.length,
    };

    const retryBudgetLimit = typeof options.retryBudget === "number" ? options.retryBudget : undefined;
    const sharedRetryBudget = retryBudgetLimit === undefined ? undefined : createRetryBudget(retryBudgetLimit);

    const hookLifeCycle = new HookableLifeCycle(hooks, onHookError);
    const failureLogLifeCycle = new FailureLogLifeCycle(workspaceRoot);

    // Explicit `--output-style` wins; absent the flag, quiet only when
    // run.quietOnSuccess is on (computed above, defaults to off).
    const outputStyle = resolveOutputStyle(options.outputStyle, visConfig?.run?.quietOnSuccess);

    // Fire service:attach for each registered service we attached to.
    // Computed earlier in `applyServiceRegistry`; the hook fires here
    // because `hooks` only exists post-`registerPlugins`. `taskIds` is
    // the set of in-graph dependents that consume the service's env —
    // empty when the service was attached but no dependent kept it.
    //
    // service:attach is an observation hook (see VisHooks docstring),
    // so a buggy plugin warns through `onHookError` rather than aborting
    // the run. Matches how the standalone `vis service` commands fire
    // service:start/service:stop in `commands/service/handler.ts`.
    if (serviceResult.satisfiedServices.length > 0) {
        for (const entry of serviceResult.satisfiedServices) {
            const taskIds = serviceResult.serviceDependentsByServiceId.get(entry.id) ?? [];

            try {
                await hooks.callHook("service:attach", entry, taskIds);
            } catch (error) {
                onHookError("service:attach", error);
            }
        }
    }

    return {
        childEnvPolicyFor,
        failureLogLifeCycle,
        hookLifeCycle,
        hooks,
        isTTY,
        lifecycleOptions,
        maybeWriteProfile,
        outputStyle,
        preTraceCheck,
        resolveCommand,
        runnerOptions,
        sharedRetryBudget,
        spawnContext,
        startTime,
        strictEnvFailure,
    };
};

export type RunRuntime = Awaited<ReturnType<typeof createRunRuntime>>;
