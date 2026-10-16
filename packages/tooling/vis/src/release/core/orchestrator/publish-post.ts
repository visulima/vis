import type { resolveSyncTagGroups } from "../group-tags";
import type { PublishWave } from "./publish-wave";
import { persistWaveState } from "./publish-wave";
import { createRemoteReleases } from "./remote-releases";

/**
 * Persist + commit the pending-stage registry. Runs on every publish
 * wave (success, partial, all-skipped) so the tracked file always
 * reflects what's live on npm. The `[skip ci]` tag prevents this
 * chore commit from triggering another release cycle.
 *
 * Commit message reflects the delta direction so the git log reads
 * sensibly without having to diff the file: "record" for net-new
 * pending entries, "drain" for net-removed entries, "update" for
 * mixed waves.
 */
export const commitStagedRegistry = async (wave: PublishWave): Promise<void> => {
    const { context, options, runner } = wave;

    if (!options.dryRun) {
        const previous = wave.priorRegistrySnapshot.pending.length;
        const next = wave.stagedRegistry.pending.length;
        const write = await wave.modules.registry.writeStagedRegistry(context.cwd, wave.changesDir, wave.stagedRegistry);

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
};

/**
 * Workspace-level changelog wave entry (C5 fix). Written from the
 * publish phase — AFTER tag-push — using `result.published[]` so a
 * stage rejected at the gate never produces an orphan wave entry.
 * Skipped on dry-run, when config disables it, or when no package
 * actually published.
 */
export const writeChangelogWave = async (wave: PublishWave): Promise<void> => {
    const { context, options, result, runner } = wave;

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
};

/**
 * Post-publish lifecycle: forge releases + PR walker + chat notifications,
 * then the cross-runner registry write. Only runs when the publish actually
 * shipped and its tags reached the remote.
 */
export const runPostPublish = async (wave: PublishWave, syncTags: ReturnType<typeof resolveSyncTagGroups>): Promise<void> => {
    const { context, options, result, runner } = wave;

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
            const alreadyWalked = new Set([...(wave.state.walked ?? []), ...(wave.stagedRegistry.recentlyWalked ?? []).map((entry) => entry.key)]);
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

                wave.state.walked = [...(wave.state.walked ?? []), ...walkedKeys];
                await persistWaveState(wave);

                // Cross-runner persistence — append to the tracked
                // registry too. The follow-up registry write + commit
                // sits after the notifications block so one commit
                // captures both walked + notified deltas.
                wave.stagedRegistry = recordRecentlyWalked(wave.stagedRegistry, walkedKeys);

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
                const alreadyNotified = new Set([...(wave.state.notified ?? []), ...(wave.stagedRegistry.recentlyNotified ?? []).map((entry) => entry.key)]);
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

                        wave.state.notified = [...(wave.state.notified ?? []), ...notifiedKeys];
                        await persistWaveState(wave);

                        // Cross-runner persistence — same rationale as the
                        // walked path above. Mutates the in-memory registry;
                        // the trailing write + commit below captures it.
                        const { recordRecentlyNotified } = await import("../staged-registry");

                        wave.stagedRegistry = recordRecentlyNotified(wave.stagedRegistry, notifiedKeys);
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
                const followUpWrite = await wave.modules.registry.writeStagedRegistry(context.cwd, wave.changesDir, wave.stagedRegistry);

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
};
