import { realpath, rm } from "node:fs/promises";
import { createInterface } from "node:readline";

import { isAccessibleSync } from "@visulima/fs";
import { formatBytes } from "@visulima/humanizer";
import { Cache } from "@visulima/task-runner";

import { clearCache as clearAiResponseCache } from "../../ai/ai-cache";
import { isCacheDirectoryInsideWorkspace } from "../../cache/cache-directory";
import { pail } from "../../io/logger";
import { clearDepsDevCache } from "../../security/deps-dev-security";
import { clearSnykCache } from "../../security/snyk-security";
import { clearSocketCache } from "../../security/socket-security";
import { collectCacheEntries, evictionDirectories } from "./entries";

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
