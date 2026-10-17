import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join, relative } from "@visulima/path";
import { Cache, digestFile } from "@visulima/task-runner";

import { pail } from "../../io/logger";
import { writeJsonLine } from "./output";

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
