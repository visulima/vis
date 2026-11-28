/**
 * Lists a pnpm workspace from `pnpm-workspace.yaml` instead of running `pnpm -r ls`.
 *
 * The answer is only given for the shapes whose result is known to match what
 * pnpm prints: `undefined` means "ask pnpm". Read-only release commands use
 * this to avoid a 0.3 s spawn; every command that writes keeps the spawn.
 *
 * What pnpm does, and what is reproduced here:
 * - the workspace root is always listed, then every directory below it that the
 *   `packages` patterns select and that holds a `package.json`;
 * - `node_modules`, `bower_components` and dot directories are never entered, and
 *   `.gitignore` plays no part (unlike vis's own project discovery);
 * - paths are the real path of the root joined with the relative directory;
 * - the order depends on the pnpm version: pnpm 9 to 11 sort the path strings
 *   (`a-b`, `a.b`, `a/x`), pnpm 12 sorts directory by directory (`a`, `a/x`,
 *   `a-b`). The version that will run is only known from the root manifest's
 *   `packageManager` pin, so a workspace without a pin, or with one outside the
 *   versions checked against the real binary, is left to pnpm.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { parse as parseYaml } from "@visulima/yaml";

import type { WorkspaceListEntry } from "./interface";

const SKIPPED_DIRECTORIES = new Set(["bower_components", "node_modules"]);

/** A path segment pnpm and this reader agree on: a literal name, `*` or `**`. */
const SUPPORTED_SEGMENT_RE = /^(?:\*\*?|[\w@][\w.@-]*)$/;

/** Names outside the basic plane are ordered by code point by some runtimes and by code unit by others, so they are left to the manager. */
const SURROGATE_RE = /[\uD800-\uDFFF]/;

interface Pattern {
    segments: string[];
}

/**
 * Splits a `packages` entry into segments, or returns `undefined` when it uses
 * anything beyond literal names, `*` and `**` (braces, extglobs, dot segments,
 * a leading `./`, a trailing slash, partial wildcards such as `pkg-*`).
 */
const toPattern = (raw: string): Pattern | undefined => {
    const segments = raw.split("/");

    return segments.every((segment) => SUPPORTED_SEGMENT_RE.test(segment)) ? { segments } : undefined;
};

/**
 * Whether `segments` (a directory) is matched by `pattern`, where `*` is one
 * segment and `**` is any number of segments, including none.
 */
const matchesSegments = (pattern: ReadonlyArray<string>, segments: ReadonlyArray<string>): boolean => {
    const [head, ...rest] = pattern;

    if (head === undefined) {
        return segments.length === 0;
    }

    if (head === "**") {
        return segments.some((_, index) => matchesSegments(rest, segments.slice(index))) || matchesSegments(rest, []);
    }

    const [first, ...others] = segments;

    return first !== undefined && (head === "*" || head === first) && matchesSegments(rest, others);
};

type Comparator = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => number;

/** The order of pnpm 9 to 11: the path strings compared by UTF-16 code units, so `a-b` and `a.b` come before `a/x`. */
const comparePathStrings: Comparator = (a, b) => {
    const left = a.join("/");
    const right = b.join("/");

    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
};

/** The order of pnpm 12: one name at a time, so a directory comes right before what is inside it (`a`, `a/x`, `a-b`). */
const compareSegments: Comparator = (a, b) => {
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) {
            return (a[index] as string) < (b[index] as string) ? -1 : 1;
        }
    }

    return a.length - b.length;
};

const PNPM_PIN_RE = /^pnpm@(\d+)\.(\d+)\.\d+(?:\+[\w.-]+)?$/;

/**
 * The ordering of the pnpm that a `packageManager` pin selects, or `undefined`
 * for no pin, another manager, a pre-release or a version that was not checked
 * against the real binary: 9.5 to 11.x, and 12.2 to 12.23. pnpm 12.0 and 12.1
 * also list dot directories that a pattern matches, so they are not covered.
 */
const comparatorForPin = (pin: unknown): Comparator | undefined => {
    const match = typeof pin === "string" ? PNPM_PIN_RE.exec(pin) : null;
    const major = Number(match?.[1]);
    const minor = Number(match?.[2]);

    if ((major === 9 && minor >= 5) || major === 10 || major === 11) {
        return comparePathStrings;
    }

    return major === 12 && minor >= 2 && minor <= 23 ? compareSegments : undefined;
};

