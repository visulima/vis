import { VisReleaseError } from "../../errors";
import type { resolveSyncTagGroups } from "../group-tags";
import type { PublishWave } from "./publish-wave";
import { commitPublishLock, persistWaveState } from "./publish-wave";

/**
 * Create and push release tags for the successfully published packages.
 * Returns the syncGitTag resolution so the post-publish phase reuses it.
 */
export const createPublishTags = async (wave: PublishWave): Promise<ReturnType<typeof resolveSyncTagGroups>> => {
    const { context, options, result, runner } = wave;
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
        wave.state.tagged = [...result.tags];
        wave.state.pushed = result.tagsPushed;

        await persistWaveState(wave);

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
            await wave.modules.state.clearState(context.cwd, wave.changesDir, wave.lockInGit);

            // Commit + push the lock removal so the next run (anywhere)
            // sees a clean slate rather than a stale lock that would make
            // it skip the whole already-published plan.
            if (wave.lockInGit) {
                await commitPublishLock(context, runner, wave.changesDir, "close", { noPush: options.noPush });
            }
        }
    }

    return syncTags;
};
