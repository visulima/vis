import type { ChildEnvOptions, Task, TaskResults, TaskRunnerOptions } from "@visulima/task-runner";
import { generateRunSummary, pickChildParentEnv, resolveTurboEnvCompat, writeChromeTrace } from "@visulima/task-runner";
import isInCi from "is-in-ci";

import { applyBranchScope, resolveSharedCacheDirectory } from "../../../cache/cache-directory";
import { FailureLogLifeCycle } from "../../../report/failure-log";
import { deleteEntry } from "../../../services/registry";
import { checkStrictEnv, formatStrictEnvError } from "../../../task/strict-env";
import { resolveOutputStyle } from "../../../tui/static-life-cycle";
import { createVisHooks, HookableLifeCycle, registerPlugins } from "../../../util/hooks";
import { getVisWorkspaceDataDir } from "../../../util/vis-paths";
import { createTaskSpawnContext, effectiveChildEnvPolicy, getTaskOptions, resolveTaskSpawn } from "../task-env";
import type { RunContext } from "./run-context";
import { createRetryBudget } from "./run-executor";
import { parseCacheBackend, parseCacheMode, parseEnvConcurrency } from "./run-parse";
import { cleanupEphemeralServices } from "./run-persistent-tasks";
import type { ServiceRegistryResult } from "./run-services";
import { resolveTaskCommand } from "./run-shell";

/**
 * Phase 8: everything the run modes need — hooks, runner options, remote cache,
 * lifecycle options, spawn context. Ends with the `run:before` hook.
 */
export const prepareRunRuntime = async (ctx: RunContext, serviceResult: ServiceRegistryResult) => {
    const { config, invocationCwd, logger, options, visConfig, workspaceRoot } = ctx;
    const { serviceEnvByTaskId } = serviceResult;

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

        const summary = generateRunSummary(results, ctx.taskGraph, startTime);

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
        affectedFiles: ctx.affectedFiles,
        childEnvPolicy: childEnvPolicyFor,
        initCwd: invocationCwd,
        serviceEnvByTaskId,
        taskSlots: resolvedParallel,
        workspaceRoot,
    });

    // The command a spawn runs, and the strict-env failure for it. The executor
    // and the traced run both call these, so the two read the same command and
    // the same child environment.
    const resolveCommand = (task: Task): string | undefined => resolveTaskCommand(task, ctx.affectedFiles, ctx.currentOs);

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

    // Resolve the remote-cache config in three layers (CLI > vis.config.ts
    // > Turbo env-var compat). Fill missing HTTP fields from TURBO_API /
    // TURBO_TOKEN / TURBO_TEAM so a workspace migrating from Turbo keeps
    // working without rewriting CI secrets. Rejects malformed CLI values
    // up front so a typo in `--cache-mode=eread` doesn't silently fall
    // through to the runner and surface as "no cache hits".
    const envCompatRemoteCache = resolveTurboEnvCompat(configTaskRunner.remoteCache);

    if (envCompatRemoteCache) {
        const cliMode = parseCacheMode(options.cacheMode);
        const cliBackend = parseCacheBackend(options.cacheBackend);

        runnerOptions.remoteCache = {
            ...envCompatRemoteCache,
            ...(cliMode ? { mode: cliMode } : {}),
            ...(cliBackend ? { backend: cliBackend } : {}),
        };

        // Config can only carry serializable attestation knobs
        // (`requireOnDownload`, `expectedIdentity`); the actual keyless
        // sign/verify callbacks can't live in vis.config.ts. When the
        // user opted in, swap the declarative stub for Sigstore-backed
        // hooks here.
        if (runnerOptions.remoteCache.attestation) {
            const { expectedIdentity, requireOnDownload } = runnerOptions.remoteCache.attestation;

            // Verifying a keyless bundle without pinning the signer
            // proves integrity, not authenticity — that is what the HMAC
            // `signing` block already does. Accept any of the three
            // public identity forms; refuse a half-configured setup
            // loudly rather than ship a false sense of provenance.
            const identityConfigured
                = expectedIdentity !== undefined
                    && (("github" in expectedIdentity
                        && typeof expectedIdentity.github?.ref === "string"
                        && typeof expectedIdentity.github.repo === "string"
                        && typeof expectedIdentity.github.workflow === "string")
                    || ("oidcIssuer" in expectedIdentity
                        && typeof expectedIdentity.oidcIssuer === "string"
                        && (typeof (expectedIdentity as { san?: unknown }).san === "string"
                            || typeof (expectedIdentity as { sanRegex?: unknown }).sanRegex === "string")));

            if (!identityConfigured) {
                throw new Error(
                    "[vis run] remoteCache.attestation requires a pinned keyless signer via `expectedIdentity`. Use one of:\n  • { github: { repo, workflow, ref } }   (GitHub Actions — recommended)\n  • { oidcIssuer, san }                   (literal identity; vis regex-escapes + anchors it)\n  • { oidcIssuer, sanRegex }              (advanced: raw regex, you own anchoring)\nWithout it, verification is integrity-only — use `remoteCache.signing` (HMAC) for that instead.",
                );
            }

            // Only the raw-regex form carries the unanchored-match
            // hazard: sigstore matches the SAN with `String.match`, so a
            // substring-matched pattern lets a longer attacker SAN that
            // merely *contains* the expected value pass. The `github`
            // and literal `san` forms are escaped and `^…$`-anchored by
            // `normalizeExpectedIdentity`, so they're safe by default.
            if ("sanRegex" in expectedIdentity && (!expectedIdentity.sanRegex.startsWith("^") || !expectedIdentity.sanRegex.endsWith("$"))) {
                logger.warn(
                    "[vis run] remoteCache.attestation.expectedIdentity.sanRegex is not anchored (^…$). sigstore matches it as a regex; an unanchored value is substring-matched and weakens the identity pin. Prefer the literal `san` form unless you need a pattern.",
                );
            }

            const { installCommandFor, isSigstoreInstalled } = await import("../../../security/sigstore/loader");

            // Surface a missing optional peer dep at startup rather than
            // mid-run: warn (don't fail) so a misconfigured consumer
            // still runs, just without provenance, with a copy-paste fix.
            if (!isSigstoreInstalled()) {
                logger.warn(
                    `[vis run] remoteCache.attestation is configured but the optional \`sigstore\` package is not installed. Cache uploads will be unsigned and signed entries can't be verified until you install it:\n  ${installCommandFor(workspaceRoot)}`,
                );
            }

            const { buildCacheAttestationHooks } = await import("../../../security/sigstore/cache-attestation");

            runnerOptions.remoteCache.attestation = buildCacheAttestationHooks({
                expectedIdentity,
                onReject: (hash, reason) => {
                    logger.warn(`[vis run] remote cache entry ${hash.slice(0, 12)} rejected: attestation ${reason}. Treating as a cache miss.`);
                },
                onVerifyFailure: (message) => {
                    logger.warn(`[vis run] attestation verification failed: ${message}`);
                },
                requireOnDownload,
                workspaceRoot,
            });
        }
    } else if (options.cacheMode || options.cacheBackend) {
        logger.warn("[vis run] --cache-mode and --cache-backend require a `remoteCache` block in vis.config.ts (or TURBO_API env); ignoring.");
    }

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
        args: { parallel: runnerOptions.parallel, targets: [ctx.target] },
        autoExit: autoExitConfig,
        projectNames: ctx.projectsWithTarget,
        // A `splitCompound` target runs as its segments, so list those in its
        // place; the unsplit parent never completes and would show as skipped.
        tasks: [...ctx.initialTasks, ...ctx.persistentTasks].flatMap((task) => {
            const segments = Object.values(ctx.taskGraph.tasks).filter((candidate) => candidate.segment !== undefined && candidate.id.startsWith(`${task.id}#`));

            return segments.length > 0 ? segments : [task];
        }),
        // The table rows above only cover the directly-requested tasks. The
        // executor also runs every `dependsOn` dependency in `taskGraph`, and
        // those count toward the succeeded/failed/cached tallies. Pass the
        // full graph size so the "N total" label shares that scope instead of
        // under-reporting at the row count.
        totalTaskCount: Object.keys(ctx.taskGraph.tasks).length + ctx.persistentTasks.length,
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

    await hooks.callHook("run:before", { tasks: ctx.initialTasks, workspaceRoot });

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

