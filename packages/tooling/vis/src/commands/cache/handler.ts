import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { Toolbox } from "@visulima/cerebro";
import { isAccessibleSync } from "@visulima/fs";
import { formatBytes } from "@visulima/humanizer";
import { join, relative } from "@visulima/path";
import type { TaskFingerprint } from "@visulima/task-runner";
import { Cache, digestFile, getLastRunSummaryPath, readLastRunSummary } from "@visulima/task-runner";

import { getCacheStats as getAiCacheStats } from "../../ai/ai-cache";
import { pail } from "../../io/logger";
import { findTaskInSummary, readRunSummaryById } from "../../report/run-summary-utils";
import { getDepsDevCacheStats } from "../../security/deps-dev-security";
import { getSnykCacheStats } from "../../security/snyk-security";
import { getSocketCacheStats } from "../../security/socket-security";
import { getVisRunsDir, getVisWorkspaceDataDir } from "../../util/vis-paths";
import type { CacheHashOptions, CacheListOptions, CacheSizeOptions, CacheVerifyOptions } from "./index";
import { collectCacheEntries, formatAge, includesTarget, isoOrNull, parseCacheTarget, printLine, printStatsBlock, resolveCacheDirectoryFromContext, resolveWorkspaceRoot } from "./shared";
import { renderHashDetailsBucket, truncateHash, writeJsonLine } from "./why";

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

interface RunHashOptions {
    /** Cache roots to read a trace-mode fingerprint from, in lookup order. */
    cacheDirectories?: string[];
    format: string;
    runId: string | undefined;
    workspaceRoot: string;
}

/**
 * Trace-mode tasks have no declared hash details; their tracked inputs live in
 * the cache entry keyed by the run's hash.
 */
const readTrackedFingerprint = async (hash: string | undefined, cacheDirectories: string[], workspaceRoot: string): Promise<TaskFingerprint | undefined> => {
    if (hash === undefined) {
        return undefined;
    }

    for (const cacheDirectory of cacheDirectories) {
        const entry = await new Cache({ cacheDirectory, workspaceRoot }).get(hash);

        if (entry?.fingerprint) {
            return entry.fingerprint;
        }
    }

    return undefined;
};

const renderTrackedFingerprint = (fingerprint: TaskFingerprint, logger: Console): void => {
    renderHashDetailsBucket("tracked files", fingerprint.fileHashes, logger);
    renderHashDetailsBucket("tracked env", fingerprint.envHashes, logger);
    renderHashDetailsBucket("missing files", Object.fromEntries(fingerprint.missingFiles.map((path) => [path, "absent"])), logger);
};

