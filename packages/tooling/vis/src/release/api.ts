/**
 * Programmatic API entry points (RFC §15).
 *
 * Wired through `core/orchestrator.ts` which composes config loading,
 * workspace discovery, plan assembly, apply, and publish.
 */

import { applyContext, buildContext, publishContext, publishMissing } from "./core/orchestrator";
import { VisReleaseError } from "./errors";
import type { PlannedRelease, ReleasePlan, VisReleaseConfig } from "./types";

// `await using` resolves `obj[Symbol.asyncDispose]` against the engine's
// well-known symbol, which Node 22 provides at runtime. The configured TS lib
// is `ES2024` (no `esnext.disposable`), so the type is augmented here rather
// than widening the whole repo's lib set.
declare global {
    interface SymbolConstructor {
        readonly asyncDispose: unique symbol;
    }
}

// ── Common option shapes ─────────────────────────────────────────────

export interface ReleaseOptionsBase {
    /** Force a specific channel name (overrides branch detection). */
    channel?: string;
    /** Inline config — merged on top of `vis.config.ts`'s `release` block. */
    config?: VisReleaseConfig;
    /** Override workspace root (default: `process.cwd()`'s monorepo root). */
    cwd?: string;
    /** Skip writes / network calls. */
    dryRun?: boolean;

    /**
     * Greenfield bootstrap. Forces `currentVersionResolver: "disk"` and
     * skips remote tag-collision checks so the very first release on a
     * fresh repo (no prior git tag, no published version) can proceed
     * without errors. Maps to `nx release --first-release` and
     * release-please's `bootstrap-sha`.
     */
    firstRelease?: boolean;
    /** Limit to packages matching these globs. */
    projects?: string[];
    /** Resume from a previous run's `.state.json`. */
    resume?: boolean;
}

export interface VersionOptions extends ReleaseOptionsBase {
    /** Auto-commit after writing versions. (Wired in M5.) */
    commit?: boolean;
}

export interface ChangelogOptions extends ReleaseOptionsBase {
    interactive?: boolean;
    versionData?: PlannedRelease[];
}

export interface PublishOptions extends ReleaseOptionsBase {
    /**
     * Instead of the pending plan, publish every version a release commit set
     * but no wave finished (untagged, not on the registry), tagging it on that
     * commit. Same as `vis release publish --missing`.
     */
    missing?: boolean;
    /** Skip `git push --tags` after publish. */
    noPush?: boolean;
    /** 2FA token. */
    otp?: string;
    /** Override npm dist-tag. */
    tag?: string;
    versionData?: PlannedRelease[];
}

export interface SnapshotOptions extends ReleaseOptionsBase {
    registry?: string;
    tag: string;
}

export interface ReleaseOptions extends VersionOptions {
    /**
     * Before planning, publish the versions an earlier, partly failed wave
     * committed but never published (see {@link PublishOptions.missing}).
     * Throws `PUBLISH_FAILED` when that recovery fails, before anything new
     * is versioned. Ignored with `skipPublish`.
     */
    publishMissing?: boolean;
    skipPublish?: boolean;
    yes?: boolean;
}

// ── Result shapes ────────────────────────────────────────────────────

export interface VersionResult {
    /** Files written / deleted by `apply-release-plan`. */
    changedFiles: string[];
    deletedFiles: string[];
    plan: ReleasePlan;
}

export interface ChangelogResult {
    projectChangelogs: { content: string; file: string; package: string }[];
    workspaceChangelog?: { content: string; file: string };
}

export interface PublishResult {
    failed: { name: string; reason: string }[];
    published: { name: string; version: string }[];
    skipped: { name: string; reason: string }[];
    /** Non-fatal problems: plan warnings plus post-publish ones (forge releases, success-walk comments, notifications). */
    warnings?: string[];
}

export interface SnapshotResult {
    failed: { name: string; reason: string }[];
    published: { name: string; url?: string; version: string }[];
    skipped: { name: string; reason: string }[];
    /** Snapshot version applied to every published item. */
    snapshotVersion: string;
    /** dist-tag used. */
    tag: string;
}

// ── Implementations ──────────────────────────────────────────────────

export const releaseVersion = async (options: VersionOptions = {}): Promise<VersionResult> => {
    const ctx = await buildContext(options);
    const result = await applyContext(ctx, { dryRun: options.dryRun });

    return {
        changedFiles: result.changedFiles,
        deletedFiles: result.deletedFiles,
        plan: result.plan,
    };
};

