/**
 * Recognised input sources for the codeowners aggregator.
 *
 * - `project-json` — owners declared on each project's `project.json`.
 *   Canonical source; takes precedence over the other two on path conflicts.
 * - `nested-codeowners` — `CODEOWNERS` files placed at arbitrary depth
 *   in the workspace tree (excluding the generated root file).
 * - `package-json-maintainers` — fallback that reads each project's
 *   `package.json#maintainers` and emits one entry per project root for
 *   projects with no `project.json owners`. GitHub handles are extracted
 *   from each maintainer's `url` (e.g. `https://github.com/&lt;handle&gt;`).
 */
export type CodeownersSource = "nested-codeowners" | "package-json-maintainers" | "project-json";

export interface CodeownersConfig {
    /** Markers that bracket the generated block when `preserveBlock` is set. */
    blockMarker?: { begin: string; end: string };
    /** Workspace-level paths that apply outside any project (e.g., `.github/**`). */
    globalPaths?: Record<string, string[]>;
    /** Glob patterns used to discover nested `CODEOWNERS` files. Defaults to `["**\/CODEOWNERS"]`. */
    nestedIncludes?: string[];
    /** Sort order for generated entries — mirrors moon's `orderBy`. */
    orderBy?: "file-source" | "project-id";

    /**
     * When set, the generated content is spliced between
     * {@link CodeownersConfig.blockMarker} markers in the existing file
     * (markers are appended if missing) instead of overwriting the file.
     */
    preserveBlock?: boolean;
    /** Provider determines whether `channel` is emitted (GitHub supports it via comment). */
    provider?: "bitbucket" | "github" | "gitlab" | "other";

    /**
     * Header instruction shown to reviewers. Replaces the default
     * "Update each project's project.json `owners` field…" line. Useful
     * when the canonical regenerate path is a custom script.
     */
    regenerationCommand?: string;
    /** Enabled input sources. Defaults to `["project-json"]`. */
    sources?: CodeownersSource[];
}

/**
 * Declared code-owner assignment for a path glob within a project.
 * Mirrors moon's `owners` shape so migrations can round-trip cleanly.
 */
export interface OwnersEntry {
    /** Optional notification channel (e.g. Slack, Teams). */
    channel?: string;
    /** Owner handles (e.g. `@visulima/core-team`). */
    owners: string[];
    /** File/glob pattern relative to the project root. */
    path: string;
}