export const runHash = async (taskId: string, options: RunHashOptions, logger: Console): Promise<void> => {
    const { format, runId, workspaceRoot } = options;

    const summary
        = runId === undefined
            ? await readLastRunSummary(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) })
            : await readRunSummaryById(workspaceRoot, runId);

    if (!summary) {
        if (format === "json") {
            process.stdout.write(`${JSON.stringify({ error: "no-summary", runId: runId ?? null, taskId }, undefined, 2)}\n`);
            process.exitCode = 1;

            return;
        }

        if (runId === undefined) {
            pail.error(
                `No previous run summary found. Run a task first to populate \`${getLastRunSummaryPath(workspaceRoot, { dataDirectory: getVisWorkspaceDataDir(workspaceRoot) })}\`.`,
            );
        } else {
            pail.error(`Run summary "${runId}" not found in ${getVisRunsDir(workspaceRoot)}/.`);
        }

        process.exitCode = 1;

        return;
    }

    const task = findTaskInSummary(summary, taskId);

    if (!task) {
        if (format === "json") {
            process.stdout.write(`${JSON.stringify({ error: "task-not-in-summary", runId: summary.id, taskId }, undefined, 2)}\n`);
            process.exitCode = 1;

            return;
        }

        pail.error(`Task "${taskId}" was not part of run ${summary.id}.`);
        process.exitCode = 1;

        return;
    }

    const trackedFingerprint = task.hashDetails === undefined ? await readTrackedFingerprint(task.hash, options.cacheDirectories ?? [], workspaceRoot) : undefined;

    if (format === "json") {
        process.stdout.write(
            `${JSON.stringify(
                {
                    cacheStatus: task.cacheStatus,
                    hash: task.hash ?? null,
                    hashDetails: task.hashDetails ?? null,
                    hashSource: task.hashSource ?? null,
                    runId: summary.id,
                    taskId: task.taskId,
                    trackedFingerprint: trackedFingerprint ?? null,
                },
                undefined,
                2,
            )}\n`,
        );

        return;
    }

    pail.info(`Hash for ${taskId} (run ${summary.id})`);
    logger.info("");
    logger.info(`  status:  ${task.cacheStatus}`);
    logger.info(`  hash:    ${task.hash ?? "(none)"}`);

    if (task.hashSource === "declared-fallback") {
        logger.info("  key:     declared-fallback (no files were tracked; the entry is keyed on the declared inputs below)");
    }

    if (task.hashDetails) {
        logger.info("");
        logger.info(`  command: ${truncateHash(task.hashDetails.command)}`);
        renderHashDetailsBucket("nodes", task.hashDetails.nodes, logger);
        renderHashDetailsBucket("runtime", task.hashDetails.runtime, logger);
        renderHashDetailsBucket("implicitDeps", task.hashDetails.implicitDeps, logger);
    } else if (trackedFingerprint) {
        logger.info("");
        renderTrackedFingerprint(trackedFingerprint, logger);
    } else {
        logger.info("");
        pail.info("No hash details recorded for this task.");
    }
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

interface RunVerifyOptions {
    /**
     * Ordered list of cache directories to consult. The first one
     * containing the requested task entry is used; the rest are
     * ignored. Use a single-element array for the common case.
     */
    cacheDirectories: string[];
    format: string;
    workspaceRoot: string;
}

interface CachedFileMeta {
    hash: string;
    mode: number;
    mtimeMs: number;
    relativePath: string;
    sizeBytes: number;
}

interface VerifyDiff {
    actual?: { hash?: string; mode?: number; mtimeMs?: number };
    expected?: { hash: string; mode: number; mtimeMs: number };
    issues: ReadonlyArray<"content" | "missing" | "mode" | "mtime">;
    relativePath: string;
}

const walkAndDigest = async (root: string): Promise<CachedFileMeta[]> => {
    const out: CachedFileMeta[] = [];

    const walk = async (absolute: string): Promise<void> => {
        const entries = await readdir(absolute, { withFileTypes: true });
        const items = entries.toSorted((a, b) => a.name.localeCompare(b.name));

        for (const item of items) {
            const childAbsolute = join(absolute, item.name);

            if (item.isDirectory()) {
                await walk(childAbsolute);

                continue;
            }

            if (!item.isFile()) {
                continue;
            }

            const [info, digest] = await Promise.all([stat(childAbsolute), digestFile(childAbsolute)]);

            out.push({
                hash: digest?.hash ?? "",
                // eslint-disable-next-line no-bitwise -- low 12 bits hold the rwx triplet
                mode: info.mode & 0o7777,
                mtimeMs: info.mtimeMs,
                relativePath: relative(root, childAbsolute).replaceAll("\\", "/"),
                sizeBytes: info.size,
            });
        }
    };

    await walk(root);

    return out;
};

const compareSecondsTruncated = (a: number, b: number): boolean => Math.floor(a / 1000) === Math.floor(b / 1000);

const VERIFY_DIFF_CONCURRENCY = 16;

