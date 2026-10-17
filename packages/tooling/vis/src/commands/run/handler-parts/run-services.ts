import type { Task } from "@visulima/task-runner";
import isInCi from "is-in-ci";

import { VisUserError } from "../../../errors/vis-user-error";
import { runReadiness } from "../../../services/readiness";
import { readAllEntries } from "../../../services/registry";
import type { ServiceEntry } from "../../../services/types";
import { ServiceDockStore } from "../../../tui/components/service-dock/service-dock-store";
import { applyServiceRegistry } from "../apply-service-registry";
import type { ServiceBridgeEntry } from "../service-event-bridge";
import { ServiceEventBridge } from "../service-event-bridge";
import { buildBootstrapPaths, describeServicesPolicySource, extractPreflightTasks, injectServiceTasks, resolveServicesPolicy } from "../service-preflight";
import { SERVICE_PROBE_TIMEOUT_MS } from "./persistent-tasks";
import type { RunContext } from "./run-context";

export type ServiceRegistryResult = Awaited<ReturnType<typeof applyServiceRegistry>>;

/**
 * Phase 6a: auto-attach to services already running in the registry. The
 * probe re-runs each service's readiness check, so a dead wrapper PID is not
 * attached. Returns the result for the later service phases.
 */
export const attachRegisteredServices = async (ctx: RunContext): Promise<ServiceRegistryResult> => {
    const { options, workspaceRoot } = ctx;

    // Auto-attach: if a service this run depends on is already
    // running in the background registry, drop it from the graph and
    // capture its env for the surviving dependents. Diagnostics here
    // mean the user invoked something whose dep is a service that
    // isn't running — refuse to half-execute.
    //
    // The probe re-runs the service's readiness check with a short
    // timeout before accepting the entry. PID-alive isn't enough: a
    // shell-wrapped service whose underlying server has crashed leaves
    // the wrapper PID alive, and we don't want to attach a dependent
    // task to a dead port. The probe is skipped in `--dry-run` because
    // a plan print never executes the dependent task, so probing risks
    // a misleading "service down" diagnostic for what is really a
    // planning-only invocation.
    const visVersion = process.env["VIS_VERSION"] ?? "0.0.0";
    const probe = options.dryRun
        ? undefined
        : async (entry: ServiceEntry): Promise<boolean> => {
            try {
                await runReadiness(entry.config, { timeoutMs: SERVICE_PROBE_TIMEOUT_MS });

                return true;
            } catch {
                return false;
            }
        };

    const registeredEntries = await readAllEntries(workspaceRoot);

    // User-invoked tasks for `applyServiceRegistry`'s "is this user-asked-for?"
    // check — includes persistent ones so a user running `vis run dev` (where
    // `dev` is persistent) doesn't get a confusing "service deps missing"
    // diagnostic for the persistent task itself.
    return applyServiceRegistry({
        initialTasks: [...ctx.initialTasks, ...ctx.persistentTasks],
        probe,
        registeredEntries,
        taskGraph: ctx.taskGraph,
        visVersion,
    });
};

/**
 * Phase 6b: when a service dependency is not running, either boot it for this
 * run (ephemeral or registry mode) or fail with a diagnostic naming the
 * override. Injects the boot tasks into the graph and wires the dock + bridge.
 */
