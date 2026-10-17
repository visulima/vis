import { DEFAULT_CHANGES_DIR } from "../../config";
import { createShellRunner } from "../shell-runner";
import type { OrchestratorContext } from "./context";
import { runHook } from "./hooks";
import { publishPackages } from "./publish-packages";
import { runPostPublish } from "./publish-post";
import { runPublishPreflight } from "./publish-preflight";
import { commitStagedRegistry, writeWorkspaceChangelogEntry } from "./publish-records";
import { createReleaseTags } from "./publish-tags";
import type { PublishContextOptions, PublishContextResult } from "./publish-types";
import { openPublishWave } from "./publish-wave";

/**
 * Publish each release in the plan via its resolved versionActions.
 * Topological order is honored so dependencies publish before dependents.
 */
export const publishContext = async (context: OrchestratorContext, options: PublishContextOptions = {}): Promise<PublishContextResult> => {
    const result: PublishContextResult = { failed: [], published: [], skipped: [], tags: [], tagsPushed: false };
    const runner = createShellRunner();

    if (context.plan.releases.length === 0) {
        return result;
    }

    if (await runPublishPreflight(context, runner, options, result)) {
        return result;
    }

    // Process-level lock (RFC §19.1) — prevents two `vis release publish`
    // invocations on the same machine from racing. Acquired here; released
    // in the finally block at the end of this function.
    const changesDirForLock = context.config.changesDir ?? DEFAULT_CHANGES_DIR;
    const { acquireLock, releaseLock } = await import("../state");
    let lockAcquired = false;

    if (!options.dryRun) {
        try {
            await acquireLock(context.cwd, changesDirForLock);
            lockAcquired = true;
        } catch (error) {
            result.failed.push({ name: "_lock", reason: (error as Error).message });

            return result;
        }
    }

    try {
        const wave = await openPublishWave(context, runner, options, result);

        await publishPackages(context, wave);

        // syncGitTag groups: members collapse to one shared tag +
        // aggregate release. Resolved once for the wave — both the tag-creation
        // phase below and createRemoteReleases consume it (no double resolution).
        const { resolveSyncTagGroups } = await import("../group-tags");
        const syncTags = resolveSyncTagGroups(context.config, result.published);

        await createReleaseTags(context, wave, syncTags);
        await commitStagedRegistry(context, wave);
        await writeWorkspaceChangelogEntry(context, wave);
        await runPostPublish(context, wave, syncTags);

        if (!options.dryRun && context.config.postPublishCommand) {
            try {
                await runHook(context.cwd, context.config.postPublishCommand, "postPublishCommand");
            } catch (error) {
                // Don't fail the whole release for a post-hook bug; surface it.
                result.failed.push({ name: "_postPublishCommand", reason: (error as Error).message });
            }
        }

        return result;
    } finally {
        if (lockAcquired) {
            await releaseLock(context.cwd, changesDirForLock);
        }
    }
};