const computeFileDiff = async (file: CachedFileMeta, workspaceRoot: string): Promise<VerifyDiff | undefined> => {
    const livePath = join(workspaceRoot, file.relativePath);
    const liveStat = await stat(livePath).catch(() => undefined);

    if (!liveStat) {
        return {
            expected: { hash: file.hash, mode: file.mode, mtimeMs: file.mtimeMs },
            issues: ["missing"],
            relativePath: file.relativePath,
        };
    }

    const liveDigest = await digestFile(livePath);

    const issues: ("content" | "mode" | "mtime")[] = [];

    if ((liveDigest?.hash ?? "") !== file.hash) {
        issues.push("content");
    }

    // eslint-disable-next-line no-bitwise -- low 12 bits hold the rwx triplet
    const liveMode = liveStat.mode & 0o7777;

    if (process.platform !== "win32" && liveMode !== file.mode) {
        issues.push("mode");
    }

    // Tar headers are second precision; a sub-second mismatch never
    // indicates a real problem.
    if (!compareSecondsTruncated(liveStat.mtimeMs, file.mtimeMs)) {
        issues.push("mtime");
    }

    if (issues.length === 0) {
        return undefined;
    }

    return {
        actual: { hash: liveDigest?.hash, mode: liveMode, mtimeMs: liveStat.mtimeMs },
        expected: { hash: file.hash, mode: file.mode, mtimeMs: file.mtimeMs },
        issues,
        relativePath: file.relativePath,
    };
};

const resolveVerifyCache = async (
    taskId: string,
    cacheDirectories: string[],
    workspaceRoot: string,
): Promise<{ cached: { hash: string }; cacheDirectory: string } | undefined> => {
    // Walk the resolved directories in order — the entry can only live
    // in one cache (task hashes are content-addressed), and we want the
    // first match to win so --scope=all has predictable semantics
    // (shared first, then worktree).
    for (const directory of cacheDirectories) {
        const found = await new Cache({ cacheDirectory: directory, workspaceRoot }).getByTaskId(taskId);

        if (found) {
            return { cached: found, cacheDirectory: directory };
        }
    }

    return undefined;
};

const failVerify = (format: string, jsonPayload: Record<string, unknown>, message: string): void => {
    if (format === "json") {
        writeJsonLine(jsonPayload);
    } else {
        pail.error(message);
    }

    process.exitCode = 1;
};

const computeVerifyDiffs = async (cachedFiles: CachedFileMeta[], workspaceRoot: string): Promise<VerifyDiff[]> => {
    // Bounded parallel: per-file IO (stat + sha256 stream) is
    // independent across files, but unbounded parallelism on a
    // 10k-file output tree would exhaust fd limits on common Linux
    // setups (default 1024). 16 keeps us well below that while
    // still saturating typical SSD read throughput.
    const diffSlots: (VerifyDiff | undefined)[] = Array.from({ length: cachedFiles.length });

    for (let offset = 0; offset < cachedFiles.length; offset += VERIFY_DIFF_CONCURRENCY) {
        const chunk = cachedFiles.slice(offset, offset + VERIFY_DIFF_CONCURRENCY);

        const results = await Promise.all(chunk.map(async (file) => computeFileDiff(file, workspaceRoot)));

        for (const [index, result] of results.entries()) {
            diffSlots[offset + index] = result;
        }
    }

    return diffSlots.filter((slot): slot is VerifyDiff => slot !== undefined);
};

const printContentDrift = (expected: { hash: string }, actual: { hash?: string }, logger: Console): void => {
    logger.info(`    expected hash: ${expected.hash || "(none)"}`);
    logger.info(`    actual   hash: ${actual.hash ?? "(unreadable)"}`);
};

const printModeDrift = (expected: { mode: number }, actual: { mode?: number }, logger: Console): void => {
    logger.info(`    expected mode: ${expected.mode.toString(8)}`);
    logger.info(`    actual   mode: ${(actual.mode ?? 0).toString(8)}`);
};

const printMtimeDrift = (expected: { mtimeMs: number }, actual: { mtimeMs?: number }, logger: Console): void => {
    logger.info(`    expected mtime: ${new Date(expected.mtimeMs).toISOString()}`);
    logger.info(`    actual   mtime: ${actual.mtimeMs === undefined ? "(unreadable)" : new Date(actual.mtimeMs).toISOString()}`);
};