export const injectMissingServices = (ctx: RunContext, serviceResult: ServiceRegistryResult): void => {
    const { config, logger, options, workspaceRoot } = ctx;

    if (serviceResult.diagnostics.length > 0) {
        const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
        const decision = options.dryRun
            ? "off"
            : resolveServicesPolicy({
                cli: options.services,
                config: config.run?.services,
                isCi: Boolean(isInCi),
                isPersistentTarget: ctx.persistentTasks.length > 0,
                isTty,
                target: ctx.target,
            });

        if (decision === "off") {
            for (const diagnostic of serviceResult.diagnostics) {
                logger.error(diagnostic.message);
            }

            // Auto-start exists and would have satisfied every one of these
            // deps — it just wasn't reached, because `--dry-run` skips it or
            // the TTY-aware default resolved to `off` (CI, a piped stdout, a
            // non-interactive shell). Naming the override turns a dead end
            // into a one-flag fix; without it a declarative `dependsOn` on a
            // service reads as simply unsupported.
            const source = describeServicesPolicySource({ cli: options.services, config: config.run?.services });
            const hints: string[] = [];

            if (options.dryRun) {
                hints.push("`--dry-run` never starts services; drop it to let vis boot them.");
            } else if (source === "default") {
                hints.push(
                    "vis only auto-starts service deps in an interactive terminal by default (this run is CI or non-TTY).",
                    "Pass `--services=ephemeral` to boot them for this run, or set `run.services` in vis.config.ts.",
                );
            } else if (source === "cli") {
                hints.push("`--services=off` was passed; use `--services=ephemeral` to boot them for this run.");
            } else {
                hints.push("`run.services: \"off\"` is set in vis.config.ts; override it with `--services=ephemeral`.");
            }

            throw new VisUserError(
                [`${serviceResult.diagnostics.length} service dependency error(s) — start the missing services or invoke them directly.`, ...hints].join(
                    "\n",
                ),
            );
        }

        const missingIds = serviceResult.diagnostics.map((d) => d.targetId);
        const mode = decision;

        // Capture the original (pre-injection) per-service config so the
        // bridge's registry entries hold the actual service command —
        // `injectServiceTasks` rewrites `task.overrides.command` to the
        // `vis service start <id>` wrapper, which is the wrong thing to
        // re-spawn from `#retryRegistry`.
        const preInjectionExtracted = mode === "registry" ? extractPreflightTasks(workspaceRoot, missingIds, ctx.taskGraph) : undefined;

        // Inject the missing services as regular task graph nodes —
        // they'll render as rows in the run TUI with live boot logs,
        // execute strictly sequentially (artificial deps chain them),
        // and exit 0 the moment readiness passes. The synthesized env
        // map below mirrors apply-service-registry's prune-time logic
        // without actually pruning the graph.
        const visBin = process.argv[1] ?? "vis";
        const injection = injectServiceTasks({
            missingServiceIds: missingIds,
            mode,
            taskGraph: ctx.taskGraph,
            visBin,
            workspaceRoot,
        });

        if (injection.skipped.length > 0) {
            for (const { id, reason } of injection.skipped) {
                logger.error(`Cannot auto-start ${id}: ${reason}`);
            }

            throw new VisUserError(`${injection.skipped.length} service(s) cannot be auto-started — invoke them directly or add a service config.`);
        }

        ctx.ephemeralPidFiles.push(...injection.ephemeralPidFiles);
        ctx.serviceRunDir = injection.runDir;
        ctx.injectedServiceIds = injection.chain;

        for (const id of injection.chain) {
            ctx.injectedServiceIdSet.add(id);
        }

        if (mode === "registry") {
            ctx.registryStartedCount = injection.chain.length;
            ctx.registryStartedIds.push(...injection.chain);
        }

        // Stand up the dock + bridge for both modes. Ephemeral surfaces
        // boot events through the bootstrap's stdout marker channel and
        // running-phase log via fs.watch. Registry surfaces them through
        // the wrapper task's `started`/`close` lifecycle events emitted
        // by the executor — see the bridge wiring in `onEvent`.
        if (injection.chain.length > 0) {
            const dock = new ServiceDockStore(injection.chain);
            const bridgeEntries = new Map<string, ServiceBridgeEntry>();

            if (mode === "ephemeral" && injection.runDir) {
                for (const id of injection.chain) {
                    const paths = buildBootstrapPaths(injection.runDir, `${injection.runDir}/bootstrap.mjs`, id);

                    bridgeEntries.set(id, {
                        ephemeral: {
                            configFile: paths.configFile,
                            cwd: workspaceRoot,
                            logFile: paths.logFile,
                            pidFile: paths.pidFile,
                            scriptPath: paths.scriptPath,
                        },
                        mode: "ephemeral",
                    });
                }
            } else if (mode === "registry" && preInjectionExtracted) {
                for (const svc of preInjectionExtracted.services) {
                    bridgeEntries.set(svc.id, {
                        mode: "registry",
                        registry: {
                            command: svc.command,
                            config: svc.config,
                            cwd: svc.cwd,
                            env: svc.env,
                        },
                    });
                }
            }

            if (bridgeEntries.size > 0) {
                const bridge = new ServiceEventBridge({
                    indexToId: new Map(),
                    services: bridgeEntries,
                    sink: {
                        crashed: (id, tail) => {
                            dock.markCrashed(id, tail);
                        },
                        failed: (id, reason, detail) => {
                            dock.markFailed(id, reason, detail);
                        },
                        log: (id, chunk) => {
                            dock.appendLog(id, chunk);
                        },
                        ready: (id, info) => {
                            dock.markReady(id, info);
                        },
                        started: (id, pid) => {
                            dock.markStarted(id, pid);

                            // Capture registry-mode pids for the optional
                            // --stop-services cleanup. Ephemeral pids are
                            // already tracked via `ephemeralPidFiles`, so
                            // skip those to keep the two cleanup paths
                            // from doubly-killing the same pid.
                            if (mode === "registry" && pid !== null) {
                                ctx.registryStartedPids.set(id, pid);
                            }
                        },
                        starting: (id) => {
                            dock.markStarting(id);
                        },
                    },
                    workspaceRoot,
                });

                ctx.serviceDockStore = dock;
                ctx.serviceEventBridge = bridge;
            }
        }

        // Merge synthesized env on top of the 1st pass's env map.
        // 1st-pass entries cover already-running registered services;
        // injection covers services we're about to boot.
        for (const [taskId, env] of injection.serviceEnvByTaskId) {
            const existing = serviceResult.serviceEnvByTaskId.get(taskId) ?? {};

            serviceResult.serviceEnvByTaskId.set(taskId, { ...existing, ...env });
        }
    }
};

