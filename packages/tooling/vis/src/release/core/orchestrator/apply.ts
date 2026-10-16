import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_CHANGES_DIR } from "../../config";
import { VisReleaseError } from "../../errors";
import type { ReleasePlan } from "../../types";
import { applyReleasePlan } from "../apply-release-plan";
import { RELEASE_PLAN_ORDER } from "../ecosystems";
import { createShellRunner } from "../shell-runner";
import type { OrchestratorContext } from "./context";

// ── Apply phase ─────────────────────────────────────────────────────
export interface ApplyOptions {
    /** Stage + commit changed files after writing. Default `false`. */
    commit?: boolean;
    /** Override commit message template (defaults from RFC §19.5). */
    commitMessage?: string;
    dryRun?: boolean;
}

export interface ApplyResult {
    changedFiles: string[];
    /** Sha of the release commit, when `commit: true`. */
    commitSha?: string;
    deletedFiles: string[];
    plan: ReleasePlan;
}

/**
 * Apply a release plan to disk: write package.json bumps + prepended
 * CHANGELOGs, delete consumed change files. Honors `dryRun`.
 *
 * Lockfile sync (RFC §14 step 6) runs after the writes complete.
 */

/**
 * Run a configured shell hook command (preVersionCommand / postVersionCommand /
 * prePublishCommand / postPublishCommand). Empty string skips silently.
 * Throws if the command exits non-zero.
 *
 * Cross-platform: uses `cmd /c &lt;cmd>` on Windows, `sh -c &lt;cmd>` elsewhere.
 */
