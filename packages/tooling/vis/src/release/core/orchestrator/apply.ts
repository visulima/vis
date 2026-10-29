import { unlink, writeFile } from "node:fs/promises";

import { DEFAULT_CHANGES_DIR } from "../../config";
import { VisReleaseError } from "../../errors";
import type { ReleasePlan } from "../../types";
import { applyReleasePlan } from "../apply-release-plan";
import { createShellRunner } from "../shell-runner";
import { commitVersionChanges } from "./apply-commit";
import { applyExtraFileWrites } from "./apply-extra-writes";
import type { OrchestratorContext } from "./context";
import { formatChangedFiles } from "./format-changed-files";
import { runGroupPreVersionCommands, runHook } from "./hooks";

// ── Apply phase ─────────────────────────────────────────────────────

/**
 * Regenerate the lockfile (no lifecycle scripts), then check that a frozen
 * install accepts it, so a release never pushes a lockfile the branch cannot
 * install. The check runs where the adapter has one that neither installs nor
 * needs the network (pnpm), unless `release.verifyLockfile` is `false`.
 *
 * A failed regeneration only soft-fails when nothing is checked, or when the
 * package manager is not installed here at all; otherwise it throws, so the
 * version commit never carries a lockfile that was never regenerated.
 */
export const syncLockfile = async (context: OrchestratorContext): Promise<void> => {
    const verify = context.config.verifyLockfile;

    if (verify === true && !context.pm.verifyLockfile) {
        throw new VisReleaseError({
            code: "CONFIG_INVALID",
            message: `release.verifyLockfile is not supported for ${context.pm.id} (only pnpm); remove it or set it to false.`,
        });
    }

    const verifying = verify !== false && context.pm.verifyLockfile !== undefined;

    try {
        await context.pm.installLockfileOnly({ cwd: context.cwd, silent: true });
    } catch (error) {
        if (!verifying) {
            return;
        }

        const probe = await context.pm.runner.run(context.pm.id, ["--version"], { cwd: context.cwd, silent: true });

        if (probe.exitCode !== 0) {
            return;
        }

        throw error;
    }

    if (verifying) {
        await context.pm.verifyLockfile?.({ cwd: context.cwd });
    }
};
export interface ApplyOptions {
    /** Stage + commit changed files after writing. Default `false`. */
    commit?: boolean;
    /** Override commit message template (defaults from RFC §19.5). */
    commitMessage?: string;
    dryRun?: boolean;

    /**
     * Under `tagTarget: "source"`, the commit the commit's `Release-Source`
     * trailer names. Default: HEAD before committing.
     */
    releaseSource?: string;
}

export interface ApplyResult {
    changedFiles: string[];
    /** Sha of the release commit, when `commit: true`. */
    commitSha?: string;
    deletedFiles: string[];
    plan: ReleasePlan;
}

/**
 * Refuse to start a new version or publish wave when the staged-publish
 * registry already records a pending tarball for a package in the
 * current plan. Without this guard, a re-version would obsolete the
 * pending tarball and a re-publish would create a parallel stage —
 * either case lands the registry in a confusing two-tarballs-one-version
 * shape that's painful to unwind.
 *
 * Self-healing: before blocking, every conflict is checked against the
 * registry with `npm view &lt;pkg>@&lt;version> dist.tarball`. If the version
 * is already live, the operator approved the stage out-of-band (e.g.
 * via npmjs.com UI) and the registry entry is silently drained instead
 * of throwing. Without this, an out-of-band approval would force the
 * operator to manually edit staged.json — bad DX.
 *
 * The optional `preloaded` registry argument lets the publish path
 * avoid a second file read.
 */
export interface AssertNoConflictingPendingStagesOptions {
    /**
     * Persist self-heal drains to disk. Defaults to `true` (publish
     * behaviour). The version phase passes `false` so the in-memory
     * drain doesn't produce a write that would be lost on the next CI
     * runner's fresh clone — the publish phase that follows re-runs
     * self-heal and writes durably.
     */
    persistSelfHeal?: boolean;
    /** Optional injected runner (defaults to the real shell runner). */
    runner?: import("../package-managers/interface").CommandRunner;
    /** Skip the npm-view self-heal step (used in tests). */
    skipSelfHeal?: boolean;
}

