import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import ignoreModule from "ignore";

import type { ScanOptions } from "./types";

// `ignore` ships as ESM and CJS; handle both default-export shapes transparently.
export interface IgnoreMatcher {
    add: (pattern: string | string[]) => IgnoreMatcher;
    ignores: (path: string) => boolean;
}

type IgnoreFactory = () => IgnoreMatcher;

const ignore: IgnoreFactory = (ignoreModule as { default?: IgnoreFactory }).default ?? ignoreModule;

/** Build a matcher from a set of gitignore-syntax patterns. */
export const createIgnoreMatcher = (patterns: string | string[]): IgnoreMatcher | undefined => {
    if (patterns.length === 0) {
        return undefined;
    }

    const matcher = ignore();

    matcher.add(patterns);

    return matcher;
};

/**
 * Build a gitignore matcher for the `scanFiles` path — it bypasses the native
 * walker and therefore has to filter paths itself. Returns `undefined` when the
 * caller supplied no ignore files or patterns (caller should skip filtering
 * entirely in that case).
 */
export const buildIgnoreMatcher = (options: ScanOptions | undefined): IgnoreMatcher | undefined => {
    const ignoreFiles = options?.walk?.excludeFromFiles ?? [];
    const patterns = options?.walk?.excludePatterns ?? [];

    if (ignoreFiles.length === 0 && patterns.length === 0) {
        return undefined;
    }

    const matcher = ignore();

    for (const file of ignoreFiles) {
        if (!existsSync(file)) {
            continue;
        }

        try {
            matcher.add(readFileSync(file, "utf8"));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            // eslint-disable-next-line no-console -- Diagnostic output; stderr is the intended channel for library warnings.
            console.error(`secret-scanner: failed to read ignore file ${file}: ${message}`);
        }
    }

    if (patterns.length > 0) {
        matcher.add(patterns);
    }

    return matcher;
};

// On macOS, process.cwd() resolves symlinks (/private/var/…) while
// mkdtemp & path.resolve keep the un-resolved form (/var/…). On Windows the
// JS realpathSync also leaves 8.3 short names (RUNNER~1) and drive-letter
// case unnormalized, so canonicalize through realpathSync.native — that way
// relative() compares like with like instead of emitting an absolute path
// (different-drive/-case) that would make matcher.ignores() throw.
const canonicalize = (path: string): string => {
    try {
        return realpathSync.native(path);
    } catch {
        try {
            return realpathSync(path);
        } catch {
            return path;
        }
    }
};

/**
 * `absolute` as a posix path relative to `root`, or `undefined` when it is the
 * root itself or lies outside it (including another drive). The result is
 * always safe to hand to `matcher.ignores()`, which throws on anything that is
 * not a plain relative path.
 */
const insideRoot = (absolute: string, root: string): string | undefined => {
    const relativePath = relative(root, canonicalize(absolute));

    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        return undefined;
    }

    return relativePath.replaceAll("\\", "/");
};

/**
 * Filter `files` down to those *not* matched by `matcher`. When `matcher` is
 * undefined, the list passes through unchanged (callers don't need to special-
 * case the empty-matcher path). Files outside `cwd` are never filtered.
 */
export const filterIgnoredFiles = (files: string[], matcher: IgnoreMatcher | undefined, cwd: string): string[] => {
    if (!matcher) {
        return files;
    }

    const resolvedCwd = canonicalize(cwd);

    return files.filter((file) => {
        const relativePath = insideRoot(isAbsolute(file) ? file : resolve(resolvedCwd, file), resolvedCwd);

        return relativePath === undefined || !matcher.ignores(relativePath);
    });
};

/**
 * Whether `file` is excluded by the `walk.excludePatterns` / `walk.excludeFromFiles`
 * in `options`, the same filter `scanFiles` applies to a listed file. Relative
 * paths resolve against `root`; a path outside `root` is never excluded.
 */
export const isPathExcluded = (file: string, options: ScanOptions | undefined, root: string): boolean =>
    filterIgnoredFiles([file], buildIgnoreMatcher(options), root).length === 0;

const WINDOWS_ABSOLUTE_PATH = /^[a-z]:\//i;

/**
 * The path an override glob is tested against. A finding's `file` is relative
 * to the scan root, to the process cwd, or absolute (and empty for a single
 * file scan), so it is first made absolute through `bases` (the first base it
 * exists under wins), then expressed relative to `root`. A file outside `root`,
 * or `root` itself, is matched by its basename, so slash-less globs such as
 * `*.env` still apply and the result is never an input `ignore` throws on.
 */
export const overrideMatchPath = (file: string, bases: ReadonlyArray<string>, root: string): string => {
    const posix = file.replaceAll("\\", "/");
    let absolute: string;

    if (isAbsolute(posix) || WINDOWS_ABSOLUTE_PATH.test(posix)) {
        absolute = posix;
    } else {
        const candidates = (bases.length > 0 ? bases : [root]).map((base) => resolve(base, posix));

        absolute = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? root;
    }

    // A filesystem root has no basename, and `ignore` rejects an empty path.
    return insideRoot(absolute, canonicalize(root)) ?? (basename(absolute) || "_");
};
