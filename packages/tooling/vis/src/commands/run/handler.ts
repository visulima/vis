import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import type { ChildEnvOptions, LogMode, ProcessEvent, Task, TaskResults, TaskRunnerOptions } from "@visulima/task-runner";
import { CompositeLifeCycle, createLogReporter, defaultTaskRunner, generateRunSummary, pickChildParentEnv, reverseTaskGraph, runConcurrently, splitCompoundTasks, TerminalBuffer, writeChromeTrace, writeRunSummary } from "@visulima/task-runner";
import isInCi from "is-in-ci";

import { applyBranchScope, resolveSharedCacheDirectory } from "../../cache/cache-directory";
import { buildProjectGraph, discoverWorkspace, loadVisTaskConfigsForWorkspace } from "../../config/workspace";
import { FailureLogLifeCycle } from "../../report/failure-log";
import { compareDuration, formatTimingSummary, loadRunSummaries } from "../../report/run-report";
import { resolveCommandRuntime } from "../../runtime/command-runtime";
import { checkStrictEnv, formatStrictEnvError } from "../../task/strict-env";
import { detectCurrentOs, resolveTargetShell } from "../../task/target-options";
import { createDynamicOutputRenderer } from "../../tui/dynamic-life-cycle";
import { resolveOutputStyle, StaticOutputLifeCycle } from "../../tui/static-life-cycle";
import type { StdinEntry } from "../../tui/types";
import { createVisHooks, HookableLifeCycle, registerPlugins } from "../../util/hooks";
import { cleanupLegacyTaskRunnerLayout, getVisWorkspaceDataDir } from "../../util/vis-paths";
import { collectTrackedWatchTargets, createTrackedFileFilter, startWatcher } from "../../watch/watch";
import { applyProjectFilter } from "../../watch/watch-filter";
import type { KeybindHandle } from "../../watch/watch-keybinds";
import { installKeybinds, writeHelp } from "../../watch/watch-keybinds";
import type { MutexPool } from "./executor";
import { createConcurrentExecutor, createRetryBudget } from "./executor";
import type { RunOptions } from "./index";
import { MAX_OUTPUT_BYTES } from "./output";
import { parseEnvConcurrency, renderLastRunSummary } from "./parse";
import { runPersistentTasks } from "./persistent-tasks";
import { resolveRunArguments } from "./run-arguments";
import { createRunCleanup } from "./run-cleanup";
import { printDryRunPlan } from "./run-dry-run";
import { buildInitialTasks } from "./run-initial-tasks";
import { runStartupPreflights } from "./run-preflight";
import { applyRemoteCacheConfig } from "./run-remote-cache";
import { enforceRunConstraints, narrowProjectSelection, narrowToAffectedProjects, pickRunTarget, validateAffectedOnlyFlags } from "./run-selection";
import { wireRunServices } from "./run-services";
import { logRegistryServiceHint, reportRunOutcome } from "./run-summary";
import { selectProjectsWithTarget } from "./run-target-projects";
import { createRunTaskGraph } from "./run-task-graph";
import { resolveTaskCommand } from "./shell";
import { AFFECTED_FILES_ENV, createTaskSpawnContext, effectiveChildEnvPolicy, getTaskOptions, resolveRetrySpawn, resolveTaskSpawn } from "./task-env";