/**
 * Standalone changelog rendering — produces the per-package CHANGELOG.md
 * entries WITHOUT writing them to disk. Useful for previewing the
 * changelog output, or for downstream tooling (e.g. release-notes for
 * GH Releases) that needs the rendered content separately from the
 * version-apply pass.
 *
 * The default `releaseVersion` path also writes changelog entries
 * automatically (formatter is invoked inside `applyReleasePlan`); this
 * function is for read-only access to the same rendered output.
 */
export const releaseChangelog = async (options: ChangelogOptions = {}): Promise<ChangelogResult> => {
    const ctx = await buildContext(options);
    const { resolveFormatter } = await import("./core/changelog/resolve");
    const formatter = await resolveFormatter(ctx.config.changelog, ctx.cwd);
    const date = new Date().toISOString().slice(0, 10);

    const projectChangelogs: ChangelogResult["projectChangelogs"] = [];

    for (const release of ctx.plan.releases) {
        const pkg = ctx.depGraph.getPackage(release.name);

        if (!pkg) {
            continue;
        }

        const content = await formatter({
            changeFiles: release.changeFiles,
            date,
            release,
            target: "changelog",
        });

        projectChangelogs.push({
            content,
            file: `${pkg.dir}/CHANGELOG.md`,
            package: release.name,
        });
    }

    return { projectChangelogs };
};

export const releasePublish = async (options: PublishOptions = {}): Promise<PublishResult> => {
    const ctx = await buildContext(options);
    const publishOptions = { dryRun: options.dryRun, otp: options.otp, tag: options.tag };

    if (options.missing) {
        const result = await publishMissing(ctx, { ...publishOptions, projects: options.projects });

        return { ...result, warnings: [...ctx.plan.warnings, ...result.warnings] };
    }

    return { ...(await publishContext(ctx, publishOptions)), warnings: ctx.plan.warnings };
};

// ── Draft (Explicit Resource Management) ─────────────────────────────

/**
 * A computed-but-not-yet-applied release. Holds the resolved {@link ReleasePlan}
 * so callers can inspect what *would* happen, then either {@link ReleaseDraft.apply}
 * it (write versions + changelogs, consume change files) or {@link ReleaseDraft.discard}
 * it.
 *
 * Implements `Symbol.asyncDispose`, so the idiomatic form is:
 *
 * ```ts
 * await using draft = await releaseDraft({ cwd });
 * console.log(draft.plan.releases);
 * // draft.apply() runs automatically when the block exits — unless you
 * // called draft.discard() first.
 * ```
 *
 * Disposal fires on *any* scope exit, including thrown errors. If you need
 * apply-only-on-success semantics, call {@link ReleaseDraft.apply} explicitly
 * and `discard()` on the error path instead of relying on disposal.
 */
export interface ReleaseDraft {
    /** Auto-apply on `await using` scope exit unless already applied or discarded. */
    [Symbol.asyncDispose]: () => Promise<void>;
    /** Write the planned versions + changelogs and consume the change files. Idempotent — repeat calls are no-ops returning the first result. */
    apply: () => Promise<VersionResult>;
    /** Abandon the draft so disposal will not apply it. */
    discard: () => void;
    /** The computed plan (available before apply). */
    readonly plan: ReleasePlan;
}

export const releaseDraft = async (options: VersionOptions = {}): Promise<ReleaseDraft> => {
    const ctx = await buildContext(options);

    let settled = false;
    let appliedResult: VersionResult | undefined;

    const apply = async (): Promise<VersionResult> => {
        if (appliedResult) {
            return appliedResult;
        }

        settled = true;

        const result = await applyContext(ctx, { dryRun: options.dryRun });

        appliedResult = {
            changedFiles: result.changedFiles,
            deletedFiles: result.deletedFiles,
            plan: result.plan,
        };

        return appliedResult;
    };

    return {
        apply,
        discard: (): void => {
            settled = true;
        },
        plan: ctx.plan,
        [Symbol.asyncDispose]: async (): Promise<void> => {
            if (!settled) {
                await apply();
            }
        },
    };
};

