import type { SimilarDepFamily } from "../../deps/similar-deps";
import type { ExtraCustomType } from "./project";

export interface NativeAuditExclusions {
    /** Package names to exclude from audit (yarn berry only). */
    excludedPackages: string[];
    /** Advisory IDs to ignore (CVE-*, GHSA-*, or numeric IDs). */
    ignoredAdvisories: string[];
}

/**
 * The 8 Socket.dev-style supply-chain policies. Used in `security.policies`
 * and `security.acceptedRisks[*].policies`. Kept as a const tuple so callers
 * can import the runtime array (`POLICY_NAMES`) for iteration without
 * drifting from the union type.
 */
export const POLICY_NAMES = ["firstSeen", "installScripts", "license", "malware", "publisherChange", "score", "unexpectedDeps", "vulnerability"] as const;

export type PolicyName = (typeof POLICY_NAMES)[number];

export interface VisPolicyConfig {
    /**
     * Map of dep names or globs → reason (or `{ reason, replacement, packages?, paths? }`).
     * Internal/workspace deps are never flagged here; the
     * workspace-protocol lint owns those.
     *
     * Optional `packages` (globs over the declaring package's `name`) and
     * `paths` (globs over the workspace-relative `packageDir`) narrow where
     * the rule applies. With both set, either match is enough. Omit both
     * to ban anywhere — the default.
     * @example
     * ```
     * bannedDeps: {
     *   request: "deprecated; use undici",
     *   moment: { reason: "huge bundle, frozen upstream", replacement: "date-fns" },
     *   "@radix-ui/*": "we standardized on shadcn",
     *   react: { reason: "no react in shared libs", paths: ["packages/shared/*"] },
     *   "next": { reason: "apps only", packages: ["@app/*"] },
     * }
     * ```
     */
    bannedDeps?: Record<string, string | { packages?: string[]; paths?: string[]; reason: string; replacement?: string }>;

    /**
     * Tweak the custom-types lint that flags drift in `engines.{node,pnpm,...}`,
     * `packageManager`, `volta.{node,pnpm,yarn}`, and the proposed
     * `devEngines.{runtime,packageManager}` array form.
     *
     * Each (customType × name) cluster is tracked independently —
     * `engines.node` and `volta.node` don't cross-couple here. Use a
     * versionGroup once that lands if you need to enforce they agree.
     */
    customTypes?: {
        /**
         * Three-state autofix opt-out. See `workspaceProtocol.autofix`
         * for the contract — same semantics, applied to drift rewrites
         * across engines / packageManager / volta / devEngines.
         *
         * Note: `--fix` strips any `+sha512.&lt;hash&gt;` suffix from
         * `packageManager` on bump — content-integrity hashes are tied
         * to a specific package, not a version, so users must regenerate
         * via their PM (`pnpm install` re-pins; `corepack use pnpm@X` etc.).
         * @default true
         */
        autofix?: "prompt" | boolean;

        /**
         * User-defined custom-type pin locations. Each entry tells the
         * customTypes lint to read additional version pins from a
         * non-standard JSON path inside every workspace package.json,
         * cluster them by `(name × depName)` like the built-in types,
         * and rewrite them with `--fix`.
         *
         * The original built-ins (`engines`, `volta`, `packageManager`,
         * `devEngines.runtime`, `devEngines.packageManager`) keep
         * running unconditionally — these layer on top.
         *
         * Strategies:
         * - `versionsByName`: the JSON at `path` is `{ [depName]: version }`
         *   (like `engines` or `pnpm.overrides`).
         * - `name@version`: the JSON at `path` is a string of the form
         *   `name@version` (like `packageManager`). The leading `name@`
         *   is preserved; only the version segment is rewritten.
         * - `string`: the JSON at `path` is a bare version string. The
         *   `depName` field is required and identifies the dep cluster.
         *
         * `name` must not collide with a built-in type name. `path` is
         * a dot-separated walk into the package.json (e.g. `pnpm.overrides`).
         * @example
         * ```ts
         * extraTypes: [
         *   { name: "pnpmOverridesLegacy", path: "pnpm.overrides", strategy: "versionsByName" },
         *   { name: "myToolPin",           path: "myTool.runtime", strategy: "name@version" },
         *   { name: "minNode",             path: "config.minNode", strategy: "string", depName: "node" },
         * ]
         * ```
         */
        extraTypes?: ExtraCustomType[];

        /**
         * Dep names exempt from the drift check (exact match against the
         * field name within the block — e.g. `node`, `pnpm`).
         */
        ignore?: string[];

        /**
         * Resolution strategy used when `--fix` runs.
         * - `highest` (default): align every drifting instance to the
         *   highest declared version.
         * - `lowest`: align to the lowest.
         * @default "highest"
         */
        resolve?: "highest" | "lowest";
    };

    /**
     * Tweak the dead-workspace-patterns lint that flags entries in
     * `pnpm-workspace.yaml#packages` / `package.json#workspaces` which
     * resolve to zero on-disk directories.
     */
    deadWorkspacePatterns?: {
        /**
         * Three-state autofix opt-out. See `workspaceProtocol.autofix`
         * for the contract — applied here to dropping unmatched patterns
         * from the workspace config file.
         * @default true
         */
        autofix?: "prompt" | boolean;
    };

    /**
     * Tweak the empty-deps lint that flags empty `dependencies` /
     * `devDependencies` / `peerDependencies` / `optionalDependencies`
     * blocks across the workspace.
     */
    emptyDeps?: {
        /**
         * Three-state autofix opt-out. See `workspaceProtocol.autofix`
         * for the contract — applied here to removing the empty key.
         * @default true
         */
        autofix?: "prompt" | boolean;

        /**
         * Block names exempt from the rule (e.g. `["peerDependencies"]`
         * to keep the key around as a marker even when empty).
         */
        ignoreBlocks?: ("dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies")[];
    };

