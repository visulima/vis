import type { VersionActions } from "../version-actions/interface";

// ── Publish phase ──────────────────────────────────────────────────
export interface PublishContextOptions {
    dryRun?: boolean;

    /**
     * Commit the wave's bookkeeping (publish lock, staged registry, walk /
     * notify dedupe, workspace changelog) without pushing the branch: the
     * caller pushes it once. Tags are still pushed.
     */
    noBranchPush?: boolean;
    /** Skip `git push --tags` after publish. */
    noPush?: boolean;
    /** Skip local tag creation entirely. */
    noTag?: boolean;
    otp?: string;

    /**
     * Test-only override: use this `VersionActions` instance for every
     * package in the wave instead of resolving from `versionActions` config.
     * Production callers should leave this unset.
     */
    publishActionsOverride?: VersionActions;
    /** Resume from previous run's state file. */
    resume?: boolean;
    tag?: string;
    /** Commit to put a package's release tag on, by package name. Default: HEAD. */
    tagTargets?: ReadonlyMap<string, string>;
}

export interface PublishContextResult {
    failed: { name: string; reason: string }[];
    published: {
        name: string;
        /** Set when `publish.stage: true` — the npm stage id awaiting approval. */
        stageId?: string;
        /** Tarball hashes when publish.releaseAssets.stampHashes / uploadTarball are wanted. */
        tarball?: { path: string; sha256: string; sha512: string; size: number };
        /** Forge release URL — populated by `createRemoteReleases` for per-package releases. */
        url?: string;
        version: string;
    }[];
    skipped: { name: string; reason: string }[];
    /** Tags created locally (not yet pushed). */
    tags: string[];
    /** Whether tags were successfully pushed to the remote. */
    tagsPushed: boolean;
}
