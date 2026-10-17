import isInCi from "is-in-ci";

import { VisUserError } from "../../errors/vis-user-error";
import { collectAvailableTargets, suggestTargets } from "../../task/target-discovery";
import type { VisTargetConfiguration } from "../../task/target-options";
import { matchesRunnerTags, shouldRunInCI } from "../../task/target-options";
import type { RunOptions } from "./index";
import type { DiscoveredWorkspace, RunLogger } from "./run-context";

/**
 * Keeps the selected projects that define the target and pass the CI,
 * runner-tag and internal-target filters. Returns `undefined` when none
 * remain and `--if-present` asked for a quiet exit; otherwise throws.
 */
export const selectProjectsWithTarget = ({
    logger,
    options,
    projectNames,
    projectOptions,
    target,
    workspace,
}: {
    logger: RunLogger;
    options: RunOptions;
    projectNames: string[];
    projectOptions: DiscoveredWorkspace["projectOptions"];
    target: string;
    workspace: DiscoveredWorkspace["workspace"];
}): { projectsWithTarget: string[]; projectTargetIndex: Map<string, VisTargetConfiguration> } | undefined => {
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

            return undefined;
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

    return { projectsWithTarget, projectTargetIndex };
};
