import { collectContributors } from "../release-note-template";
import type { createShellRunner } from "../shell-runner";
import type { OrchestratorContext } from "./context";
import { applyReleaseNoteTemplate, composeRelatedReleasesBlock, extractInternalAuthors } from "./notes";
import type { PublishContextResult } from "./publish-types";

/**
 * Create per-package GH releases (or one aggregated release if `aggregateRelease`
 * is on). Failures are non-fatal — the publish itself already succeeded.
 */
export const createRemoteReleases = async (
    context: OrchestratorContext,
    result: PublishContextResult,
    runner: ReturnType<typeof createShellRunner>,
    syncTags: import("../group-tags").SyncTagResolution,
): Promise<void> => {
    const { createRemoteClient, detectRemoteProvider } = await import("../remote/detect");
    const provider = await detectRemoteProvider(context.cwd, runner, context.config.provider);
    const client = createRemoteClient(provider, {
        githubHost: context.config.githubHost,
        gitlabHost: context.config.gitlabHost,
        httpProxy: context.config.httpProxy,
    });
    const repo = await client.detectRepoSlug(context.cwd, runner);

    if (!repo) {
        return;
    }

    const aggregateConfig
        = typeof context.config.aggregateRelease === "object" ? context.config.aggregateRelease : { enabled: context.config.aggregateRelease === true };

    const draftRelease = context.config.publish?.draftRelease === true;
    const discussionCategory = context.config.publish?.discussionCategory;
    const addReleases = context.config.publish?.addReleases;

    if (aggregateConfig.enabled) {
        const date = new Date().toISOString().slice(0, 10);
        const titleTemplate = aggregateConfig.title ?? "Release {date}";
        const title = titleTemplate.replaceAll("{date}", date);
        const tag = `release-${date}`;
        const body = result.published.map((p) => `- \`${p.name}\` → ${p.version}`).join("\n");

        try {
            const created = await client.createRelease(runner, {
                body,
                cwd: context.cwd,
                discussionCategory,
                draft: draftRelease,
                repo,
                tag,
                title,
            });

            // M-2 fix: aggregate-release mode previously left every
            // `result.published[].url` undefined, which made successWalk's
            // template substitution emit `... is available on [GitHub
            // release]().` Stamp the SAME aggregate-release URL on every
            // published entry so downstream consumers (successWalk,
            // notifications) get a meaningful link.
            if (created?.url) {
                for (const item of result.published) {
                    item.url = created.url;
                }
            }
        } catch {
            // soft-fail
        }

        return;
    }

    // Per-package releases. Match the tag pattern used by the publish phase
    // so the GitHub release points at the actual git tag we created.
    const { defaultTagFor, renderTagPattern } = await import("../git");
    const rootTagPattern = context.config.releaseTagPattern;
    const channelName = context.channel?.tag;
    const releaseAssets = context.config.publish?.releaseAssets ?? {};

    // Wave-scoped tokens hoisted out of the per-package loop:
    //   - `date`: previously recomputed per iteration, which gave
    //     packages on either side of UTC midnight different `{date}`
    //     stamps within the same wave.
    //   - `contributors`: previously collected from per-package
    //     `planned.changeFiles`, which dropped attribution on
    //     cascade / dependency-only bumps and split the contributor
    //     list across two releases on `--resume` after a partial
    //     publish failure. Sourced from the plan's
    //     `consumedChangeFiles` so the list covers the whole wave.
    const date = new Date().toISOString().slice(0, 10);
    const internalAuthors = extractInternalAuthors(context.config.changelog);
    const waveContributors = collectContributors(context.plan.consumedChangeFiles ?? [], { internalAuthors });

    // syncGitTag groups get ONE aggregate release pointing at the shared tag;
    // their members are skipped in the per-package loop below. The resolution is
    // computed once in publishContext and threaded in via `syncTags`.

    for (const group of syncTags.groups) {
        const body = group.members.map((name) => `- \`${name}\` → ${result.published.find((p) => p.name === name)?.version ?? group.version}`).join("\n");

        try {
            const created = await client.createRelease(runner, {
                body,
                cwd: context.cwd,
                discussionCategory,
                draft: draftRelease,
                prerelease: group.version.includes("-"),
                repo,
                tag: group.tag,
                title: `${group.name} ${group.version}`,
            });

            if (created?.url) {
                for (const item of result.published) {
                    if (group.members.includes(item.name)) {
                        item.url = created.url;
                    }
                }
            }
        } catch (error) {
            // eslint-disable-next-line no-console
            console.warn(`createRelease failed for group ${group.name} (tag ${group.tag}): ${(error as Error).message}`);
        }
    }

    for (const item of result.published) {
        if (syncTags.grouped.has(item.name)) {
            continue;
        }

        const perPkgPattern = context.perPackageConfig.get(item.name)?.releaseTagPattern;
        const pattern = perPkgPattern ?? rootTagPattern;
        const tag = pattern
            ? renderTagPattern(pattern, { channel: channelName, name: item.name, version: item.version })
            : defaultTagFor(item.name, item.version);
        const isPrerelease = item.version.includes("-");

        let body = `Release of ${item.name}@${item.version}.`;

        if (item.stageId) {
            // Staged publishes are invisible to `npm install` until approved.
            // Flag this in the release body so consumers don't conclude the
            // npm version exists when they hit a 404 trying to install it.
            body = `${body}\n\n> ⏳ **Staged — not yet installable.** Approve via \`vis release stage approve ${item.stageId}\` or the npmjs.com web UI.`;
        }

        if (releaseAssets.stampHashes && item.tarball) {
            // Stamp tarball hashes into the release body so consumers can
            // verify the registry tarball matches the audited build.
            body = `${body}\n\n### Tarball integrity\n\n- size: \`${item.tarball.size}\` bytes\n- sha256: \`${item.tarball.sha256}\`\n- sha512: \`${item.tarball.sha512}\``;
        }

        if (addReleases !== undefined && addReleases !== false) {
            // Link the immediately
            // previous N releases of THIS package. Tag pattern is the
            // same one we used to mint the current tag — `@scope/pkg@`
            // for the default `{name}@{version}`, derived empirically
            // from the resolved tag value (everything up to and
            // including the LAST `@` before the version).
            try {
                const lastAt = tag.lastIndexOf("@");
                const tagPrefix = lastAt > 0 ? tag.slice(0, lastAt + 1) : "";
                const recent = await client.listRecentReleases(runner, {
                    cwd: context.cwd,
                    excludeTag: tag,
                    limit: 5,
                    repo,
                    tagPrefix,
                });
                const block = composeRelatedReleasesBlock(recent);

                if (block) {
                    body = addReleases === "top" ? `${block}\n\n${body}` : `${body}\n\n${block}`;
                }
            } catch {
                // Soft-fail: a forge hiccup listing prior releases
                // shouldn't block the actually-completed publish.
            }
        }

        // releaseNoteTemplate: wrap the
        // composed body with operator-supplied header / footer. The
        // tokens cover the common case ("link to the migration guide",
        // "thank a sponsor") without requiring a custom formatter. Skipped
        // implicitly when the template is absent.
        const { releaseNoteTemplate } = context.config;

        if (releaseNoteTemplate) {
            const planned = context.plan.releases.find((r) => r.name === item.name);
            const previousVersion = planned?.oldVersion ?? "";

            body = applyReleaseNoteTemplate(body, releaseNoteTemplate, {
                contributors: waveContributors,
                date,
                name: item.name,
                previousVersion,
                repo,
                version: item.version,
            });
        }

        const assets: string[] = [];

        if (releaseAssets.uploadTarball && item.tarball) {
            assets.push(item.tarball.path);
        }

        try {
            const created = await client.createRelease(runner, {
                assets: assets.length > 0 ? assets : undefined,
                body,
                cwd: context.cwd,
                discussionCategory,
                draft: draftRelease,
                prerelease: isPrerelease,
                repo,
                tag,
                title: `${item.name} v${item.version}`,
            });

            // Record the release URL so the success-walk can put a link in
            // the sticky comment body. Only set when the adapter returns
            // one (GitLab may omit URL; custom adapters may too).
            if (created?.url) {
                item.url = created.url;
            }
        } catch (error) {
            // Soft-fail: publish already succeeded, but surface the failure
            // so an operator can re-run remote-release creation or fix the
            // forge-side issue (auth, rate limit, missing tag).
            // eslint-disable-next-line no-console
            console.warn(`createRelease failed for ${item.name}@${item.version} (tag ${tag}): ${(error as Error).message}`);
        }
    }
};
