import { DEFAULT_CHANGES_DIR } from "../../config";
import { createShellRunner } from "../shell-runner";
import type { VersionActions } from "../version-actions/interface";
import { runHook } from "./apply";
import type { OrchestratorContext } from "./context";
import { runPublishLoop } from "./publish-loop";
import { commitStagedRegistry, runPostPublish, writeChangelogWave } from "./publish-post";
import { createPublishTags, planPublishTags } from "./publish-tags";
import { openPublishWave } from "./publish-wave";

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
 * Tags a publish of the current plan pushes: release tags it creates (per
 * package, or one per `syncGitTag` group) and floating major tags it moves.
 * Mirrors the tagging in {@link publishContext}; private packages are skipped
 * because they are never published, so never tagged.
 */
const plannedPushTags = async (context: OrchestratorContext): Promise<{ created: string[]; updated: string[] }> => {
    const { resolveSyncTagGroups } = await import("../group-tags");
    const planned = context.plan.releases
        .filter((release) => context.depGraph.getPackage(release.name)?.manifest?.private !== true)
        .map((release) => {
            return { name: release.name, version: release.newVersion };
        });
    const syncTags = resolveSyncTagGroups(context.config, planned);
    const plan = await planPublishTags(context, planned, syncTags);

    return {
        created: [...plan.groups.map((group) => group.tag), ...plan.packages.map((pkg) => pkg.tag)],
        updated: plan.packages.flatMap((pkg) => (pkg.floatTag === undefined ? [] : [pkg.floatTag])),
    };
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
 * In-flight version-PR check (RFC §19.1) — refuse to publish locally if an
 * open release PR exists, to catch the cross-machine race where a developer
 * runs `vis release publish` while CI is mid-release-PR cycle. Records the
 * refusal on `result` and returns `true` when the publish must stop.
 */
const refuseWhileReleasePrOpen = async (
    context: OrchestratorContext,
    runner: ReturnType<typeof createShellRunner>,
    result: PublishContextResult,
): Promise<boolean> => {
    const { createRemoteClient, detectRemoteProvider } = await import("../remote/detect");
    let repo: string | undefined;

    try {
        const provider = await detectRemoteProvider(context.cwd, runner, context.config.provider);
        const client = createRemoteClient(provider, {
            githubHost: context.config.githubHost,
            gitlabHost: context.config.gitlabHost,
            httpProxy: context.config.httpProxy,
        });

        repo = await client.detectRepoSlug(context.cwd, runner);
    } catch (error) {
        result.failed.push({
            name: "_preflight",
            reason: `Could not read the remote to check for an open release PR: ${(error as Error).message}`,
        });

        return true;
    }

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

                    return true;
                }
            }
        } catch {
            // gh not available — skip the check (fail-open).
        }
    }

    return false;
};

/**
 * Publish each release in the plan via its resolved versionActions.
 * Topological order is honored so dependencies publish before dependents.
 *
 * Orchestrates one publish wave: pre-flight guards, the process lock, then
 * the wave phases (open, per-package loop, tags, registry commit, changelog,
 * post-publish). Phase bodies live in `./publish-*.ts`.
 */
export const publishContext = async (context: OrchestratorContext, options: PublishContextOptions = {}): Promise<PublishContextResult> => {
    const result: PublishContextResult = { failed: [], published: [], skipped: [], tags: [], tagsPushed: false };
    const runner = createShellRunner();

    if (context.plan.releases.length === 0) {
        return result;
    }

    if (!options.dryRun && context.channel?.mode === "version-pr" && (await refuseWhileReleasePrOpen(context, runner, result))) {
        return result;
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
        let pushError: string | undefined;

        try {
            pushError = await verifyReleasePushes(context, runner, { noTag: options.noTag === true });
        } catch (error) {
            result.failed.push({ name: "_preflight", reason: `Could not verify the release pushes: ${(error as Error).message}` });

            return result;
        }

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
        // Lazily-loaded state modules, loaded in the order the wave has always used.
        const stateModule = await import("../state");
        const registryModule = await import("../staged-registry");
        const wave = await openPublishWave({ context, options, result, runner }, { registry: registryModule, state: stateModule });

        await runPublishLoop(wave);

        const syncTags = await createPublishTags(wave);

        await commitStagedRegistry(wave);
        await writeChangelogWave(wave);
        await runPostPublish(wave, syncTags);

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
