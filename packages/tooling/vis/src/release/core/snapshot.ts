/**
 * Snapshot release logic — extracted from `commands/release/snapshot/handler.ts`
 * so both `vis release snapshot` and `vis release ci snapshot` can call into
 * the same code path without one CLI handler delegating to another (which
 * was previously type-unsafe — `as never` casts).
 */

import { readFile, writeFile } from "node:fs/promises";

import { DEFAULT_CHANGES_DIR } from "../config";
import type { PackageManifest, WorkspacePackage } from "../types";
import { rewriteRangeForVersion } from "./apply-release-plan";
import { parseCatalogs, rewriteCatalogRefs } from "./catalog";
import { cleanPackageJsonForPublish } from "./clean-package-json";
import { getCurrentSha, getShortSha } from "./git";
import type { OrchestratorContext } from "./orchestrator";
import type { CommandRunner } from "./package-managers/interface";
import { NpmAdapter } from "./package-managers/npm";

const interpolateTemplate = (template: string, vars: { branch?: string; pr?: string; sha: string; shortSha: string; tag: string; timestamp: string }): string =>
    template
        .replaceAll("{tag}", vars.tag)
        .replaceAll("{sha}", vars.sha)
        .replaceAll("{shortSha}", vars.shortSha)
        .replaceAll("{branch}", vars.branch ?? "")
        .replaceAll("{pr}", vars.pr ?? "")
        .replaceAll("{timestamp}", vars.timestamp);

export interface RunSnapshotOptions {
    /** Already-built orchestrator context (avoids re-walking the workspace). */
    context: OrchestratorContext;
    /** Don't pack/publish; print what would happen. */
    dryRun?: boolean;
    /** Glob filter (CSV) — limit snapshots to specific packages. */
    filter?: string;
    /** Override registry URL. */
    registry?: string;
    /** Injected runner — defaults to a shell runner. */
    runner?: CommandRunner;
    /** Required dist-tag for the snapshot. */
    tag: string;
}

export interface SnapshotItem {
    name: string;
    version: string;
}

export interface RunSnapshotResult {
    failed: { name: string; reason: string }[];
    published: SnapshotItem[];
    skipped: { name: string; reason: string }[];
    /** Snapshot version applied to every published item. */
    snapshotVersion: string;
    /** dist-tag used. */
    tag: string;
}

interface SnapshotTagRefs {
    branch?: string;
    prFromEnv?: string;
    sha: string;
    shortSha: string;
}

const snapshotTagAlias = (kind: string, refs: SnapshotTagRefs): string | undefined => {
    switch (kind) {
        case "branch": {
            return refs.branch && refs.branch !== "HEAD" ? refs.branch : undefined;
        }
        case "pr": {
            return refs.prFromEnv ? `pr-${refs.prFromEnv}` : undefined;
        }
        case "sha": {
            return refs.sha;
        }
        case "short-sha": {
            return refs.shortSha;
        }
        default: {
            return undefined;
        }
    }
};

// Multi-tag support (RFC §13.2): the same tarball can be published under
// multiple aliases (sha / short-sha / branch / pr) so reviewers can pin to
// whatever granularity. Default = the single user-supplied tag; aliases are
// only added when `release.snapshot.tags` is configured.
const resolveSnapshotTags = (tag: string, tagKinds: ReadonlyArray<string>, refs: SnapshotTagRefs): string[] => {
    const tags: string[] = [tag];

    for (const kind of tagKinds) {
        const extra = snapshotTagAlias(kind, refs);

        if (extra && extra !== tag && !tags.includes(extra)) {
            tags.push(extra);
        }
    }

    return tags;
};

const selectSnapshotTargets = async (packages: ReadonlyArray<WorkspacePackage>, filter: string | undefined): Promise<WorkspacePackage[]> => {
    let targets = [...packages];

    if (filter) {
        const { default: zeptomatch } = await import("zeptomatch");
        const globs = filter
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        targets = targets.filter((p) => globs.some((g) => p.name === g || zeptomatch(g, p.name)));
    }

    // Snapshots are for installable previews — skip private packages.
    return targets.filter((p) => !p.private);
};