export const assertNoConflictingPendingStages = async (
    context: OrchestratorContext,
    phase: "publish" | "version",
    preloaded?: import("../../types").StagedRegistryFile,
    options: AssertNoConflictingPendingStagesOptions = {},
): Promise<void> => {
    const { findConflictingPendingStages, readStagedRegistry, removePendingStages, writeStagedRegistry } = await import("../staged-registry");
    const changesDir = context.config.changesDir ?? DEFAULT_CHANGES_DIR;
    let registry = preloaded ?? (await readStagedRegistry(context.cwd, changesDir));

    if (registry.pending.length === 0) {
        return;
    }

    const planByName = new Map(context.plan.releases.map((r) => [r.name, r.newVersion] as const));
    const planNames = [...planByName.keys()];

    // Same-package conflicts are only a real problem when versions
    // differ. A pending `pkg@1.2.0` against a plan for `pkg@1.2.1` is
    // the orphan-risk case (block). A pending `pkg@1.2.0` against a
    // plan for `pkg@1.2.0` is the resume case (allow — the publish
    // loop's per-package action will see the existing stage and either
    // resolve through `alreadyPublished` or re-stage; either is correct).
    let conflicts = findConflictingPendingStages(registry, planNames).filter((entry) => planByName.get(entry.name) !== entry.version);

    if (conflicts.length === 0) {
        return;
    }

    // Self-heal: out-of-band approvals look like "version is live on the
    // registry but our staged.json still says pending". Run a cheap
    // `npm view` for each conflict; drain anything that's already live.
    // Bounded by the size of `conflicts`, which is in turn bounded by the
    // size of the release plan (single-digit at typical workspace scale).
    let resolved: string[] = [];

    if (!options.skipSelfHeal) {
        const runner = options.runner ?? createShellRunner();

        // Run the `npm view` round-trips concurrently. The check is read-
        // only on the registry and each query is independent. At typical
        // workspace scale (single-digit conflicts) the speedup is small;
        // at pathological scale (50+ stuck stages on a flipped config)
        // it's the difference between a sub-second preflight and a 15-
        // second one.
        const lookups = await Promise.all(
            conflicts.map(async (entry) => {
                const npmView = await runner.run("npm", ["view", `${entry.name}@${entry.version}`, "dist.tarball", "--silent"], {
                    cwd: context.cwd,
                    silent: true,
                });

                // npm prints the tarball URL on stdout when the version is
                // live. On 404 / non-zero exit, the version isn't
                // published yet → keep the entry as a real conflict.
                return npmView.exitCode === 0 && npmView.stdout.trim().length > 0 ? entry.id : undefined;
            }),
        );

        resolved = lookups.filter((id): id is string => id !== undefined);
    }

    if (resolved.length > 0) {
        registry = removePendingStages(registry, resolved);

        if (options.persistSelfHeal !== false) {
            try {
                await writeStagedRegistry(context.cwd, changesDir, registry);
            } catch {
                // Soft-fail: a write hiccup shouldn't block the release. The
                // entry will be re-resolved on the next wave.
            }
        }

        // Re-check with the same "different version is the orphan-risk
        // case" filter (the resume case stays allowed).
        conflicts = findConflictingPendingStages(registry, planNames).filter((entry) => planByName.get(entry.name) !== entry.version);

        if (conflicts.length === 0) {
            return;
        }
    }

    const summary = conflicts.map((entry) => `  • ${entry.name}@${entry.version} — stage ${entry.id} (${entry.reason}, recorded ${entry.stagedAt})`).join("\n");

    const verb = phase === "version" ? "version" : "publish";

    throw new VisReleaseError({
        code: "STAGE_PENDING",
        hint: "Resolve via `vis release stage approve <id>` / `--all` or `vis release stage reject <id>`, commit the updated staged.json, then retry.",
        message: `Refusing to ${verb} — ${conflicts.length} package(s) have a pending stage from a prior wave:\n${summary}`,
    });
};

/**
 * Apply a release plan to disk: write package.json bumps + prepended
 * CHANGELOGs, delete consumed change files. Honors `dryRun`.
 *
 * Lockfile sync (RFC §14 step 6) runs after the writes complete.
 */
