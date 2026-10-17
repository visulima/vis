import { DEFAULT_CHANGES_DIR } from "../../config";
import type { PlannedRelease, StagedRegistryFile, StateFile } from "../../types";
import type { createShellRunner } from "../shell-runner";
import { assertNoConflictingPendingStages } from "./apply";
import type { OrchestratorContext } from "./context";
import type { PublishContextOptions, PublishContextResult } from "./publish-types";

/** State shared by the stages of one publish wave. */
export interface PublishWave {
    changesDir: string;
    lockInGit: boolean;
    options: PublishContextOptions;
    /** Persist the resume state (and commit it when the lock is git-tracked). */
    persistState: () => Promise<void>;
    /** Pending-stage registry as it stood before the publish loop. */
    priorRegistrySnapshot: StagedRegistryFile;
    /** Releases still to publish (resume-filtered). */
    releases: PlannedRelease[];
    result: PublishContextResult;
    runner: ReturnType<typeof createShellRunner>;
    stagedRegistry: StagedRegistryFile;
    state: StateFile;
}

/**
 * Commit + push the git-tracked publish lock (`release.publish.lockInGit`).
 * `open` is committed at the start of a wave (so an ephemeral runner can resume
 * if this one dies); `progress` checkpoints in-flight state mid-wave; `close`
 * commits the lock removal on full success. Soft-fail — a commit hiccup must not
 * fail an otherwise-successful publish. A failed *push* is surfaced as a warning
 * because it silently breaks cross-runner resume.
 */
export const commitPublishLock = async (
    context: OrchestratorContext,
    runner: ReturnType<typeof createShellRunner>,
    changesDir: string,
    phase: "close" | "open" | "progress",
    options: { noPush?: boolean },
): Promise<void> => {
    const { stageAndCommitFile } = await import("../git");
    const { stateFilePath } = await import("../state");

    try {
        const result = await stageAndCommitFile(
            { cwd: context.cwd, runner },
            stateFilePath(context.cwd, changesDir, true),
            `chore(release): ${phase} publish lock [skip ci]`,
            {
                author: context.config.gitUser,
                push: !options.noPush,
                sign: context.config.gitSignCommits === true,
            },
        );

        if (!options.noPush && result.committed && !result.pushed) {
            process.stderr.write(
                `[vis release] Warning: publish lock (${phase}) was committed locally but could not be pushed — cross-runner resume may use a stale lock.\n`,
            );
        }
    } catch (error) {
        process.stderr.write(`[vis release] Warning: could not commit publish lock (${phase}): ${(error as Error).message}\n`);
    }
};

/**
 * Load (or start) the resume state and the pending-stage registry for a
 * publish wave, and refuse to continue while a conflicting stage is pending.
 */
export const openPublishWave = async (
    context: OrchestratorContext,
    runner: ReturnType<typeof createShellRunner>,
    options: PublishContextOptions,
    result: PublishContextResult,
): Promise<PublishWave> => {
    // Resume support: read state file, skip already-published packages.
    const { filterPlanByState, newState, readState, writeState } = await import("../state");
    const { readStagedRegistry } = await import("../staged-registry");
    const changesDir = context.config.changesDir ?? DEFAULT_CHANGES_DIR;
    // Git-tracked publish lock (RFC §19.1): persists state to
    // a committed `publish-lock.json` so an ephemeral runner can resume.
    // When enabled, a committed lock means "resume" even without --resume —
    // its mere presence signals an in-progress publish from another runner.
    const lockInGit = context.config.publish?.lockInGit === true;
    let state = options.resume || lockInGit ? await readState(context.cwd, changesDir, lockInGit) : undefined;

    // A git-tracked lock is auto-resumed by presence, so a lock left behind
    // by a prior wave (e.g. one whose "close" commit/push failed) could pin
    // its stale channel tag onto this run. The current branch is the
    // authoritative channel — refresh it. (Per-package `name@version` resume
    // filtering still self-heals which packages publish.)
    if (state && lockInGit) {
        state.channel = context.channel?.tag;
    }

    // Persist the in-progress state at a resume checkpoint. When the lock is
    // git-tracked, also commit + push it so a fresh runner resumes from this
    // exact point (published / tagged / walked / notified) instead of
    // replaying side effects. The commit is a no-op (no push) when `state`
    // is unchanged, so only real progress reaches the remote.
    const persistState = async (): Promise<void> => {
        if (options.dryRun || !state) {
            return;
        }

        await writeState(context.cwd, changesDir, state, lockInGit);

        if (lockInGit) {
            await commitPublishLock(context, runner, changesDir, "progress", { noPush: options.noPush });
        }
    };

    let stagedRegistry = await readStagedRegistry(context.cwd, changesDir);

    // Guard the publish phase too — `vis release publish` can run on its
    // own (no preceding `version` step in CI), so the version-phase guard
    // isn't enough. Pending stages on the same package mean the operator
    // must resolve them first or the new publish will create a parallel
    // tarball. Throws `STAGE_PENDING`; the CLI handler catches it and
    // prints the hint.
    await assertNoConflictingPendingStages(context, "publish", stagedRegistry, { runner });

    // Re-read in case the guard's self-heal mutated the registry — the
    // mutated copy is what we want for downstream upsert/remove work.
    stagedRegistry = await readStagedRegistry(context.cwd, changesDir);

    // Snapshot the registry as it stands BEFORE the publish loop. Used
    // at the end of the wave to compute the delta for the commit
    // message ("record N" vs "drain N" vs "update").
    const priorRegistrySnapshot = { ...stagedRegistry, pending: [...stagedRegistry.pending] };

    let { releases } = context.plan;

    if (state) {
        releases = filterPlanByState(releases, state);
    } else {
        state = newState(context.channel?.tag, context.plan.releases);

        if (!options.dryRun) {
            await writeState(context.cwd, changesDir, state, lockInGit);

            // Commit + push the tracked lock at the start of the wave so a
            // different (ephemeral) runner can resume if this one dies.
            if (lockInGit) {
                await commitPublishLock(context, runner, changesDir, "open", { noPush: options.noPush });
            }
        }
    }

    return { changesDir, lockInGit, options, persistState, priorRegistrySnapshot, releases, result, runner, stagedRegistry, state };
};