export const releaseSnapshot = async (options: SnapshotOptions): Promise<SnapshotResult> => {
    const ctx = await buildContext(options);
    const { runSnapshot } = await import("./core/snapshot");
    const result = await runSnapshot({
        context: ctx,
        dryRun: options.dryRun,
        registry: options.registry,
        tag: options.tag,
    });

    return {
        failed: result.failed,
        published: result.published,
        skipped: result.skipped,
        snapshotVersion: result.snapshotVersion,
        tag: result.tag,
    };
};

export const release = async (
    options: ReleaseOptions = {},
): Promise<{
    changelog: ChangelogResult;
    publish: PublishResult;
    version: VersionResult;
}> => {
    // Recover first, on its own context: the plan's current versions must see
    // the tags the recovery creates, or a cascade recomputes a recovered
    // version and collides with it.
    const recovered
        = options.publishMissing && !options.skipPublish
            ? await publishMissing(await buildContext(options), { dryRun: options.dryRun, projects: options.projects })
            : undefined;

    if (recovered && recovered.failed.length > 0) {
        throw new VisReleaseError({
            code: "PUBLISH_FAILED",
            message: `Recovering unpublished versions failed, nothing new was versioned: ${recovered.failed.map((f) => `${f.name}: ${f.reason}`).join("; ")}`,
        });
    }

    // Build the context exactly once. Each downstream phase used to call
    // `buildContext()` again, but `applyContext()` deletes consumed change
    // files, so a re-build at changelog/publish time saw an empty plan and
    // silently no-op'd the rest of the release.
    const ctx = await buildContext(options);
    const applied = await applyContext(ctx, { dryRun: options.dryRun });

    const version: VersionResult = {
        changedFiles: applied.changedFiles,
        deletedFiles: applied.deletedFiles,
        plan: applied.plan,
    };

    // Re-render changelog text from the SAME plan applyContext just used.
    // The plan is captured pre-mutation so the renderer still sees every
    // release entry even though the change files on disk have been deleted.
    const { resolveFormatter } = await import("./core/changelog/resolve");
    const formatter = await resolveFormatter(ctx.config.changelog, ctx.cwd);
    const date = new Date().toISOString().slice(0, 10);
    const projectChangelogs: ChangelogResult["projectChangelogs"] = [];

    for (const planned of applied.plan.releases) {
        const pkg = ctx.depGraph.getPackage(planned.name);

        if (!pkg) {
            continue;
        }

        const content = await formatter({
            changeFiles: planned.changeFiles,
            date,
            release: planned,
            target: "changelog",
        });

        projectChangelogs.push({
            content,
            file: `${pkg.dir}/CHANGELOG.md`,
            package: planned.name,
        });
    }

    const changelog: ChangelogResult = { projectChangelogs };

    if (options.skipPublish) {
        return { changelog, publish: { failed: [], published: [], skipped: [] }, version };
    }

    // Re-use the same context for publish; otherwise `buildContext()` re-runs
    // after applyContext deleted the change files and would surface an empty
    // plan, leaving nothing to publish.
    const publish = await publishContext(ctx, {
        dryRun: options.dryRun,
        otp: undefined,
        tag: undefined,
    });

    if (recovered) {
        publish.published.unshift(...recovered.published);
        publish.skipped.unshift(...recovered.skipped);
    }

    return { changelog, publish: { ...publish, warnings: [...(recovered?.warnings ?? []), ...ctx.plan.warnings] }, version };
};

// ── Class form (matches nx's ReleaseClient) ────────────────────────

export class ReleaseClient {
    public constructor(public readonly config: VisReleaseConfig = {}) {}

    public releaseVersion(options: Omit<VersionOptions, "config"> = {}): Promise<VersionResult> {
        return releaseVersion({ ...options, config: this.config });
    }

    public releaseChangelog(options: Omit<ChangelogOptions, "config"> = {}): Promise<ChangelogResult> {
        return releaseChangelog({ ...options, config: this.config });
    }

    public releasePublish(options: Omit<PublishOptions, "config"> = {}): Promise<PublishResult> {
        return releasePublish({ ...options, config: this.config });
    }

    public releaseDraft(options: Omit<VersionOptions, "config"> = {}): Promise<ReleaseDraft> {
        return releaseDraft({ ...options, config: this.config });
    }

    public releaseSnapshot(options: Omit<SnapshotOptions, "config">): Promise<SnapshotResult> {
        return releaseSnapshot({ ...options, config: this.config });
    }
}