export const runHook = async (cwd: string, command: string, label: string): Promise<void> => {
    if (!command || command.trim() === "") {
        return;
    }

    const runner = createShellRunner();
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd" : "sh";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];

    const result = await runner.run(shell, shellArgs, { cwd, silent: false });

    if (result.exitCode !== 0) {
        throw new Error(`${label} failed (exit ${result.exitCode}): ${command}`);
    }
};

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
        const { normaliseGroup } = await import("../../types");
        const allGroups = [...(context.config.fixed ?? []), ...(context.config.linked ?? [])].map((g) => normaliseGroup(g));
        const { default: zeptomatch } = await import("zeptomatch");

        for (const [groupKey, command] of Object.entries(context.config.groupPreVersionCommands)) {
            const groupIndex = Number.parseInt(groupKey.replace(/^group-/, ""), 10);
            const group = allGroups[groupIndex];

            if (!group) {
                continue;
            }

            // Only run if the group has at least one package being released this wave.
            // Group entries can be literal names OR glob patterns — match both.
            const groupTouched = context.plan.releases.some((r) =>
                group.packages.some((memberPattern) => r.name === memberPattern || zeptomatch(memberPattern, r.name)),
            );

            if (!groupTouched) {
                continue;
            }

            await runHook(context.cwd, command, `groupPreVersionCommand[${groupKey}]`);
        }
    }

    const fs = await import("node:fs/promises");
    const { readFileSync } = await import("node:fs");
    const { resolveFormatter } = await import("../changelog/resolve");
    const { resolveGroupChangelogRouting } = await import("../changelog/workspace");
    const formatter = await resolveFormatter(context.config.changelog, context.cwd);
    const date = new Date().toISOString().slice(0, 10);

    // Build the group-changelog routing once. Fixed/linked groups that
    // opt in via `changelog.mode: "shared"` get a single
    // `GROUP-CHANGELOG.md` (changesets #1059); other packages fall back
    // to the default per-package routing.
    const groupRouting = resolveGroupChangelogRouting(context.config, context.packages, context.cwd);

    const applied = await applyReleasePlan(context.plan, context.depGraph, {
        changelogPath: (pkg) => groupRouting.get(pkg.name) ?? `${pkg.dir}/CHANGELOG.md`,
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

    // Apply extra-files rules and built-in versionFiles per release. Both
    // produce writes that are appended to the applied set so the existing
    // commit + dry-run code paths pick them up automatically.
    const extraFileWarnings: string[] = [];

    {
        const { applyExtraFilesForRelease } = await import("../extra-files");
        const { applyVersionFilesForRelease } = await import("../version-files");
        const { cargoManifestPaths } = await import("../cargo-lock");

        const perReleaseResults = await Promise.all(
            context.plan.releases.map(async (release) => {
                const pkg = context.depGraph.getPackage(release.name);

                if (!pkg) {
                    return { warnings: [], writes: [] };
                }

                const perPkgRules = context.perPackageConfig.get(release.name)?.extraFiles ?? [];
                const workspaceRules = context.config.publish?.extraFiles ?? [];
                const versionFiles = context.perPackageConfig.get(release.name)?.versionFiles ?? [];

                const hasExtraRules = perPkgRules.length > 0 || workspaceRules.length > 0;
                const extra = hasExtraRules
                    ? await applyExtraFilesForRelease(context.cwd, pkg.dir, release.newVersion, release.name, workspaceRules, perPkgRules)
                    : { warnings: [], writes: [] };

                // Runs after extraFiles and reads its output, so a file named by
                // both is rewritten once with both edits instead of the later write
                // silently discarding the earlier one.
                const versioned
                    = versionFiles.length > 0
                        ? await applyVersionFilesForRelease(pkg.dir, versionFiles, release.newVersion, release.name, new Map(extra.writes.map((write) => [write.path, write.content])))
                        : { writes: [] };

                return { warnings: extra.warnings, writes: [...extra.writes, ...versioned.writes] };
            }),
        );

        // Cargo edits are planned once for the whole wave: crate versions,
        // dependents' requirements and Cargo.lock. Per-release steps started
        // from the original files, so two releases in one file (or one lock)
        // silently dropped each other's edit. Everything below reads and
        // writes one pending map.
        const pending = new Map<string, string>();
        const touched = new Set<string>();

        for (const result of perReleaseResults) {
            for (const write of result.writes) {
                pending.set(write.path, write.content);
                touched.add(write.path);
            }

            extraFileWarnings.push(...result.warnings);
        }

        const cargoCrates = context.packages.filter((pkg) => pkg.ecosystem === "cargo");
        const planReleases = context.plan.releases.flatMap((release) => {
            const pkg = context.depGraph.getPackage(release.name);

            // Python projects, Maven and Gradle modules have their own plans (planPythonWorkspace,
            // planMavenWorkspace, planGradleWorkspace); a uv.lock is not a Cargo.lock, and a pom or a build script is not one either.
            if (!pkg || (pkg.ecosystem !== undefined && pkg.ecosystem !== "cargo")) {
                return [];
            }

            const manifestPaths
                = pkg.ecosystem === "cargo" ? [pkg.manifestPath] : cargoManifestPaths(pkg.dir, context.perPackageConfig.get(release.name) ?? {});

            return manifestPaths.length > 0 || pkg.ecosystem === "cargo"
                ? [{ ecosystem: pkg.ecosystem, manifestPaths, name: release.name, newVersion: release.newVersion }]
                : [];
        });

        if (planReleases.length > 0) {
            // Every Cargo manifest a JS package claims is rescanned too, so a
            // dependent in a JS-owned crate still gets its requirement moved.
            const scanManifests = new Set(cargoCrates.map((pkg) => pkg.manifestPath));

            // A virtual root has no [package], so discovery never returns it, but its
            // [workspace.dependencies] requirements must still follow a bumped crate.
            if (cargoCrates.length > 0) {
                scanManifests.add(resolve(context.cwd, "Cargo.toml"));
            }

            for (const pkg of context.packages) {
                if (pkg.ecosystem === undefined) {
                    for (const manifestPath of cargoManifestPaths(pkg.dir, context.perPackageConfig.get(pkg.name) ?? {})) {
                        scanManifests.add(manifestPath);
                    }
                }
            }

            const { planCargoWorkspace } = await import("../cargo-plan");
            const cargo = await planCargoWorkspace({
                crateManifests: cargoCrates.map((pkg) => pkg.manifestPath),
                cwd: context.cwd,
                pending,
                releases: planReleases,
                // Other crates' requirements move only for discovered crates; a `cargo()` package keeps its lock in step.
                rewriteDependents: context.config.cargo?.discover === true,
                scanManifests: [...scanManifests],
            });

            for (const path of cargo.touched) {
                touched.add(path);
            }

            extraFileWarnings.push(...cargo.warnings);
        }

        // Cargo planned above: its release filter also covers JS packages that claim a Cargo manifest. The rest run in plan order.
        for (const eco of RELEASE_PLAN_ORDER) {
            const releases = context.plan.releases.flatMap((release) => {
                const pkg = context.depGraph.getPackage(release.name);

                return pkg?.ecosystem === eco.id ? [{ name: release.name, newVersion: release.newVersion }] : [];
            });

            if (releases.length === 0 || eco.plan === undefined) {
                continue;
            }

            const outcome = await eco.plan({ context, pending, projects: context.projectsByEcosystem?.get(eco.id) ?? [], releases });

            for (const path of outcome.touched) {
                touched.add(path);
            }

            extraFileWarnings.push(...outcome.warnings);
        }

        for (const path of touched) {
            applied.writes.push({ content: pending.get(path)!, path });
        }

        // Surface warnings through plan.warnings so they bubble up to
        // CI logs alongside the other release warnings.
        if (extraFileWarnings.length > 0) {
            context.plan.warnings.push(...extraFileWarnings);
        }
    }

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

    // Lockfile sync (RFC §19/§14)
    try {
        await context.pm.installLockfileOnly({ cwd: context.cwd, silent: true });
    } catch {
        // Soft-fail: not all CI environments have the pm available, and we'd
        // rather ship the version commit than block on lockfile noise.
    }

    // Format changed files (RFC §14 step 7) — opt-in, scoped to the files the
    // version step just wrote (package.json bumps + CHANGELOG entries),
    // soft-fail. Runs after lockfile sync so a reformatted lockfile (if the
    // PM emitted one) is included.
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

    let commitSha: string | undefined;

    if (options.commit) {
        const { stageAndCommit } = await import("../git");
        const runner = createShellRunner();

        // Lockfile paths to also stage (best-effort; some PMs don't have one yet).
        const lockfileCandidates = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];
        const path = await import("node:path");
        const lockfilesPresent: string[] = [];

        for (const name of lockfileCandidates) {
            try {
                await fs.access(path.join(context.cwd, name));
                lockfilesPresent.push(path.join(context.cwd, name));
            } catch {
                // not present
            }
        }

        const aggregateEnabled
            = context.config.aggregateRelease === true || (typeof context.config.aggregateRelease === "object" && context.config.aggregateRelease.enabled);

        // RFC §19.5: one release commit per package (multi-semantic-release
        // parity) when opted in and not aggregating. Shared artifacts
        // (lockfiles + consumed change-file deletions) ride in the final
        // package's commit. The per-package template ignores any aggregate
        // `options.commitMessage` override (it's inherently single-message).
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

                commitSha = await stageAndCommit({ cwd: context.cwd, runner }, files, `release(${channel}): ${release.name}@${release.newVersion} [skip ci]`, {
                    author: context.config.gitUser,
                });
            }
        } else {
            // Single aggregate commit for the whole wave (default).
            const message = options.commitMessage ?? buildDefaultCommitMessage(context);
            const allFiles = [...applied.writes.map((w) => w.path), ...applied.deletions, ...lockfilesPresent];

            commitSha = await stageAndCommit({ cwd: context.cwd, runner }, allFiles, message, { author: context.config.gitUser });
        }
    }

    // Workspace-level changelog is intentionally NOT written here — the
    // wave entry is appended from `publishContext` against the actually-
    // published set (`result.published[]`) instead of the optimistic plan
    // (C5 fix). Otherwise a stage rejected at the gate would leave an
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
    // M9 fix: use the pinned `context.preMode` snapshot from
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

