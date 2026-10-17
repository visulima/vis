import type { PackageManifest } from "../../types";
import { parseCatalogs } from "../catalog";
import { createVersionActions } from "../version-actions/registry";
import { resolveVersionActionsId } from "../workspace";
import type { OrchestratorContext } from "./context";
import type { PublishWave } from "./publish-wave";

const shouldProvenance = (context: OrchestratorContext): boolean => {
    const args = context.config.publish?.publishArgs ?? [];

    return args.includes("--provenance") && context.pm.id !== "bun";
};

/**
 * Publish each release of the wave via its resolved versionActions, in
 * topological order so dependencies publish before dependents.
 */
export const publishPackages = async (context: OrchestratorContext, wave: PublishWave): Promise<void> => {
    const { options, persistState, releases, result, state } = wave;
    const { removePendingStages, upsertPendingStages } = await import("../staged-registry");

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
        const existingStage = wave.stagedRegistry.pending.find((entry) => entry.name === name && entry.version === release.newVersion);

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
                const idsToDrop = wave.stagedRegistry.pending
                    .filter((entry) => entry.name === name && entry.version === release.newVersion)
                    .map((entry) => entry.id);

                if (idsToDrop.length > 0) {
                    wave.stagedRegistry = removePendingStages(wave.stagedRegistry, idsToDrop);
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

                    wave.stagedRegistry = upsertPendingStages(wave.stagedRegistry, [
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
};
