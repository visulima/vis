import type { Toolbox } from "@visulima/cerebro";
import { enforceProjectConstraints } from "@visulima/task-runner";

import { VisUserError } from "../../errors/vis-user-error";
import { selectAffectedProjects } from "../../task/affected-selection";
import { filterProjectsByNames } from "../../task/project-name-filter";
import { filterProjectsByQuery, filterProjectsByTags, resolveSelector } from "../../task/selectors";
import { buildAliasMap, collectAvailableTargets, formatTargetList, promptTargetInteractively, resolveTargetAlias } from "../../task/target-discovery";
import { appendToShellHistory } from "../../util/shell-history";
import { applyFilterStrings } from "./filter";
import type { RunOptions } from "./index";
import type { DiscoveredWorkspace, RunLogger, RunProjectGraph } from "./run-context";

/**
 * Resolves the target to run. Returns the selector string, or `undefined`
 * when the interactive picker was dismissed and nothing should run.
 * Throws a VisUserError when no target was given outside a TTY.
 */
export const pickRunTarget = async ({
    argument,
    logger,
    workspace,
}: {
    argument: string[];
    logger: RunLogger;
    workspace: DiscoveredWorkspace["workspace"];
}): Promise<string | undefined> => {
    let rawSelector = argument[0];

    if (!rawSelector) {
        const available = collectAvailableTargets(workspace);

        if (process.stdout.isTTY && process.stdin.isTTY) {
            const picked = await promptTargetInteractively(available);

            if (!picked) {
                logger.info("No target selected.");

                return undefined;
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

    return rawSelector;
};

/**
 * Enforces the workspace `constraints` rules unless `--skip-constraints` is
 * given. Throws when any rule is violated.
 */
export const enforceRunConstraints = ({
    config,
    logger,
    options,
    projectGraph,
}: {
    config: DiscoveredWorkspace["config"];
    logger: RunLogger;
    options: RunOptions;
    projectGraph: RunProjectGraph;
}): void => {
    if (config.constraints && !options.skipConstraints) {
        const violations = enforceProjectConstraints(projectGraph, config.constraints);

        if (violations.length > 0) {
            for (const v of violations) {
                logger.error(`[${v.rule}] ${v.message}`);
            }

            throw new Error(`${violations.length} project constraint violation(s) found. Use --skip-constraints to bypass.`);
        }
    }
};

/**
 * `--affected` modifiers (`--base`, `--head`, `--downstream`, `--upstream`,
 * `--uncommitted`) only make sense together with `--affected`. Throws when
 * any of them is passed without it.
 */
export const validateAffectedOnlyFlags = ({ options, rawSelector }: { options: RunOptions; rawSelector: string }): void => {
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
};

/**
 * Resolves the selector and target alias, then narrows the project list by
 * `--projects`, `--filter`, `--query` and `--tag`. Returns `undefined` when a
 * narrowing step matched nothing and `--if-present` asked for a quiet exit.
 */
export const narrowProjectSelection = async ({
    logger,
    options,
    packageJsons,
    projectGraph,
    projectOptions,
    rawSelector,
    visConfig,
    workspace,
    workspaceRoot,
}: {
    logger: RunLogger;
    options: RunOptions;
    packageJsons: DiscoveredWorkspace["packageJsons"];
    projectGraph: RunProjectGraph;
    projectOptions: DiscoveredWorkspace["projectOptions"];
    rawSelector: string;
    visConfig: Toolbox<Console, RunOptions>["visConfig"];
    workspace: DiscoveredWorkspace["workspace"];
    workspaceRoot: string;
}): Promise<{ projectNames: string[]; target: string } | undefined> => {
    const selectorResult = await resolveSelector(rawSelector, workspace, process.cwd(), workspaceRoot);
    // Resolve target aliases declared on any VisTargetConfiguration
    // before any further filtering so `vis run t` picks up `test`.
    const aliasMap = buildAliasMap(projectOptions);
    const target = resolveTargetAlias(selectorResult.target, aliasMap);

    if (target !== selectorResult.target) {
        logger.debug?.(`Resolved alias "${selectorResult.target}" → "${target}"`);
    }

    let projectNames = selectorResult.projects;

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

            return undefined;
        }
    }

    // Apply --query filter (language=X && tag=Y style).
    if (options.query) {
        projectNames = filterProjectsByQuery(projectNames, workspace, options.query);

        if (projectNames.length === 0) {
            onEmptySelection(`Query "${String(options.query)}" matched no projects`);

            return undefined;
        }
    }

    // `--tag` shorthand, applied as its own pass so it composes with
    // `--query` regardless of which operator that query uses.
    if (options.tag && options.tag.length > 0) {
        projectNames = filterProjectsByTags(projectNames, workspace, options.tag);

        if (projectNames.length === 0) {
            onEmptySelection(`Tag filter ${options.tag.map((t: string) => `"${t}"`).join(", ")} matched no projects`);

            return undefined;
        }
    }

    return { projectNames, target };
};

/**
 * `--affected`: narrows the selection in-process to the projects touched by
 * the changed files. Returns `undefined` when nothing changed or no project is
 * affected, so the run exits without executing anything.
 */
export const narrowToAffectedProjects = async ({
    fileOwners,
    logger,
    options,
    projectGraph,
    projectNames: projectNamesIn,
    visConfig,
    workspace,
    workspaceRoot,
}: {
    fileOwners: DiscoveredWorkspace["fileOwners"];
    logger: RunLogger;
    options: RunOptions;
    projectGraph: RunProjectGraph;
    projectNames: string[];
    visConfig: Toolbox<Console, RunOptions>["visConfig"];
    workspace: DiscoveredWorkspace["workspace"];
    workspaceRoot: string;
}): Promise<{ affectedChangedFiles: string[] | undefined; projectNames: string[] } | undefined> => {
    let projectNames = projectNamesIn;
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

            return undefined;
        }

        const affectedSet = new Set(affected.affectedProjects);

        projectNames = projectNames.filter((name) => affectedSet.has(name));

        if (projectNames.length === 0) {
            logger.info("No projects affected by the changes.");

            return undefined;
        }

        // Paths skipped by `affectedIgnore` changed nothing, so tasks don't receive them either.
        const ignoredFiles = new Set(affected.ignoredFiles);

        affectedChangedFiles = affected.changedFiles.filter((file) => !ignoredFiles.has(file));

        logger.info(`Affected projects: ${projectNames.join(", ")}`);
    }

    return { affectedChangedFiles, projectNames };
};
