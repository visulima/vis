import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import type { ChildEnvOptions, LogMode, OutputSpec, ProcessEvent, TargetConfiguration, Task, TaskResults, TaskRunnerOptions, TaskTarget } from "@visulima/task-runner";
import { CompositeLifeCycle, createLogReporter, createTaskGraph, defaultTaskRunner, enforceProjectConstraints, expandTokensInString, generateRunSummary, parsePartition, pickChildParentEnv, reverseTaskGraph, runConcurrently, splitCompoundTasks, TaskScheduler, TerminalBuffer, writeChromeTrace, writeRunSummary } from "@visulima/task-runner";
import isInCi from "is-in-ci";

import { applyBranchScope, resolveSharedCacheDirectory } from "../../cache/cache-directory";
import { buildProjectGraph, discoverWorkspace, loadVisTaskConfigsForWorkspace } from "../../config/workspace";
import { VisUserError } from "../../errors/vis-user-error";
import { FailureLogLifeCycle } from "../../report/failure-log";
import { compareDuration, formatTimingSummary, loadRunSummaries } from "../../report/run-report";
import { resolveCommandRuntime } from "../../runtime/command-runtime";
import { runReadiness } from "../../services/readiness";
import { readAllEntries } from "../../services/registry";
import type { ServiceEntry } from "../../services/types";
import { selectAffectedProjects } from "../../task/affected-selection";
import { describeMisplacedTargetKeys, findMisplacedTargetKeys } from "../../task/misplaced-options";
import { filterProjectsByNames } from "../../task/project-name-filter";
import { filterProjectsByQuery, filterProjectsByTags, resolveSelector } from "../../task/selectors";
import { resolveSkipCachePatterns } from "../../task/skip-cache";
import { checkStrictEnv, formatStrictEnvError } from "../../task/strict-env";
import { buildAliasMap, collectAvailableTargets, formatTargetList, promptTargetInteractively, resolveTargetAlias, suggestTargets } from "../../task/target-discovery";
import type { VisTargetConfiguration, VisTargetOptions } from "../../task/target-options";
import { detectCurrentOs, matchesRunnerTags, resolveTargetShell, shouldRunInCI } from "../../task/target-options";
import { ServiceDockStore } from "../../tui/components/service-dock/service-dock-store";
import { createDynamicOutputRenderer } from "../../tui/dynamic-life-cycle";
import { resolveOutputStyle, StaticOutputLifeCycle } from "../../tui/static-life-cycle";
import type { StdinEntry } from "../../tui/types";
import { createVisHooks, HookableLifeCycle, registerPlugins } from "../../util/hooks";
import { appendToShellHistory } from "../../util/shell-history";
import { cleanupLegacyTaskRunnerLayout, getVisWorkspaceDataDir } from "../../util/vis-paths";
import { collectTrackedWatchTargets, createTrackedFileFilter, startWatcher } from "../../watch/watch";
import { applyProjectFilter } from "../../watch/watch-filter";
import type { KeybindHandle } from "../../watch/watch-keybinds";
import { installKeybinds, writeHelp } from "../../watch/watch-keybinds";
import { applyServiceRegistry } from "./apply-service-registry";
import type { MutexPool } from "./executor";
import { createConcurrentExecutor, createRetryBudget } from "./executor";
import { applyFilterStrings } from "./filter";
import type { RunOptions } from "./index";
import { MAX_OUTPUT_BYTES } from "./output";
import { parseEnvConcurrency, parseHashMode, renderLastRunSummary } from "./parse";
import { runPersistentTasks, SERVICE_PROBE_TIMEOUT_MS } from "./persistent-tasks";
import { createRunCleanup } from "./run-cleanup";
import { printDryRunPlan } from "./run-dry-run";
import { runStartupPreflights } from "./run-preflight";
import { applyRemoteCacheConfig } from "./run-remote-cache";
import { logRegistryServiceHint, reportRunOutcome } from "./run-summary";
import type { ServiceBridgeEntry } from "./service-event-bridge";
import { ServiceEventBridge } from "./service-event-bridge";
import { buildBootstrapPaths, describeServicesPolicySource, extractPreflightTasks, injectServiceTasks, resolveServicesPolicy } from "./service-preflight";
import { FORWARDED_ARGS_KEY, resolveTaskCommand } from "./shell";
import { resolveTaskArguments } from "./task-arguments";
import { AFFECTED_FILES_ENV, createTaskSpawnContext, effectiveChildEnvPolicy, getTaskOptions, resolveRetrySpawn, resolveTaskSpawn, TASK_ARG_ENV_KEY } from "./task-env";

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

    let rawSelector = argument[0];

    if (!rawSelector) {
        const available = collectAvailableTargets(workspace);

        if (process.stdout.isTTY && process.stdin.isTTY) {
            const picked = await promptTargetInteractively(available);

            if (!picked) {
                logger.info("No target selected.");

                return;
            }

            rawSelector = picked;

            // The user ran `vis run` (no target) — without this, the
            // resolved pick never appears in shell history, so
            // up-arrow replays the picker, not the task. Best-effort,
            // skipped on Windows / unrecognized shell.
            await appendToShellHistory(`vis run ${picked}`);
        } else {
            // Non-interactive and no target: there is nothing to pick and
            // nothing to run. Returning 0 here made the missing target a
            // *passing* CI job that printed a target list where its task
            // output should have been.
            logger.info("Available targets:");
            logger.info("");
            logger.info(formatTargetList(available));
            logger.info("");

            throw new VisUserError("Missing target. Usage: vis run <target>");
        }
    }

    if (config.constraints && !options.skipConstraints) {
        const violations = enforceProjectConstraints(projectGraph, config.constraints);

        if (violations.length > 0) {
            for (const v of violations) {
                logger.error(`[${v.rule}] ${v.message}`);
            }

            throw new Error(`${violations.length} project constraint violation(s) found. Use --skip-constraints to bypass.`);
        }
    }

    // The `--affected` modifiers are meaningless on their own. Reject them
    // rather than accepting a flag that changes nothing — silently ignoring
    // `--base` here is how a CI job ends up "passing" without running.
    if (!options.affected) {
        // `--no-uncommitted` arrives here as `uncommitted: false`, so report
        // the flag the user actually typed rather than its positive twin.
        const uncommittedFlag = options.uncommitted ? "--uncommitted" : "--no-uncommitted";
        const affectedOnlyFlags = (
            [
                ["--base", options.base],
                ["--head", options.head],
                ["--downstream", options.downstream],
                ["--upstream", options.upstream],
                [uncommittedFlag, options.uncommitted],
            ] as [string, string | boolean | undefined][]
        )
            .filter(([, value]) => value !== undefined)
            .map(([flag]) => flag);

        if (affectedOnlyFlags.length > 0) {
            throw new VisUserError(
                `${affectedOnlyFlags.join(", ")} ${affectedOnlyFlags.length === 1 ? "requires" : "require"} --affected.\n`
                + `Did you mean: vis run ${rawSelector} --affected ${affectedOnlyFlags.map((flag) => (flag.includes("uncommitted") ? flag : `${flag}=…`)).join(" ")}`
                + `\nOr use the dedicated command: vis affected ${rawSelector} …`,
            );
        }
    }

    const selectorResult = await resolveSelector(rawSelector, workspace, process.cwd(), workspaceRoot);
    // Resolve target aliases declared on any VisTargetConfiguration
    // before any further filtering so `vis run t` picks up `test`.
    const aliasMap = buildAliasMap(projectOptions);
    const target = resolveTargetAlias(selectorResult.target, aliasMap);

    if (target !== selectorResult.target) {
        logger.debug?.(`Resolved alias "${selectorResult.target}" → "${target}"`);
    }

    let projectNames = selectorResult.projects;

    // Any positional args past the target name are forwarded only to the
    // invoked task — not to `dependsOn` deps. The task-runner string-form
    // resolver strips overrides so deps start with a clean slate.
    const forwardedArgs: string[] = argument.slice(1).map(String);

    // `!== undefined`, not truthiness: `--projects=` must reach the filter
    // and error rather than silently running the whole workspace.
    if (options.projects !== undefined) {
        projectNames = filterProjectsByNames(projectNames, String(options.projects), Object.keys(workspace.projects));
    }

    // A selection that matches nothing must not look like a pass: throw so the CLI exits
    // non-zero. `--if-present` opts back into a quiet exit 0 with a one-line notice.
    const onEmptySelection = (summary: string): void => {
        if (options.ifPresent) {
            logger.info(`${summary}; skipping (--if-present).`);

            return;
        }

        throw new VisUserError(`${summary}.\n\nPass --if-present to skip quietly when nothing matches.`);
    };

    // Apply pnpm-style `--filter`/`-F` selectors. They compose with the
    // selector + `--projects` set above (intersection) so a filter never
    // pulls in projects the selector already excluded. Multiple `--filter`
    // flags are unioned, matching pnpm.
    if (options.filter && options.filter.length > 0) {
        const packageNameByProject = new Map<string, string | undefined>();

        for (const [name, pkg] of packageJsons) {
            packageNameByProject.set(name, pkg.name);
        }

        const filtered = await applyFilterStrings(options.filter, {
            defaultBase: visConfig?.defaultBase,
            packageNameByProject,
            projectGraph,
            workspaceRoot,
        });

        const filteredSet = new Set(filtered);

        projectNames = projectNames.filter((name) => filteredSet.has(name));

        if (projectNames.length === 0) {
            onEmptySelection(`Filter ${options.filter.map((f: string) => `"${f}"`).join(", ")} matched no projects`);

            return;
        }
    }

    // Apply --query filter (language=X && tag=Y style).
    if (options.query) {
        projectNames = filterProjectsByQuery(projectNames, workspace, options.query);

        if (projectNames.length === 0) {
            onEmptySelection(`Query "${String(options.query)}" matched no projects`);

            return;
        }
    }

    // `--tag` shorthand, applied as its own pass so it composes with
    // `--query` regardless of which operator that query uses.
    if (options.tag && options.tag.length > 0) {
        projectNames = filterProjectsByTags(projectNames, workspace, options.tag);

        if (projectNames.length === 0) {
            onEmptySelection(`Tag filter ${options.tag.map((t: string) => `"${t}"`).join(", ")} matched no projects`);

            return;
        }
    }

    // `--affected` narrows the selection in-process rather than re-invoking
    // `vis affected`. The old delegation round-trip could only forward the
    // handful of flags it enumerated, so --dry-run, --fail-fast, --partition
    // and friends were silently dropped on the way out. Computing here keeps
    // every option on this run intact.
    let affectedChangedFiles: string[] | undefined;

    if (options.affected) {
        const affected = await selectAffectedProjects(
            {
                base: options.base,
                downstream: options.downstream,
                head: options.head,
                uncommitted: options.uncommitted,
                upstream: options.upstream,
            },
            { fileOwners, projectGraph, projects: workspace.projects, workspaceRoot },
            { affectedIgnore: visConfig?.affectedIgnore, defaultBase: visConfig?.defaultBase },
        );

        for (const note of affected.notes) {
            logger.info(`▸ ${note}`);
        }

        if (affected.changedFiles.length === 0) {
            logger.info("No files changed. Nothing to run.");

            return;
        }

        const affectedSet = new Set(affected.affectedProjects);

        projectNames = projectNames.filter((name) => affectedSet.has(name));

        if (projectNames.length === 0) {
            logger.info("No projects affected by the changes.");

            return;
        }

        // Paths skipped by `affectedIgnore` changed nothing, so tasks don't receive them either.
        const ignoredFiles = new Set(affected.ignoredFiles);

        affectedChangedFiles = affected.changedFiles.filter((file) => !ignoredFiles.has(file));

        logger.info(`Affected projects: ${projectNames.join(", ")}`);
    }

    const currentOs = detectCurrentOs();

    // `vis affected` delegates to `vis run --projects=…` and passes the
    // changed-file set through the environment; an in-process `--affected`
    // run already has it in hand.
    const affectedFilesRaw = process.env[AFFECTED_FILES_ENV];
    const affectedFiles = affectedChangedFiles ?? (affectedFilesRaw ? affectedFilesRaw.split("\n").filter(Boolean) : undefined);

    // Runner-tag filter: CLI flag wins over env so a script can override
    // a CI-injected default. Empty string after splitting is dropped so
    // `--runner-tags=` (no value) doesn't accidentally enable a filter
    // with one empty tag. `undefined` keeps the filter inactive.
    const runnerTagsRaw = (typeof options.runnerTags === "string" ? options.runnerTags : process.env["VIS_RUNNER_TAGS"]) ?? undefined;
    const runnerTags = runnerTagsRaw
        ? new Set(
            runnerTagsRaw
                .split(",")
                .map((tag: string) => tag.trim())
                .filter(Boolean),
        )
        : undefined;

    const projectsWithTarget: string[] = [];
    const projectTargetIndex = new Map<string, VisTargetConfiguration>();

    for (const name of projectNames) {
        const visTargets = projectOptions.get(name);
        const visTarget = visTargets?.[target];

        if (!visTarget) {
            continue;
        }

        const visOptions = visTarget.options;

        if (visOptions?.internal) {
            continue;
        }

        if (!shouldRunInCI(visOptions, Boolean(isInCi))) {
            logger.debug?.(`Skipping ${name}:${target} — runInCI filter`);
            continue;
        }

        if (!matchesRunnerTags(visOptions, runnerTags)) {
            logger.debug?.(`Skipping ${name}:${target} — runner-tags filter`);
            continue;
        }

        // when:/os gates are evaluated by the task-runner orchestrator
        // just before launch — see TargetConfiguration.when. Letting them
        // through to the graph means skipped tasks show up with a reason
        // in the run summary instead of being silently filtered here.

        projectsWithTarget.push(name);
        projectTargetIndex.set(name, visTarget);
    }

    if (projectsWithTarget.length === 0) {
        if (options.ifPresent) {
            logger.info(`No projects have the "${target}" target; skipping (--if-present).`);

            return;
        }

        const available = collectAvailableTargets(workspace);
        const exactMatchProjects = Object.entries(workspace.projects)
            .filter(([, proj]) => proj.targets?.[target] !== undefined)
            .map(([name]) => name);

        // A run that executed nothing must not look like a pass: throw so the CLI exits non-zero.
        // `--if-present` (handled above) is the explicit opt-out.
        const lines = [`No projects have the "${target}" target.`];

        if (exactMatchProjects.length > 0) {
            // The target exists somewhere in the workspace — it was
            // just filtered out by selector/query/os/runInCI/runner-tags.
            // Tell the user which projects do implement it.
            lines.push("", `Target "${target}" exists in these projects but was filtered out:`, ...exactMatchProjects.slice(0, 5).map((name) => `  - ${name}`));

            if (exactMatchProjects.length > 5) {
                lines.push(`  …and ${exactMatchProjects.length - 5} more`);
            }
        } else {
            const suggestions = suggestTargets(target, available, 3);

            if (suggestions.length > 0) {
                lines.push(
                    "",
                    suggestions.length === 1 ? `Did you mean "${suggestions[0]}"?` : `Did you mean one of: ${suggestions.map((s) => `"${s}"`).join(", ")}?`,
                );
            }

            lines.push("", "Run `vis run` without arguments to see all available targets, or pass --if-present to skip when no project has the target.");
        }

        throw new VisUserError(lines.join("\n"));
    }

    const ptyFlag = options.pty;

    // First-class task arguments: validate the forwarded args against the
    // invoked target's declared schema, surface per-task `--help`, and expose
    // validated values to the command as VIS_ARG_* env vars. See
    // `./task-arguments`. Because the same args + VIS_ARG_* reach every
    // selected project, all of them must agree on the contract — fail fast if
    // two projects expose this target with different `arguments` schemas
    // rather than validate one project's invocation against another's.
    const schemasByProject = projectsWithTarget
        .map((projectName) => {
            return { project: projectName, schema: projectTargetIndex.get(projectName)?.arguments };
        })
        .filter(
            (entry): entry is { project: string; schema: NonNullable<VisTargetConfiguration["arguments"]> } =>
                Array.isArray(entry.schema) && entry.schema.length > 0,
        );

    const distinctSchemas = new Map<string, string[]>();

    for (const { project, schema } of schemasByProject) {
        const key = JSON.stringify(schema);
        const projects = distinctSchemas.get(key) ?? [];

        projects.push(project);
        distinctSchemas.set(key, projects);
    }

    if (distinctSchemas.size > 1) {
        const groups = [...distinctSchemas.values()].map((projects) => projects.join(", ")).join(" | ");

        throw new Error(
            `Target "${target}" declares conflicting \`arguments\` schemas across projects (${groups}). `
            + `Run a single project (e.g. \`vis run ${schemasByProject[0]?.project}:${target}\` or --projects=<name>) so the argument contract is unambiguous.`,
        );
    }

    const argumentSchema = schemasByProject[0]?.schema;
    const argumentDescription = projectTargetIndex.get(schemasByProject[0]?.project ?? (projectsWithTarget[0] as string))?.description;
    const argumentResolution = resolveTaskArguments(target, argumentDescription, argumentSchema, forwardedArgs);

    if (argumentResolution.kind === "help") {
        logger.info(argumentResolution.text);

        return;
    }

    if (argumentResolution.kind === "invalid") {
        logger.info(`Invalid arguments for "${target}":`);

        for (const message of argumentResolution.errors) {
            logger.info(`  ✖ ${message}`);
        }

        logger.info("");
        logger.info(argumentResolution.help);

        throw new Error(`Invalid arguments for target "${target}"`);
    }

    const taskArgumentEnvVars = argumentResolution.env;

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

            return;
        }
    }

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
    let taskGraph = createTaskGraph([...initialTasks, ...persistentTasks], {
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
    // global --no-cache (which drops the runner's `skipNxCache` switch
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

    await runStartupPreflights({ config, logger, options, packageJsons, workspaceRoot });

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
    const serviceResult = await applyServiceRegistry({
        initialTasks: [...initialTasks, ...persistentTasks],
        probe,
        registeredEntries,
        taskGraph,
        visVersion,
    });

    /**
     * Ephemeral pid files written by the bootstrap wrapper at service
     * boot. Read at run end + SIGTERM the recorded pids so a failed run
     * never leaves orphan children. Registry-mode services are NOT
     * tracked here — they persist by design.
     */
    const ephemeralPidFiles: string[] = [];
    /** Per-run scratch directory holding the bootstrap script + pid/config files. Removed at run end. */
    let serviceRunDir: string | undefined;
    /** Registry-mode services started this run; surfaced in a one-line cleanup hint after the run completes. */
    let registryStartedCount = 0;
    /** Ids of registry-mode services this run started — used by `--stop-services` to clean only its own. */
    const registryStartedIds: string[] = [];
    /** id → pid for registry-mode services this run started, captured in the bridge `started` sink. Used by the sync signal-path cleanup. */
    const registryStartedPids = new Map<string, number>();

    /**
     * Service ids injected as regular dep nodes for this run. The dynamic
     * TUI's `TaskStore` only renders rows for tasks it knows about at
     * construction time — top-level `initialTasks` alone would hide the
     * service rows. We prepend these task objects to `initialTasks` after
     * the 2nd-pass `applyServiceRegistry` so the renderer makes rows for
     * them and live boot logs land somewhere visible.
     */
    let injectedServiceIds: string[] = [];
    /** Set form of `injectedServiceIds` used by the executor's onOutput hook to route per-task chunks. */
    const injectedServiceIdSet = new Set<string>();
    /** Service dock store + event bridge (ephemeral mode only in v1). Constructed alongside successful injection. */
    let serviceDockStore: ServiceDockStore | null = null;
    let serviceEventBridge: ServiceEventBridge | null = null;

    if (serviceResult.diagnostics.length > 0) {
        const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
        const decision = options.dryRun
            ? "off"
            : resolveServicesPolicy({
                cli: options.services,
                config: config.run?.services,
                isCi: Boolean(isInCi),
                isPersistentTarget: persistentTasks.length > 0,
                isTty,
                target,
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
        const preInjectionExtracted = mode === "registry" ? extractPreflightTasks(workspaceRoot, missingIds, taskGraph) : undefined;

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
            taskGraph,
            visBin,
            workspaceRoot,
        });

        if (injection.skipped.length > 0) {
            for (const { id, reason } of injection.skipped) {
                logger.error(`Cannot auto-start ${id}: ${reason}`);
            }

            throw new VisUserError(`${injection.skipped.length} service(s) cannot be auto-started — invoke them directly or add a service config.`);
        }

        ephemeralPidFiles.push(...injection.ephemeralPidFiles);
        serviceRunDir = injection.runDir;
        injectedServiceIds = injection.chain;

        for (const id of injection.chain) {
            injectedServiceIdSet.add(id);
        }

        if (mode === "registry") {
            registryStartedCount = injection.chain.length;
            registryStartedIds.push(...injection.chain);
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
                                registryStartedPids.set(id, pid);
                            }
                        },
                        starting: (id) => {
                            dock.markStarting(id);
                        },
                    },
                    workspaceRoot,
                });

                serviceDockStore = dock;
                serviceEventBridge = bridge;
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

    // applyServiceRegistry was called with `[...initialTasks, ...persistentTasks]`
    // so its "is this user-asked-for?" check covers persistent targets like
    // `vis run dev`. Its returned `initialTasks` therefore *also* contains
    // the persistent ones (minus any satisfied services). Strip them back
    // out — `runPersistentTasks` runs them; the regular runner must not.
    // Without this filter, `web:serve` is fed to *both* pipelines and the
    // TUI renders the row twice.
    const persistentIdSet = new Set(persistentTasks.map((task) => task.id));

    initialTasks = serviceResult.initialTasks.filter((task) => !persistentIdSet.has(task.id));
    taskGraph = serviceResult.taskGraph;

    if (injectedServiceIds.length > 0) {
        const serviceTasks = injectedServiceIds.map((id) => taskGraph.tasks[id]).filter((t): t is Task => t !== undefined);

        initialTasks = [...serviceTasks, ...initialTasks];
    }

    // Persistent tasks were folded into the graph above so their service
    // deps could be walked. Strip them now so the regular task runner
    // doesn't try to execute them — they have their own runner pipeline
    // via `runPersistentTasks`. Their dep edges are removed too; the
    // service tasks they pointed at become roots and run on their own.
    if (persistentTasks.length > 0) {
        const persistentIds = new Set(persistentTasks.map((task) => task.id));

        const filteredTasks: Record<string, Task> = {};

        for (const [id, task] of Object.entries(taskGraph.tasks)) {
            if (!persistentIds.has(id)) {
                filteredTasks[id] = task;
            }
        }

        const filteredDependencies: Record<string, string[]> = {};

        for (const [id, deps] of Object.entries(taskGraph.dependencies)) {
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

        taskGraph = {
            dependencies: filteredDependencies,
            roots: filteredRoots,
            tasks: filteredTasks,
        };
    }

    // Service env precedence: the executor merges these on top of
    // process.env when running each dependent task. See
    // apply-service-registry.ts → ApplyServiceRegistryResult.serviceEnvByTaskId
    // for the keying contract (per *dependent*, not per service).
    const { serviceEnvByTaskId } = serviceResult;

    if (serviceResult.satisfiedServices.length > 0) {
        const names = serviceResult.satisfiedServices.map((s) => s.id).join(", ");

        logger.debug?.(`Auto-attached to running services: ${names}`);

        // Surface attached services in the dock so a second `vis run dev`
        // (where the registry already holds api:db, api:redis, …) still
        // shows the green pill. Without this, the dock is empty on rerun
        // and the user can't tell whether their deps are wired.
        if (serviceDockStore) {
            for (const entry of serviceResult.satisfiedServices) {
                serviceDockStore.registerService(entry.id);
            }
        } else {
            serviceDockStore = new ServiceDockStore(serviceResult.satisfiedServices.map((s) => s.id));
        }

        for (const entry of serviceResult.satisfiedServices) {
            const readinessPort = entry.config.readiness?.tcp?.port ?? entry.config.port ?? 0;
            const readinessHost = entry.config.readiness?.tcp?.host ?? "127.0.0.1";

            serviceDockStore.markReady(entry.id, { host: readinessHost, port: readinessPort });
        }
    }

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
