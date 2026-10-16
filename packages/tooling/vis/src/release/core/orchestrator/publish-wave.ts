import { DEFAULT_CHANGES_DIR } from "../../config";
import type { PlannedRelease, StagedRegistryFile, StateFile } from "../../types";
import type { createShellRunner } from "../shell-runner";
import type { readStagedRegistry, removePendingStages, upsertPendingStages, writeStagedRegistry } from "../staged-registry";
import type { clearState, filterPlanByState, newState, readState, writeState } from "../state";
import { assertNoConflictingPendingStages } from "./apply";
import type { OrchestratorContext } from "./context";
import type { PublishContextOptions, PublishContextResult } from "./publish";

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
 * State shared by every phase of one publish wave. Fields that a later phase
 * reassigns (`state`, `stagedRegistry`) are read from the wave at use time,
 * never copied into a phase's locals.
 */
export interface PublishWave {
    changesDir: string;
    context: OrchestratorContext;
    lockInGit: boolean;
    /** State and staged-registry functions, loaded once per wave. */
    modules: PublishWaveModules;
    options: PublishContextOptions;
    /** Registry as it stood before the publish loop; drives the commit message delta. */
    priorRegistrySnapshot: StagedRegistryFile;
    releases: PlannedRelease[];
    result: PublishContextResult;
    runner: ReturnType<typeof createShellRunner>;
    stagedRegistry: StagedRegistryFile;
    state: StateFile;
}

export interface PublishWaveModules {
    registry: {
        readStagedRegistry: typeof readStagedRegistry;
        removePendingStages: typeof removePendingStages;
        upsertPendingStages: typeof upsertPendingStages;
        writeStagedRegistry: typeof writeStagedRegistry;
    };
    state: {
        clearState: typeof clearState;
        filterPlanByState: typeof filterPlanByState;
        newState: typeof newState;
        readState: typeof readState;
        writeState: typeof writeState;
    };
}

/** Phase-independent inputs handed to {@link openPublishWave}. */
export interface PublishWaveBase {
    context: OrchestratorContext;
    options: PublishContextOptions;
    result: PublishContextResult;
    runner: ReturnType<typeof createShellRunner>;
}

/**
 * Persist the in-progress state at a resume checkpoint. When the lock is
 * git-tracked, also commit + push it so a fresh runner resumes from this
 * exact point (published / tagged / walked / notified) instead of
 * replaying side effects. The commit is a no-op (no push) when `state`
 * is unchanged, so only real progress reaches the remote.
 */
export const persistWaveState = async (wave: PublishWave): Promise<void> => {
    if (wave.options.dryRun) {
        return;
    }

    await wave.modules.state.writeState(wave.context.cwd, wave.changesDir, wave.state, wave.lockInGit);

    if (wave.lockInGit) {
        await commitPublishLock(wave.context, wave.runner, wave.changesDir, "progress", { noPush: wave.options.noPush });
    }
};

/**
 * Read the resume state, guard against conflicting pending stages, and start
 * the wave (state file + `open` lock commit) before any package is published.
 */
export const openPublishWave = async (base: PublishWaveBase, modules: PublishWaveModules): Promise<PublishWave> => {
    const { context, options, runner } = base;
    // Resume support: read state file, skip already-published packages.
    const changesDir = context.config.changesDir ?? DEFAULT_CHANGES_DIR;
    // Git-tracked publish lock (RFC §19.1): persists state to
    // a committed `publish-lock.json` so an ephemeral runner can resume.
    // When enabled, a committed lock means "resume" even without --resume —
    // its mere presence signals an in-progress publish from another runner.
    const lockInGit = context.config.publish?.lockInGit === true;
    let state = options.resume || lockInGit ? await modules.state.readState(context.cwd, changesDir, lockInGit) : undefined;

    // A git-tracked lock is auto-resumed by presence, so a lock left behind
    // by a prior wave (e.g. one whose "close" commit/push failed) could pin
    // its stale channel tag onto this run. The current branch is the
    // authoritative channel — refresh it. (Per-package `name@version` resume
    // filtering still self-heals which packages publish.)
    if (state && lockInGit) {
        state.channel = context.channel?.tag;
    }

    let stagedRegistry = await modules.registry.readStagedRegistry(context.cwd, changesDir);

    // Guard the publish phase too — `vis release publish` can run on its
    // own (no preceding `version` step in CI), so the version-phase guard
    // isn't enough. Pending stages on the same package mean the operator
    // must resolve them first or the new publish will create a parallel
    // tarball. Throws `STAGE_PENDING`; the CLI handler catches it and
    // prints the hint.
    await assertNoConflictingPendingStages(context, "publish", stagedRegistry, { runner });

    // Re-read in case the guard's self-heal mutated the registry — the
    // mutated copy is what we want for downstream upsert/remove work.
    stagedRegistry = await modules.registry.readStagedRegistry(context.cwd, changesDir);

    // Snapshot the registry as it stands BEFORE the publish loop. Used
    // at the end of the wave to compute the delta for the commit
    // message ("record N" vs "drain N" vs "update").
    const priorRegistrySnapshot = { ...stagedRegistry, pending: [...stagedRegistry.pending] };

    let { releases } = context.plan;

    if (state) {
        releases = modules.state.filterPlanByState(releases, state);
    } else {
        state = modules.state.newState(context.channel?.tag, context.plan.releases);

        if (!options.dryRun) {
            await modules.state.writeState(context.cwd, changesDir, state, lockInGit);

            // Commit + push the tracked lock at the start of the wave so a
            // different (ephemeral) runner can resume if this one dies.
            if (lockInGit) {
                await commitPublishLock(context, runner, changesDir, "open", { noPush: options.noPush });
            }
        }
    }

    return { ...base, changesDir, lockInGit, modules, priorRegistrySnapshot, releases, stagedRegistry, state };
};
