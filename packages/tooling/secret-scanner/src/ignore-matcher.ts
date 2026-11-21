import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import ignoreModule from "ignore";

import type { ScanOptions } from "./types";

/** Tests a path against a set of gitignore-syntax patterns. */
export interface IgnoreMatcher {
    ignores: (path: string) => boolean;
}

interface Ignore {
    add: (patterns: string | string[]) => Ignore;
    ignores: (path: string) => boolean;
}

// `ignore` ships as ESM and CJS; handle both default-export shapes transparently.
const ignore: () => Ignore = (ignoreModule as { default?: () => Ignore }).default ?? ignoreModule;

// On macOS, process.cwd() resolves symlinks (/private/var/…) while mkdtemp &
// path.resolve keep the un-resolved form (/var/…). On Windows realpathSync also
// leaves 8.3 short names and drive-letter case unnormalized, so canonicalize
// through realpathSync.native — that way relative() compares like with like
// instead of emitting an absolute path that makes matcher.ignores() throw.
export const canonicalize = (path: string): string => {
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

/** Whether `file` is strictly inside `root`. Both must already be canonical. */
export const isWithin = (root: string, file: string): boolean => {
    const relativePath = relative(root, file);

    return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
};

/** Build a matcher from a set of gitignore-syntax patterns, tested against plain relative paths. */
export const createIgnoreMatcher = (patterns: string | string[]): IgnoreMatcher | undefined => {
    if (patterns.length === 0) {
        return undefined;
    }

    // `ignore.add()` splits a multi-line string but treats array entries as
    // individual patterns — preserve the caller's shape.
    const matcher = ignore().add(patterns);

    return { ignores: (path) => matcher.ignores(path) };
};

// Patterns are anchored at `base`, and absolute paths outside it are never matched.
const sourceMatcher = (base: string, patterns: string | string[]): IgnoreMatcher | undefined => {
    const matcher = createIgnoreMatcher(patterns);

    if (matcher === undefined) {
        return undefined;
    }

    const root = canonicalize(base);

    return { ignores: (path) => isWithin(root, path) && matcher.ignores(relative(root, path)) };
};

const SECRETLINTIGNORE = ".secretlintignore";

/**
 * Build the matcher for the `scanFiles` path — it bypasses the native walker
 * and therefore has to filter paths itself. Every ignore file is its own
 * source: a `.secretlintignore` is anchored at its own directory, any other
 * file and the inline patterns at `base`. `!` re-includes inside the source that declared it, but never
 * overrides an exclusion from another source. The matcher takes absolute, canonical paths. Returns `undefined` when the
 * caller supplied no ignore files or patterns (caller should skip filtering
 * entirely in that case).
 */
export const buildIgnoreMatcher = (options: ScanOptions | undefined, base: string): IgnoreMatcher | undefined => {
    const matchers: IgnoreMatcher[] = [];

    for (const file of options?.walk?.excludeFromFiles ?? []) {
        if (!existsSync(file)) {
            continue;
        }

        try {
            const fromFile = sourceMatcher(basename(file) === SECRETLINTIGNORE ? dirname(resolve(file)) : base, readFileSync(file, "utf8"));

            if (fromFile !== undefined) {
                matchers.push(fromFile);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            // eslint-disable-next-line no-console -- Diagnostic output; stderr is the intended channel for library warnings.
            console.error(`secret-scanner: failed to read ignore file ${file}: ${message}`);
        }
    }

    const fromPatterns = sourceMatcher(base, options?.walk?.excludePatterns ?? []);

    if (fromPatterns !== undefined) {
        matchers.push(fromPatterns);
    }

    return matchers.length > 0 ? { ignores: (path) => matchers.some((matcher) => matcher.ignores(path)) } : undefined;
};

const isFile = (path: string): boolean => {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
};

// Discovery stops at the repository root (the nearest ancestor with a `.git`),
// so a stray ignore file in a parent of the checkout never applies. Outside a
// repository only the scan root itself is searched.
const discoverInAncestors = (root: string): string[] => {
    const start = isFile(root) ? dirname(resolve(root)) : resolve(root);
    let top = start;

    for (let directory = start; ; directory = dirname(directory)) {
        if (existsSync(join(directory, ".git"))) {
            top = directory;

            break;
        }

        if (dirname(directory) === directory) {
            break;
        }
    }

    const found: string[] = [];

    for (let directory = start; ; directory = dirname(directory)) {
        const candidate = join(directory, ".secretlintignore");

        if (isFile(candidate)) {
            found.push(candidate);
        }

        if (directory === top) {
            return found;
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
    const real = canonicalize(absolute);

    return isWithin(root, real) ? relative(root, real).replaceAll("\\", "/") : undefined;
};

/**
 * Resolve the `.secretlintignore` files for a scan: explicit paths from
 * `secretlintIgnore`, plus auto-discovered files in each root and its parents
 * up to the repository root. Pass `secretlintIgnore: false` to disable both.
 */
export const resolveSecretlintIgnoreFiles = (options: ScanOptions | undefined, roots: ReadonlyArray<string>): string[] => {
    if (options?.secretlintIgnore === false) {
        return [];
    }

    const explicit = (options?.secretlintIgnore ?? []).map((path) => resolve(path));
    const discovered = roots.flatMap((root) => discoverInAncestors(root));

    return [...new Set([...explicit, ...discovered])];
};

/**
 * Fold discovered `.secretlintignore` files into `walk.excludeFromFiles` so
 * both the native walker and the JS `scanFiles` matcher use the same sources.
 */
export const applySecretlintIgnores = (options: ScanOptions | undefined, roots: ReadonlyArray<string>): ScanOptions | undefined => {
    const files = resolveSecretlintIgnoreFiles(options, roots);
    const existing = options?.walk?.excludeFromFiles ?? [];
    const merged = [...new Set([...existing, ...files])];

    if (merged.length === existing.length) {
        return options;
    }

    return { ...options, walk: { ...options?.walk, excludeFromFiles: merged } };
};

/**
 * Filter `files` down to those *not* matched by `matcher`; relative paths
 * resolve against `cwd`. When `matcher` is undefined, the list passes through
 * unchanged (callers don't need to special-case the empty-matcher path). Files
 * outside `cwd` are never filtered.
 */
export const filterIgnoredFiles = (files: string[], matcher: IgnoreMatcher | undefined, cwd: string): string[] => {
    if (!matcher) {
        return files;
    }

    const resolvedCwd = canonicalize(cwd);

    return files.filter((file) => {
        const absolute = canonicalize(isAbsolute(file) ? file : resolve(resolvedCwd, file));

        return insideRoot(absolute, resolvedCwd) === undefined || !matcher.ignores(absolute);
    });
};

/**
 * Whether `file` is excluded by the `walk.excludePatterns` / `walk.excludeFromFiles`
 * in `options` (plus any discovered `.secretlintignore`), the same filter
 * `scanFiles` applies to a listed file. Relative paths resolve against `root`;
 * a path outside `root` is never excluded.
 */
export const isPathExcluded = (file: string, options: ScanOptions | undefined, root: string): boolean => {
    const base = canonicalize(root);

    return filterIgnoredFiles([file], buildIgnoreMatcher(applySecretlintIgnores(options, [base]), base), base).length === 0;
};

const WINDOWS_ABSOLUTE_PATH = /^[a-z]:\//i;

/**
 * The path an override glob is tested against. A finding's `file` is relative
 * to the scan root, to the process cwd, or absolute (and empty for a single
 * file scan), so it is first made absolute through `fileRoot` (the scan root
 * the finding carries) or, without one, through `bases` (the first base it
 * exists under wins), then expressed relative to `root`. A file outside `root`,
 * or `root` itself, is matched by its basename, so slash-less globs such as
 * `*.env` still apply and the result is never an input `ignore` throws on.
 */
export const overrideMatchPath = (file: string, bases: ReadonlyArray<string>, root: string, fileRoot?: string): string => {
    const posix = file.replaceAll("\\", "/");
    let absolute: string;

    if (isAbsolute(posix) || WINDOWS_ABSOLUTE_PATH.test(posix)) {
        absolute = posix;
    } else {
        const searchBases = fileRoot === undefined ? bases : [fileRoot];
        const candidates = (searchBases.length > 0 ? searchBases : [root]).map((base) => resolve(base, posix));

        absolute = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? root;
    }

    // A filesystem root has no basename, and `ignore` rejects an empty path.
    return insideRoot(absolute, canonicalize(root)) ?? (basename(absolute) || "_");
};
