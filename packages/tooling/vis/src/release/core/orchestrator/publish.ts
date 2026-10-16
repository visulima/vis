import { DEFAULT_CHANGES_DIR } from "../../config";
import { VisReleaseError } from "../../errors";
import type { PackageManifest } from "../../types";
import { parseCatalogs } from "../catalog";
import { createShellRunner } from "../shell-runner";
import type { VersionActions } from "../version-actions/interface";
import { createVersionActions } from "../version-actions/registry";
import { resolveVersionActionsId } from "../workspace";
import { assertNoConflictingPendingStages, runHook } from "./apply";
import type { OrchestratorContext } from "./context";
import { createRemoteReleases, shouldProvenance } from "./remote-releases";

// ── Publish phase ──────────────────────────────────────────────────
export interface PublishContextOptions {
    dryRun?: boolean;
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

/**
 * Commit + push the git-tracked publish lock (`release.publish.lockInGit`).
 * `open` is committed at the start of a wave (so an ephemeral runner can resume
 * if this one dies); `progress` checkpoints in-flight state mid-wave; `close`
 * commits the lock removal on full success. Soft-fail — a commit hiccup must not
 * fail an otherwise-successful publish. A failed *push* is surfaced as a warning
 * because it silently breaks cross-runner resume.
 */
const commitPublishLock = async (
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
 * Tags a publish of the current plan pushes: release tags it creates (per
 * package, or one per `syncGitTag` group) and floating major tags it moves.
 * Mirrors the tagging in {@link publishContext}; private packages are skipped
 * because they are never published, so never tagged.
 */
const plannedPushTags = async (context: OrchestratorContext): Promise<{ created: string[]; updated: string[] }> => {
    const { defaultTagFor, floatingMajorTagFor, renderTagPattern } = await import("../git");
    const { resolveSyncTagGroups } = await import("../group-tags");
    const planned = context.plan.releases
        .filter((release) => context.depGraph.getPackage(release.name)?.manifest?.private !== true)
        .map((release) => {
            return { name: release.name, version: release.newVersion };
        });
    const syncTags = resolveSyncTagGroups(context.config, planned);
    const created = syncTags.groups.map((group) => group.tag);
    const updated: string[] = [];
    const isPrerelease = Boolean(context.channel?.prerelease) || Boolean(context.preMode);

    for (const { name, version } of planned) {
        if (syncTags.grouped.has(name)) {
            continue;
        }

        const perPkg = context.perPackageConfig.get(name);
        const pattern = perPkg?.releaseTagPattern ?? context.config.releaseTagPattern;

        created.push(pattern ? renderTagPattern(pattern, { channel: context.channel?.tag, name, version }) : defaultTagFor(name, version));

        if (context.config.floatingMajorTag === true && !isPrerelease && !pattern?.includes("{major}") && perPkg?.skipNpmPublish !== true) {
            const floatTag = floatingMajorTagFor(name, version);

            if (floatTag !== undefined) {
                updated.push(floatTag);
            }
        }
    }

    return { created, updated };
};

/**
 * Check, before anything is published, that this run's pushes will be
 * accepted: a dry-run push proves the token authenticates, and on GitHub the
 * rulesets / branch protection covering the release tags and branch are read
 * through the API, since a dry-run never reaches them. Returns the failure
 * reason, or `undefined` to go ahead; problems with soft-fail pushes only
 * print warnings. Skipped without an `origin` remote (nothing to push to).
 */
const verifyReleasePushes = async (
    context: OrchestratorContext,
    runner: ReturnType<typeof createShellRunner>,
    options: { noTag: boolean },
): Promise<string | undefined> => {
    const originResult = await runner.run("git", ["remote", "get-url", "--push", "origin"], { cwd: context.cwd, silent: true });

    if (originResult.exitCode !== 0) {
        return undefined;
    }

    const { getCurrentBranch, resolvePushCredentials, verifyPushAccess } = await import("../git");
    const gitContext = { cwd: context.cwd, runner };
    const pushError = await verifyPushAccess(gitContext);

    if (pushError !== undefined) {
        return `Cannot push to origin, nothing was published. Set VIS_GH_TOKEN (or GITHUB_TOKEN / GITLAB_TOKEN) with write access, or pass --no-push. git said: ${pushError}`;
    }

    const { createRemoteClient, detectRemoteProvider } = await import("../remote/detect");
    let provider: Awaited<ReturnType<typeof detectRemoteProvider>>;

    try {
        provider = await detectRemoteProvider(context.cwd, runner, context.config.provider);
    } catch {
        return undefined;
    }

    if (provider !== "github") {
        return undefined;
    }

    const client = createRemoteClient(provider, { githubHost: context.config.githubHost, httpProxy: context.config.httpProxy });
    const repo = await client.detectRepoSlug(context.cwd, runner);

    if (!repo) {
        return undefined;
    }

    // Bypass rights are per identity: ask with the token the push will use.
    const credentials = await resolvePushCredentials(gitContext);
    const ghEnv: NodeJS.ProcessEnv = { ...process.env };

    if (credentials !== undefined) {
        ghEnv["GH_TOKEN"] = credentials.token;
    }

    if (context.config.githubHost) {
        ghEnv["GH_HOST"] = context.config.githubHost;
    }

    if (context.config.httpProxy) {
        ghEnv["HTTPS_PROXY"] = context.config.httpProxy;
        ghEnv["HTTP_PROXY"] = context.config.httpProxy;
    }

    const { checkGithubPushRules } = await import("../remote/github-push-rules");
    const tags = options.noTag ? { created: [], updated: [] } : await plannedPushTags(context);
    const rules = await checkGithubPushRules(runner, {
        branch: await getCurrentBranch(gitContext),
        createdTags: tags.created,
        cwd: context.cwd,
        env: ghEnv,
        repo,
        signedCommits: context.config.gitSignCommits === true,
        updatedTags: tags.updated,
    });

    for (const warning of rules.warnings) {
        process.stderr.write(`[vis release] Warning: ${warning}\n`);
    }

    if (rules.blocked.length > 0) {
        return `GitHub push rules would reject this release, nothing was published:\n  - ${rules.blocked.join("\n  - ")}\nGrant the pushing token a bypass, adjust the ruleset, or pass --no-push / --no-tag.`;
    }

    return undefined;
};

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

    // In-flight version-PR check (RFC §19.1) — refuse to publish locally
    // if an open release PR exists, to catch the cross-machine race where
    // a developer runs `vis release publish` while CI is mid-release-PR cycle.
    if (!options.dryRun && context.channel?.mode === "version-pr") {
        const { createRemoteClient, detectRemoteProvider } = await import("../remote/detect");
        const provider = await detectRemoteProvider(context.cwd, runner, context.config.provider);
        const client = createRemoteClient(provider, {
            githubHost: context.config.githubHost,
            gitlabHost: context.config.gitlabHost,
            httpProxy: context.config.httpProxy,
        });
        const repo = await client.detectRepoSlug(context.cwd, runner);
        const branch = context.config.versionPr?.branch ?? "vis-release/version-packages";

        if (repo) {
            try {
                // gh CLI: list open PRs from the version-PR branch.
                const list = await runner.run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number"], {
                    cwd: context.cwd,
                    silent: true,
                });

                if (list.exitCode === 0 && list.stdout.trim() && list.stdout.trim() !== "[]") {
                    const parsed = JSON.parse(list.stdout) as { number: number }[];

                    if (parsed[0]) {
                        result.failed.push({
                            name: "_preflight",
                            reason: `Open release PR #${parsed[0].number} exists. Merge or close it before publishing locally. (Override: --no-push then \`git push --tags\` manually.)`,
                        });

                        return result;
                    }
                }
            } catch {
                // gh not available — skip the check (fail-open).
            }
        }
    }

    if (!options.dryRun && context.config.prePublishCommand) {
        try {
            await runHook(context.cwd, context.config.prePublishCommand, "prePublishCommand");
        } catch (error) {
            result.failed.push({ name: "_prePublishCommand", reason: (error as Error).message });

            return result;
        }
    }

    // Fail before publishing when the pushes later in this run would be
    // rejected, so packages don't land on the registry without their tags.
    if (!options.dryRun && !options.noPush) {
        const pushError = await verifyReleasePushes(context, runner, { noTag: options.noTag === true });

        if (pushError !== undefined) {
            result.failed.push({ name: "_pushAccess", reason: pushError });

            return result;
        }
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
        // Resume support: read state file, skip already-published packages.
        const { clearState, filterPlanByState, newState, readState, writeState } = await import("../state");
        const { readStagedRegistry, removePendingStages, upsertPendingStages, writeStagedRegistry } = await import("../staged-registry");
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

        // Build catalog for catalog: rewriting (only relevant for pnpm; harmless otherwise)
        const catalogYaml = await context.pm.readCatalogYaml(context.cwd);
        const catalogs = parseCatalogs(catalogYaml);

        // Topo-sort the (possibly resume-filtered) release subset
        const order = context.depGraph.topologicalSort(releases.map((r) => r.name));

        // O(1) lookup by name in the publish loop (was O(n²) via Array.find)
        const releaseByName = new Map(releases.map((r) => [r.name, r] as const));

        // Names that must not have dependents published after them: either the
        // package's own publish threw, or it was skipped because one of *its*
        // runtime dependencies was already in this set. Topo order guarantees a
        // dependency is processed before its dependents, so by the time we
        // reach a dependent every blocking ancestor is already recorded here.
        const failedNames = new Set<string>();

        // Build name → versioned manifest map for protocol resolution
        const versionedManifestByName = new Map<string, PackageManifest>();

        for (const release of context.plan.releases) {
            const pkg = context.depGraph.getPackage(release.name);

            if (pkg) {
                versionedManifestByName.set(release.name, { ...pkg.manifest, version: release.newVersion });
            }
        }

        // Lifecycle plugins (loaded once for the wave).
        const pluginBase = { config: context.config, cwd: context.cwd };
        const pluginHooks = context.config.plugins?.length ? await import("../plugins") : undefined;

        for (const name of order) {
            const release = releaseByName.get(name);

            if (!release) {
                // Should never happen — the topo sort runs over the same names
                // we put into releaseByName. If it does, surface it via the
                // result.skipped channel so downstream tooling can spot the bug.
                result.skipped.push({ name, reason: "topo-sort returned a name not in the release plan (internal bug)" });
                continue;
            }

            const pkg = context.depGraph.getPackage(name);

            if (!pkg) {
                continue;
            }

            // Don't orphan a dependent. If one of this package's internal
            // runtime dependencies failed to publish (or was itself skipped
            // for the same reason), the `workspace:` range we rewrite at pack
            // time would resolve to a version that never reached the registry,
            // leaving consumers with an uninstallable tree. Skip the cascade
            // and surface why. devDependencies are excluded — they aren't
            // installed by downstream consumers and the topo sort already
            // ignores them for ordering.
            const blockingDeps = [
                ...new Set(
                    context.depGraph
                        .getDependencies(name)
                        .filter((dep) => dep.kind !== "devDependencies" && failedNames.has(dep.name))
                        .map((dep) => dep.name),
                ),
            ];

            if (blockingDeps.length > 0) {
                result.skipped.push({
                    name,
                    reason: `dependency-failed: not published because ${blockingDeps.join(", ")} failed to publish (publishing would orphan this package's dependency range)`,
                });
                failedNames.add(name);
                continue;
            }

            const perPkg = context.perPackageConfig.get(name) ?? {};
            const actionsId = resolveVersionActionsId(pkg, perPkg);
            const actions = options.publishActionsOverride ?? createVersionActions(actionsId);

            const tag = options.tag ?? context.channel?.tag;

            // willPublish gate: a plugin can veto this package's publish.
            if (pluginHooks) {
                const verdict = await pluginHooks.runWillPublishHooks(pluginBase, {
                    dir: pkg.dir,
                    name,
                    oldVersion: release.oldVersion,
                    version: release.newVersion,
                });

                if (verdict.skip) {
                    result.skipped.push({ name, reason: `plugin-skipped${verdict.by ? ` by "${verdict.by}"` : ""}` });
                    // Treat a veto like a non-publish: mark it so dependents later
                    // in the topo order are skipped by the `blockingDeps` guard
                    // rather than published against a `workspace:` range that
                    // resolves to a version this veto kept off the registry.
                    failedNames.add(name);
                    continue;
                }
            }

            // Resume the existing stage when staged.json already holds an
            // entry for this exact (name, version). The action's publish
            // method short-circuits pack+publish and resumes the wait —
            // re-uploading would either be rejected by npm or create a
            // parallel stage.
            const existingStage = stagedRegistry.pending.find((entry) => entry.name === name && entry.version === release.newVersion);

            try {
                const out = await actions.publish({
                    catalogs,
                    cleanPackageJsonConfig: context.config.publish?.cleanPackageJson,
                    dryRun: options.dryRun,
                    otp: options.otp,
                    perPackageConfig: perPkg,
                    pkg,
                    pm: context.pm,
                    provenance: shouldProvenance(context),
                    registry: perPkg.registry,
                    release,
                    resumeStageId: existingStage?.id,
                    tag,
                    versionedManifestByName,
                    workspaceConfig: context.config,
                });

                // Drain any stale pending-stage entries for this exact
                // (package, version) regardless of outcome. Covers two paths:
                //   - approved in this run (npm.ts clears out.stageId, but the
                //     entry we wrote in a prior wave is still in staged.json)
                //   - already-published (operator approved a timed-out stage
                //     out-of-band via npmjs.com UI; we never see a stageId
                //     here, just a "version is now live" signal)
                if (out.published || out.alreadyPublished) {
                    const idsToDrop = stagedRegistry.pending
                        .filter((entry) => entry.name === name && entry.version === release.newVersion)
                        .map((entry) => entry.id);

                    if (idsToDrop.length > 0) {
                        stagedRegistry = removePendingStages(stagedRegistry, idsToDrop);
                    }
                }

                if (out.published) {
                    result.published.push({ name, stageId: out.stageId, tarball: out.tarball, version: release.newVersion });
                    state.published.push(`${name}@${release.newVersion}`);

                    // afterPublish: post-effect hook (errors logged, not fatal).
                    if (pluginHooks) {
                        await pluginHooks.runAfterPublishHooks(pluginBase, { dir: pkg.dir, name, oldVersion: release.oldVersion, version: release.newVersion });
                    }
                } else if (out.alreadyPublished) {
                    result.skipped.push({ name, reason: "already-published" });
                    // Treat as published for resume purposes — re-running won't try again.
                    state.published.push(`${name}@${release.newVersion}`);
                } else {
                    result.skipped.push({ name, reason: out.output ?? "skipped" });

                    // Rejected / timed-out stages flow through here. Record
                    // them in the persistent registry so the operator can
                    // come back later (workflow re-run, `stage approve --all`,
                    // npmjs.com UI) without losing the id.
                    if (out.stageId) {
                        const reason = (out.output ?? "").startsWith("stage-rejected") ? "rejected" : "timeout";

                        stagedRegistry = upsertPendingStages(stagedRegistry, [
                            {
                                id: out.stageId,
                                name,
                                reason,
                                stagedAt: new Date().toISOString(),
                                tag: tag ?? "latest",
                                version: release.newVersion,
                            },
                        ]);
                    }
                }

                // Per-package durability: persist + (for lockInGit) commit/push
                // after each package so a death anywhere in the loop lets a fresh
                // runner resume with the exact already-published set.
                await persistState();
            } catch (error) {
                result.failed.push({ name, reason: (error as Error).message });
                // Mark so dependents downstream in the topo order are skipped
                // rather than published against a missing dependency version.
                failedNames.add(name);
            }
        }

        // afterPublishAll: post-effect wave summary hook (errors logged, not fatal).
        if (pluginHooks) {
            await pluginHooks.runAfterPublishAllHooks(pluginBase, {
                failed: result.failed.map((f) => {
                    return { name: f.name, reason: f.reason };
                }),
                published: result.published.map((p) => {
                    return { name: p.name, version: p.version };
                }),
                skipped: result.skipped.map((s) => {
                    return { name: s.name, reason: s.reason };
                }),
            });
        }

        // syncGitTag groups: members collapse to one shared tag +
        // aggregate release. Resolved once for the wave — both the tag-creation
        // phase below and createRemoteReleases consume it (no double resolution).
        const { resolveSyncTagGroups } = await import("../group-tags");
        const syncTags = resolveSyncTagGroups(context.config, result.published);

        // Create + push tags for successfully-published releases (RFC §14 / §19.1).
        if (!options.dryRun && !options.noTag && result.published.length > 0) {
            const { createOrUpdateFloatingTag, createTag, defaultTagFor, floatingMajorTagFor, pushTags, renderTagPattern } = await import("../git");
            const rootTagPattern = context.config.releaseTagPattern;

            const channelName = context.channel?.tag;
            const floatingMajorEnabled = context.config.floatingMajorTag === true;
            // Floating major tags must NOT move across prerelease channels —
            // an unstable `v1` pointer would yank consumers from a stable
            // major into a half-finished release. Skipped when the active
            // channel resolved to a prerelease identifier.
            const isPrerelease = Boolean(context.channel?.prerelease) || Boolean(context.preMode);

            for (const { name, version } of result.published) {
                if (syncTags.grouped.has(name)) {
                    continue;
                }

                const perPkgPattern = context.perPackageConfig.get(name)?.releaseTagPattern;
                const pattern = perPkgPattern ?? rootTagPattern;
                const tag = pattern ? renderTagPattern(pattern, { channel: channelName, name, version }) : defaultTagFor(name, version);

                try {
                    await createTag(
                        { cwd: context.cwd, runner },
                        tag,
                        `Release ${name}@${version}`,
                        // First-release bootstraps a brand-new tag history —
                        // there's no remote to consult, and a left-over orphan
                        // would simply be re-published this wave. Skip the
                        // remote pre-check so the very first run on a fresh
                        // repo doesn't error.
                        { signing: context.config.signing, skipRemoteCheck: context.firstRelease },
                    );
                    result.tags.push(tag);
                } catch (error) {
                    // Under `--first-release` a TAG_COLLISION is the "re-run with
                    // dangling state" recovery path: a freshly-cloned greenfield repo
                    // can't legitimately produce colliding tags, so it is skipped.
                    // Any other tag-creation failure leaves the package published but
                    // untagged, so it is a failure: the command exits non-zero and the
                    // state file stays so the tag can be retried.
                    if (context.firstRelease && error instanceof VisReleaseError && error.code === "TAG_COLLISION") {
                        result.skipped.push({ name: tag, reason: "tag-creation: tag already exists (first-release — skipped)" });
                    } else {
                        result.failed.push({ name: tag, reason: `tag-creation: ${(error as Error).message}` });
                    }
                }

                // Floating major tag (`<safe-name>-v<major>`) —
                // semantic-release #1515 parity. Force-update so the
                // pointer always tracks the latest patch / minor under the
                // current major.
                //
                // Conditions to emit:
                //   - `release.floatingMajorTag === true`
                //   - active channel is NOT a prerelease (incl. pre-mode)
                //   - the resolved tag pattern doesn't already contain
                //     `{major}` (the pattern is already serving that role)
                //   - the package is NOT private and does NOT set
                //     `skipNpmPublish` (no published artifact for a
                //     consumer to pin against — a floating tag would
                //     just clutter the tag history)
                //
                // Errors are soft-fail: a floating-tag hiccup must not
                // prevent the rest of the wave from publishing.
                const pkgForFloat = context.depGraph.getPackage(name);
                const perPkgForFloat = context.perPackageConfig.get(name);
                const isPrivate = pkgForFloat?.manifest?.private === true;
                const skipNpmPublish = perPkgForFloat?.skipNpmPublish === true;

                if (floatingMajorEnabled && !isPrerelease && !pattern?.includes("{major}") && !isPrivate && !skipNpmPublish) {
                    // Scope-qualified (`@acme/cli` → `acme-cli-v1`) so two packages
                    // with the same unscoped name never retarget each other's tag
                    // (audit F2); undefined for an empty name or major.
                    const floatTag = floatingMajorTagFor(name, version);

                    if (floatTag !== undefined) {
                        try {
                            await createOrUpdateFloatingTag({ cwd: context.cwd, runner }, floatTag, {
                                push: !options.noPush,
                                signing: context.config.signing,
                            });
                            // Recorded in result.tags so the operator
                            // sees it on the summary line.
                            result.tags.push(floatTag);
                        } catch (error) {
                            result.skipped.push({
                                name: floatTag,
                                reason: `floating-major-tag: ${(error as Error).message}`,
                            });
                        }
                    }
                }
            }

            // One shared tag per syncGitTag group (created after per-package tags
            // so it's a single annotated tag for the whole group).
            for (const group of syncTags.groups) {
                try {
                    await createTag({ cwd: context.cwd, runner }, group.tag, `Release ${group.name} ${group.version}`, {
                        signing: context.config.signing,
                        skipRemoteCheck: context.firstRelease,
                    });
                    result.tags.push(group.tag);
                } catch (error) {
                    if (context.firstRelease && error instanceof VisReleaseError && error.code === "TAG_COLLISION") {
                        result.skipped.push({ name: group.tag, reason: "tag-creation: tag already exists (first-release — skipped)" });
                    } else {
                        result.failed.push({ name: group.tag, reason: `tag-creation: ${(error as Error).message}` });
                    }
                }
            }

            if (!options.noPush && result.tags.length > 0) {
                try {
                    await pushTags({ cwd: context.cwd, runner });
                    result.tagsPushed = true;
                } catch (error) {
                    // Soft-fail on the tag push itself (the publish already
                    // succeeded), but surface a failed entry so the CLI exits
                    // non-zero and prints the TAG_PUSH_FAILED hint. The user
                    // can re-run with --resume to retry the push.
                    result.tagsPushed = false;
                    result.failed.push({
                        name: "_pushTags",
                        reason: `git push --tags failed: ${(error as Error).message}. Retry with: git push --tags`,
                    });
                }
            }

            // Persist final tag state.
            state.tagged = [...result.tags];
            state.pushed = result.tagsPushed;

            await persistState();

            // Successful end-state: clear the state file. "Done" means no
            // failures — which includes a `--resume` that finishes with only
            // already-published packages and zero new publishes this run. Gating
            // on `published.length > 0` would strand the tracked lock in that
            // case, so the next runner keeps auto-resuming a finished wave. (The
            // empty-plan case returned early above, so reaching here means the
            // wave had work and all of it succeeded.) We treat a successful
            // publish as done even if `git push --tags` failed — that can be
            // retried independently and shouldn't hold the state file open.
            if (result.failed.length === 0 && !options.dryRun) {
                await clearState(context.cwd, changesDir, lockInGit);

                // Commit + push the lock removal so the next run (anywhere)
                // sees a clean slate rather than a stale lock that would make
                // it skip the whole already-published plan.
                if (lockInGit) {
                    await commitPublishLock(context, runner, changesDir, "close", { noPush: options.noPush });
                }
            }
        }

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
            const previous = priorRegistrySnapshot.pending.length;
            const next = stagedRegistry.pending.length;
            const write = await writeStagedRegistry(context.cwd, changesDir, stagedRegistry);

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
                        push: !options.noPush,
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

        // Workspace-level changelog wave entry (C5 fix). Written from the
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
                                push: !options.noPush,
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

        // Create GH releases (or aggregated release) for every successful publish.
        // Post-publish lifecycle: forge releases + PR walker + chat
        // notifications. All three run within the same guard (the publish
        // actually shipped + tags reached the remote) but `noRelease`
        // only suppresses the forge-release write — successWalk + chat
        // notifications still fire even when the operator opts out of
        // GH/GitLab release pages (e.g. teams managing release notes in
        // a separate doc site still want PR comments + Slack pings).
        //
        // F3 fix (audit): `noRelease` previously gated this whole block,
        // which silently disabled both successWalk and notifications.
        // Now the inner block is split so each lifecycle step can be
        // configured independently.
        if (!options.dryRun && result.published.length > 0 && result.tagsPushed) {
            if (context.config.publish?.noRelease !== true) {
                await createRemoteReleases(context, result, runner, syncTags);
            }

            // Walk every referenced PR / issue and post a "released in X.Y.Z"
            // sticky comment + `released` label (semantic-release parity).
            // Runs after createRemoteReleases so each entry has its release
            // URL populated. Soft-fails everything to plan.warnings — the
            // publish already succeeded, so a forge hiccup here shouldn't
            // roll it back.
            //
            // C-4 fix: dedupe against `state.walked` so a `--resume` after a
            // partial failure doesn't re-walk PRs whose comments + labels
            // already landed on run 1. Sticky-comment markers provide
            // forge-side idempotency, but skipping the walk entirely saves
            // the rate-limited API calls (relevant for waves touching many
            // PRs).
            try {
                const { walkSuccessfulRelease } = await import("../success-walk");
                const { createRemoteClient, detectRemoteProvider } = await import("../remote/detect");
                const { resolveFormatter } = await import("../changelog/resolve");
                const provider = await detectRemoteProvider(context.cwd, runner, context.config.provider);
                const client = createRemoteClient(provider, {
                    githubHost: context.config.githubHost,
                    gitlabHost: context.config.gitlabHost,
                    httpProxy: context.config.httpProxy,
                });
                const repo = await client.detectRepoSlug(context.cwd, runner);
                const formatter = await resolveFormatter(context.config.changelog, context.cwd);

                // Dedupe against BOTH `state.walked` (per-run dedupe — kept
                // for `--resume` semantics on the originating runner) AND
                // `stagedRegistry.recentlyWalked` (cross-runner dedupe — the
                // committed `.vis/release/staged.json` survives a fresh CI
                // runner checkout, so a re-fired workflow on a different
                // machine doesn't re-walk the PRs).
                const { recordRecentlyWalked } = await import("../staged-registry");
                const alreadyWalked = new Set([...(state.walked ?? []), ...(stagedRegistry.recentlyWalked ?? []).map((entry) => entry.key)]);
                const walkable = {
                    ...result,
                    published: result.published.filter((p) => !alreadyWalked.has(`${p.name}@${p.version}`)),
                };

                if (walkable.published.length > 0) {
                    const walkResult = await walkSuccessfulRelease(context, walkable, runner, {
                        client,
                        formatter,
                        repo,
                    });

                    // Record successful walks so a later --resume doesn't repeat
                    // them. We optimistically mark the WHOLE walkable set as
                    // walked even if individual refs failed — the soft-fail
                    // logic inside walkSuccessfulRelease already turned those
                    // into warnings, so re-walking would just hit the same
                    // forge issues.
                    const walkedKeys = walkable.published.map((p) => `${p.name}@${p.version}`);

                    state.walked = [...(state.walked ?? []), ...walkedKeys];
                    await persistState();

                    // Cross-runner persistence — append to the tracked
                    // registry too. The follow-up registry write + commit
                    // sits after the notifications block so one commit
                    // captures both walked + notified deltas.
                    stagedRegistry = recordRecentlyWalked(stagedRegistry, walkedKeys);

                    if (walkResult.warnings.length > 0) {
                        context.plan.warnings.push(...walkResult.warnings);
                    }
                }
            } catch (error) {
                // Top-level safety net — any orchestration error in the walk
                // setup itself (provider detect crash, formatter resolution)
                // shouldn't fail the publish.
                context.plan.warnings.push(`successWalk: could not run post-release walk: ${(error as Error).message}`);
            }

            // Fan out post-release notifications (slack / discord / webhook /
            // plugins). Runs LAST in the post-publish sequence because chat
            // pings should reflect the FINAL state — tags pushed, GH releases
            // created, PRs walked + labelled — not an in-progress snapshot.
            // Per-channel failures are isolated; the publish itself is
            // already complete and immutable at this point.
            if (context.config.notifications) {
                try {
                    const { dispatchNotifications } = await import("../notifications/interface");
                    const { createRemoteClient, detectRemoteProvider } = await import("../remote/detect");
                    const provider = await detectRemoteProvider(context.cwd, runner, context.config.provider);
                    const client = createRemoteClient(provider, {
                        githubHost: context.config.githubHost,
                        gitlabHost: context.config.gitlabHost,
                        httpProxy: context.config.httpProxy,
                    });
                    const repo = await client.detectRepoSlug(context.cwd, runner);

                    // Pull root package.json#name when available so chat
                    // messages carry the workspace identity even when the
                    // git remote slug isn't enough context.
                    let monorepoName: string | undefined;

                    try {
                        const rootManifestPath = `${context.cwd}/package.json`;
                        const fs2 = await import("node:fs/promises");
                        const rootManifest = JSON.parse(await fs2.readFile(rootManifestPath, "utf8")) as { name?: string };

                        monorepoName = rootManifest.name;
                    } catch {
                        // root manifest missing or unreadable — fine, we just
                        // omit the field.
                    }

                    // C-4 fix: dedupe notifications against state.notified so
                    // a `--resume` after a partial failure doesn't re-fire
                    // Slack/Discord pings for releases that already shipped
                    // + notified on run 1. Unlike successWalk's sticky
                    // markers, chat webhooks have NO server-side idempotency
                    // — a re-send produces a duplicate message.
                    //
                    // Cross-runner extension: also dedupe against
                    // `stagedRegistry.recentlyNotified`, which is committed
                    // to the worktree and therefore survives a fresh CI
                    // runner clone. `state.notified` alone is per-run + per-
                    // machine — a re-fired workflow on a different runner
                    // would otherwise re-fire the chat pings.
                    const alreadyNotified = new Set([...(state.notified ?? []), ...(stagedRegistry.recentlyNotified ?? []).map((entry) => entry.key)]);
                    const notifiable = result.published.filter((p) => !alreadyNotified.has(`${p.name}@${p.version}`));

                    // When everything in this wave was already notified on a
                    // prior run, skip the dispatcher entirely (chat webhooks
                    // have no server-side idempotency, so a re-send would
                    // duplicate). Crucially, do NOT return here — the
                    // cross-runner persistence + post-publish hook below still
                    // need to run, and the function must return `result`.
                    if (notifiable.length > 0) {
                        const notificationResult = await dispatchNotifications(
                            context.config.notifications,
                            {
                                channel: context.channel?.tag,
                                completedAt: new Date().toISOString(),
                                ...(monorepoName === undefined ? {} : { monorepoName }),
                                published: notifiable.map((p) => {
                                    return {
                                        name: p.name,
                                        tag: context.channel?.tag,
                                        ...(p.url === undefined ? {} : { url: p.url }),
                                        version: p.version,
                                    };
                                }),
                                ...(repo === undefined ? {} : { repo }),
                                skipped: result.skipped.map((s) => {
                                    return { name: s.name, reason: s.reason };
                                }),
                            },
                            { warn: (m) => context.plan.warnings.push(m) },
                        );

                        // Mark the dispatched-this-run set as notified ONLY when
                        // at least one channel succeeded — that way a total
                        // dispatch failure (all channels down) can retry next
                        // wave instead of being silently skipped forever. The
                        // sticky-marker / webhook-rate-limit guards keep the
                        // retry from being too noisy.
                        if (notificationResult.succeeded.length > 0) {
                            const notifiedKeys = notifiable.map((p) => `${p.name}@${p.version}`);

                            state.notified = [...(state.notified ?? []), ...notifiedKeys];
                            await persistState();

                            // Cross-runner persistence — same rationale as the
                            // walked path above. Mutates the in-memory registry;
                            // the trailing write + commit below captures it.
                            const { recordRecentlyNotified } = await import("../staged-registry");

                            stagedRegistry = recordRecentlyNotified(stagedRegistry, notifiedKeys);
                        }

                        // B-2: surface the dispatch outcome explicitly so
                        // `vis release plan` and CI tails can show "notified
                        // 2/3 channels" instead of guessing from absent
                        // failure entries. Skipped when all channels succeed
                        // AND no failures occurred (the silent success case).
                        if (notificationResult.failed.length > 0 || notificationResult.succeeded.length > 0) {
                            const total = notificationResult.succeeded.length + notificationResult.failed.length;

                            if (notificationResult.failed.length > 0) {
                                context.plan.warnings.push(
                                    `[notifications] dispatched ${notificationResult.succeeded.length}/${total} channels${notificationResult.succeeded.length > 0 ? ` (succeeded: ${notificationResult.succeeded.join(", ")})` : ""}; ${notificationResult.failed.length} failed.`,
                                );

                                for (const failure of notificationResult.failed) {
                                    context.plan.warnings.push(`[notifications:${failure.id}] ${failure.error}`);
                                }
                            }
                        }
                    }
                } catch (error) {
                    // Top-level safety net for the dispatcher itself
                    // (config materialisation crash, dynamic-import failure).
                    context.plan.warnings.push(`notifications: dispatch failed: ${(error as Error).message}`);
                }
            }

            // Cross-runner persistence — commit staged.json IF either
            // recentlyNotified or recentlyWalked grew during this wave.
            // The initial write at the end of the publish loop only
            // captured the pending-stage delta; the walk + notify steps
            // run AFTER that point, so a second write picks up their
            // contributions.
            //
            // Soft-failed for the same reason the first commit is:
            // staged.json being on disk is enough to recover next wave,
            // even if the commit itself hiccupped.
            if (!options.dryRun) {
                try {
                    const followUpWrite = await writeStagedRegistry(context.cwd, changesDir, stagedRegistry);

                    if (followUpWrite.changed) {
                        const { stageAndCommitFile } = await import("../git");

                        try {
                            await stageAndCommitFile(
                                { cwd: context.cwd, runner },
                                followUpWrite.path,
                                "chore(release): record cross-runner notify/walk dedupe [skip ci]",
                                {
                                    author: context.config.gitUser,
                                    push: !options.noPush,
                                    sign: context.config.gitSignCommits === true,
                                },
                            );
                        } catch (error) {
                            process.stderr.write(
                                `[vis release] Warning: could not commit ${followUpWrite.path} (notify/walk dedupe): ${(error as Error).message}\n`,
                            );
                        }
                    }
                } catch (error) {
                    // Don't fail the whole publish for a registry-write
                    // hiccup — the cross-runner dedupe degrades gracefully
                    // back to `state.notified` / `state.walked` (per-run
                    // only) on the next wave.
                    process.stderr.write(`[vis release] Warning: could not update cross-runner dedupe registry: ${(error as Error).message}\n`);
                }
            }
        }

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
