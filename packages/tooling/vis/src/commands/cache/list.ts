import { isAccessibleSync } from "@visulima/fs";
import { formatBytes } from "@visulima/humanizer";

import { pail } from "../../io/logger";
import { collectCacheEntries, formatAge } from "./entries";
import { printLine } from "./output";

export const runList = async (cacheDirectory: string, format: string, logger: Console): Promise<void> => {
    if (!isAccessibleSync(cacheDirectory)) {
        if (format === "json") {
            process.stdout.write(`${JSON.stringify({ directory: cacheDirectory, entries: [], totalBytes: 0, totalCount: 0 }, undefined, 2)}\n`);

            return;
        }

        pail.info(`No cache directory found at ${cacheDirectory}`);

        return;
    }

    const entries = await collectCacheEntries(cacheDirectory);

    if (entries.length === 0) {
        if (format === "json") {
            process.stdout.write(`${JSON.stringify({ directory: cacheDirectory, entries: [], totalBytes: 0, totalCount: 0 }, undefined, 2)}\n`);

            return;
        }

        pail.info(`Cache directory is empty: ${cacheDirectory}`);

        return;
    }

    const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

    if (format === "json") {
        const now = Date.now();

        process.stdout.write(
            `${JSON.stringify(
                {
                    directory: cacheDirectory,
                    entries: entries.map((entry) => {
                        return {
                            ageMs: now - entry.mtimeMs,
                            hash: entry.hash,
                            mtimeIso: new Date(entry.mtimeMs).toISOString(),
                            sizeBytes: entry.sizeBytes,
                        };
                    }),
                    totalBytes,
                    totalCount: entries.length,
                },
                undefined,
                2,
            )}\n`,
        );

        return;
    }

    printLine(`Cache directory: ${cacheDirectory}`);
    printLine(`Entries: ${String(entries.length)} (${formatBytes(totalBytes, { decimals: 1, space: false })})`);
    logger.info("");

    const renderedAt = Date.now();
    const rows = entries.map((entry) => {
        return {
            age: formatAge(entry.mtimeMs, renderedAt),
            hash: entry.hash.slice(0, 12),
            size: formatBytes(entry.sizeBytes, { decimals: 1, space: false }),
        };
    });

    const hashWidth = Math.max(4, ...rows.map((r) => r.hash.length));
    const sizeWidth = Math.max(4, ...rows.map((r) => r.size.length));
    const ageWidth = Math.max(3, ...rows.map((r) => r.age.length));

    logger.info(`  ${"hash".padEnd(hashWidth)}  ${"size".padEnd(sizeWidth)}  ${"age".padEnd(ageWidth)}`);
    logger.info(`  ${"-".repeat(hashWidth)}  ${"-".repeat(sizeWidth)}  ${"-".repeat(ageWidth)}`);

    for (const row of rows) {
        logger.info(`  ${row.hash.padEnd(hashWidth)}  ${row.size.padEnd(sizeWidth)}  ${row.age.padEnd(ageWidth)}`);
    }
};
