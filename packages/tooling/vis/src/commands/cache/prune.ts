import { rm } from "node:fs/promises";

import { isAccessibleSync } from "@visulima/fs";
import { formatBytes } from "@visulima/humanizer";
import { Cache, parseCacheSize } from "@visulima/task-runner";

import { pail } from "../../io/logger";
import { collectCacheEntries } from "./entries";

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
