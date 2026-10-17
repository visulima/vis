import { readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";

import { isAccessibleSync } from "@visulima/fs";
import { join } from "@visulima/path";

/**
 * Subdirectory `applyBranchScope` nests per-branch caches under. Reserved:
 * it is a container, not a cache entry.
 */
const BRANCH_SCOPE_DIRECTORY = "branches";

/**
 * Shape returned by `collectCacheEntries`. Kept close to what `removeOldEntries`
 * uses internally so we can render the list identically.
 */
interface CacheEntry {
    hash: string;
    mtimeMs: number;
    path: string;
    sizeBytes: number;
}

const sumDirectorySize = async (directory: string): Promise<number> => {
    let total = 0;

    try {
        const entries = await readdir(directory, { withFileTypes: true });

        for (const entry of entries) {
            const full = join(directory, entry.name);

            if (entry.isDirectory()) {
                total += await sumDirectorySize(full);
            } else if (entry.isFile()) {
                const s = await stat(full);

                total += s.size;
            }
        }
    } catch {
        // Ignore — permissions, concurrent deletes, etc.
    }

    return total;
};

export const collectCacheEntries = async (cacheDirectory: string): Promise<CacheEntry[]> => {
    const entries: CacheEntry[] = [];

    let dirents: string[];

    try {
        dirents = await readdir(cacheDirectory);
    } catch {
        return [];
    }

    for (const name of dirents) {
        // `branches` is the branch-scoping container, never a cache entry:
        // its children are cache roots in their own right. Counting it as one
        // entry reported N branches' worth of hashes as a single row, and
        // listing it alongside those roots would double-count them.
        if (name.startsWith(".") || name === BRANCH_SCOPE_DIRECTORY) {
            continue;
        }

        const fullPath = join(cacheDirectory, name);

        try {
            const s = await stat(fullPath);

            if (!s.isDirectory()) {
                continue;
            }

            const sizeBytes = await sumDirectorySize(fullPath);

            entries.push({
                hash: name,
                mtimeMs: s.mtimeMs,
                path: fullPath,
                sizeBytes,
            });
        } catch {
            // Ignore — entry may have been removed concurrently.
        }
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return entries;
};

export const formatAge = (mtimeMs: number, now: number = Date.now()): string => {
    // Clamp future timestamps to 0 — clock skew or networked filesystems
    // can produce mtimes ahead of `now`, and "-NNs" in the table is noise.
    const seconds = Math.max(0, Math.floor((now - mtimeMs) / 1000));

    if (seconds < 60) {
        return `${String(seconds)}s`;
    }

    if (seconds < 3600) {
        return `${String(Math.floor(seconds / 60))}m`;
    }

    if (seconds < 86_400) {
        return `${String(Math.floor(seconds / 3600))}h`;
    }

    return `${String(Math.floor(seconds / 86_400))}d`;
};

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
