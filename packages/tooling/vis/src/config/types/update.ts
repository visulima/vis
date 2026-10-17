export interface VisUpdateConfig {
    /**
     * Dependency fields to scan for outdated packages.
     * Beyond the standard fields, supports:
     * - `"overrides"` (npm)
     * - `"resolutions"` (yarn)
     * - `"pnpm.overrides"`
     * @default ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
     */
    depFields?: string[];
    exclude?: string[];
    format?: "json" | "minimal" | "table";

    /**
     * Package names or glob patterns to permanently ignore during updates.
     * Ignored packages are skipped and listed in the output so you know
     * they were not checked.
     * @example ["eslint", "@types/*"]
     */
    ignore?: string[];
    include?: string[];

    /**
     * Include packages with pinned/exact versions (no `^` or `~` prefix).
     * By default, pinned versions are skipped during update checks.
     * @default false
     */
    includeLocked?: boolean;
    install?: boolean;

    /**
     * Maximum number of concurrent registry requests during outdated checks.
     * Higher values speed up large workspaces but risk hitting registry rate
     * limits or self-hosted Verdaccio caps.
     * @default 8
     */
    maxConcurrentRequests?: number;

    /**
     * Minimum number of minutes since a version was published before
     * vis will consider it for updates. This mirrors pnpm's
     * `minimumReleaseAge` — a single setting that applies to both
     * install and update.
     *
     * Not set by default. If your package manager config
     * (`pnpm-workspace.yaml`) has `minimumReleaseAge`, vis will
     * read it from there as a fallback.
     * @example 1440 // 24 hours
     */
    minimumReleaseAge?: number;

    /**
     * Package names/patterns excluded from the minimumReleaseAge check.
     * @example ["webpack", "@myorg/*"]
     */
    minimumReleaseAgeExclude?: string[];

    /**
     * Per-package or per-pattern update target overrides.
     * Keys are exact package names, glob patterns, or regex patterns
     * wrapped in `/` (e.g., `/^@vue/`).
     * Values are `"latest"`, `"minor"`, or `"patch"`.
     * @example { "typescript": "minor", "/^@vue/": "patch" }
     */
    packageMode?: Record<string, "latest" | "minor" | "patch">;
    prerelease?: boolean;

    /**
     * Which release channels to consider when picking the target version.
     * - `"stable"` (default) — only ship stable releases (no prereleases).
     * - `"same"` — match the prerelease channel of the *current* range:
     *   if you're on `react@19.0.0-rc.1`, only `rc.*` candidates qualify;
     *   if you're on a stable, only stable candidates. Prevents
     *   accidentally promoting a prerelease pin to a stable major bump.
     * - `"any"` — equivalent to `--prerelease`. Any channel is fair game.
     *
     * `--release-channel` on the CLI overrides this. If `prerelease: true`
     * is set without `releaseChannel`, vis treats it as `"any"`.
     * @default "stable"
     */
    releaseChannel?: "any" | "same" | "stable";
    security?: boolean;
    target?: "latest" | "minor" | "patch";
}
