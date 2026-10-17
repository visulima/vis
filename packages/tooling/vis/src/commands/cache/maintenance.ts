import { readdirSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { Toolbox } from "@visulima/cerebro";
import { isAccessibleSync } from "@visulima/fs";
import { formatBytes } from "@visulima/humanizer";
import { join } from "@visulima/path";
import { Cache, parseCacheSize } from "@visulima/task-runner";

import { clearCache as clearAiResponseCache, getCacheStats as getAiCacheStats } from "../../ai/ai-cache";
import { isCacheDirectoryInsideWorkspace } from "../../cache/cache-directory";
import { pail } from "../../io/logger";
import { clearDepsDevCache, getDepsDevCacheStats } from "../../security/deps-dev-security";
import { clearSnykCache, getSnykCacheStats } from "../../security/snyk-security";
import { clearSocketCache, getSocketCacheStats } from "../../security/socket-security";
import type { CacheCleanOptions, CachePruneOptions } from "./index";
import { BRANCH_SCOPE_DIRECTORY, collectCacheEntries, includesTarget, parseCacheTarget, resolveCacheDirectoryFromContext } from "./shared";

/**
 * Expands a cache root into the directories an eviction pass must walk.
 *
 * With branch scoping on, entries live in `&lt;base>/branches/&lt;slug>`; every
 * such subtree counts against retention, including branches this checkout
 * has never been on.
 *
 * `base` itself is always included, never replaced. A workspace that ran
 * unscoped before turning `branchScopedCache` on still has entries sitting
 * directly under it, and returning only the branch subtrees made those
 * unreachable to `--max-age-days` / `--max-size` while `clean` still
 * deleted them — retention silently stopped covering part of the store.
 * `collectCacheEntries` skips the `branches` container, so listing `base`
 * cannot double-count what the subtrees already report.
 */
export const evictionDirectories = (base: string, branchScoped: boolean): string[] => {
    if (!branchScoped) {
        return [base];
    }

    const branchesRoot = join(base, BRANCH_SCOPE_DIRECTORY);

    if (!isAccessibleSync(branchesRoot)) {
        return [base];
    }

    try {
        const slugs = readdirSync(branchesRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(branchesRoot, entry.name));

        return [base, ...slugs];
    } catch {
        return [base];
    }
};

/**
 * True when cache entries sit directly under `base`, outside any branch
 * subtree — the layout a workspace has if it ran before `branchScopedCache`
 * was turned on.
 *
 * Those entries are never *hit* once scoping is on, since `vis run` resolves
 * to a branch subtree. But they are still on disk and still reclaimed by
 * `prune`, so the reporting commands have to see them: `size` counting only
 * the branch subtree made the store look smaller than what `prune` went on to
 * free, which is the "reports less than it holds" discrepancy this command
 * family exists to avoid.
 */
export const hasUnscopedEntries = (base: string): boolean => {
    if (!isAccessibleSync(base)) {
        return false;
    }

    try {
        return readdirSync(base, { withFileTypes: true }).some((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== BRANCH_SCOPE_DIRECTORY);
    } catch {
        return false;
    }
};

const confirmPrompt = (question: string): Promise<boolean> =>
    new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });

        rl.question(`${question} (y/N) `, (answer) => {
            rl.close();
            const trimmed = answer.trim().toLowerCase();

            resolve(trimmed === "y" || trimmed === "yes");
        });
    });

