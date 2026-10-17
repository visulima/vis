import type { OutputSpec, Task, TaskTarget } from "@visulima/task-runner";
import { enforceProjectConstraints, expandTokensInString, parsePartition, TaskScheduler } from "@visulima/task-runner";
import isInCi from "is-in-ci";

import { buildProjectGraph, discoverWorkspace, loadVisTaskConfigsForWorkspace } from "../../../config/workspace";
import { VisUserError } from "../../../errors/vis-user-error";
import { resolveCommandRuntime } from "../../../runtime/command-runtime";
import { selectAffectedProjects } from "../../../task/affected-selection";
import { describeMisplacedTargetKeys, findMisplacedTargetKeys } from "../../../task/misplaced-options";
import { filterProjectsByNames } from "../../../task/project-name-filter";
import { filterProjectsByQuery, filterProjectsByTags, resolveSelector } from "../../../task/selectors";
import { buildAliasMap, collectAvailableTargets, formatTargetList, promptTargetInteractively, resolveTargetAlias, suggestTargets } from "../../../task/target-discovery";
import type { VisTargetConfiguration, VisTargetOptions } from "../../../task/target-options";
import { matchesRunnerTags, shouldRunInCI } from "../../../task/target-options";
import { appendToShellHistory } from "../../../util/shell-history";
import { cleanupLegacyTaskRunnerLayout } from "../../../util/vis-paths";
import { applyFilterStrings } from "../filter";
import { resolveTaskArguments } from "../task-arguments";
import { AFFECTED_FILES_ENV, getTaskOptions, TASK_ARG_ENV_KEY } from "../task-env";
import type { RunContext, RunToolbox } from "./run-context";
import { createRunContext } from "./run-context";
import { parseHashMode, renderLastRunSummary } from "./run-parse";
import { FORWARDED_ARGS_KEY } from "./run-shell";

/**
 * Phase 0: resolve the runtime, sweep legacy state, handle `--last-details`,
 * and load the workspace. Returns `undefined` when the run must stop here.
 */
export const loadRunWorkspace = async (inputs: {
    argument: RunToolbox["argument"];
    logger: RunToolbox["logger"];
    options: RunContext["options"];
    visConfig: RunToolbox["visConfig"];
    workspaceRoot: string;
}): Promise<RunContext | undefined> => {
    const { argument, logger, options, visConfig, workspaceRoot } = inputs;

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

        return undefined;
    }

    // The directory the user invoked `vis` from, captured before any
    // workspace resolution. Propagated as INIT_CWD to every task —
    // matches pnpm/npm/yarn semantics so scripts can resolve paths
    // relative to where the user actually ran the command.
    const invocationCwd = process.cwd();
    const taskConfigs = await loadVisTaskConfigsForWorkspace(workspaceRoot, visConfig);
    const { config, fileOwners, packageJsons, projectOptions, workspace } = discoverWorkspace(workspaceRoot, visConfig, taskConfigs);
    const projectGraph = buildProjectGraph(workspaceRoot, workspace, packageJsons);

    return createRunContext({
        argument,
        config,
        fileOwners,
        invocationCwd,
        logger,
        options,
        packageJsons,
        projectGraph,
        projectOptions,
        visConfig,
        workspace,
        workspaceRoot,
    });
};

/**
 * Phase 1: pick the target selector and narrow the project set by selector,
 * `--projects`, `--filter`, `--query`, `--tag` and `--affected`. Returns `true`
 * when the run must stop here (nothing to run, or a diagnostic was printed).
 */
