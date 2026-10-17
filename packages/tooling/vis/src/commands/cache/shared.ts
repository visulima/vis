import { readdir, stat } from "node:fs/promises";

import { formatBytes } from "@visulima/humanizer";
import { join } from "@visulima/path";

import { applyBranchScope, resolveSharedCacheDirectory } from "../../cache/cache-directory";
import { pail } from "../../io/logger";
import { evictionDirectories, hasUnscopedEntries } from "./maintenance";

/**
 * Subdirectory `applyBranchScope` nests per-branch caches under. Reserved:
 * it is a container, not a cache entry.
 */
export const BRANCH_SCOPE_DIRECTORY = "branches";

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

export const isoOrNull = (value: number | undefined): string | null => (value === undefined ? null : new Date(value).toISOString());

/**
 * Writes one line of report output verbatim.
 *
 * Deliberately not `pail.info`: the pretty reporter frames every call in a
 * full-width timestamped rule plus a blank line, so a five-field stats
 * block rendered as ~20 terminal lines and the numbers scrolled the
 * directory path off screen. These lines are tabular data, not log events.
 */
export const printLine = (line: string): void => {
    process.stdout.write(`${line}\n`);
};

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

// Which cache stores does an operation touch? "task" is the workspace task
// runner cache (resolved with --scope/--cache-dir), "ai" is the global AI
// response cache under ~/.vis/cache/ai, "socket" is the Socket.dev report
// cache under ~/.vis/cache/socket-security, "deps-dev" is the Google
// deps.dev cache under ~/.vis/cache/deps-dev, "snyk" is the Snyk issue
// cache under ~/.vis/cache/snyk. "all" means every store.
type CacheTarget = "all" | "ai" | "deps-dev" | "snyk" | "socket" | "task";

export const parseCacheTarget = (raw: string | undefined): CacheTarget => {
    if (raw === "task" || raw === "ai" || raw === "socket" || raw === "deps-dev" || raw === "snyk" || raw === "all") {
        return raw;
    }

    if (raw && raw.length > 0) {
        pail.warn(`Unknown --type value '${raw}'; falling back to 'all'.`);
    }

    return "all";
};

export const includesTarget = (selected: CacheTarget, kind: Exclude<CacheTarget, "all">): boolean => selected === "all" || selected === kind;

type CacheScope = "all" | "shared" | "worktree";

const parseScope = (raw: string | undefined): CacheScope => {
    if (raw === "worktree" || raw === "shared" || raw === "all") {
        return raw;
    }

    if (raw && raw.length > 0) {
        pail.warn(`Unknown --scope value '${raw}'; falling back to 'shared'.`);
    }

    return "shared";
};

/**
 * What a `vis cache` subcommand intends to do, which decides how branch
 * scoping applies:
 *
 * - `read` — inspect what the current checkout would hit. Scoped to this
 *   branch, because that is where `vis run` writes.
 * - `evict` — enforce retention. Must see *every* branch's entries: a
 *   branch-scoped `prune --max-size` would leave every other branch's
 *   subtree growing forever, with only the nuclear `clean` able to touch
 *   them.
 * - `wipe` — remove everything. Clearing the cache means clearing the
 *   cache, not just the checked-out branch's slice of it.
 */
type CacheOperation = "evict" | "read" | "wipe";

interface ResolvedCacheContext {
    /**
     * Directories this operation should act on, deduplicated.
     *
     * Prefer this over the raw fields below — it is the one place the
     * branch-scoping decision is made, so a new subcommand cannot pick the
     * wrong one by reaching for a sibling field.
     */
    directoriesFor: (operation: CacheOperation) => string[];
    scope: CacheScope;
    sharedWorktreeCache: boolean | undefined;
    workspaceRoot: string;
}

export const resolveCacheDirectoryFromContext = (
    workspaceRoot: string | undefined,
    options: Record<string, unknown>,
    visConfig: Record<string, unknown> | undefined,
): ResolvedCacheContext => {
    const resolvedWorkspaceRoot = workspaceRoot ?? process.cwd();
    const cfg = (visConfig ?? {}) as { branchScopedCache?: boolean; sharedWorktreeCache?: boolean; taskRunner?: { cacheDirectory?: string } };
    const taskRunner = cfg.taskRunner ?? {};
    const scope = parseScope(options.scope as string | undefined);
    const optionsCacheDir = options.cacheDir as string | undefined;

    // Worktree-local: this checkout's `node_modules/.cache/vis`. Disable
    // worktree-share by passing `sharedWorktreeCache: false` so the
    // resolver returns the literal workspace_root path.
    const worktreeBase = resolveSharedCacheDirectory(resolvedWorkspaceRoot, optionsCacheDir, taskRunner.cacheDirectory, false);

    // Shared: the main worktree's cache (or workspace_root for primary checkouts).
    const sharedBase = resolveSharedCacheDirectory(resolvedWorkspaceRoot, optionsCacheDir, taskRunner.cacheDirectory, cfg.sharedWorktreeCache);

    // `vis run` writes into `<base>/branches/<slug>` when branch scoping is
    // on (see `applyBranchScope`). Without the same hop here every `vis
    // cache` subcommand inspected the empty base directory and reported a
    // full cache as 0 entries. No-op when `branchScopedCache` isn't `true`.
    const worktreeDirectory = applyBranchScope(worktreeBase, resolvedWorkspaceRoot, cfg.branchScopedCache);
    const sharedDirectory = applyBranchScope(sharedBase, resolvedWorkspaceRoot, cfg.branchScopedCache);

    // Pair each selected root with its branch-scoped read location, so
    // every operation can pick the form it needs from the same selection.
    let selected: { base: string; scoped: string }[];

    switch (scope) {
        case "all": {
            selected
                = sharedDirectory === worktreeDirectory
                    ? [{ base: sharedBase, scoped: sharedDirectory }]
                    : [
                        { base: sharedBase, scoped: sharedDirectory },
                        { base: worktreeBase, scoped: worktreeDirectory },
                    ];
            break;
        }
        case "worktree": {
            selected = [{ base: worktreeBase, scoped: worktreeDirectory }];
            break;
        }
        default: {
            selected = [{ base: sharedBase, scoped: sharedDirectory }];
        }
    }

    const branchScoped = cfg.branchScopedCache === true;

    return {
        directoriesFor: (operation: CacheOperation): string[] => {
            if (operation === "read") {
                // The branch subtree is where `vis run` reads and writes, so it
                // leads. A base still holding pre-scoping entries is appended so
                // the reporting commands account for every byte `prune` can
                // reclaim — they are dead weight, but they are not invisible.
                return [
                    ...new Set(
                        selected.flatMap((entry) =>
                            (entry.scoped !== entry.base && hasUnscopedEntries(entry.base) ? [entry.scoped, entry.base] : [entry.scoped]),
                        ),
                    ),
                ];
            }

            if (operation === "wipe") {
                return [...new Set(selected.map((entry) => entry.base))];
            }

            return [...new Set(selected.flatMap((entry) => evictionDirectories(entry.base, branchScoped)))];
        },
        scope,
        sharedWorktreeCache: cfg.sharedWorktreeCache,
        workspaceRoot: resolvedWorkspaceRoot,
    };
};

export const resolveWorkspaceRoot = (workspaceRoot: string | undefined): string => workspaceRoot ?? process.cwd();