const printVerifyDiffEntry = (diff: VerifyDiff, logger: Console): void => {
    const tag = diff.issues.includes("missing") ? "MISSING" : diff.issues.join(",").toUpperCase();

    logger.info(`  [${tag}] ${diff.relativePath}`);

    const { expected } = diff;
    const { actual } = diff;

    if (diff.issues.includes("missing") || !expected || !actual) {
        return;
    }

    if (diff.issues.includes("content")) {
        printContentDrift(expected, actual, logger);
    }

    if (diff.issues.includes("mode")) {
        printModeDrift(expected, actual, logger);
    }

    if (diff.issues.includes("mtime")) {
        printMtimeDrift(expected, actual, logger);
    }
};

const printVerifyTextReport = (
    taskId: string,
    hash: string,
    cacheDirectory: string,
    fileCount: number,
    diffs: VerifyDiff[],
    logger: Console,
): void => {
    pail.info(`Verify ${taskId}  (hash ${hash})`);
    logger.info("");
    logger.info(`  cache:      ${cacheDirectory}`);
    logger.info(`  files:      ${String(fileCount)}`);

    if (diffs.length === 0) {
        logger.info("");
        pail.success("Cache restore is faithful — all files match content, mode, and mtime.");

        return;
    }

    logger.info(`  drift:      ${String(diffs.length)} file(s)`);
    logger.info("");

    for (const diff of diffs) {
        printVerifyDiffEntry(diff, logger);
    }

    process.exitCode = 1;
};

// Logging convention in this command: `pail.error` / `pail.info` /
// `pail.success` carry the status banner (one-line summary, errors), and
// the cerebro `logger.info` carries body text (the per-file drift
// listing). Matches `runWhy` / `runHash`.
export const runVerify = async (taskId: string, options: RunVerifyOptions, logger: Console): Promise<void> => {
    const { cacheDirectories, format, workspaceRoot } = options;

    if (cacheDirectories.length === 0) {
        failVerify(format, { error: "no-cache-directory", taskId }, "No cache directory resolved — pass --cache-dir or run inside a workspace.");

        return;
    }

    const resolved = await resolveVerifyCache(taskId, cacheDirectories, workspaceRoot);

    if (!resolved) {
        failVerify(
            format,
            { error: "no-cached-entry", searchedCaches: cacheDirectories, taskId },
            `No cached entry found for task "${taskId}". Run it once before verifying.`,
        );

        return;
    }

    const { cached, cacheDirectory } = resolved;
    const stagingRoot = await mkdtemp(join(tmpdir(), "vis-cache-verify-"));

    try {
        // Restore into a throwaway workspaceRoot so we can compare the
        // restored files against the live tree without disturbing it.
        const stagingCache = new Cache({ cacheDirectory, workspaceRoot: stagingRoot });
        const restored = await stagingCache.restoreOutputs(cached.hash);

        if (!restored) {
            failVerify(format, { error: "restore-failed", hash: cached.hash, taskId }, `Cache restore failed for ${taskId} (hash ${cached.hash}).`);

            return;
        }

        const cachedFiles = await walkAndDigest(stagingRoot);

        if (cachedFiles.length === 0) {
            if (format === "json") {
                writeJsonLine({ diffs: [], hash: cached.hash, status: "no-outputs", taskId });
            } else {
                pail.info(`Cached entry for ${taskId} has no recorded outputs — nothing to verify.`);
            }

            return;
        }

        const diffs = await computeVerifyDiffs(cachedFiles, workspaceRoot);

        if (format === "json") {
            writeJsonLine({
                cachedFileCount: cachedFiles.length,
                cacheDirectory,
                diffs,
                hash: cached.hash,
                status: diffs.length === 0 ? "ok" : "drift",
                taskId,
            });

            if (diffs.length > 0) {
                process.exitCode = 1;
            }

            return;
        }

        printVerifyTextReport(taskId, cached.hash, cacheDirectory, cachedFiles.length, diffs, logger);
    } finally {
        await rm(stagingRoot, { force: true, recursive: true }).catch(() => {});
    }
};

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

export { cacheCleanExecute, cachePruneExecute, runClean, runPrune } from "./maintenance";
// Entry points moved to sibling modules. Re-exported here so existing importers of
// this module keep resolving them.
export { collectCacheEntries, formatAge } from "./shared";
export { cacheWhyExecute, runWhy } from "./why";