export const selectRunProjects = async (ctx: RunContext): Promise<boolean> => {
    const { config, logger, options, projectGraph, projectOptions, visConfig, workspace, workspaceRoot } = ctx;
    let rawSelector = ctx.argument[0];

    if (!rawSelector) {
        const available = collectAvailableTargets(workspace);

        if (process.stdout.isTTY && process.stdin.isTTY) {
            const picked = await promptTargetInteractively(available);

            if (!picked) {
                logger.info("No target selected.");

                return true;
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

    ctx.target = resolveTargetAlias(selectorResult.target, aliasMap);

    if (ctx.target !== selectorResult.target) {
        logger.debug?.(`Resolved alias "${selectorResult.target}" → "${ctx.target}"`);
    }

    ctx.projectNames = selectorResult.projects;

    // Any positional args past the target name are forwarded only to the
    // invoked task — not to `dependsOn` deps. The task-runner string-form
    // resolver strips overrides so deps start with a clean slate.
    ctx.forwardedArgs = ctx.argument.slice(1).map(String);

    // `!== undefined`, not truthiness: `--projects=` must reach the filter
    // and error rather than silently running the whole workspace.
    if (options.projects !== undefined) {
        ctx.projectNames = filterProjectsByNames(ctx.projectNames, String(options.projects), Object.keys(workspace.projects));
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

        for (const [name, pkg] of ctx.packageJsons) {
            packageNameByProject.set(name, pkg.name);
        }

        const filtered = await applyFilterStrings(options.filter, {
            defaultBase: visConfig?.defaultBase,
            packageNameByProject,
            projectGraph,
            workspaceRoot,
        });

        const filteredSet = new Set(filtered);

        ctx.projectNames = ctx.projectNames.filter((name) => filteredSet.has(name));

        if (ctx.projectNames.length === 0) {
            onEmptySelection(`Filter ${options.filter.map((f: string) => `"${f}"`).join(", ")} matched no projects`);

            return true;
        }
    }

    // Apply --query filter (language=X && tag=Y style).
    if (options.query) {
        ctx.projectNames = filterProjectsByQuery(ctx.projectNames, workspace, options.query);

        if (ctx.projectNames.length === 0) {
            onEmptySelection(`Query "${String(options.query)}" matched no projects`);

            return true;
        }
    }

    // `--tag` shorthand, applied as its own pass so it composes with
    // `--query` regardless of which operator that query uses.
    if (options.tag && options.tag.length > 0) {
        ctx.projectNames = filterProjectsByTags(ctx.projectNames, workspace, options.tag);

        if (ctx.projectNames.length === 0) {
            onEmptySelection(`Tag filter ${options.tag.map((t: string) => `"${t}"`).join(", ")} matched no projects`);

            return true;
        }
    }

    // `--affected` narrows the selection in-process rather than re-invoking
    // `vis affected`. The old delegation round-trip could only forward the
    // handful of flags it enumerated, so --dry-run, --fail-fast, --partition
    // and friends were silently dropped on the way out. Computing here keeps
    // every option on this run intact.
    if (options.affected) {
        const affected = await selectAffectedProjects(
            {
                base: options.base,
                downstream: options.downstream,
                head: options.head,
                uncommitted: options.uncommitted,
                upstream: options.upstream,
            },
            { fileOwners: ctx.fileOwners, projectGraph, projects: workspace.projects, workspaceRoot },
            { affectedIgnore: visConfig?.affectedIgnore, defaultBase: visConfig?.defaultBase },
        );

        for (const note of affected.notes) {
            logger.info(`▸ ${note}`);
        }

        if (affected.changedFiles.length === 0) {
            logger.info("No files changed. Nothing to run.");

            return true;
        }

        const affectedSet = new Set(affected.affectedProjects);

        ctx.projectNames = ctx.projectNames.filter((name) => affectedSet.has(name));

        if (ctx.projectNames.length === 0) {
            logger.info("No projects affected by the changes.");

            return true;
        }

        // Paths skipped by `affectedIgnore` changed nothing, so tasks don't receive them either.
        const ignoredFiles = new Set(affected.ignoredFiles);

        ctx.affectedChangedFiles = affected.changedFiles.filter((file) => !ignoredFiles.has(file));

        logger.info(`Affected projects: ${ctx.projectNames.join(", ")}`);
    }

    return false;
};

/**
 * Phase 2: keep the projects that have the target and are allowed to run here
 * (internal, runInCI, runner tags). Returns `true` when the run must stop.
 */
export const selectProjectsWithTarget = (ctx: RunContext): boolean => {
    const { logger, options, projectOptions, target, workspace } = ctx;

    // `vis affected` delegates to `vis run --projects=…` and passes the
    // changed-file set through the environment; an in-process `--affected`
    // run already has it in hand.
    const affectedFilesRaw = process.env[AFFECTED_FILES_ENV];

    ctx.affectedFiles = ctx.affectedChangedFiles ?? (affectedFilesRaw ? affectedFilesRaw.split("\n").filter(Boolean) : undefined);

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

    for (const name of ctx.projectNames) {
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

        ctx.projectsWithTarget.push(name);
        ctx.projectTargetIndex.set(name, visTarget);
    }

    if (ctx.projectsWithTarget.length === 0) {
        if (options.ifPresent) {
            logger.info(`No projects have the "${target}" target; skipping (--if-present).`);

            return true;
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

    return false;
};

/**
 * Phase 3: validate the forwarded task arguments, build the initial task list,
 * and split persistent tasks from regular ones. Returns `true` when the run
 * must stop (`--help` for the task, or an empty partition).
 */
export const buildInitialTasks = (ctx: RunContext): boolean => {
    const { logger, options, projectsWithTarget, target, workspace } = ctx;
    const { projectTargetIndex } = ctx;
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
    const argumentResolution = resolveTaskArguments(target, argumentDescription, argumentSchema, ctx.forwardedArgs);

    if (argumentResolution.kind === "help") {
        logger.info(argumentResolution.text);

        return true;
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

    const initialTasks: Task[] = projectsWithTarget.map((projectName) => {
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
        const expandedCommand = visTarget.command ? expandTokensInString(visTarget.command, { affectedFiles: ctx.affectedFiles, projectRoot: project?.root }) : visTarget.command;

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
                ...(ctx.forwardedArgs.length > 0 ? { [FORWARDED_ARGS_KEY]: ctx.forwardedArgs } : {}),
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

    const regularTasks: Task[] = [];

    for (const task of initialTasks) {
        const opts = getTaskOptions(task);

        if (opts?.persistent) {
            task.cache = false;
            ctx.persistentTasks.push(task);
        } else {
            regularTasks.push(task);
        }
    }

    ctx.initialTasks = regularTasks;

    const partition = parsePartition(options.partition);

    if (partition) {
        ctx.initialTasks = TaskScheduler.partitionTasks(ctx.initialTasks, partition);

        logger.info(`Partition ${partition.index}/${partition.total}: running ${ctx.initialTasks.length} task(s)`);

        if (ctx.initialTasks.length === 0) {
            logger.info("No tasks assigned to this partition.");

            return true;
        }
    }

    return false;
};