// Keep each clear independent — a failure in one store (e.g. EPERM on a
// stale lockfile) shouldn't prevent the others from being cleared, and
// neither should bubble up and abort `vis cache clean`.
export const clearAiCacheSafe = (): void => {
    try {
        const aiDeleted = clearAiResponseCache();

        if (aiDeleted > 0) {
            pail.info(`Cleared ${String(aiDeleted)} cached AI response${aiDeleted === 1 ? "" : "s"}.`);
        }
    } catch (error: unknown) {
        pail.warn(`Failed to clear AI response cache: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const clearSocketCacheSafe = (): void => {
    try {
        const socketDeleted = clearSocketCache();

        if (socketDeleted > 0) {
            pail.info(`Cleared ${String(socketDeleted)} cached Socket.dev report${socketDeleted === 1 ? "" : "s"}.`);
        }
    } catch (error: unknown) {
        pail.warn(`Failed to clear Socket.dev cache: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const clearDepsDevCacheSafe = (): void => {
    try {
        const depsDevDeleted = clearDepsDevCache();

        if (depsDevDeleted > 0) {
            pail.info(`Cleared ${String(depsDevDeleted)} cached deps.dev record${depsDevDeleted === 1 ? "" : "s"}.`);
        }
    } catch (error: unknown) {
        pail.warn(`Failed to clear deps.dev cache: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const clearSnykCacheSafe = (): void => {
    try {
        const snykDeleted = clearSnykCache();

        if (snykDeleted > 0) {
            pail.info(`Cleared ${String(snykDeleted)} cached Snyk record${snykDeleted === 1 ? "" : "s"}.`);
        }
    } catch (error: unknown) {
        pail.warn(`Failed to clear Snyk cache: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const runClean = async (cacheDirectory: string, workspaceRoot: string, options: { dryRun: boolean; force: boolean }): Promise<void> => {
    if (!isAccessibleSync(cacheDirectory)) {
        pail.info(`No cache directory to clean at ${cacheDirectory}`);

        return;
    }

    if (options.dryRun) {
        // Count across every branch subtree, not just the top level. Under
        // branch scoping the entries live one level down, so a plain read of
        // the base saw the single `branches` directory and announced
        // "Would remove 1 cache entry" for N branches' worth. The byte total
        // was right all along, which made the count look plausible.
        const perDirectory = await Promise.all(evictionDirectories(cacheDirectory, true).map(async (directory) => collectCacheEntries(directory)));
        const entries = perDirectory.flat();
        const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

        pail.info(
            `Would remove ${String(entries.length)} cache entr${entries.length === 1 ? "y" : "ies"} `
            + `(${formatBytes(totalBytes, { decimals: 1, space: false })}) from ${cacheDirectory}`,
        );

        return;
    }

    const insideWorkspace = isCacheDirectoryInsideWorkspace(cacheDirectory, workspaceRoot);

    try {
        const realCache = await realpath(cacheDirectory);
        const realWorkspace = await realpath(workspaceRoot);

        if (realCache === realWorkspace) {
            pail.error("Refusing to delete the workspace root. The cache directory resolved to the same path as the workspace.");
            process.exitCode = 1;

            return;
        }
    } catch {
        // Path may not exist on disk; deletion branches handle missing paths safely.
    }

    if (!insideWorkspace && !options.force) {
        pail.warn(`Cache directory is outside the workspace root: ${cacheDirectory}`);
        pail.warn("This will recursively delete the entire directory, including anything stored there by other tools.");

        if (!process.stdin.isTTY) {
            pail.error("Refusing to clean an out-of-workspace cache without --force (stdin is not a TTY).");
            process.exitCode = 1;

            return;
        }

        const confirmed = await confirmPrompt("  Continue?");

        if (!confirmed) {
            pail.info("Aborted.");

            return;
        }
    }

    if (insideWorkspace) {
        const cache = new Cache({ cacheDirectory, workspaceRoot });

        await cache.clear();
    } else {
        await rm(cacheDirectory, { force: true, recursive: true });
    }

    pail.success(`Cleared cache: ${cacheDirectory}`);
};

export const runPrune = async (
    cacheDirectory: string,
    workspaceRoot: string,
    options: { keepLast?: number; maxCacheAgeDays?: number; maxCacheSize?: string },
): Promise<void> => {
    if (!isAccessibleSync(cacheDirectory)) {
        pail.info(`No cache directory to prune at ${cacheDirectory}`);

        return;
    }

    if (options.maxCacheAgeDays !== undefined && (!Number.isFinite(options.maxCacheAgeDays) || options.maxCacheAgeDays < 0)) {
        pail.error(`Invalid --max-age-days value: expected a finite number >= 0, got ${String(options.maxCacheAgeDays)}`);
        process.exitCode = 1;

        return;
    }

    if (options.keepLast !== undefined && (!Number.isFinite(options.keepLast) || options.keepLast < 0 || !Number.isInteger(options.keepLast))) {
        pail.error(`Invalid --keep-last value: expected a non-negative integer, got ${String(options.keepLast)}`);
        process.exitCode = 1;

        return;
    }

    if (options.maxCacheSize !== undefined) {
        let parsedBytes: number;

        try {
            parsedBytes = parseCacheSize(options.maxCacheSize);
        } catch (error: unknown) {
            pail.error(`Invalid --max-size value: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;

            return;
        }

        if (!Number.isFinite(parsedBytes) || parsedBytes <= 0) {
            pail.error(`Invalid --max-size value: expected a positive size, got "${options.maxCacheSize}" (${String(parsedBytes)} bytes)`);
            process.exitCode = 1;

            return;
        }
    }

    const maxCacheAge = options.maxCacheAgeDays === undefined ? undefined : options.maxCacheAgeDays * 24 * 60 * 60 * 1000;

    const before = await collectCacheEntries(cacheDirectory);
    const beforeBytes = before.reduce((sum, entry) => sum + entry.sizeBytes, 0);

    // --keep-last runs first: trim by recency before letting the
    // task-runner Cache enforce age/size limits. This way `--keep-last 30`
    // is an absolute floor — we never end up over 30 even if the surviving
    // entries are also young or small.
    if (options.keepLast !== undefined && before.length > options.keepLast) {
        const stale = before.slice(options.keepLast);

        await Promise.all(stale.map((entry) => rm(entry.path, { force: true, recursive: true })));
    }

    const cache = new Cache({
        cacheDirectory,
        maxCacheAge,
        maxCacheSize: options.maxCacheSize,
        workspaceRoot,
    });

    await cache.removeOldEntries();

    const after = await collectCacheEntries(cacheDirectory);
    const afterBytes = after.reduce((sum, entry) => sum + entry.sizeBytes, 0);

    const removed = before.length - after.length;
    const reclaimedBytes = beforeBytes - afterBytes;

    if (removed <= 0) {
        pail.info("Nothing to prune — all entries are within the configured limits.");

        return;
    }

    pail.success(`Pruned ${String(removed)} entr${removed === 1 ? "y" : "ies"}, freed ${formatBytes(reclaimedBytes, { decimals: 1, space: false })}.`);
};

export const cacheCleanExecute = async ({ options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, CacheCleanOptions>): Promise<void> => {
    const target = parseCacheTarget(options.type);
    const dryRun = Boolean(options.dryRun);

    if (includesTarget(target, "task")) {
        const { directoriesFor, workspaceRoot } = resolveCacheDirectoryFromContext(wsRoot, options, visConfig as Record<string, unknown> | undefined);

        // `runClean` already invokes `isCacheDirectoryInsideWorkspace` and
        // prompts for out-of-workspace targets — when the user is in a linked
        // worktree and the resolver landed on the *main* worktree's cache,
        // that path lives outside the current `workspaceRoot`, so the
        // existing prompt naturally requires `--force` (or interactive
        // confirmation) before nuking the shared store.
        for (const directory of directoriesFor("wipe")) {
            await runClean(directory, workspaceRoot, {
                dryRun,
                force: Boolean(options.force),
            });
        }
    }

    if (includesTarget(target, "ai")) {
        if (dryRun) {
            const stats = getAiCacheStats();

            pail.info(`Would clear ${String(stats.entries)} cached AI response${stats.entries === 1 ? "" : "s"}.`);
        } else {
            clearAiCacheSafe();
        }
    }

    if (includesTarget(target, "socket")) {
        if (dryRun) {
            const stats = getSocketCacheStats();

            pail.info(`Would clear ${String(stats.entries)} cached Socket.dev report${stats.entries === 1 ? "" : "s"}.`);
        } else {
            clearSocketCacheSafe();
        }
    }

    if (includesTarget(target, "deps-dev")) {
        if (dryRun) {
            const stats = getDepsDevCacheStats();

            pail.info(`Would clear ${String(stats.entries)} cached deps.dev record${stats.entries === 1 ? "" : "s"}.`);
        } else {
            clearDepsDevCacheSafe();
        }
    }

    if (includesTarget(target, "snyk")) {
        if (dryRun) {
            const stats = getSnykCacheStats();

            pail.info(`Would clear ${String(stats.entries)} cached Snyk record${stats.entries === 1 ? "" : "s"}.`);
        } else {
            clearSnykCacheSafe();
        }
    }
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export const cachePruneExecute = async ({ options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, CachePruneOptions>): Promise<void> => {
    const { directoriesFor, workspaceRoot } = resolveCacheDirectoryFromContext(wsRoot, options, visConfig as Record<string, unknown> | undefined);
    // "evict": retention has to see every branch's entries. Scoped to the
    // checked-out branch, `--max-size` could never reclaim another branch's
    // subtree, so the store grew one subtree per branch ever checked out and
    // only the nuclear `clean` could touch them.
    const cacheDirectories = directoriesFor("evict");

    for (const directory of cacheDirectories) {
        if (cacheDirectories.length > 1) {
            pail.info(`# ${directory}`);
        }

        await runPrune(directory, workspaceRoot, {
            keepLast: typeof options.keepLast === "number" ? options.keepLast : undefined,
            maxCacheAgeDays: typeof options.maxAgeDays === "number" ? options.maxAgeDays : undefined,
            maxCacheSize: options.maxSize,
        });
    }
};