/**
 * Phase 6c: strip persistent tasks back out of the regular graph, put the
 * injected service boot tasks in front, and mark already-running services
 * ready in the dock.
 */
export const finalizeServiceGraph = (ctx: RunContext, serviceResult: ServiceRegistryResult): void => {
    const { logger } = ctx;

    // applyServiceRegistry was called with `[...initialTasks, ...persistentTasks]`
    // so its "is this user-asked-for?" check covers persistent targets like
    // `vis run dev`. Its returned `initialTasks` therefore *also* contains
    // the persistent ones (minus any satisfied services). Strip them back
    // out — `runPersistentTasks` runs them; the regular runner must not.
    // Without this filter, `web:serve` is fed to *both* pipelines and the
    // TUI renders the row twice.
    const persistentIdSet = new Set(ctx.persistentTasks.map((task) => task.id));

    ctx.initialTasks = serviceResult.initialTasks.filter((task) => !persistentIdSet.has(task.id));
    ctx.taskGraph = serviceResult.taskGraph;

    if (ctx.injectedServiceIds.length > 0) {
        const serviceTasks = ctx.injectedServiceIds.map((id) => ctx.taskGraph.tasks[id]).filter((t): t is Task => t !== undefined);

        ctx.initialTasks = [...serviceTasks, ...ctx.initialTasks];
    }

    // Persistent tasks were folded into the graph above so their service
    // deps could be walked. Strip them now so the regular task runner
    // doesn't try to execute them — they have their own runner pipeline
    // via `runPersistentTasks`. Their dep edges are removed too; the
    // service tasks they pointed at become roots and run on their own.
    if (ctx.persistentTasks.length > 0) {
        const persistentIds = new Set(ctx.persistentTasks.map((task) => task.id));

        const filteredTasks: Record<string, Task> = {};

        for (const [id, task] of Object.entries(ctx.taskGraph.tasks)) {
            if (!persistentIds.has(id)) {
                filteredTasks[id] = task;
            }
        }

        const filteredDependencies: Record<string, string[]> = {};

        for (const [id, deps] of Object.entries(ctx.taskGraph.dependencies)) {
            if (persistentIds.has(id)) {
                continue;
            }

            filteredDependencies[id] = deps.filter((depId) => !persistentIds.has(depId));
        }

        // Recompute roots from the trimmed graph: anything no remaining
        // task depends on. Service tasks orphaned by removing their
        // dependent persistent task become roots here.
        const dependedOn = new Set<string>();

        for (const deps of Object.values(filteredDependencies)) {
            for (const depId of deps) {
                dependedOn.add(depId);
            }
        }

        const filteredRoots = Object.keys(filteredTasks).filter((id) => !dependedOn.has(id));

        ctx.taskGraph = {
            dependencies: filteredDependencies,
            roots: filteredRoots,
            tasks: filteredTasks,
        };
    }

    if (serviceResult.satisfiedServices.length > 0) {
        const names = serviceResult.satisfiedServices.map((s) => s.id).join(", ");

        logger.debug?.(`Auto-attached to running services: ${names}`);

        // Surface attached services in the dock so a second `vis run dev`
        // (where the registry already holds api:db, api:redis, …) still
        // shows the green pill. Without this, the dock is empty on rerun
        // and the user can't tell whether their deps are wired.
        if (ctx.serviceDockStore) {
            for (const entry of serviceResult.satisfiedServices) {
                ctx.serviceDockStore.registerService(entry.id);
            }
        } else {
            ctx.serviceDockStore = new ServiceDockStore(serviceResult.satisfiedServices.map((s) => s.id));
        }

        for (const entry of serviceResult.satisfiedServices) {
            const readinessPort = entry.config.readiness?.tcp?.port ?? entry.config.port ?? 0;
            const readinessHost = entry.config.readiness?.tcp?.host ?? "127.0.0.1";

            ctx.serviceDockStore.markReady(entry.id, { host: readinessHost, port: readinessPort });
        }
    }
};