export const applyContext = async (context: OrchestratorContext, options: ApplyOptions = {}): Promise<ApplyResult> => {
    if (context.plan.releases.length === 0) {
        return { changedFiles: [], deletedFiles: [], plan: context.plan };
    }

    // Refuse to re-version a package that still has a pending stage from a
    // prior wave. Otherwise the new version would obsolete the staged
    // tarball — best case, two parallel stages confuse maintainers; worst
    // case, npm publishes them out of semver order. Operator must resolve
    // the prior stage (approve / reject) before re-versioning.
    //
    // persistSelfHeal: false — the version phase can self-heal in memory
    // to decide whether to throw, but committing the drained registry is
    // the publish phase's job (it's the step that actually changes git
    // state). Without this, a version-only workflow would write a drain
    // to disk that the next CI clone would lose anyway.
    await assertNoConflictingPendingStages(context, "version", undefined, { persistSelfHeal: false });

    if (!options.dryRun && context.config.preVersionCommand) {
        await runHook(context.cwd, context.config.preVersionCommand, "preVersionCommand");
    }

    // Group-scoped preVersion commands. Each `fixed`/`linked` group can opt
    // in via `groupPreVersionCommands["group-<index>"]`. Runs after the
    // workspace-level preVersionCommand, before any package mutations.
    if (!options.dryRun && context.config.groupPreVersionCommands) {
        await runGroupPreVersionCommands(context, context.config.groupPreVersionCommands);
    }

    const { readFileSync } = await import("node:fs");
    const { resolveFormatter } = await import("../changelog/resolve");
    const { resolveGroupChangelogRouting } = await import("../changelog/workspace");
    const formatter = await resolveFormatter(context.config.changelog, context.cwd);
    const date = new Date().toISOString().slice(0, 10);

    // Build the group-changelog routing once. Fixed/linked groups that
    // opt in via `changelog.mode: "shared"` get a single
    // `GROUP-CHANGELOG.md`; other packages fall back
    // to the default per-package routing.
    const groupRouting = resolveGroupChangelogRouting(context.config, context.packages, context.cwd);

    const applied = await applyReleasePlan(context.plan, context.depGraph, {
        changelogPath: (pkg) => groupRouting.get(pkg.name) ?? `${pkg.dir}/CHANGELOG.md`,
        internalDependencyRanges: context.config.internalDependencyRanges,
        readChangelog: (path) => {
            try {
                return readFileSync(path, "utf8");
            } catch {
                return undefined;
            }
        },
        readManifest: (path) => {
            try {
                return readFileSync(path, "utf8");
            } catch {
                return undefined;
            }
        },
        renderChangelogEntry: (release) =>
            formatter({
                changeFiles: release.changeFiles,
                date,
                release,
                target: "changelog",
            }),
    });

    await applyExtraFileWrites(context, applied);

    if (options.dryRun) {
        return {
            changedFiles: applied.writes.map((w) => w.path),
            deletedFiles: applied.deletions,
            plan: context.plan,
        };
    }

    // Writes + deletions in parallel — all targets are independent files.
    // For a 49-package release wave (98 writes + N deletions), parallel
    // saves the bulk of the wall-time vs sequential awaits.
    await Promise.all([
        ...applied.writes.map((write) => writeFile(write.path, write.content)),
        ...applied.deletions.map(async (path) => {
            try {
                await unlink(path);
            } catch {
                // ignore — file may have already been removed
            }
        }),
    ]);

    // Format changed files (RFC §14 step 7) — opt-in, scoped to the files the
    // version step just wrote (package.json bumps + CHANGELOG entries),
    // soft-fail.
    if (!options.dryRun && context.config.formatChangedFiles) {
        await formatChangedFiles(
            applied.writes.map((w) => w.path),
            context.cwd,
        );
    }

    // Lifecycle plugins: the draft (versions + changelogs + extra-files) is on
    // disk but NOT yet committed. Run applyDraft here so a thrown hook aborts
    // before the version commit (real fail-fast gate) and so edits a plugin
    // makes to the already-written files land in that commit. (Brand-new files
    // a plugin creates are its own responsibility to stage.)
    if (context.config.plugins?.length) {
        const { runApplyDraftHooks } = await import("../plugins");

        await runApplyDraftHooks({ config: context.config, cwd: context.cwd }, context.plan);
    }

    // Lockfile sync (RFC §19/§14) — after the plugins, which may still edit
    // manifests (e.g. dependency ranges), so the lockfile matches what is committed.
    await syncLockfile(context);

    const commitSha = options.commit ? await commitVersionChanges(context, applied, options.commitMessage, options.releaseSource) : undefined;

    // Workspace-level changelog is intentionally NOT written here — the
    // wave entry is appended from `publishContext` against the actually-
    // published set (`result.published[]`) instead of the optimistic plan.
    // Otherwise a stage rejected at the gate would leave an
    // orphan wave entry in CHANGELOG.md. Per-package CHANGELOG.md sections
    // are still written above as part of the version commit; their orphan-
    // risk is a documented operator workflow note — the `stage reject` post-
    // action prints an edit hint.

    if (!options.dryRun && context.config.postVersionCommand) {
        await runHook(context.cwd, context.config.postVersionCommand, "postVersionCommand");
    }

    // Pre-mode exit consolidation: when the file is in `exit-pending`
    // mode, this version run is the consolidation step — delete the
    // file so the next wave is a regular stable bump.
    //
    // Use the pinned `context.preMode` snapshot from
    // `buildContext` instead of re-reading pre.json here. Otherwise a
    // concurrent `vis release pre exit` between the two reads could
    // leave the version computed as prerelease (snapshot says
    // `undefined`) while this block fires the exit-pending cleanup
    // (re-read sees `exit-pending`) — or vice versa.
    if (!options.dryRun && context.preMode?.mode === "exit-pending") {
        const { deletePreMode, preModeFilePath } = await import("../pre-mode");
        const changesDir = context.config.changesDir ?? ".vis/release";
        const removed = await deletePreMode(context.cwd, changesDir);

        if (removed) {
            context.plan.warnings.push(
                `Pre-mode exited: \`${preModeFilePath(context.cwd, changesDir)}\` was deleted. Commit the deletion so the registry stays consistent across CI runs.`,
            );
        }
    }

    return {
        changedFiles: applied.writes.map((w) => w.path),
        commitSha,
        deletedFiles: applied.deletions,
        plan: context.plan,
    };
};