/** `!dir/**` ignores `dir` and everything under it: true when some leading part of `segments` matches `dir`. */
const isIgnored = (ignores: ReadonlyArray<Pattern>, segments: ReadonlyArray<string>): boolean =>
    ignores.some((ignore) => segments.some((_, index) => matchesSegments(ignore.segments, segments.slice(0, index + 1))));

const readPackages = async (root: string): Promise<{ ignores: Pattern[]; includes: Pattern[] } | undefined> => {
    let content: string;

    try {
        content = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
    } catch {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = parseYaml(content, { strict: true });
    } catch {
        return undefined;
    }

    const packages = (parsed as { packages?: unknown } | null)?.packages;

    if (!Array.isArray(packages) || packages.length === 0) {
        return undefined;
    }

    const includes: Pattern[] = [];
    const ignores: Pattern[] = [];

    for (const entry of packages) {
        if (typeof entry !== "string") {
            return undefined;
        }

        if (entry.startsWith("!")) {
            // Only `dir/**`: any other negation reaches pnpm's glob engine in a way this reader does not model.
            const negated = entry.endsWith("/**") ? toPattern(entry.slice(1, -3)) : undefined;

            if (negated === undefined || negated.segments.every((segment) => segment === "*" || segment === "**")) {
                return undefined;
            }

            ignores.push(negated);
        } else {
            const pattern = toPattern(entry);

            if (pattern === undefined) {
                return undefined;
            }

            includes.push(pattern);
        }
    }

    return includes.length > 0 ? { ignores, includes } : undefined;
};

/** Directories (as segment lists) below `root` that hold a `package.json`, or `undefined` when the tree holds something this reader cannot answer for. */
const findPackageDirectories = async (root: string, ignores: ReadonlyArray<Pattern>): Promise<string[][] | undefined> => {
    const found: string[][] = [];
    let unsupported = false;

    const visit = async (segments: string[]): Promise<void> => {
        let entries: Dirent[];

        try {
            entries = await readdir(join(root, ...segments), { withFileTypes: true });
        } catch {
            unsupported = true;

            return;
        }

        const children: string[][] = [];

        for (const entry of entries) {
            if (entry.name === "package.json") {
                found.push(segments);
            } else if (entry.name === "package.json5" || entry.name === "package.yaml") {
                // pnpm reads these as manifests too.
                unsupported = true;
            } else if (entry.isSymbolicLink()) {
                // fast-glob follows links; whether pnpm lists what they point at is not modelled here.
                if (!entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name)) {
                    const target = await stat(join(root, ...segments, entry.name)).catch(() => undefined);

                    if (target?.isDirectory() !== false) {
                        unsupported = true;
                    }
                }
            } else if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name)) {
                const child = [...segments, entry.name];

                if (!isIgnored(ignores, child)) {
                    children.push(child);
                }
            }
        }

        await Promise.all(children.map((child) => visit(child)));
    };

    await visit([]);

    return unsupported ? undefined : found;
};

/**
 * The packages `pnpm -r ls --depth -1 --json` would list for the workspace at `cwd`, read from files.
 * `undefined` when the answer is not certain, in which case the caller runs pnpm.
 */
export const listPnpmWorkspaceFromFiles = async (cwd: string): Promise<WorkspaceListEntry[] | undefined> => {
    if (sep !== "/") {
        return undefined;
    }

    const patterns = await readPackages(cwd);

    if (patterns === undefined) {
        return undefined;
    }

    let compare: Comparator | undefined;

    try {
        compare = comparatorForPin((JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager);
    } catch {
        return undefined;
    }

    if (compare === undefined) {
        return undefined;
    }

    let root: string;

    try {
        root = await realpath(cwd);
    } catch {
        return undefined;
    }

    const directories = await findPackageDirectories(root, patterns.ignores);

    if (directories === undefined) {
        return undefined;
    }

    const selected = directories
        .filter((segments) => segments.length === 0 || patterns.includes.some((pattern) => matchesSegments(pattern.segments, segments)))
        .sort(compare);

    // No root manifest: pnpm's output for that case is not modelled.
    if (selected[0]?.length !== 0 || selected.some((segments) => segments.some((name) => SURROGATE_RE.test(name)))) {
        return undefined;
    }

    const entries: WorkspaceListEntry[] = [];

    for (const segments of selected) {
        const path = join(root, ...segments);
        let manifest: { name?: unknown; private?: unknown; version?: unknown };

        try {
            manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as typeof manifest;
        } catch {
            // pnpm fails the whole listing on an unreadable manifest.
            return undefined;
        }

        if (typeof manifest.name === "string") {
            entries.push({
                name: manifest.name,
                path,
                private: manifest.private === true,
                version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
            });
        }
    }

    return entries;
};
