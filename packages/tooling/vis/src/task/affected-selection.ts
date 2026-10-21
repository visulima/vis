import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { dirname, join } from "@visulima/path";
import type {
    AffectedResult,
    AffectedScope,
    ExternalInputDefinition,
    NamedInputs,
    ProjectConfiguration,
    ProjectGraph,
    TargetConfiguration,
} from "@visulima/task-runner";
import { collectExternalInputs, getAffectedProjects } from "@visulima/task-runner";
import isInCi from "is-in-ci";

import { VisUserError } from "../errors/vis-user-error";
import { resolveAffectedShas } from "../runtime/affected-shas";
import { DEFAULT_WORKSPACE_CACHE_DIRECTORY } from "../util/vis-paths";

const VALID_SCOPES = new Set<string>(["deep", "direct", "none"]);

/**
 * The `--affected` knobs, shared verbatim by `vis affected` and
 * `vis run --affected` so the two entry points can never drift.
 */
export interface AffectedSelectionOptions {
    /** Git base ref. Auto-resolved from CI/git when omitted. */
    base?: string;

    /** How far to follow dependents of changed projects. Default `"deep"`. */
    downstream?: string;

    /** Git head ref. Auto-resolved from CI/git when omitted. */
    head?: string;

    /**
     * Whether to fold uncommitted working-tree changes into the changed-file
     * set. `undefined` means "auto": on for local runs, off in CI.
     */
    uncommitted?: boolean;

    /** How far to follow dependencies of changed projects. Default `"none"`. */
    upstream?: string;
}

export interface SelectAffectedInput {
    /** Unowned-path globs from `vis.config.ts#affectedIgnore`. */
    affectedIgnore?: string[];

    /** Default base branch from `vis.config.ts#defaultBase`. */
    defaultBase?: string;

    /**
     * Where the previous run's external-input hashes are stored. Defaults to
     * `{workspaceRoot}/node_modules/.cache/vis/external-inputs.json` so the
     * snapshot lives with derived cache state and is cleaned with it.
     * Callers that resolved a custom cache directory should pass it here.
     */
    externalInputStatePath?: string;

    /**
     * Whether to write the external-input snapshot immediately. Defaults to
     * `true` for selection-only commands (`vis affected --sparse-checkout`).
     * `vis run --affected` sets this to `false` and persists after a
     * successful run, so a failed run cannot advance the baseline past input
     * state the tasks never processed.
     */
    persistExternalInputState?: boolean;

    /** Injectable for tests; defaults to a real `git` invocation. */
    readWorkingTreeChanges?: (workspaceRoot: string) => string[];

    /** Injectable for tests; defaults to `is-in-ci`. */
    runningInCi?: boolean;
}

export interface SelectAffectedResult extends AffectedResult {
    /**
     * Location of the external-input snapshot. Present when the selection
     * declared external inputs; `vis run` uses it to persist after a
     * successful run.
     */
    externalInputStatePath?: string;

    /** Human-readable provenance lines describing how base/head were picked. */
    notes: string[];

    /** Number of changed files contributed by the uncommitted working tree. */
    uncommittedFileCount: number;
}

/**
 * Parse `git status --porcelain -z` into a list of workspace-relative paths.
 *
 * NUL-delimited output is used rather than the newline form because the
 * latter shell-quotes paths containing spaces or non-ASCII bytes, which
 * would then not match any project root. Rename/copy entries carry a second
 * NUL-terminated field holding the *original* path; both sides are returned
 * since a rename changes two projects.
 */
export const parsePorcelainStatus = (raw: string): string[] => {
    const files: string[] = [];
    const fields = raw.split("\0");

    for (let index = 0; index < fields.length; index++) {
        const entry = fields[index];

        // Trailing NUL yields a final empty field.
        if (!entry) {
            continue;
        }

        // Each entry is "XY <path>": two status columns, a space, then the
        // path. Anything shorter is not a status line we understand.
        if (entry.length < 4) {
            continue;
        }

        const status = entry.slice(0, 2);
        const path = entry.slice(3);

        if (path) {
            files.push(path);
        }

        // Renames and copies append the source path as its own field.
        if (status.includes("R") || status.includes("C")) {
            index += 1;

            const source = fields[index];

            if (source) {
                files.push(source);
            }
        }
    }

    return files;
};

