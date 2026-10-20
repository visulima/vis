// eslint-disable-next-line n/no-unsupported-features/node-builtins -- stable in the Node 22.x runtimes we ship against
import { glob, readFile, stat } from "node:fs/promises";

// eslint-disable-next-line import/no-extraneous-dependencies -- bundled inline by packem from workspace devDependency
import { xxh3Hash } from "@shared/xxh3";
import { isAbsolute, relative, resolve } from "@visulima/path";

import { looksLikeInputUri, parseInputUri } from "./parse-input-uri";
import type { FileSetInput, InputDefinition, NamedInputs, ProjectConfiguration, TargetConfiguration } from "./types";
import { collectFiles } from "./utils";

/**
 * A file-set input that resolves outside `workspaceRoot`, together with the
 * projects whose targets declared it.
 *
 * The task hasher and affected detection must agree on this set: the hasher
 * folds the external files into the cache key, while affected detection uses
 * the same owner map to decide which projects an external change touches.
 */
export interface ExternalInputDefinition {
    /** Absolute glob or literal path, with forward slashes. */
    pattern: string;
    /** Projects that declared this external input. */
    projects: string[];
}

/** Directory names the native directory walker skips, mirrored here. */
const IGNORED_DIRECTORIES = new Set([".cache", ".git", "coverage", "dist", "node_modules"]);

const GLOB_METACHARS = /[*?[\]{}]/;

/**
 * Normalizes a fileset entry into a string pattern that uses
 * `{projectRoot}` / `{workspaceRoot}` tokens.
 *
 * - Bare strings are returned unchanged.
 * - Object form `{ pattern, base: "workspace" }` → `{workspaceRoot}/&lt;pattern>`
 *   (or `!{workspaceRoot}/...` when `pattern` starts with `!`).
 * - Object form `{ pattern, base: "package" }` → `{projectRoot}/&lt;pattern>`.
 */
export const normalizeFileset = (fileset: FileSetInput["fileset"]): string => {
    if (typeof fileset === "string") {
        return fileset;
    }

    const token = fileset.base === "workspace" ? "{workspaceRoot}" : "{projectRoot}";

    if (fileset.pattern.startsWith("!")) {
        return `!${token}/${fileset.pattern.slice(1)}`;
    }

    return `${token}/${fileset.pattern}`;
};

/**
 * Resolves a fileset pattern against the workspace. Returns an absolute,
 * forward-slash pattern with a leading `!` preserved for negations.
 */
export const resolveFilesetPattern = (workspaceRoot: string, projectRoot: string, fileset: FileSetInput["fileset"]): string => {
    const normalized = normalizeFileset(fileset);
    const negated = normalized.startsWith("!");
    const body = negated ? normalized.slice(1) : normalized;
    const resolved = resolve(workspaceRoot, body.replaceAll("{projectRoot}", () => projectRoot).replaceAll("{workspaceRoot}", () => "."));

    return negated ? `!${resolved}` : resolved;
};

/**
 * The deepest directory prefix of a pattern that contains no glob magic.
 * Used to decide containment without treating a wildcard as a path segment.
 */
const nonGlobBase = (pattern: string): string => {
    const segments = pattern.split("/");
    const firstGlobIndex = segments.findIndex((segment) => GLOB_METACHARS.test(segment));

    return (firstGlobIndex === -1 ? segments : segments.slice(0, firstGlobIndex)).join("/") || "/";
};

/**
 * Returns `true` when a resolved pattern addresses something outside the
 * workspace root. Glob magic is removed before the containment check so a
 * pattern like `/external/**` is evaluated on `/external`.
 */
export const isExternalPattern = (workspaceRoot: string, pattern: string): boolean => {
    const absolute = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    const rel = relative(workspaceRoot, nonGlobBase(absolute));

    return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
};

const isFileSetInput = (input: InputDefinition): input is FileSetInput => "fileset" in input;

/** Expands named inputs and URI sugar into the raw fileset patterns they carry. */
const collectFilesetPatterns = (
    inputs: (string | InputDefinition)[],
    namedInputs: NamedInputs,
    seen: Set<string>,
): FileSetInput["fileset"][] => {
    const patterns: FileSetInput["fileset"][] = [];

    for (const input of inputs) {
        if (typeof input === "string") {
            if (looksLikeInputUri(input)) {
                const parsed = parseInputUri(input);

                if (parsed && isFileSetInput(parsed)) {
                    patterns.push(parsed.fileset);
                }

                continue;
            }

            if (input.startsWith("{") || input.startsWith("!{")) {
                patterns.push(input);
            } else if (input.startsWith("^")) {
                continue;
            } else if (namedInputs[input] && !seen.has(input)) {
                seen.add(input);
                patterns.push(...collectFilesetPatterns(namedInputs[input], namedInputs, seen));
            } else {
                patterns.push(input);
            }
        } else if (isFileSetInput(input)) {
            patterns.push(input.fileset);
        }
    }

    return patterns;
};