export type RunRuntime = Awaited<ReturnType<typeof prepareRunRuntime>>;

/**
 * SIGTERM the ephemeral service group + drop the scratch dir exactly
 * once. Run from the run-block's `finally`, AND from a Ctrl+C/SIGTERM
 * listener so children don't outlive the run when the dynamic TUI's
 * own `process.exit(1)` short-circuits the normal exit path.
 *
 * Registers the signal listeners when there is cleanup work; the caller
 * must pass the result to {@link teardownRun}.
 */
export const armRunCleanup = (ctx: RunContext) => {
    const stopServicesOnExit = ctx.options.stopServices;
    let cleanupRan = false;
    const runCleanupOnce = (): void => {
        if (cleanupRan) {
            return;
        }

        cleanupRan = true;

        if (ctx.serviceEventBridge) {
            ctx.serviceEventBridge.dispose().catch(() => {});
        }

        // When --stop-services is set, also kill the registry-mode services
        // this run started. Their pids are captured by the bridge `started`
        // sink. Registry entries point at dead pids after this; `vis
        // service list` / `pruneDead` cleans them up later.
        const extraPids = stopServicesOnExit ? [...ctx.registryStartedPids.values()] : undefined;

        cleanupEphemeralServices({ extraPids, pidFiles: ctx.ephemeralPidFiles, runDir: ctx.serviceRunDir });
    };
    const onCleanupSignal = (): void => {
        runCleanupOnce();
    };
    const hasCleanupWork = ctx.ephemeralPidFiles.length > 0 || ctx.serviceRunDir !== undefined || (stopServicesOnExit && ctx.registryStartedIds.length > 0);

    if (hasCleanupWork) {
        process.on("SIGINT", onCleanupSignal);
        process.on("SIGTERM", onCleanupSignal);
    }

    return { hasCleanupWork, onCleanupSignal, runCleanupOnce, stopServicesOnExit };
};

/**
 * The `finally` of a run: stop services, detach the signal listeners, and
 * drop the registry entries for services this run stopped.
 */
export const teardownRun = async (ctx: RunContext, cleanup: ReturnType<typeof armRunCleanup>): Promise<void> => {
    cleanup.runCleanupOnce();

    if (cleanup.hasCleanupWork) {
        process.off("SIGINT", cleanup.onCleanupSignal);
        process.off("SIGTERM", cleanup.onCleanupSignal);
    }

    // Clean exit path: also delete the registry entries for services
    // we just stopped so `vis service list` doesn't show stale rows.
    // The signal-handler path skips this — sync FS work in a SIGINT
    // handler is risky, and `pruneDead` reconciles dead entries on
    // demand anyway.
    if (cleanup.stopServicesOnExit && ctx.registryStartedIds.length > 0) {
        await Promise.all(
            ctx.registryStartedIds.map(async (id) => {
                try {
                    await deleteEntry(ctx.workspaceRoot, id);
                } catch {
                    // Best-effort — entry may already be gone.
                }
            }),
        );
    }
};