const defaultReadWorkingTreeChanges = (workspaceRoot: string): string[] => {
    // `--porcelain` paths are repository-root relative, matching the
    // `git diff --name-only` output that task-runner maps to projects.
    const result = spawnSync("git", ["status", "--porcelain", "-z"], { cwd: workspaceRoot, encoding: "utf8" });

    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
        return [];
    }

    return parsePorcelainStatus(result.stdout);
};

const readExternalInputHashes = async (statePath: string): Promise<Record<string, string> | undefined> => {
    try {
        const content = await readFile(statePath, "utf8");
        const parsed: unknown = JSON.parse(content);

        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : undefined;
    } catch {
        // No snapshot yet (or an unreadable/corrupt one): affected detection
        // treats every external input as changed, which is the safe answer.
        return undefined;
    }
};

export const persistExternalInputHashes = async (statePath: string, hashes: Record<string, string>): Promise<void> => {
    const temporaryPath = `${statePath}.${process.pid}.tmp`;

    try {
        await mkdir(dirname(statePath), { recursive: true });
        await writeFile(temporaryPath, JSON.stringify(hashes));
        await rename(temporaryPath, statePath);
    } catch {
        // Best-effort: a read-only workspace must not fail affected detection.
        await rm(temporaryPath, { force: true }).catch(() => {});
    }
};

/**
 * Drops the external-input snapshot after a failure that happened outside the
 * regular task-results map (for example a persistent task exiting non-zero).
 * The next selection then treats every external input as changed, which is the
 * safe outcome.
 */
export const invalidateExternalInputState = async (statePath: string): Promise<void> => {
    await rm(statePath, { force: true }).catch(() => {});
};

/**
 * Resolve which projects are affected, applying the same base/head
 * resolution, scope validation and working-tree handling regardless of
 * whether the caller was `vis affected` or `vis run --affected`.
 *
 * Throws on an invalid `--downstream`/`--upstream` value.
 */