/**
 * Collects every file-set input declared by a project target that resolves
 * outside `workspaceRoot`, grouped by the projects that declare it.
 *
 * Both the declared hasher (for cache keys) and affected detection (for
 * project selection) build on this function, so they cannot disagree about
 * which external paths belong to which project.
 */
export const collectExternalInputs = (
    workspaceRoot: string,
    projects: Record<string, ProjectConfiguration>,
    options: { namedInputs?: NamedInputs; targetDefaults?: Record<string, Partial<TargetConfiguration>> } = {},
): ExternalInputDefinition[] => {
    const namedInputs = options.namedInputs ?? {};
    const targetDefaults = options.targetDefaults ?? {};
    const owners = new Map<string, Set<string>>();

    for (const [projectName, project] of Object.entries(projects)) {
        const projectRoot = project.root ?? "";
        const targets = new Map<string, Partial<TargetConfiguration>>(Object.entries(targetDefaults));

        for (const [targetName, target] of Object.entries(project.targets ?? {})) {
            targets.set(targetName, { ...targets.get(targetName), ...target });
        }

        for (const target of targets.values()) {
            if (!target.inputs) {
                continue;
            }

            for (const fileset of collectFilesetPatterns(target.inputs, namedInputs, new Set())) {
                const pattern = resolveFilesetPattern(workspaceRoot, projectRoot, fileset);

                if (pattern.startsWith("!") || !isExternalPattern(workspaceRoot, pattern)) {
                    continue;
                }

                let projectNames = owners.get(pattern);

                if (!projectNames) {
                    projectNames = new Set();
                    owners.set(pattern, projectNames);
                }

                projectNames.add(projectName);
            }
        }
    }

    return [...owners.entries()]
        .map(([pattern, projectNames]) => { return { pattern, projects: [...projectNames].toSorted() }; })
        .toSorted((a, b) => a.pattern.localeCompare(b.pattern));
};

/** Expands a literal path or glob into the sorted files it addresses. */
const expandPattern = async (pattern: string): Promise<string[]> => {
    if (!GLOB_METACHARS.test(pattern)) {
        const direct = await stat(pattern).catch(() => undefined);

        if (direct?.isFile()) {
            return [pattern];
        }

        if (direct?.isDirectory()) {
            const files = await collectFiles(pattern, IGNORED_DIRECTORIES);

            return files.toSorted();
        }

        return [];
    }

    try {
        const entries: string[] = [];

        for await (const entry of glob(pattern, { withFileTypes: false })) {
            if (typeof entry === "string" && !entry.split(/[/\\]/).some((segment) => IGNORED_DIRECTORIES.has(segment))) {
                entries.push(entry);
            }
        }

        return entries.toSorted();
    } catch {
        return [];
    }
};

/**
 * Content-hashes every file addressed by the external patterns. The result
 * is keyed by the pattern itself, so callers can compare a previous snapshot
 * with the current state and find the patterns (and therefore projects) whose
 * external inputs changed.
 *
 * A pattern that currently matches nothing hashes as an empty string rather
 * than being omitted: a file appearing later is then a change.
 */
export const computeExternalInputHashes = async (inputs: ReadonlyArray<ExternalInputDefinition>): Promise<Record<string, string>> => {
    const hashes: Record<string, string> = {};

    for (const input of inputs) {
        // eslint-disable-next-line no-await-in-loop -- patterns are hashed sequentially to keep IO pressure predictable
        const files = await expandPattern(input.pattern);
        const parts: string[] = [];

        for (const file of files) {
            try {
                // eslint-disable-next-line no-await-in-loop -- per-file reads are bounded by the pattern's file count
                const content = await readFile(file);

                parts.push(`${file}:${xxh3Hash(content)}`);
            } catch {
                // Unreadable files contribute a stable marker so gaining or
                // losing read permission still changes the snapshot.
                parts.push(`${file}:__unreadable__`);
            }
        }

        hashes[input.pattern] = xxh3Hash(Buffer.from(parts.join("\n"), "utf8"));
    }

    return hashes;
};

/**
 * Returns the subset of external patterns whose content differs from the
 * previous snapshot. When no previous snapshot exists, every pattern counts
 * as changed — affected detection must not report "nothing changed" for
 * external inputs it has never observed.
 */
export const findChangedExternalInputs = (
    inputs: ReadonlyArray<ExternalInputDefinition>,
    current: Record<string, string>,
    previous: Record<string, string> | undefined,
): string[] =>
    inputs
        .filter((input) => previous === undefined || previous[input.pattern] !== current[input.pattern])
        .map((input) => input.pattern);

/** Returns the projects that own at least one of the given external patterns. */
export const projectsForExternalPatterns = (
    inputs: ReadonlyArray<ExternalInputDefinition>,
    patterns: ReadonlyArray<string>,
): string[] => {
    const changed = new Set(patterns);
    const projects = new Set<string>();

    for (const input of inputs) {
        if (!changed.has(input.pattern)) {
            continue;
        }

        for (const project of input.projects) {
            projects.add(project);
        }
    }

    return [...projects];
};
