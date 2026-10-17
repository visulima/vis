import type { Toolbox } from "@visulima/cerebro";
import { isAccessibleSync } from "@visulima/fs";

import { getCacheStats as getAiCacheStats } from "../../ai/ai-cache";
import { pail } from "../../io/logger";
import { getDepsDevCacheStats } from "../../security/deps-dev-security";
import { getSnykCacheStats } from "../../security/snyk-security";
import { getSocketCacheStats } from "../../security/socket-security";
import { clearAiCacheSafe, clearDepsDevCacheSafe, clearSnykCacheSafe, clearSocketCacheSafe, runClean } from "./clean";
import { includesTarget, parseCacheTarget, resolveCacheDirectoryFromContext } from "./context";
import { collectCacheEntries } from "./entries";
import { runHash } from "./hash";
import type { CacheCleanOptions, CacheHashOptions, CacheListOptions, CachePruneOptions, CacheSizeOptions, CacheVerifyOptions, CacheWhyOptions } from "./index";
import { runList } from "./list";
import { runPrune } from "./prune";
import { isoOrNull, printStatsBlock, runSize } from "./size";
import { runVerify } from "./verify";
import { runWhy } from "./why";

export const cacheListExecute = async ({ logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, CacheListOptions>): Promise<void> => {
    const { directoriesFor } = resolveCacheDirectoryFromContext(wsRoot, options, visConfig as Record<string, unknown> | undefined);
    const cacheDirectories = directoriesFor("read");
    const format = options.format ?? "table";

    for (const directory of cacheDirectories) {
        if (cacheDirectories.length > 1) {
            pail.info(`# ${directory}`);
        }

        await runList(directory, format, logger);
    }
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

const resolveWorkspaceRoot = (workspaceRoot: string | undefined): string => workspaceRoot ?? process.cwd();

export const cacheWhyExecute = async ({ argument, logger, options, workspaceRoot: wsRoot }: Toolbox<Console, CacheWhyOptions>): Promise<void> => {
    const taskId = argument[0];

    if (!taskId) {
        pail.error("No task ID specified. Usage: vis cache why <project>:<target>");
        process.exitCode = 1;

        return;
    }

    await runWhy(
        taskId,
        {
            format: options.format ?? "table",
            runId: options.run,
            workspaceRoot: resolveWorkspaceRoot(wsRoot),
        },
        logger,
    );
};

export const cacheHashExecute = async ({ argument, logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, CacheHashOptions>): Promise<void> => {
    const taskId = argument[0];

    if (!taskId) {
        pail.error("No task ID specified. Usage: vis cache hash <project>:<target>");
        process.exitCode = 1;

        return;
    }

    const { directoriesFor } = resolveCacheDirectoryFromContext(wsRoot, options, visConfig as Record<string, unknown> | undefined);

    await runHash(
        taskId,
        {
            cacheDirectories: directoriesFor("read"),
            format: options.format ?? "table",
            runId: options.run,
            workspaceRoot: resolveWorkspaceRoot(wsRoot),
        },
        logger,
    );
};

export const cacheSizeExecute = async ({ options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, CacheSizeOptions>): Promise<void> => {
    const target = parseCacheTarget(options.type);
    const format = options.format ?? "table";

    if (format === "json") {
        const payload: Record<string, unknown> = {};

        if (includesTarget(target, "task")) {
            const { directoriesFor } = resolveCacheDirectoryFromContext(wsRoot, options, visConfig as Record<string, unknown> | undefined);
            const cacheDirectories = directoriesFor("read");

            payload.task = await Promise.all(
                cacheDirectories.map(async (directory) => {
                    const exists = isAccessibleSync(directory);
                    const entries = exists ? await collectCacheEntries(directory) : [];
                    const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

                    return {
                        directory,
                        entries: entries.length,
                        exists,
                        newestEntry: isoOrNull(entries[0]?.mtimeMs),
                        oldestEntry: isoOrNull(entries.at(-1)?.mtimeMs),
                        totalBytes,
                    };
                }),
            );
        }

        if (includesTarget(target, "ai")) {
            const stats = getAiCacheStats();

            payload.ai = {
                entries: stats.entries,
                newestEntry: isoOrNull(stats.newestEntry),
                oldestEntry: isoOrNull(stats.oldestEntry),
                totalBytes: stats.totalSizeBytes,
            };
        }

        if (includesTarget(target, "socket")) {
            const stats = getSocketCacheStats();

            payload.socket = {
                entries: stats.entries,
                newestEntry: isoOrNull(stats.newestEntry),
                oldestEntry: isoOrNull(stats.oldestEntry),
                totalBytes: stats.totalSizeBytes,
            };
        }

        if (includesTarget(target, "deps-dev")) {
            const stats = getDepsDevCacheStats();

            payload["deps-dev"] = {
                entries: stats.entries,
                newestEntry: isoOrNull(stats.newestEntry),
                oldestEntry: isoOrNull(stats.oldestEntry),
                totalBytes: stats.totalSizeBytes,
            };
        }

        if (includesTarget(target, "snyk")) {
            const stats = getSnykCacheStats();

            payload.snyk = {
                entries: stats.entries,
                newestEntry: isoOrNull(stats.newestEntry),
                oldestEntry: isoOrNull(stats.oldestEntry),
                totalBytes: stats.totalSizeBytes,
            };
        }

        process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`);

        return;
    }

    if (includesTarget(target, "task")) {
        const { directoriesFor } = resolveCacheDirectoryFromContext(wsRoot, options, visConfig as Record<string, unknown> | undefined);
        const cacheDirectories = directoriesFor("read");

        for (const directory of cacheDirectories) {
            if (cacheDirectories.length > 1) {
                pail.info(`# ${directory}`);
            }

            await runSize(directory, "table");
        }
    }

    if (includesTarget(target, "ai")) {
        printStatsBlock("AI response cache", getAiCacheStats());
    }

    if (includesTarget(target, "socket")) {
        printStatsBlock("Socket.dev report cache", getSocketCacheStats());
    }

    if (includesTarget(target, "deps-dev")) {
        printStatsBlock("deps.dev cache", getDepsDevCacheStats());
    }

    if (includesTarget(target, "snyk")) {
        printStatsBlock("Snyk issue cache", getSnykCacheStats());
    }
};

export const cacheVerifyExecute = async ({
    argument,
    logger,
    options,
    visConfig,
    workspaceRoot: wsRoot,
}: Toolbox<Console, CacheVerifyOptions>): Promise<void> => {
    const taskId = argument[0];

    if (!taskId) {
        pail.error("No task ID specified. Usage: vis cache verify <project>:<target>");
        process.exitCode = 1;

        return;
    }

    // Pass every directory the chosen --scope produced. With
    // `--scope=all`, that's [shared, worktree]; verify will look up the
    // task hash in each, in order, and use the first match. Other
    // scopes resolve to a single-element list.
    const { directoriesFor, workspaceRoot } = resolveCacheDirectoryFromContext(wsRoot, options, visConfig as Record<string, unknown> | undefined);
    const cacheDirectories = directoriesFor("read");

    await runVerify(
        taskId,
        {
            cacheDirectories,
            format: options.format ?? "table",
            workspaceRoot,
        },
        logger,
    );
};

export { clearAiCacheSafe, clearDepsDevCacheSafe, clearSnykCacheSafe, clearSocketCacheSafe, runClean } from "./clean";
export { collectCacheEntries, formatAge } from "./entries";
export { runHash } from "./hash";
export { runList } from "./list";
export { runPrune } from "./prune";
export { runSize } from "./size";
export { runVerify } from "./verify";
export { runWhy } from "./why";