interface SnapshotPublishDeps {
    ctx: OrchestratorContext;
    npmCli: NpmAdapter;
    registry: string | undefined;
    snapshotVersion: string;
    tags: string[];
}

type SnapshotPackageOutcome = { kind: "published" } | { kind: "skipped"; reason: string } | { kind: "failed"; reason: string };

// Packs the rewritten manifest and publishes the tarball under every tag alias.
// The source manifest is always restored, even when packing or publishing fails.
const publishSnapshotManifest = async (
    pkg: WorkspacePackage,
    cleaned: PackageManifest,
    deps: SnapshotPublishDeps,
): Promise<SnapshotPackageOutcome> => {
    let original: string | undefined;

    try {
        original = await readFile(pkg.manifestPath, "utf8");

        await writeFile(pkg.manifestPath, `${JSON.stringify(cleaned, null, 4)}\n`);

        // Pack to a temp dir to keep the worktree clean.
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const tempDir = mkdtempSync(join(tmpdir(), "vis-snapshot-"));

        const packed = await deps.ctx.pm.pack({ cwd: pkg.dir, destination: tempDir });

        // First tag's outcome determines the per-package status; later
        // tags are best-effort (already-published is success).
        let firstResult: Awaited<ReturnType<typeof deps.npmCli.publish>> | undefined;

        for (const t of deps.tags) {
            const r = await deps.npmCli.publish({
                access: "public",
                extraArgs: ["--no-git-checks"],
                registry: deps.registry,
                tag: t,
                tarball: packed.tarball,
            });

            firstResult ??= r;
        }

        if (firstResult?.published) {
            return { kind: "published" };
        }

        if (firstResult?.alreadyPublished) {
            return { kind: "skipped", reason: "already-published" };
        }

        return { kind: "skipped", reason: firstResult?.output ?? "unknown" };
    } catch (error) {
        return { kind: "failed", reason: (error as Error).message };
    } finally {
        if (original !== undefined) {
            try {
                await writeFile(pkg.manifestPath, original);
            } catch {
                // best-effort restore
            }
        }
    }
};

// Builds the manifest that would be published for `pkg`: versioned workspace
// deps, catalog references resolved, publish-only fields cleaned.
const buildSnapshotManifest = (pkg: WorkspacePackage, deps: { catalogs: ReturnType<typeof parseCatalogs>; ctx: OrchestratorContext; versionedByName: ReadonlyMap<string, PackageManifest> }): PackageManifest => {
    const composed = composeSnapshotManifest(pkg, deps.versionedByName);
    const catalogResolved = rewriteCatalogRefs(composed, deps.catalogs);

    return cleanPackageJsonForPublish(catalogResolved, deps.ctx.config.publish?.cleanPackageJson);
};

/**
 * Run the snapshot workflow against an orchestrator context. Caller is
 * responsible for surfacing the result (CLI handlers print + set exit code;
 * `vis release ci snapshot` posts a sticky PR comment).
 */
