import type { createShellRunner } from "../shell-runner";
import type { OrchestratorContext } from "./context";
import { runHook } from "./hooks";
import type { PublishContextOptions, PublishContextResult } from "./publish-types";

/**
 * Tags a publish of the current plan pushes: release tags it creates (per
 * package, or one per `syncGitTag` group) and floating major tags it moves.
 * Mirrors the tagging in `createReleaseTags`; private packages are skipped
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
 * Checks that must pass before anything is published: no open version PR
 * (version-pr channels), the prePublishCommand hook, and push access for
 * the tags and commits this run will push. A failure is recorded on
 * `result.failed`; returns `true` when the publish must stop.
 */
export const runPublishPreflight = async (
    context: OrchestratorContext,
    runner: ReturnType<typeof createShellRunner>,
    options: PublishContextOptions,
    result: PublishContextResult,
): Promise<boolean> => {
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

                        return true;
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

            return true;
        }
    }

    // Fail before publishing when the pushes later in this run would be
    // rejected, so packages don't land on the registry without their tags.
    if (!options.dryRun && !options.noPush) {
        const pushError = await verifyReleasePushes(context, runner, { noTag: options.noTag === true });

        if (pushError !== undefined) {
            result.failed.push({ name: "_pushAccess", reason: pushError });

            return true;
        }
    }

    return false;
};
