import { isAccessibleSync } from "@visulima/fs";
import { formatBytes } from "@visulima/humanizer";

import { pail } from "../../io/logger";
import { collectCacheEntries } from "./entries";
import { printLine } from "./output";

export const isoOrNull = (value: number | undefined): string | null => (value === undefined ? null : new Date(value).toISOString());

interface AuxStats {
    /** Only the task cache has a configurable location worth printing. */
    directory?: string;
    entries: number;
    newestEntry: number | undefined;
    oldestEntry: number | undefined;
    totalSizeBytes: number;
}

/** Renders one labelled cache-store block. Shared by every store `vis cache size` reports. */
export const printStatsBlock = (label: string, stats: AuxStats): void => {
    printLine(`${label}:`);

    if (stats.directory !== undefined) {
        printLine(`  Directory:  ${stats.directory}`);
    }

    printLine(`  Entries:    ${String(stats.entries)}`);
    printLine(`  Total size: ${formatBytes(stats.totalSizeBytes, { decimals: 1, space: false })}`);
    printLine(`  Oldest:     ${stats.oldestEntry ? new Date(stats.oldestEntry).toISOString() : "N/A"}`);
    printLine(`  Newest:     ${stats.newestEntry ? new Date(stats.newestEntry).toISOString() : "N/A"}`);
};

export const runSize = async (cacheDirectory: string, format: string): Promise<void> => {
    if (!isAccessibleSync(cacheDirectory)) {
        if (format === "json") {
            process.stdout.write(`${JSON.stringify({ directory: cacheDirectory, exists: false, totalBytes: 0, totalCount: 0 })}\n`);

            return;
        }

        pail.info(`No cache directory at ${cacheDirectory}`);

        return;
    }

    const entries = await collectCacheEntries(cacheDirectory);
    const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

    if (format === "json") {
        process.stdout.write(
            `${JSON.stringify({
                directory: cacheDirectory,
                exists: true,
                totalBytes,
                totalCount: entries.length,
            })}\n`,
        );

        return;
    }

    printStatsBlock("Task cache", {
        directory: cacheDirectory,
        entries: entries.length,
        newestEntry: entries[0]?.mtimeMs,
        oldestEntry: entries.at(-1)?.mtimeMs,
        totalSizeBytes: totalBytes,
    });
};