export const runSnapshot = async (options: RunSnapshotOptions): Promise<RunSnapshotResult> => {
    const { context: ctx, dryRun = false, registry, tag } = options;

    const { createShellRunner } = await import("./shell-runner");
    const runner = options.runner ?? createShellRunner();

    const sha = await getCurrentSha({ cwd: ctx.cwd, runner });
    const shortSha = await getShortSha({ cwd: ctx.cwd, runner });

    if (!sha || !shortSha) {
        throw new Error("Could not resolve git HEAD. Snapshot requires a git workspace.");
    }

    const template = ctx.config.snapshot?.versionTemplate ?? "0.0.0-{tag}-{shortSha}";
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "").slice(0, 14);

    const branch = await runner
        .run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.cwd, silent: true })
        .then((r) => (r.exitCode === 0 ? r.stdout.trim() : undefined))
        .catch(() => undefined);
    const prFromEnv = process.env["VIS_PR_NUMBER"] ?? process.env["PR_NUMBER"];
    const resolvedBranch = branch && branch !== "HEAD" ? branch : undefined;

    const tags = resolveSnapshotTags(tag, ctx.config.snapshot?.tags ?? [], { branch, prFromEnv, sha, shortSha });
    const targets = await selectSnapshotTargets(ctx.packages, options.filter);

    const snapshotVersion = interpolateTemplate(template, {
        branch: resolvedBranch,
        pr: prFromEnv,
        sha,
        shortSha,
        tag,
        timestamp,
    });

    const versionedByName = new Map<string, PackageManifest>();

    for (const pkg of targets) {
        versionedByName.set(pkg.name, { ...pkg.manifest, version: snapshotVersion });
    }

    const catalogs = parseCatalogs(await ctx.pm.readCatalogYaml(ctx.cwd));
    const deps: SnapshotPublishDeps = { ctx, npmCli: new NpmAdapter(runner), registry, snapshotVersion, tags };

    const published: SnapshotItem[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const failed: { name: string; reason: string }[] = [];

    // Process-level lock (RFC §19.1) — prevents two `vis release snapshot`
    // invocations on the same workspace from racing on the manifest swap
    // (read → write → pack → restore). The publish path uses the same lock,
    // so snapshot + publish on the same workspace also serialise.
    const changesDirForLock = ctx.config.changesDir ?? DEFAULT_CHANGES_DIR;
    const { acquireLock, releaseLock } = await import("./state");
    let lockAcquired = false;

    if (!dryRun) {
        try {
            await acquireLock(ctx.cwd, changesDirForLock);
            lockAcquired = true;
        } catch (error) {
            failed.push({ name: "_lock", reason: (error as Error).message });

            return { failed, published, skipped, snapshotVersion, tag };
        }
    }

    try {
        for (const pkg of targets) {
            // Snapshots rewrite a package.json and pack it with npm. A non-npm project
            // has neither, so it is skipped rather than having JSON written into its manifest.
            if (pkg.ecosystem !== undefined) {
                skipped.push({ name: pkg.name, reason: "non-npm-packages-have-no-snapshot" });

                continue;
            }

            const cleaned = buildSnapshotManifest(pkg, { catalogs, ctx, versionedByName });

            if (dryRun) {
                published.push({ name: pkg.name, version: snapshotVersion });

                continue;
            }

            const outcome = await publishSnapshotManifest(pkg, cleaned, deps);

            if (outcome.kind === "published") {
                published.push({ name: pkg.name, version: snapshotVersion });
            } else if (outcome.kind === "skipped") {
                skipped.push({ name: pkg.name, reason: outcome.reason });
            } else {
                failed.push({ name: pkg.name, reason: outcome.reason });
            }
        }
    } finally {
        if (lockAcquired) {
            await releaseLock(ctx.cwd, changesDirForLock);
        }
    }

    return { failed, published, skipped, snapshotVersion, tag };
};

const DEPENDENCY_KINDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const composeSnapshotManifest = (pkg: WorkspacePackage, versionedByName: ReadonlyMap<string, PackageManifest>): PackageManifest => {
    const baseManifest = versionedByName.get(pkg.name) ?? pkg.manifest;
    const composed: PackageManifest = { ...baseManifest };

    for (const kind of DEPENDENCY_KINDS) {
        const block = baseManifest[kind];

        if (!block || typeof block !== "object") {
            continue;
        }

        const next: Record<string, string> = { ...block };

        for (const [depName, range] of Object.entries(block)) {
            const versioned = versionedByName.get(depName);

            if (!versioned) {
                continue;
            }

            if (range.startsWith("workspace:")) {
                const inner = range.slice("workspace:".length);
                const rewritten = rewriteRangeForVersion(inner === "*" ? "*" : range, versioned.version);

                next[depName] = rewritten.startsWith("workspace:") ? rewritten.slice("workspace:".length) : rewritten;
            }
        }

        composed[kind] = next;
    }

    return composed;
};
