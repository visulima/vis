import semver from "semver";

import type { PlannedRelease, WorkspacePackage } from "../../types";
import { DEFAULT_RELEASE_COMMIT_PATTERNS } from "../generate/conventional-commits";
import { createTag, defaultTagFor, pushTags, renderTagPattern, resolveReleaseSource } from "../git";
import type { CommandRunner } from "../package-managers/interface";
import { createShellRunner } from "../shell-runner";
import { clearCurrentVersionMemo, resolveCurrentVersion } from "../version-resolver";
import type { OrchestratorContext } from "./context";
import { publishContext } from "./publish";
import type { PublishContextOptions, PublishContextResult } from "./publish-types";

/**
 * A version that a release commit wrote to a manifest but that never got its
 * release tag — the trace a wave leaves when a package fails to publish
 * (tags are only created after a successful publish).
 */
export interface MissingRelease {
    /** The release commit that set `version`. */
    commit: string;
    name: string;
    /** `true` when the registry already has `version` (published, never tagged): tag only. */
    onRegistry: boolean;
    /** Highest version already tagged for the package. */
    previousVersion: string;
    /** Where the tag goes: the commit the release commit's `Release-Source` trailer names, else the release commit. */
    target: string;
    version: string;
}

export interface FindMissingReleasesResult {
    missing: MissingRelease[];
    /** Packages that looked unreleased but were left alone, and why. */
    skipped: { name: string; reason: string }[];
}

/** `true` = the registry has the version, `false` = it does not, `undefined` = could not tell. */
export type RegistryProbe = (pkg: WorkspacePackage, version: string, registry: string | undefined) => Promise<boolean | undefined>;

/**
 * Ask npm whether `name@version` exists, from the directory the publish runs
 * in (the workspace root) so both read the same `.npmrc` registry + auth. Only a definite answer counts: npm ≥ 10 exits
 * E404 for a missing version, older npm exits 0 with empty output. Any other
 * failure (auth, network) is "unknown", and an unknown is never published.
 */
const npmRegistryProbe
    = (runner: CommandRunner, cwd: string): RegistryProbe =>
        async (pkg, version, registry) => {
            const args = ["view", `${pkg.name}@${version}`, "version"];

            if (registry) {
                args.push("--registry", registry);
            }

            const result = await runner.run("npm", args, { cwd, silent: true });

            if (result.exitCode === 0) {
                return result.stdout.trim() !== "";
            }

            return /\bE404\b/.test(`${result.stdout}\n${result.stderr}`) ? false : undefined;
        };

/**
 * The commit that last changed the manifest's `version` field, with its
 * subject. `-G` matches diffs whose added/removed lines match, so a range
 * rewrite elsewhere in the manifest does not count.
 */
const findVersionCommit = async (runner: CommandRunner, cwd: string, manifestPath: string): Promise<{ sha: string; subject: string } | undefined> => {
    const result = await runner.run("git", ["log", "-1", "--format=%H%x00%s", String.raw`-G"version"[[:space:]]*:`, "--", manifestPath], { cwd, silent: true });
    const [sha, subject] = result.stdout.trim().split("\0");

    return result.exitCode === 0 && sha ? { sha, subject: subject ?? "" } : undefined;
};

/**
 * Find npm packages whose manifest version was set by a release commit but
 * never tagged. Guards — each one skips rather than publishes:
 *   - npm packages only, not private, not `skipNpmPublish`;
 *   - the package already has a release tag and the manifest version is
 *     greater than the highest one (keeps `0.0.0-development`-style and
 *     registry-resolved manifests out);
 *   - the commit that set the version is a release commit (a hand-edited
 *     version is not published behind anyone's back);
 *   - the package dir is unchanged since that commit, so what is packed is
 *     what was versioned;
 *   - the registry gives a definite answer.
 */
export const findMissingReleases = async (
    context: OrchestratorContext,
    options: { projects?: string[]; registryProbe?: RegistryProbe; runner?: CommandRunner } = {},
): Promise<FindMissingReleasesResult> => {
    const runner = options.runner ?? createShellRunner();
    const probe = options.registryProbe ?? npmRegistryProbe(runner, context.cwd);
    const result: FindMissingReleasesResult = { missing: [], skipped: [] };
    const versionedBy = context.config.versionPr?.title ?? "🚀 Versioned release";
    const isReleaseCommit = (subject: string): boolean =>
        subject.startsWith(versionedBy) || DEFAULT_RELEASE_COMMIT_PATTERNS.some((pattern) => pattern.test(subject));
    const { default: zeptomatch } = await import("zeptomatch");
    const globs = options.projects ?? [];

    for (const pkg of context.packages) {
        const perPkg = context.perPackageConfig.get(pkg.name);

        if (pkg.ecosystem !== undefined || pkg.private || perPkg?.skipNpmPublish === true || !semver.valid(pkg.version)) {
            continue;
        }

        if (globs.length > 0 && !globs.some((glob) => glob === pkg.name || zeptomatch(glob, pkg.name))) {
            continue;
        }

        const tagged = await resolveCurrentVersion(pkg, "git-tag", context.depGraph, {
            cwd: context.cwd,
            perPackageConfig: perPkg,
            pm: context.pm,
            runner,
            workspaceConfig: context.config,
        });

        if (tagged.resolvedFrom !== "git-tag" || !semver.gt(pkg.version, tagged.version)) {
            continue;
        }

        const skip = (reason: string): void => {
            result.skipped.push({ name: pkg.name, reason: `${pkg.version} is untagged but ${reason}` });
        };

        const commit = await findVersionCommit(runner, context.cwd, pkg.manifestPath);

        if (!commit) {
            skip("the commit that set it could not be found");
            continue;
        }

        if (!isReleaseCommit(commit.subject)) {
            skip(`it was set by ${commit.sha.slice(0, 7)} ("${commit.subject}"), which is not a release commit`);
            continue;
        }

        const diff = await runner.run("git", ["diff", "--quiet", commit.sha, "--", pkg.dir], { cwd: context.cwd, silent: true });

        // ponytail: only the package dir is compared; content inlined from outside it (a shared
        // source dir, a catalog version) can drift unnoticed. Compare the packed tarball if that bites.
        if (diff.exitCode !== 0) {
            skip(`${pkg.dir} changed since ${commit.sha.slice(0, 7)}; the next release covers it`);
            continue;
        }

        const onRegistry = await probe(pkg, pkg.version, perPkg?.registry);

        if (onRegistry === undefined) {
            skip("the registry could not confirm whether it is published");
            continue;
        }

        // A wave released with `tagTarget: "source"` tagged the commit it was
        // planned from; once its release commit was rebased, the commits under
        // it are not in that wave and must stay in the next range.
        const target = (await resolveReleaseSource({ cwd: context.cwd, runner }, commit.sha)) ?? commit.sha;

        result.missing.push({ commit: commit.sha, name: pkg.name, onRegistry, previousVersion: tagged.version, target, version: pkg.version });
    }

    return result;
};