export const selectAffectedProjects = async (
    options: AffectedSelectionOptions,
    workspace: {
        fileOwners?: Record<string, string[]>;
        namedInputs?: NamedInputs;
        projectGraph: ProjectGraph;
        projects: Record<string, ProjectConfiguration>;
        targetDefaults?: Record<string, Partial<TargetConfiguration>>;
        workspaceRoot: string;
    },
    input: SelectAffectedInput = {},
): Promise<SelectAffectedResult> => {
    const downstreamValue = options.downstream ?? "deep";
    const upstreamValue = options.upstream ?? "none";

    if (!VALID_SCOPES.has(downstreamValue)) {
        throw new VisUserError(`Invalid --downstream value: "${downstreamValue}". Must be "none", "direct", or "deep".`);
    }

    if (!VALID_SCOPES.has(upstreamValue)) {
        throw new VisUserError(`Invalid --upstream value: "${upstreamValue}". Must be "none", "direct", or "deep".`);
    }

    const { fileOwners, namedInputs, projectGraph, projects, targetDefaults, workspaceRoot } = workspace;
    const notes: string[] = [];

    let { base } = options;
    let { head } = options;

    if (!base || !head) {
        const resolved = resolveAffectedShas({ defaultBase: input.defaultBase, workspaceRoot });

        // `||`, not `??` — the guard above treats an empty string as "not
        // supplied", so `--base=` must fall back too. With `??` it would
        // survive as "" and reach git as an empty ref.
        base = base || resolved.base;
        head = head || resolved.head;

        notes.push(`Resolved affected refs from ${resolved.provider} (${resolved.notes.join("; ")})`);
    }

    // A ref-to-ref diff cannot see the working tree, so locally `--affected`
    // would answer "nothing changed" for the exact edits the user is asking
    // about. Fold in `git status` unless the head was pinned to something
    // other than the working tree, or we are in CI where the checkout is the
    // whole truth.
    const inCi = input.runningInCi ?? isInCi;
    const headIsWorkingTree = head === "HEAD" || head === "";
    const includeUncommitted = options.uncommitted ?? (!inCi && headIsWorkingTree);

    let additionalChangedFiles: string[] = [];

    if (includeUncommitted) {
        if (headIsWorkingTree) {
            const readWorkingTree = input.readWorkingTreeChanges ?? defaultReadWorkingTreeChanges;
            const workingTreeFiles = readWorkingTree(workspaceRoot);

            // Keep only paths that land inside a known project.
            //
            // `getAffectedProjects` treats a changed file belonging to no
            // project as a workspace-wide change and marks *every* project
            // affected. That is the right call for a committed change to a
            // root tsconfig, but not for the working tree: `git status`
            // also reports untracked scratch — `notes.md`, `plans/`,
            // `.env.local`, and (before `vis init` runs) `.vis/` itself.
            // Any one of them would silently turn `--affected` into "build
            // everything" while still printing an affected-projects list.
            const projectRoots = Object.values(projects)
                .map((project) => project.root?.replace(/\/$/, ""))
                .filter((root): root is string => Boolean(root) && root !== ".");

            additionalChangedFiles = workingTreeFiles.filter(
                (file) =>
                    (fileOwners !== undefined && Object.hasOwn(fileOwners, file)) || projectRoots.some((root) => file === root || file.startsWith(`${root}/`)),
            );

            const skipped = workingTreeFiles.length - additionalChangedFiles.length;

            if (additionalChangedFiles.length > 0) {
                notes.push(`including ${additionalChangedFiles.length} uncommitted working-tree file(s)`);
            }

            if (skipped > 0) {
                notes.push(`ignoring ${skipped} uncommitted path(s) outside any project (untracked scratch would otherwise mark every project affected)`);
            }
        } else {
            // An explicit --head names a commit, so "uncommitted relative to
            // it" is not a meaningful set. Say so rather than silently
            // ignoring the flag.
            notes.push(`ignoring --uncommitted: --head=${head} pins the comparison to a commit, not the working tree`);
        }
    }

    const externalInputs: ExternalInputDefinition[] = collectExternalInputs(workspaceRoot, projects, { namedInputs, targetDefaults });
    const externalInputStatePath = input.externalInputStatePath ?? join(workspaceRoot, DEFAULT_WORKSPACE_CACHE_DIRECTORY, "external-inputs.json");
    const previousExternalInputHashes = externalInputs.length > 0 ? await readExternalInputHashes(externalInputStatePath) : undefined;

    const result = await getAffectedProjects({
        additionalChangedFiles,
        base,
        downstream: downstreamValue as AffectedScope,
        externalInputs,
        fileOwners,
        head,
        ignoredFiles: input.affectedIgnore,
        previousExternalInputHashes,
        projectGraph,
        projects,
        upstream: upstreamValue as AffectedScope,
        workspaceRoot,
    });

    if (externalInputs.length > 0 && result.externalInputHashes && input.persistExternalInputState !== false) {
        await persistExternalInputHashes(externalInputStatePath, result.externalInputHashes);
    }

    if (result.changedExternalInputs && result.changedExternalInputs.length > 0) {
        notes.push(`including ${result.changedExternalInputs.length} changed external input(s) outside the workspace`);
    }

    if (result.ignoredFiles.length > 0) {
        notes.push(`ignoring ${result.ignoredFiles.length} changed path(s) outside any project matching affectedIgnore`);
    }

    return {
        ...result,
        externalInputStatePath: externalInputs.length > 0 ? externalInputStatePath : undefined,
        notes,
        uncommittedFileCount: additionalChangedFiles.length,
    };
};
