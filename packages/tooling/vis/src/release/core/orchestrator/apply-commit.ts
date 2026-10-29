import type { applyReleasePlan } from "../apply-release-plan";
import { createShellRunner } from "../shell-runner";
import type { OrchestratorContext } from "./context";

const buildDefaultCommitMessage = (context: OrchestratorContext): string => {
    const channel = context.channel?.tag ?? context.branch ?? "main";
    const { releases } = context.plan;
    const summary = releases.length <= 3 ? releases.map((r) => `${r.name}@${r.newVersion}`).join(", ") : `version ${releases.length} packages`;

    const details = releases.map((r) => `- ${r.name}: ${r.oldVersion} → ${r.newVersion}`).join("\n");

    return `release(${channel}): ${summary} [skip ci]\n\n${details}`;
};

/**
 * Stage and commit the version step's writes, deletions and lockfiles: one
 * commit per package when `oneCommitPerPackage` is on and the wave is not
 * aggregated, one commit for the whole wave otherwise. Returns the sha of
 * the last commit.
 */
export const commitVersionChanges = async (
    context: OrchestratorContext,
    applied: Awaited<ReturnType<typeof applyReleasePlan>>,
    commitMessage: string | undefined,
): Promise<string | undefined> => {
    const fs = await import("node:fs/promises");
    const { getCurrentSha, LOCKFILE_NAMES, RELEASE_SOURCE_TRAILER, stageAndCommit } = await import("../git");
    const runner = createShellRunner();

    // Lockfile paths to also stage (best-effort; some PMs don't have one yet).
    const path = await import("node:path");
    const lockfilesPresent: string[] = [];

    for (const name of LOCKFILE_NAMES) {
        try {
            await fs.access(path.join(context.cwd, name));
            lockfilesPresent.push(path.join(context.cwd, name));
        } catch {
            // not present
        }
    }

    // Tags go on the commit the wave was planned from; record it so they still
    // find it after `ci release` rebases these commits onto a moved branch.
    const source = context.config.tagTarget === "source" ? await getCurrentSha({ cwd: context.cwd, runner }) : undefined;
    const trailer = source === undefined ? "" : `\n\n${RELEASE_SOURCE_TRAILER}: ${source}`;
    const aggregateEnabled
        = context.config.aggregateRelease === true || (typeof context.config.aggregateRelease === "object" && context.config.aggregateRelease.enabled);
    let commitSha: string | undefined;

    // RFC §19.5: one release commit per package when opted in and not
    // aggregating. Shared artifacts (lockfiles + consumed change-file
    // deletions) ride in the final package's commit. The per-package
    // template ignores any aggregate `options.commitMessage` override
    // (it's inherently single-message).
    if (context.config.oneCommitPerPackage === true && !aggregateEnabled && context.plan.releases.length > 0) {
        const channel = context.channel?.tag ?? context.branch ?? "main";
        const writePaths = applied.writes.map((w) => w.path);
        const claimed = new Set<string>();
        const { releases } = context.plan;

        for (let index = 0; index < releases.length; index += 1) {
            const release = releases[index]!;
            const pkg = context.depGraph.getPackage(release.name);
            const pkgPrefix = pkg ? `${pkg.dir}${path.sep}` : undefined;
            const pkgFiles = pkgPrefix ? writePaths.filter((p) => p.startsWith(pkgPrefix)) : [];

            for (const file of pkgFiles) {
                claimed.add(file);
            }

            // Last package sweeps up anything unclaimed (writes outside a
            // package dir, e.g. a root file), the change-file deletions,
            // and the lockfiles.
            const trailing = index === releases.length - 1 ? [...writePaths.filter((p) => !claimed.has(p)), ...applied.deletions, ...lockfilesPresent] : [];

            const files = [...pkgFiles, ...trailing];

            if (files.length === 0) {
                continue;
            }

            commitSha = await stageAndCommit(
                { cwd: context.cwd, runner },
                files,
                `release(${channel}): ${release.name}@${release.newVersion} [skip ci]${trailer}`,
                {
                    author: context.config.gitUser,
                },
            );
        }
    } else {
        // Single aggregate commit for the whole wave (default).
        const message = commitMessage ?? buildDefaultCommitMessage(context);
        const allFiles = [...applied.writes.map((w) => w.path), ...applied.deletions, ...lockfilesPresent];

        commitSha = await stageAndCommit({ cwd: context.cwd, runner }, allFiles, `${message}${trailer}`, { author: context.config.gitUser });
    }

    return commitSha;
};