/** The release tag of `name@version` under the package's (or workspace's) `releaseTagPattern`. */
export const releaseTagFor = (context: OrchestratorContext, name: string, version: string): string => {
    const pattern = context.perPackageConfig.get(name)?.releaseTagPattern ?? context.config.releaseTagPattern;

    return pattern ? renderTagPattern(pattern, { channel: context.channel?.tag, name, version }) : defaultTagFor(name, version);
};

/** The bump a recovered version represents, as the plan would have labelled it. */
const bumpLevelOf = (from: string, to: string): PlannedRelease["type"] => {
    const diff = semver.diff(from, to);

    if (diff === "major" || diff === "premajor") {
        return "major";
    }

    return diff === "minor" || diff === "preminor" ? "minor" : "patch";
};

export interface PublishMissingOptions extends PublishContextOptions {
    /** Limit to packages matching these globs. */
    projects?: string[];
    /** Test-only override of the npm registry lookup. */
    registryProbe?: RegistryProbe;
}

export interface PublishMissingResult extends PublishContextResult {
    /** Versions found missing (published, or tagged when already on the registry). */
    missing: MissingRelease[];
}

/**
 * Publish every version a release commit wrote but no wave finished — the
 * self-heal for a partly failed publish. Versions already on the registry
 * only get their tag. Tags go on the release commit (or the commit its
 * `Release-Source` trailer names), not HEAD, so the
 * "last release tag" boundary `generate --since-last-release` walks from
 * does not jump over commits made after it.
 *
 * Run it before planning a new wave: the plan's current versions come from
 * these tags, and a cascade would otherwise recompute a missing version and
 * collide with it.
 */
export const publishMissing = async (context: OrchestratorContext, options: PublishMissingOptions = {}): Promise<PublishMissingResult> => {
    const runner = createShellRunner();
    const found = await findMissingReleases(context, { projects: options.projects, registryProbe: options.registryProbe, runner });
    const result: PublishMissingResult = { failed: [], missing: found.missing, published: [], skipped: [...found.skipped], tags: [], tagsPushed: false };

    // The next `buildContext` in this process must read the tags created below.
    if (found.missing.length > 0) {
        clearCurrentVersionMemo();
    }

    const toPublish = found.missing.filter((entry) => !entry.onRegistry);
    const tagOnly = found.missing.filter((entry) => entry.onRegistry);

    if (toPublish.length > 0) {
        const releases: PlannedRelease[] = toPublish.map((entry) => {
            return {
                changeFiles: [],
                isCascadeBump: false,
                isDependencyBump: false,
                isGroupBump: false,
                name: entry.name,
                newVersion: entry.version,
                oldVersion: entry.previousVersion,
                reasons: [],
                sources: [],
                type: bumpLevelOf(entry.previousVersion, entry.version),
            };
        });
        const published = await publishContext(
            { ...context, plan: { consumedChangeFiles: [], releases, warnings: [] } },
            { ...options, tagTargets: new Map(toPublish.map((entry) => [entry.name, entry.target])) },
        );

        result.failed.push(...published.failed);
        result.published.push(...published.published);
        result.skipped.push(...published.skipped);
        result.tags.push(...published.tags);
        result.tagsPushed = published.tagsPushed;
    }

    if (tagOnly.length === 0 || options.dryRun || options.noTag) {
        return result;
    }

    const tagged: string[] = [];

    for (const entry of tagOnly) {
        const tag = releaseTagFor(context, entry.name, entry.version);

        try {
            await createTag({ cwd: context.cwd, runner }, tag, `Release ${entry.name}@${entry.version}`, {
                signing: context.config.signing,
                target: entry.target,
            });
            tagged.push(tag);
            result.skipped.push({ name: entry.name, reason: `already-published: tagged ${tag}` });
        } catch (error) {
            result.failed.push({ name: tag, reason: `tag-creation: ${(error as Error).message}` });
        }
    }

    result.tags.push(...tagged);

    if (tagged.length > 0 && !options.noPush) {
        try {
            await pushTags({ cwd: context.cwd, runner });
            result.tagsPushed = true;
        } catch (error) {
            result.tagsPushed = false;
            result.failed.push({ name: "_pushTags", reason: `git push --tags failed: ${(error as Error).message}. Retry with: git push --tags` });
        }
    }

    return result;
};