type PrettierModule = {
    format: (source: string, options: Record<string, unknown>) => Promise<string>;
    getFileInfo: (file: string) => Promise<{ ignored: boolean; inferredParser: null | string }>;
    resolveConfig: (file: string) => Promise<Record<string, unknown> | null>;
};

/**
 * Run the project's Prettier over the version step's written files (RFC §14
 * step 7). Scoped to those files only; resolves the *project's* Prettier from
 * `cwd` (not vis's own). Soft-fails entirely when Prettier isn't installed,
 * and skips any file Prettier ignores or can't infer a parser for. Never
 * throws — formatting must not fail a release.
 */
const formatChangedFiles = async (files: string[], cwd: string): Promise<void> => {
    if (files.length === 0) {
        return;
    }

    const { join } = await import("node:path");

    let prettier: PrettierModule;

    try {
        const { createRequire } = await import("node:module");
        const { pathToFileURL } = await import("node:url");
        const requireFromProject = createRequire(join(cwd, "package.json"));

        prettier = (await import(pathToFileURL(requireFromProject.resolve("prettier")).href)) as PrettierModule;
    } catch {
        // Prettier not installed in the target project — skip silently.
        return;
    }

    const fsp = await import("node:fs/promises");

    for (const file of files) {
        try {
            const info = await prettier.getFileInfo(file);

            if (info.ignored || !info.inferredParser) {
                continue;
            }

            const source = await fsp.readFile(file, "utf8");
            const config = await prettier.resolveConfig(file);
            const formatted = await prettier.format(source, { ...config, filepath: file });

            if (formatted !== source) {
                await fsp.writeFile(file, formatted);
            }
        } catch {
            // Per-file soft-fail — never break a release on a formatting error.
        }
    }
};

const buildDefaultCommitMessage = (context: OrchestratorContext): string => {
    const channel = context.channel?.tag ?? context.branch ?? "main";
    const { releases } = context.plan;
    const summary = releases.length <= 3 ? releases.map((r) => `${r.name}@${r.newVersion}`).join(", ") : `version ${releases.length} packages`;

    const details = releases.map((r) => `- ${r.name}: ${r.oldVersion} → ${r.newVersion}`).join("\n");

    return `release(${channel}): ${summary} [skip ci]\n\n${details}`;
};