const execute = async ({ argument, logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, RunOptions>): Promise<void> => {
    if (!wsRoot) {
        throw new Error("Could not determine workspace root. Run this command inside a monorepo.");
    }

    const workspaceRoot = wsRoot;

    // Validate the selected runtime (--runtime / VIS_RUNTIME / config). `run`
    // orchestrates tool binaries (tsc, vite, eslint, …) that are runtime-agnostic,
    // so it deliberately does NOT change task execution based on the runtime — and
    // must not inject it into the task env, which would rotate every task's cache
    // hash. We only validate and resolve the runtime, matching the PM verbs.
    // Runtime-specific *execution* lives in `vis x` (file runner) and the PM verbs,
    // not in task orchestration.
    resolveCommandRuntime({ options, visConfig }, workspaceRoot);

    // Vis used to write its run state under `.task-runner/` and the cache
    // under `.task-runner-cache/`. After the cutover to `.vis/` those paths
    // are no longer read, so silently sweep them away on the next run.
    cleanupLegacyTaskRunnerLayout(workspaceRoot);

    // `--last-details` short-circuits execution: render the
    // persisted last-run summary and exit. Handles the common
    // "I ran tests 30s ago, show me what happened" case without
    // re-running and (more importantly) without needing the
    // workspace to be in a runnable state.
    if (options.lastDetails) {
        await renderLastRunSummary(workspaceRoot, logger);

        return;
    }

    // The directory the user invoked `vis` from, captured before any
    // workspace resolution. Propagated as INIT_CWD to every task —
    // matches pnpm/npm/yarn semantics so scripts can resolve paths
    // relative to where the user actually ran the command.
    const invocationCwd = process.cwd();
    const taskConfigs = await loadVisTaskConfigsForWorkspace(workspaceRoot, visConfig);
    const { config, fileOwners, packageJsons, projectOptions, workspace } = discoverWorkspace(workspaceRoot, visConfig, taskConfigs);
    const projectGraph = buildProjectGraph(workspaceRoot, workspace, packageJsons);

    const rawSelector = await pickRunTarget({ argument, logger, workspace });

    if (rawSelector === undefined) {
        return;
    }

    enforceRunConstraints({ config, logger, options, projectGraph });

    validateAffectedOnlyFlags({ options, rawSelector });

    const selection = await narrowProjectSelection({
        logger,
        options,
        packageJsons,
        projectGraph,
        projectOptions,
        rawSelector,
        visConfig,
        workspace,
        workspaceRoot,
    });

    if (!selection) {
        return;
    }

    const { target } = selection;

    // Any positional args past the target name are forwarded only to the
    // invoked task — not to `dependsOn` deps. The task-runner string-form
    // resolver strips overrides so deps start with a clean slate.
    const forwardedArgs: string[] = argument.slice(1).map(String);

    const narrowed = await narrowToAffectedProjects({
        fileOwners,
        logger,
        options,
        projectGraph,
        projectNames: selection.projectNames,
        visConfig,
        workspace,
        workspaceRoot,
    });

    if (!narrowed) {
        return;
    }

    const { affectedChangedFiles, projectNames } = narrowed;

    const currentOs = detectCurrentOs();

    // `vis affected` delegates to `vis run --projects=…` and passes the
    // changed-file set through the environment; an in-process `--affected`
    // run already has it in hand.
    const affectedFilesRaw = process.env[AFFECTED_FILES_ENV];
    const affectedFiles = affectedChangedFiles ?? (affectedFilesRaw ? affectedFilesRaw.split("\n").filter(Boolean) : undefined);

    const targetSelection = selectProjectsWithTarget({ logger, options, projectNames, projectOptions, target, workspace });

    if (!targetSelection) {
        return;
    }

    const { projectsWithTarget, projectTargetIndex } = targetSelection;

    const taskArguments = resolveRunArguments({ forwardedArgs, logger, projectsWithTarget, projectTargetIndex, target });

    if (!taskArguments) {
        return;
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
        return;
    }

    const { persistentTasks } = initialSelection;
    let { initialTasks } = initialSelection;

    let taskGraph = createRunTaskGraph({
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

    await runStartupPreflights({ config, logger, options, packageJsons, workspaceRoot });

    const services = await wireRunServices({ config, initialTasks, logger, options, persistentTasks, target, taskGraph, workspaceRoot });

    initialTasks = services.initialTasks;
    taskGraph = services.taskGraph;

    const {
        ephemeralPidFiles,
        injectedServiceIdSet,
        registryStartedCount,
        registryStartedIds,
        registryStartedPids,
        serviceDockStore,
        serviceEnvByTaskId,
        serviceEventBridge,
        serviceResult,
        serviceRunDir,
    } = services;

    // Flip the task graph for teardown targets (CDK/Pulumi `destroy`,
    // `undeploy`, etc.) where dependents must run before the things
    // they depend on. Runs after service auto-attach so service
    // detection still uses the natural graph; runs before the
    // dry-run walk and scheduler so both reflect the reversed order.
    // `reverseTaskGraph` recomputes `roots` from the flipped edges,
    // so the dry-run printer and `TaskScheduler` need no further
    // changes — they already walk topologically over `dependencies`.
    if (options.reverse) {
        taskGraph = reverseTaskGraph(taskGraph);
        logger.debug?.(`Reversed task graph: ${String(taskGraph.roots.length)} new root(s) (originally leaves)`);
    }

    // `splitCompound` splits a POSIX shell line, so a target with a custom
    // shell runs its command in another language and stays whole.
    for (const task of Object.values(taskGraph.tasks)) {
        const shellOptions = projectOptions.get(task.target.project)?.[task.target.target]?.options;

        if (task.splitCompound && resolveTargetShell(shellOptions) !== undefined) {
            logger.warn(`splitCompound ignored for ${task.id}: it uses a custom shell. Running the command as one unit.`);
            task.splitCompound = undefined;
        }
    }

    // Split `splitCompound` targets into chained segment tasks before the
    // dry-run plan and the scheduler read the graph. The runner's own split
    // pass then finds nothing left to do.
    taskGraph = splitCompoundTasks(taskGraph, {
        commandOf: (task) => task.overrides["command"] as string | undefined,
        onDiagnostic: (_taskId, message) => {
            logger.warn(message);
        },
    });

    if (options.dryRun) {
        printDryRunPlan({ config, logger, persistentTasks, taskGraph });

        return;
    }

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

    // Resolve the cache directory through the shared helper so precedence
    // (CLI > vis.config.ts > default) stays consistent with `vis cache`
    // and relative --cache-dir values are normalized against the
    // workspace root. Other fields keep their existing spread semantics
    // to avoid changing override precedence for parallel/dryRun/etc.
    const configTaskRunner = (config.taskRunner ?? {}) as TaskRunnerOptions & { cacheDirectory?: string };
    // Anchor the default cache path to the *main* worktree root when this
    // workspace is a linked git worktree, so sibling agents share one cache
    // instead of rebuilding the same hash N times. Explicit paths
    // (--cache-dir, vis.config.ts, VIS_CACHE_DIRECTORY) win unchanged.
    const baseCacheDirectory = resolveSharedCacheDirectory(workspaceRoot, options.cacheDir, configTaskRunner.cacheDirectory, config.sharedWorktreeCache);
    // Branch-scope the cache dir when configured so main/feature
    // branches stop overwriting each other's entries.
    const resolvedCacheDirectory = applyBranchScope(baseCacheDirectory, workspaceRoot, config.branchScopedCache);

    // Concurrency resolution order: --parallel CLI flag > VIS_RUN_CONCURRENCY_LIMIT
    // env > built-in default of 3. Matches vite-task's
    // VP_RUN_CONCURRENCY_LIMIT semantics — lets CI runners set a
    // global limit via env without passing the flag on every call.
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
        cacheDirectory: resolvedCacheDirectory,
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

    await hooks.callHook("run:before", { tasks: initialTasks, workspaceRoot });

    const stopServicesOnExit = options.stopServices;
    const cleanup = createRunCleanup({
        ephemeralPidFiles,
        registryStartedIds,
        registryStartedPids,
        serviceEventBridge,
        serviceRunDir,
        stopServicesOnExit,
        workspaceRoot,
    });

    cleanup.install();

    try {
        if (isTTY) {
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

            let loopAction: "quit" | "rerun" | "retry" = "rerun";
            let retryTaskId: string | null = null;

            let lastResults: TaskResults = new Map();

            while (loopAction !== "quit") {
                if (loopAction === "rerun") {
                    lastResults = await defaultTaskRunner(initialTasks, runnerOptions, {
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
                } else if (loopAction === "retry" && retryTaskId) {
                    // A split target retries by segment id, which only the graph knows.
                    const task = taskGraph.tasks[retryTaskId] ?? initialTasks.find((t) => t.id === retryTaskId);
                    // Same command the first attempt ran, so a retry keeps its forwarded arguments and shell.
                    const command = task ? resolveTaskCommand(task, spawnContext.affectedFiles, currentOs) : undefined;

                    if (task && command) {
                        lifeCycle.startTasks?.([task]);

                        const retryTermBuf = new TerminalBuffer(MAX_OUTPUT_BYTES);

                        // Same cwd and child environment as the first attempt.
                        const retrySpawn = resolveRetrySpawn(spawnContext, task);

                        const retryResult = await runConcurrently(
                            [
                                {
                                    command,
                                    cwd: retrySpawn.cwd,
                                    env: retrySpawn.env,
                                    inheritEnv: retrySpawn.inheritEnv,
                                    name: task.id,
                                    ptySize: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
                                    stdin: "pty",
                                },
                            ],
                            {
                                onEvent: (event: ProcessEvent) => {
                                    if (event.kind === "started" && event.write) {
                                        stdinRegistry.set(task.id, { kill: event.kill, resize: event.resize, write: event.write });
                                    }

                                    if ((event.kind === "stdout" || event.kind === "stderr") && event.text) {
                                        retryTermBuf.write(event.text);
                                        store.setOutput(task.id, retryTermBuf.toString());
                                    }

                                    if (event.kind === "close") {
                                        stdinRegistry.delete(task.id);
                                    }
                                },
                            },
                        );

                        const closeEvent = retryResult.closeEvents[0];

                        lifeCycle.endTasks?.([
                            {
                                code: closeEvent?.exitCode ?? 1,
                                status: closeEvent?.exitCode === 0 ? "success" : "failure",
                                task,
                                terminalOutput: store.getSnapshot().outputs.get(task.id),
                            },
                        ]);
                    } else if (task) {
                        lifeCycle.endTasks?.([
                            {
                                code: 1,
                                status: "failure",
                                task,
                                terminalOutput: `No command configured for ${task.id}`,
                            },
                        ]);
                    }

                    retryTaskId = null;

                    // Mark done after retry so user can rerun/retry again
                    store.markDone();
                }

                loopAction = await new Promise<"quit" | "rerun" | "retry">((resolve) => {
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
            }

            await dynamic.renderIsDone;
            await hooks.callHook("run:after", lastResults);
            await maybeWriteProfile(lastResults);

            logRegistryServiceHint({ logger, registryStartedCount, stopServicesOnExit });
        } else {
            const mutexPool: MutexPool = new Map();
            const logModeOption = typeof options.log === "string" ? options.log.toLowerCase() : "";
            const logMode: LogMode | undefined
                = logModeOption === "labeled" || logModeOption === "grouped" || logModeOption === "interleaved" ? logModeOption : undefined;
            const logReporter = logMode ? createLogReporter(logMode) : undefined;
            // Composite so plugin hooks see every task boundary event in
            // addition to the CI-style static renderer. Build the
            // lifecycle first so the executor can forward streaming
            // stdout/stderr chunks into it.
            const lifeCycle = new CompositeLifeCycle([
                new StaticOutputLifeCycle({ ...lifecycleOptions, ciGrouping: visConfig?.run?.ciGrouping ?? "auto", logReporter, outputStyle }),
                hookLifeCycle,
                failureLogLifeCycle,
            ]);

            const taskExecutor = createConcurrentExecutor({
                hooks,
                lifeCycle,
                mutexPool,
                resolveCommand,
                retryBudget: sharedRetryBudget,
                serviceEventBridge: serviceEventBridge ?? undefined,
                spawnContext,
                strictEnvFailure,
                workspaceRoot,
            });

            const runOnce = async (): Promise<{ hasFailure: boolean; results: TaskResults; runHistory: Awaited<ReturnType<typeof loadRunSummaries>> }> => {
                const runStart = Date.now();

                const results = await defaultTaskRunner(initialTasks, runnerOptions, {
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

                const durationMs = Date.now() - runStart;

                if (options.summarize) {
                    const summary = generateRunSummary(results, taskGraph, startTime);

                    await writeRunSummary(summary, workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) });
                }

                let hasFailure = false;

                for (const [, result] of results) {
                    if (result.status === "failure") {
                        hasFailure = true;
                    }
                }

                const timingLine = formatTimingSummary(results, durationMs);

                // Load historical summaries once here and share with
                // the flakiness analyzer below — both consumers need
                // the same files and duplicate reads dominate when
                // the runs/ dir has accumulated hundreds of entries.
                const runHistory = loadRunSummaries(workspaceRoot);
                const durationComparison = compareDuration(workspaceRoot, durationMs, runHistory);

                logger.info("");
                logger.info(`  ${timingLine}${durationComparison ? ` ${durationComparison}` : ""}`);

                return { hasFailure, results, runHistory };
            };

            const firstRun = await runOnce();

            await hooks.callHook("run:after", firstRun.results);
            await maybeWriteProfile(firstRun.results);

            const { hasFailure } = firstRun;

            if (options.watch) {
                const absoluteRoots = projectsWithTarget
                    .map((name) => {
                        const project = workspace.projects[name];
                        const root = project?.root;

                        if (!root) {
                            return undefined;
                        }

                        return root.startsWith("/") ? root : `${workspaceRoot}/${root}`;
                    })
                    .filter((p): p is string => p !== undefined);

                // Snapshot the post-partition task set so `a` (clear filter)
                // can return to it after `p` narrowed the run.
                const baseTasks = initialTasks;
                let projectFilter: string | undefined;

                const applyFilter = (filter: string | undefined): number => {
                    const result = applyProjectFilter(baseTasks, filter);

                    projectFilter = result.filter;
                    initialTasks = result.tasks;

                    return result.tasks.length;
                };

                let running = false;
                let lastResults = firstRun.results;

                // Builds a fresh watcher after each run so the watch set
                // reflects the files the latest run actually touched.
                // Falls back to project roots on the first invocation
                // (no prior results) or when no task carries hashDetails.
                const buildHandle = (): { handle: ReturnType<typeof startWatcher>; mode: "tracked" | "roots" } => {
                    const targets = collectTrackedWatchTargets(lastResults, workspaceRoot);

                    if (targets.directories.length > 0 && targets.files.size > 0) {
                        const filter = createTrackedFileFilter(targets.files, workspaceRoot, targets.directories);

                        return {
                            handle: startWatcher({
                                filter,
                                onChange: onChangeHandler,
                                paths: targets.directories,
                            }),
                            mode: "tracked",
                        };
                    }

                    return {
                        handle: startWatcher({ onChange: onChangeHandler, paths: absoluteRoots }),
                        mode: "roots",
                    };
                };

                let currentHandle: ReturnType<typeof startWatcher> | undefined;

                const onChangeHandler = async (paths: string[]): Promise<void> => {
                    if (running) {
                        return;
                    }

                    running = true;

                    try {
                        logger.info(`Change detected in ${paths.length} file(s), rerunning…`);

                        const nextRun = await runOnce();

                        lastResults = nextRun.results;

                        // Rebuild the watcher so the next event only
                        // fires for files the newest run still cares
                        // about. Cheap — under 100ms on typical graphs.
                        currentHandle?.close();

                        const rebuilt = buildHandle();

                        currentHandle = rebuilt.handle;
                    } finally {
                        running = false;
                    }
                };

                const initial = buildHandle();

                currentHandle = initial.handle;

                const scope
                    = initial.mode === "tracked"
                        ? `Watching ${String(collectTrackedWatchTargets(lastResults, workspaceRoot).files.size)} tracked file(s)`
                        : `Watching ${String(absoluteRoots.length)} project root(s)`;

                logger.info(`${scope} — edit a file to rerun, press h for keybinds, q to quit.`);

                const triggerRerun = async (): Promise<void> => {
                    if (running) {
                        return;
                    }

                    running = true;

                    try {
                        if (initialTasks.length === 0) {
                            logger.info("No tasks match the active filter — press a to clear it.");

                            return;
                        }

                        const nextRun = await runOnce();

                        lastResults = nextRun.results;
                        currentHandle?.close();

                        const rebuilt = buildHandle();

                        currentHandle = rebuilt.handle;
                    } finally {
                        running = false;
                    }
                };

                await new Promise<void>((resolve) => {
                    let exited = false;
                    // Forward declarations so `exit()` can reference both the
                    // SIGINT listener and the keybind handle without hitting
                    // a TDZ if a future refactor calls exit() synchronously.
                    let keybinds: KeybindHandle | undefined;
                    const onSigint = (): void => {
                        exit();
                    };

                    const exit = (): void => {
                        if (exited) {
                            return;
                        }

                        exited = true;
                        keybinds?.close();
                        process.off("SIGINT", onSigint);
                        currentHandle?.close();
                        resolve();
                    };

                    process.on("SIGINT", onSigint);

                    keybinds = installKeybinds({
                        handlers: {
                            onClearFilter: async () => {
                                const total = applyFilter(undefined);

                                logger.info(`Filter cleared — running ${String(total)} task(s).`);
                                await triggerRerun();
                            },
                            onFilter: async (pattern) => {
                                // Capture before mutating — applyFilter() overwrites
                                // projectFilter, so we'd lose the rollback target
                                // otherwise.
                                const previousFilter = projectFilter;
                                const matching = applyFilter(pattern);

                                if (matching === 0) {
                                    logger.info(`Filter "${pattern}" matched no projects — keeping previous filter.`);
                                    applyFilter(previousFilter);

                                    return;
                                }

                                logger.info(`Filter "${pattern}" matched ${String(matching)} task(s).`);
                                await triggerRerun();
                            },
                            onHelp: () => {
                                writeHelp(process.stdout);
                            },
                            onQuit: () => {
                                exit();
                            },
                            onRerun: triggerRerun,
                        },
                    });
                });

                return;
            }

            reportRunOutcome({ firstRun, hasFailure, logger, options, workspaceRoot });

            if (persistentTasks.length > 0 && !options.failFast) {
                await runPersistentTasks(persistentTasks, spawnContext, undefined);
            }

            logRegistryServiceHint({ logger, registryStartedCount, stopServicesOnExit });
        }
    } finally {
        await cleanup.finish();
    }
};

export default execute as CommandExecute<Toolbox>;
