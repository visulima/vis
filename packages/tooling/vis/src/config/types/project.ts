import type { ProjectConfiguration, TargetConfiguration } from "@visulima/task-runner";

import type { VisTargetConfiguration } from "../../task/target-options";
import type { ScopedTasksMatch } from "../types";
import type { OwnersEntry } from "./codeowners";

/**
 * One user-declared customTypes entry. See `policy.customTypes.extraTypes`
 * for the full contract — this is just the row shape.
 */
export interface ExtraCustomType {
    /**
     * Required when `strategy === "string"`. The dep-cluster key the bare
     * version string at `path` should be associated with.
     */
    depName?: string;

    /**
     * Display name for this customType. Used as the cluster key prefix in
     * lint output and JSON. Must not collide with the built-in names.
     */
    name: string;
    /** Dot-separated walk into package.json (e.g. `pnpm.overrides`, `myTool.runtime`). */
    path: string;

    /**
     * How to interpret the JSON found at `path`.
     * - `name@version` — single string `pnpm@9.0.0` (with optional `+sha512.…` hash).
     * - `name~version` — single string `node~20.0.0`, mirrors syncpack's tilde form.
     * - `string` — bare version literal (requires `depName`).
     * - `versionsByName` — `{ name: version }` object such as `engines`.
     */
    strategy: "name@version" | "name~version" | "string" | "versionsByName";
}

export interface PackageJson {
    bin?: Record<string, string> | string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    name?: string;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    workspaces?: string[] | { catalog?: Record<string, string>; packages?: string[] };
}

/**
 * Per-project TypeScript overlay loaded from `vis.task.ts`. Adds a
 * dynamic, type-safe layer for target overrides on top of `project.json`,
 * which stays the canonical home for static metadata (`tags`, `layer`,
 * `stack`, `language`, `owners`, `projectType`, `sourceRoot`,
 * `implicitDependencies`).
 *
 * `vis.task.ts` is opt-in. A package without one behaves identically to
 * before its introduction. Targets defined here merge over `project.json`'s
 * `targets` block — see `design-config-layering.md` for the full
 * precedence stack.
 */
export interface VisTaskConfig {
    /** Per-target overrides — same shape as `project.json#targets`. */
    tasks?: Record<string, VisTargetConfiguration>;
}

/**
 * Per-project metadata surfaced by `project.json`. Extended beyond the
 * minimal `projectType` / `tags` / `sourceRoot` fields we historically
 * parsed to include targets, owners, and layer/stack classification.
 */
export interface ProjectJson {
    /** Implicit dependencies on other projects. */
    implicitDependencies?: string[];
    /** Primary language — informational and query-able. */
    language?: string;

    /**
     * Architectural layer this project sits in. Purely declarative — set
     * it here in `project.json` and nothing infers it, which is why the
     * `Layer` column in `vis list` reads `—` until you do.
     *
     * Once set it becomes queryable (`--query "layer=library"`) and feeds
     * `constraints`, where it is the natural way to express rules like
     * "nothing in `library` may depend on an `application`".
     * @example "library"
     */
    layer?: "application" | "automation" | "configuration" | "library" | "scaffolding" | "tool";

    /**
     * Project name. When set, takes precedence over `package.json#name`
     * as the project's identity in the workspace graph and CLI filters.
     * Falls back to `package.json#name` when omitted.
     */
    name?: string;
    /** Code owners for paths inside this project. */
    owners?: OwnersEntry[];
    /** Project-level metadata. */
    project?: {
        channel?: string;
        description?: string;
        maintainers?: string[];
        owner?: string;
        title?: string;
    };

    /**
     * Project type — `library`, `application`, `service`, or `tool`.
     *
     * - `library` — reusable code consumed by other workspace projects.
     * - `application` — end-user-facing build target (web app, mobile app).
     * - `service` — long-running HTTP / worker process deployed independently.
     * - `tool` — CLI or developer tooling shipped as an executable.
     */
    projectType?: "application" | "library" | "service" | "tool";

    /**
     * Marks the project as write-restricted. Consumed by
     * `vis sync codeowners --write-guard` to scope the generated
     * Write Guard workflow to this project's paths.
     */
    restricted?: boolean;
    /** Source root, used for display and language inference. */
    sourceRoot?: string;
    /** Tech stack. */
    stack?: "backend" | "data" | "frontend" | "infrastructure" | "systems";
    /** Filterable tags. */
    tags?: string[];
    /** Vis-style target definitions (merged on top of package.json scripts). */
    targets?: Record<string, VisTargetConfiguration>;
}

/**
 * A single scoped-tasks block — a set of task defaults gated by an
 * optional match predicate.
 */
export interface ScopedTasksBlock {
    /** Optional match predicate; if omitted, the block applies universally. */
    match?: ScopedTasksMatch;
    /** Task default configurations, keyed by target name. */
    tasks: Record<string, Partial<VisTargetConfiguration>>;
}

/**
 * Extended project configuration exposed on the discovered workspace.
 * Adds vis-specific metadata (layer, stack, language, owners) on top of
 * the task-runner `ProjectConfiguration`.
 */
export interface VisProjectConfiguration extends ProjectConfiguration {
    /** Primary language identifier. */
    language?: string;
    /** Project layer classification (matches moon's layer hierarchy). */
    layer?: ProjectJson["layer"];
    /** Owners entries declared in project.json. */
    owners?: OwnersEntry[];
    /** Human-readable metadata block. */
    project?: ProjectJson["project"];
    /** Whether the project is write-restricted (Write Guard). */
    restricted?: boolean;
    /** Project stack classification. */
    stack?: ProjectJson["stack"];
    /** Raw targets with vis-specific options retained. */
    targets?: Record<string, TargetConfiguration>;
}

/**
 * Per-project options cache indexed by project name. Used by the run
 * command to read vis-specific target options without reparsing.
 */
export type ProjectOptionsIndex = Map<string, Record<string, VisTargetConfiguration>>;

/**
 * Parsed `package.json` files from the discovery pass, keyed by
 * project name. `buildProjectGraph` consumes this to avoid
 * re-parsing every `package.json` just to extract dependency info.
 */
export type PackageJsonIndex = Map<string, PackageJson>;

/**
 * Pre-loaded `vis.task.ts` overlays keyed by *relative* project
 * directory (the same key that `resolveWorkspacePatterns` returns).
 * Callers that want the overlay applied must produce this map before
 * calling `discoverWorkspace` — see `loadVisTaskConfigsForWorkspace`.
 */
export type VisTaskConfigIndex = Map<string, VisTaskConfig>;