    /**
     * Tweak the redefine-root lint that flags non-root packages duplicating
     * deps already pinned at the workspace root.
     */
    redefineRoot?: {
        /** Dep names that are exempt from the redefine-root rule (exact match). */
        ignore?: string[];
    };

    /**
     * Tweak the root-deps lint that flags runtime `dependencies` declared
     * on the private workspace root (they should live in `devDependencies`).
     */
    rootDeps?: {
        /**
         * Three-state autofix opt-out. See `workspaceProtocol.autofix`
         * for the contract — applied here to moving entries from
         * `dependencies` to `devDependencies` on the root package.json.
         * @default true
         */
        autofix?: "prompt" | boolean;
    };

    /**
     * Tweak the root-package-manager lint that flags a missing or
     * malformed `packageManager` field on the workspace root.
     */
    rootPackageManager?: {
        /**
         * Three-state autofix opt-out. See `workspaceProtocol.autofix`
         * for the contract. `--fix` only writes when `suggested` is set —
         * a missing `packageManager` field has no canonical default.
         * @default true
         */
        autofix?: "prompt" | boolean;

        /**
         * Canonical specifier (`name@version`) to write when `--fix` runs
         * and the field is absent. Required to enable autofix —
         * vis won't guess the workspace's preferred manager.
         * @example "pnpm@10.32.1"
         */
        suggested?: string;
    };

    /**
     * Tweak the root-private lint that flags a workspace root package.json
     * missing `"private": true`. Only fires when the root looks like a
     * workspace (npm/yarn/bun `workspaces` field or `pnpm-workspace.yaml`).
     */
    rootPrivate?: {
        /**
         * Three-state autofix opt-out. See `workspaceProtocol.autofix`
         * for the contract — applied here to inserting `"private": true`.
         * @default true
         */
        autofix?: "prompt" | boolean;
    };

    /**
     * Tweak the similar-deps lint that flags drift across related dep
     * families (e.g. `react` and `react-dom`, all of `@babel/*`).
     *
     * The lint is report-only — aligning a family requires picking a
     * single canonical specifier across heterogeneous range syntaxes
     * (`^`, `~`, exact), which is too lossy without user input.
     */
    similarDeps?: {
        /**
         * Additional families merged with the built-ins. Same `id` wins
         * → user override fully replaces the built-in entry.
         * @example
         * ```
         * extraFamilies: [
         *   { id: "vue", label: "Vue", members: ["vue", "vue-router", "pinia"] },
         * ]
         * ```
         */
        extraFamilies?: SimilarDepFamily[];
        /** Family ids to skip entirely (matches `SimilarDepFamily.id`). */
        ignoreFamilies?: string[];
    };

    /**
     * Tweak the types-in-deps lint that flags `@types/*` declared in
     * `dependencies` on a private package (they belong in
     * `devDependencies` since the package never ships).
     */
    typesInDeps?: {
        /**
         * Three-state autofix opt-out. See `workspaceProtocol.autofix`
         * for the contract — applied here to moving the entry to
         * `devDependencies`. Existing dev pins are preserved on conflict.
         * @default true
         */
        autofix?: "prompt" | boolean;
        /** Dep names exempt from the rule (exact match, e.g. `@types/node`). */
        ignore?: string[];
    };

    /**
     * Tweak the workspace-protocol lint that flags internal deps not
     * using the `workspace:` protocol.
     */
    workspaceProtocol?: {
        /**
         * Three-state autofix opt-out. Some workspaces want detection
         * without rewrite (e.g. dual-licensed packages where `workspace:*`
         * is unsafe).
         * - `true` (default): `--fix` rewrites the specifier.
         * - `false`: never rewrite — report the violation only.
         * - `"prompt"`: ask before each rewrite. Falls back to report-only
         *   when stdin isn't a TTY (CI). Reserved; not yet implemented.
         *
         * Note: when `false` (or `"prompt"`), `--fix` still **fails CI** on
         * detected violations — the rule is "report only", not "ignore".
         * Drop the rule from the lint selection if you want a clean exit.
         * @default true
         * @example
         * ```
         * policy: {
         *   workspaceProtocol: { autofix: false },
         * }
         * ```
         */
        autofix?: "prompt" | boolean;
    };

    /**
     * Tweak the workspace-versions lint that flags external deps declared
     * at inconsistent versions across the workspace.
     */
    workspaceVersions?: {
        /**
         * Three-state autofix opt-out. See `workspaceProtocol.autofix`
         * for the contract — same semantics, applied to drift rewrites.
         *
         * Also gates the `--propose-min` catalog suggestion writer:
         * when `false` / `"prompt"`, `--fix --propose-min` reports the
         * proposed catalog entries but does not write
         * `pnpm-workspace.yaml`. Same "report only, still fails CI"
         * note applies as on `workspaceProtocol.autofix`.
         * @default true
         */
        autofix?: "prompt" | boolean;

        /** Dep names exempt from the version-drift check (exact match). */
        ignore?: string[];

        /**
         * Resolution strategy used when `--fix` runs.
         * - `highest` (default): rewrite every drifting instance to the
         *   highest sibling specifier.
         * - `lowest`: rewrite to the lowest.
         * - `catalog`: rewrite any dep already pinned in a workspace catalog
         *   to `catalog:` / `catalog:&lt;name>`. Catalog must exist; this lint
         *   does not create the catalog (see `vis lint --resolve catalog --propose`).
         * @default "highest"
         */
        resolve?: "catalog" | "highest" | "lowest";
    };
}
