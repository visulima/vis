import type { OrchestratorContext } from "./context";
import type { PublishWave } from "./publish-wave";

/** Write and commit the pending-stage registry after the publish loop. */
export const commitStagedRegistry = async (context: OrchestratorContext, wave: PublishWave): Promise<void> => {
    const { changesDir, options, runner } = wave;
    const { writeStagedRegistry } = await import("../staged-registry");

    // Persist + commit the pending-stage registry. Runs on every publish
    // wave (success, partial, all-skipped) so the tracked file always
    // reflects what's live on npm. The `[skip ci]` tag prevents this
    // chore commit from triggering another release cycle.
    //
    // Commit message reflects the delta direction so the git log reads
    // sensibly without having to diff the file: "record" for net-new
    // pending entries, "drain" for net-removed entries, "update" for
    // mixed waves.
    if (!options.dryRun) {
        const previous = wave.priorRegistrySnapshot.pending.length;
        const next = wave.stagedRegistry.pending.length;
        const write = await writeStagedRegistry(context.cwd, changesDir, wave.stagedRegistry);

        if (write.changed) {
            const { stageAndCommitFile } = await import("../git");
            let message: string;

            if (write.removed) {
                message = "chore(release): clear pending stage registry [skip ci]";
            } else if (next > previous) {
                const added = next - previous;

                message = `chore(release): record ${added} new pending stage${added === 1 ? "" : "s"} [skip ci]`;
            } else if (next < previous) {
                const removed = previous - next;

                message = `chore(release): drain ${removed} resolved stage${removed === 1 ? "" : "s"} [skip ci]`;
            } else {
                // Same count but different content (e.g. a stage was
                // drained and a new one staged in the same wave).
                message = `chore(release): update pending stage registry (${next} pending) [skip ci]`;
            }

            try {
                await stageAndCommitFile({ cwd: context.cwd, runner }, write.path, message, {
                    author: context.config.gitUser,
                    push: !options.noPush && !options.noBranchPush,
                    sign: context.config.gitSignCommits === true,
                });
            } catch (error) {
                // Don't fail the whole publish for a registry-commit
                // hiccup — the file is on disk; the next run will pick it
                // up and retry the commit. Log to stderr only; we don't
                // pollute `result.skipped[]` with infrastructure noise.
                process.stderr.write(`[vis release] Warning: could not commit ${write.path}: ${(error as Error).message}\n`);
            }
        }
    }
};

/** Append the workspace-level changelog entry for the packages this wave published. */
export const writeWorkspaceChangelogEntry = async (context: OrchestratorContext, wave: PublishWave): Promise<void> => {
    const { options, result, runner } = wave;

    // Workspace-level changelog wave entry. Written from the
    // publish phase — AFTER tag-push — using `result.published[]` so a
    // stage rejected at the gate never produces an orphan wave entry.
    // Skipped on dry-run, when config disables it, or when no package
    // actually published.
    if (!options.dryRun && result.published.length > 0 && context.config.workspaceChangelog !== false) {
        const wsRaw = context.config.workspaceChangelog;
        const wsConfig = typeof wsRaw === "object" ? wsRaw : undefined;
        // Default: only render workspace-level when explicitly opted-in OR when aggregateRelease is enabled.
        const aggregate
            = typeof context.config.aggregateRelease === "object" ? context.config.aggregateRelease.enabled : context.config.aggregateRelease === true;

        if (wsConfig !== undefined || aggregate) {
            try {
                const { writeWorkspaceChangelogWave } = await import("../changelog/workspace");

                // Project the published set back into PlannedRelease
                // shape using the plan as the source of metadata
                // (changeFiles, oldVersion, kind, etc.). Only releases
                // that actually shipped this wave are included.
                const publishedNames = new Set(result.published.map((p) => p.name));
                const publishedReleases = context.plan.releases.filter((r) => publishedNames.has(r.name));

                const waveEntryPath = await writeWorkspaceChangelogWave(
                    {
                        changelogConfig: context.config.changelog,
                        cwd: context.cwd,
                        workspaceChangelog: context.config.workspaceChangelog,
                    },
                    publishedReleases,
                );

                if (waveEntryPath) {
                    try {
                        const { stageAndCommitFile } = await import("../git");

                        await stageAndCommitFile({ cwd: context.cwd, runner }, waveEntryPath, "chore(release): record wave [skip ci]", {
                            author: context.config.gitUser,
                            push: !options.noPush && !options.noBranchPush,
                            sign: context.config.gitSignCommits === true,
                        });
                    } catch (error) {
                        // Soft-fail: the workspace CHANGELOG.md is on
                        // disk; the next wave will pick up the staged
                        // file and commit it together with the next
                        // entry. Don't fail the whole publish for a
                        // commit hiccup.
                        process.stderr.write(`[vis release] Warning: could not commit workspace CHANGELOG.md: ${(error as Error).message}\n`);
                    }
                }
            } catch (error) {
                // Soft-fail: workspace changelog is documentation, not
                // a release blocker.
                process.stderr.write(`[vis release] Warning: could not write workspace CHANGELOG.md wave entry: ${(error as Error).message}\n`);
            }
        }
    }
};
