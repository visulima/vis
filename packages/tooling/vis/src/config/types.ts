import type { ConstraintsConfig, NamedInputs, TaskRunnerOptions } from "@visulima/task-runner";

import type { FmtAdapterId, LintAdapterId } from "../lint-fmt/config-types";
import type { VisReleaseConfig } from "../release/types";
import type { RuntimeId } from "../runtime/adapters/types";
import type { ToolchainConfig as InternalToolchainConfig, VersionManagerName } from "../runtime/toolchain";
import type { StagedConfig } from "../staged";
import type { VisTargetConfiguration } from "../task/target-options";
import type { VisPlugin } from "../util/hooks";
import type { CodeownersConfig } from "./types/codeowners";
import type { LintFmtAdapterOverride } from "./types/lint";
import type { VisPolicyConfig } from "./types/policies";
import type { ProjectJson, ScopedTasksBlock } from "./types/project";
import type { VisSecurityConfig } from "./types/security";
import type { VisUpdateConfig } from "./types/update";

/**
 * Same shape as `T`. Wrapping a section type in it makes the schema
 * generator emit the section as a nested object, as it does for an inline
 * type literal, instead of a `$ref` to a named definition. This keeps the
 * published JSON schema unchanged when a section moves to its own module.
 */
type Inline<T> = { [K in keyof T]: T[K] };

/**
 * A predicate used by {@link VisConfig.scopedTasks}.
 * All listed constraints must match for the block to apply.
 */
export interface ScopedTasksMatch {
    /** Match on primary language. */
    language?: string | string[];
    /** Match on project layer. */
    layer?: ProjectJson["layer"] | ProjectJson["layer"][];
    /** Match on project type. */
    projectType?: "application" | "library" | "service" | "tool";
    /** Match on project stack. */
    stack?: ProjectJson["stack"] | ProjectJson["stack"][];
    /** Match projects tagged with any of these tags. */
    tags?: string[];
}

export interface VisConfig {
    /**
     * Workspace-relative glob patterns for changed files outside every
     * project that `vis affected`, `vis run --affected`, `vis ci` and
     * `vis ci ignore` should not count as a change.
     *
     * By default a changed file that belongs to no project (a root
     * `tsconfig.json`, `package.json`, …) is a global change and marks every
     * project affected. A changed file matching one of these patterns is
     * skipped instead. The patterns are only checked for files that belong
     * to NO project: a file inside a project root is never filtered, so a
     * broad pattern like `*.md` cannot hide a real package change.
     *
     * Patterns use `path.matchesGlob` syntax, where `*` does not cross `/`:
     * `*.md` matches `README.md` but not `docs/guide.md`.
     *
     * Do NOT list paths whose changes really do affect projects, such as
     * bundler-inlined shared source or the root `tsconfig.json`: an edit
     * there would then run nothing.
     * @example ["api-snapshots/**", "plans/**", "*.md"]
     */
    affectedIgnore?: string[];

    /** AI analysis configuration */
    ai?: {
        /** Cache TTL in milliseconds. Overrides default (1h / 30min for security). */
        cacheTtl?: number;
        /** Override default provider priority. Higher number = preferred. */
        priority?: Record<string, number>;
        /** Use a specific provider instead of auto-detecting (e.g., `"claude"`, `"gemini"`). */
        provider?: string;
    };

    /**
     * Scope the task-runner cache directory by the current git branch.
     * When `true`, caches are stored under `&lt;cacheDir>/branches/&lt;slug>`
     * so `main` and feature branches stop thrashing each other —
     * generated artefacts (schemas, `.d.ts` snapshots) that legitimately
     * differ across branches no longer oscillate the cache contents.
     *
     * Falls back to the unscoped path on detached HEAD, non-git
     * workspaces, or when git isn't available.
     * @default false
     */
    branchScopedCache?: boolean;

    /**
     * Code ownership configuration. Controls how `vis sync codeowners`
     * renders the generated CODEOWNERS file.
     */
    codeowners?: CodeownersConfig;

    /**
     * Composer packages as task projects. Off by default: a `composer.json` in a
     * subdirectory gets validate and, when its scripts define them, test and lint targets.
     */
    composer?: { discover?: boolean };

    /**
     * Project dependency constraints.
     * Enforced after building the project graph, before running tasks.
     */
    constraints?: ConstraintsConfig;

    /**
     * Configuration for the `vis create` scaffolding command.
     * Controls template downloads (via giget), default options, and
     * post-creation behavior.
     */
    create?: {
        /**
         * Authorization token for downloading private repository templates.
         * Passed as Bearer token to the git host API.
         * Can also be set via GIGET_AUTH, GITHUB_TOKEN, or GH_TOKEN environment variables.
         */
        auth?: string;

        /**
         * Default editor to configure after scaffolding.
         * When set, `vis create` automatically generates editor config files.
         * @example "vscode"
         */
        defaultEditor?: "vscode";

        /**
         * Default package manager for new standalone projects.
         * When set, skips the PM selection prompt in interactive mode.
         */
        defaultPm?: "bun" | "npm" | "pnpm" | "yarn";

        /**
         * Default giget provider for `owner/repo` shorthand inputs.
         * @default "github"
         */
        defaultProvider?: "bitbucket" | "github" | "gitlab" | "sourcehut";

        /**
         * Template used by a bare `vis create`. Accepts any template input, including an
         * organization scope (`@acme` opens the `@acme/create` manifest picker, `@acme:app`
         * selects one entry directly). In a terminal the usual prompts still run, minus the template step.
         * @example "@acme"
         */
        defaultTemplate?: string;

        /**
         * Initialize a git repository after scaffolding standalone projects.
         * @default false
         */
        gitInit?: boolean;

        /**
         * Install dependencies automatically after scaffolding.
         * @default true
         */
        install?: boolean;

        /**
         * Prefer locally cached templates over re-downloading.
         * Useful for offline development or slow connections.
         * @default false
         */
        preferOffline?: boolean;

        /**
         * Custom template registry URL.
         * When set, giget checks this registry for template metadata
         * before falling back to direct provider resolution.
         * Set to `false` to disable registry lookup entirely.
         * @see https://github.com/unjs/giget#custom-registry
         */
        registry?: false | string;

        /**
         * Named template aliases for quick access.
         * Maps short names to full giget source strings.
         * @example
         * ```
         * templates: {
         *   "react": "github:vitejs/vite/packages/create-vite/template-react-ts",
         *   "lib": "github:my-org/lib-template",
         *   "internal": "gitlab:company/templates/node-service",
         * }
         * ```
         */
        templates?: Record<string, string>;
    };

    /**
     * Dart pub workspace members as task projects. Off by default: each member listed
     * under the root `pubspec.yaml`'s `workspace:` gets analyze, test and format-check
     * targets only when this is set.
     */
    dart?: { discover?: boolean };

    /**
     * Default base branch used by `vis affected`, `vis ci`, and `vis run --affected`
     * when no explicit `--base` is passed and no CI smart-resolver fires.
     *
     * Resolved as `origin/&lt;defaultBase>` against the local clone; should be a
     * branch name (not a fully-qualified ref) such as `main`, `master`, or `trunk`.
     * Falls back to `main` when omitted.
     *
     * Migrated automatically from `nx.json#affected.defaultBase` /
     * `nx.json#defaultBase` by `vis migrate nx`.
     * @default "main"
     */
    defaultBase?: string;

    /**
     * Discover `.editorconfig` for indent / line-ending defaults during
     * file transformations (sort-package-json, migrate, hook, pm overrides,
     * workspace catalog rewrites). Per-command flags can still override.
     * @default true
     */
    editorconfig?: boolean;

    /**
     * Inherit configuration from one or more parent configs. Entries are
     * resolved left-to-right (later wins) and the consumer's own values
     * always override anything pulled in from `extends`.
     *
     * Each entry is either:
     * - a relative path (`./shared.config.ts`, `../shared.config.ts`) —
     *   resolved against the file declaring `extends`;
     * - an npm package name (`@acme/vis-preset`) — resolved via Node.js
     *   module resolution from the consumer file.
     *
     * Absolute paths are rejected — they break across machines and CI.
     * Cycles raise `VisConfigCycleError` during load.
     * @example
     * ```
     * extends: ["@acme/vis-preset", "./shared/security.config.ts"]
     * ```
     */
    extends?: string | string[];

    /**
     * Named file-group patterns, reusable from target `inputs` via the
     * `@filegroup:&lt;name>` token. File groups are resolved relative to each
     * project root at discovery time.
     * @example
     * ```
     * fileGroups: {
     *   sources: ["src/**\/*.ts", "!src/**\/*.test.ts"],
     *   tests: ["**\/*.test.ts"],
     * }
     * ```
     */
    fileGroups?: Record<string, string[]>;

    /**
     * Configuration for `vis fmt` — the formatter orchestrator.
     *
     * Tunes adapter detection precedence, per-extension routing, and
     * per-adapter overrides. Flags on the CLI always win over config.
     *
     * The default fmt precedence is `oxfmt → biome → dprint → prettier`.
     * When multiple adapters claim the same extension,
     * the first in this order owns it unless overridden here.
     * @example
     * ```
     * fmt: {
     *   order: ["biome", "prettier"],
     *   extensionOverrides: { md: "dprint" },
     *   adapters: { dprint: { enabled: false } },
     * }
     * ```
     */
    fmt?: {
        /**
         * Per-adapter overrides. Keyed by `AdapterId`. Set
         * `enabled: false` to skip an adapter even when detected, or
         * `extraArgs` to append flags verbatim.
         */
        adapters?: Partial<Record<FmtAdapterId, LintFmtAdapterOverride>>;

        /**
         * Pin a file extension (without the leading dot) to a specific
         * adapter, overriding the registry's "first detected adapter
         * wins" routing. Use to e.g. send `.md` to `dprint` even when
         * both prettier and dprint are present.
         */
        extensionOverrides?: Record<string, FmtAdapterId>;

        /**
         * Override the adapter precedence order. Adapters omitted from
         * this list still run (appended at the end in registry order),
         * but those listed earlier get priority for extension routing.
         */
        order?: FmtAdapterId[];
    };

    /**
     * Gems as task projects. Off by default: each `*.gemspec` directory (except `vendor`,
     * `node_modules` and `.bundle`) gets build, test and lint targets when this is set. The
     * root directory is not a task project. POSIX only: the inferred commands are not verified
     * on Windows.
     */
    gem?: { discover?: boolean };

    /**
     * Configuration for the `vis generate` in-repo scaffolding command.
     * Points at additional template directories beyond the defaults
     * (`.vis/templates/` and `.moon/templates/`).
     */
    generator?: {
        /**
         * Authorization token forwarded to giget when fetching
         * `git://`/`npm://` remote templates. Falls back to
         * `GIGET_AUTH` / `GITHUB_TOKEN` / `GH_TOKEN` env vars.
         */
        auth?: string;

        /**
         * Prefer locally cached remote templates over re-downloading.
         * Overridable per invocation via `--prefer-offline`.
         * @default false
         */
        preferOffline?: boolean;

        /**
         * Extra directories to scan for templates. Each directory is
         * checked for both native templates (`&lt;name>.ts`) and
         * moon-format directories (containing `template.yml`).
         * @example
         * ```
         * generator: {
         *   templates: ["./tools/generators", "./packages/scaffolding/templates"],
         * }
         * ```
         */
        templates?: string[];
    };

    /**
     * Go modules (the `use` entries of `go.work`) as task projects. Off by default.
     * The root module is not a task project.
     */
    go?: { discover?: boolean };

    /**
     * Gradle projects as task projects. Off by default: a `settings.gradle(.kts)`
     * with a build script for each module gets build and test targets only when this is set.
     */
    gradle?: { discover?: boolean };

    /**
     * Hex apps as task projects. Off by default: each `&lt;apps_path>/*` app of an umbrella
     * `mix.exs` gets build, test and format-check targets when this is set. The root project
     * is not a task project. POSIX only: the inferred commands are not verified on Windows.
     */
    hex?: { discover?: boolean };

    /**
     * Auto-create targets from detected config files (Project Crystal-style).
     * Detectors run by default; set `false` to disable them entirely, or use
     * the object form to disable individual ones. See the note at the bottom
     * of this block for what "unset" allows versus an explicit `true`.
     *
     * Inferred targets sit *below* explicit ones — the command from
     * `package.json#scripts`, `project.json#targets`, or `vis.task.ts`
     * always wins per-key, so enrichment never changes what runs. As a
     * caching aid, when a `package.json` script's command *is* a
     * detector's command (optionally with extra flags, no shell
     * chaining) and the script declares no `inputs`/`outputs`, the
     * detector's `inputs`/`outputs` are adopted so the script target can
     * cache precisely and restore its artifacts. Customised/compound
     * scripts are left untouched.
     *
     * Built-in detectors and the targets they synthesize:
     *
     * - **App frameworks** — `nuxt` (build/dev/preview/generate),
     *   `next` (build/dev/start), `remix` (build/dev/start), `astro`
     *   (build/dev), `gatsby` (build/develop/serve), `docusaurus`
     *   (build/start/serve).
     * - **Bundlers** — `vite` (build/dev/preview), `rolldown` (build),
     *   `tsdown` (build), `tsup` (build), `packem` (build), `rollup`
     *   (build), `webpack` (build).
     * - **Docs sites** — `vitepress` (docs:build/docs:dev/docs:preview),
     *   `typedoc` (docs).
     * - **Server frameworks** — `nest` (build/start/start:dev).
     * - **Test runners** — `vitest` (test/test:watch), `jest`
     *   (test/test:watch), `bun` (test), `playwright` (test:e2e),
     *   `cypress` (test:e2e/cypress:open).
     * - **Stories** — `storybook` (storybook/build-storybook).
     * - **Type checking** — `typescript` (typecheck via `tsc --noEmit`).
     * - **Lint / format** — `eslint` (lint), `prettier` (format /
     *   format:check), `biome` (lint, format), `oxlint` (lint),
     *   `oxfmt` (format / format:check), `stylelint` (lint:css),
     *   `knip` (knip).
     * - **Database tooling** — `prisma` (db:generate/db:migrate/
     *   db:push/db:studio), `drizzle` (db:generate/db:migrate/
     *   db:push/db:studio).
     * - **Codegen / release** — `graphql-codegen` (codegen),
     *   `api-extractor` (api-extract), `changeset` (changeset:version /
     *   changeset:publish / changeset:status).
     *
     * Trigger: presence of any matching config file in the project root.
     * Most detectors additionally match when their framework appears in
     * `dependencies` / `devDependencies` / `peerDependencies` /
     * `optionalDependencies` — covering convention-only setups (e.g.
     * vitest with default config). Detectors that intentionally require
     * a config file (because the package frequently appears transitively
     * and a dep-only match would synthesize broken commands): `vite`,
     * `rolldown`, `rollup`, `webpack`, `storybook`, `nest`, `remix`,
     * `vitepress`, `bun`, `changeset`.
     *
     * Conflict resolution: detectors are evaluated in registration order
     * (see `BUILT_IN_DETECTORS`) and the first to claim a target name
     * wins. Per-name priorities: `build` → nuxt > next > remix > astro
     * > gatsby > docusaurus > vite > nest > rolldown > tsdown > tsup >
     * packem > rollup > webpack; `test` → vitest > jest > bun;
     * `test:e2e` → playwright > cypress; `lint` → eslint > biome >
     * oxlint; `format` → prettier > biome > oxfmt; `db:*` →
     * prisma > drizzle.
     *
     * Also accepts an object form (`{ vite: false, vitest: true }`) to
     * opt individual detectors in or out by name. Detectors omitted from
     * the object run at their default (enabled). Useful when one
     * detector misfires for a given workspace without disabling the rest.
     *
     * **Leaving this unset is not the same as setting `true`.** Detectors
     * always *enrich* the targets a project already has — adopting their
     * `type`, `inputs` and `outputs`, which is the caching aid and changes
     * nothing about what runs. *Synthesizing* a target the project never
     * had does change what runs, so on the unset default it is limited to
     * projects that declare no scripts and no targets of their own.
     * Setting this to `true` (or the object form) opts in to synthesis
     * everywhere.
     *
     * The distinction exists because a package can deliberately omit a
     * script: a shared eslint-config ships an `eslint.config.js` but no
     * `lint` script, because linting its own flat-config export crashes
     * eslint. Synthesizing `lint` there turned a package `pnpm -r run lint`
     * had always skipped into a failing task, on a workspace that had never
     * asked for inference.
     *
     * Deliberately no `@default` tag: there is no single value that
     * describes the unset behaviour, and advertising `true` would invite
     * tooling to write it into a config and silently widen synthesis.
     */
    inferTargets?: Record<string, boolean> | boolean;

    /**
     * Installer backend selection for `vis install` / `vis add` /
     * `vis remove` / `vis update` / `vis ci`.
     *
     * Lets users opt into [aube](https://github.com/endevco/aube) — a
     * Rust-native package manager that reads/writes pnpm/npm/yarn/bun
     * lockfiles in place — as the default installer, while keeping a
     * single switch to fall back to the conventional PM detected from
     * the lockfile.
     *
     * Resolution precedence (highest first):
     * 1. CLI flag (`--installer &lt;name>` / `--no-aube`)
     * 2. Env var `VIS_INSTALLER`
     * 3. This config field
     * 4. Auto-detect (the default)
     *
     * Aube must be installed separately — `vis` does not bundle it.
     * Install via npm (`@endevco/aube`), `mise use -g aube`, or
     * `brew install endevco/tap/aube`.
     */
    install?: {
        /**
         * Which package manager performs install/add/remove/etc.
         * - `auto` (default): use `aube` when it is on PATH; otherwise
         *   fall back to the lockfile-detected PM.
         * - explicit name: always use that PM. Errors when the named
         *   binary is missing rather than silently falling back.
         * @default "auto"
         */
        backend?: "aube" | "auto" | "bun" | "npm" | "pnpm" | "yarn";

        /**
         * Whether to dispatch PM invocations through `corepack`.
         * - `"auto"` (default): use corepack only when the workspace
         *   pins a PM via the `packageManager` field AND `corepack` is
         *   on PATH AND the PM is one corepack manages (pnpm/yarn/npm).
         * - `true`: always prefix `corepack` when the binary is on PATH
         *   and the PM is corepack-managed (errors loudly otherwise).
         * - `false`: never go through corepack — invoke the PM directly.
         *
         * Mirrors nypm's `corepack: true` flag. Bun and aube are
         * never wrapped — corepack does not manage them.
         * @default "auto"
         */
        corepack?: "auto" | boolean;
    };

    /**
     * Configuration for `vis lint` — the linter orchestrator.
     *
     * Tunes adapter detection precedence and per-adapter overrides.
     * Flags on the CLI always win over config.
     *
     * The default lint precedence is `oxlint → biome → eslint →
     * stylelint`. Override with `order` to e.g. let biome
     * fire before oxlint when the workspace standardises on biome.
     * @example
     * ```
     * lint: {
     *   order: ["biome", "eslint"],
     *   adapters: { oxlint: { enabled: false } },
     * }
     * ```
     */
    lint?: {
        /**
         * Per-adapter overrides. Keyed by `AdapterId`. Set
         * `enabled: false` to skip an adapter even when detected, or
         * `extraArgs` to append flags verbatim.
         */
        adapters?: Partial<Record<LintAdapterId, LintFmtAdapterOverride>>;

        /**
         * Override the adapter precedence order. Adapters omitted from
         * this list still run (appended at the end in registry order)
         * unless explicitly disabled under `adapters[id].enabled`.
         */
        order?: LintAdapterId[];
    };

    /**
     * Maven modules as task projects. Off by default: a directory with a
     * `pom.xml` (and a project-root `artifactId`) gets build and test targets only when this is set.
     */
    maven?: { discover?: boolean };

    /**
     * `vis-mcp` promotion notice shown after successful commands when an
     * AI CLI (Claude Code, Cursor, Windsurf, Continue, Zed, Cline) is
     * installed but `@visulima/vis-mcp` is not wired into its config.
     *
     * Shown at most once every 14 days; skipped in CI, non-TTY shells,
     * during `--help`/`--version`/`ai`/`mcp` invocations, and when
     * `VIS_NO_MCP_PROMOTE=1` is set. Set `enabled: false` to silence
     * permanently for this workspace.
     * @example
     * ```
     * mcpPromote: { enabled: false }
     * ```
     */
    mcpPromote?: {
        /**
         * Show the vis-mcp promotion notice on successful command completion.
         * @default true
         */
        enabled?: boolean;
    };

    /**
     * Named input patterns inherited by every project target. Equivalent
     * to task-runner's `namedInputs` but configurable from the vis config.
     */
    namedInputs?: NamedInputs;

    /**
     * NuGet projects as task projects. Off by default: each directory with one `*.csproj` or
     * `*.fsproj` (outside `bin`, `obj` and `node_modules`) gets build, test and format:check
     * targets when this is set. POSIX only: the inferred commands are not verified on Windows.
     */
    nuget?: { discover?: boolean };

    /** Package override mappings applied during migration (e.g., `{ "lodash": "lodash-es" }`) */
    overrides?: Record<string, string>;

    /**
     * Plugins — each plugin registers typed hooks that fire at run /
     * task / cache boundaries. See {@link VisPlugin} for the contract.
     * Prefer plugins over per-target shell hooks when behaviour needs
     * access to task metadata, results, or cache state.
     */
    plugins?: VisPlugin[];

    /**
     * Workspace dep-policy lints exposed via `vis lint`. Each block opts in
     * to a single rule; the command flags (`--workspace-protocol`,
     * `--no-redefine-root`, `--banned-deps`) toggle them per-run.
     */
    policy?: Inline<VisPolicyConfig>;

    /**
     * Pre-flight checks fired before `vis run` starts the orchestrator.
     * Each check is opt-out (`false`) — defaults are sensible for the
     * common monorepo case.
     */
    preflight?: {
        /**
         * Detect "lockfile changed but `node_modules` is stale" before
         * running tasks. Compares lockfile mtime against the
         * package-manager-specific install marker
         * (`node_modules/.modules.yaml` for pnpm, `.package-lock.json`
         * for npm, etc.). Warns in TTY, hard-fails in CI.
         * @default true
         */
        lockfile?: boolean;
    };

    /**
     * Workspace package directories to leave out of the project graph:
     * `vis list`, `run`, `affected` and the graph never see them. The
     * package manager still installs them, so use this for fixtures that
     * must be in `pnpm-workspace.yaml` but should not be built or tested.
     * Uses the same `!`-exclusion semantics as `pnpm-workspace.yaml`.
     * @example ["packages/fixtures/**"]
     */
    projectIgnore?: string[];

    /**
     * Python projects as task projects. Off by default: a directory with a
     * `pyproject.toml` (and `[project]`) gets an inferred build target only when this is set.
     */
    python?: { discover?: boolean };

    /**
     * Configuration for the `vis release` subsystem. Controls change-file
     * authoring, version computation, channel routing, publish behavior,
     * and CI integration. See `packages/tooling/vis/rfc/design-release-manager.md`.
     */
    release?: VisReleaseConfig;

    /**
     * Behavior of `vis run` when invoked tasks declare service dependencies
     * that aren't running in the workspace registry. CLI `--services=&lt;mode>`
     * overrides this block.
     */
    run?: {
        /**
         * Wrap each task's CI log block in collapsible groups so users
         * can fold/unfold per-task output in the host CI's web UI.
         * Failed tasks always render expanded so the failure is visible
         * without an extra click.
         *
         * - `auto` (default): pick the format from the detected runner —
         *   `GITHUB_ACTIONS=true` → `github` (`::group::`),
         *   `GITLAB_CI=true` → `gitlab` (`section_start:` ANSI sequences),
         *   `BUILDKITE=true` → `buildkite` (`---` collapsed headers),
         *   `TF_BUILD=True` → `azure` (`##[group]`),
         *   no grouping otherwise.
         * - `off`: never group (raw separators only — useful when
         *   piping through tools that mangle the directives).
         * - `azure` / `buildkite` / `github` / `gitlab`: force the format
         *   regardless of detected environment (useful for self-hosted
         *   runners that don't set the standard env vars).
         *
         * CircleCI is intentionally not auto-detected: its 2.0+ format
         * has no inline grouping directive — steps auto-group in the
         * web UI without any markup from the runner.
         */
        ciGrouping?: "auto" | "azure" | "buildkite" | "github" | "gitlab" | "off";

        /**
         * Stay quiet when a run succeeds. When enabled:
         * - non-interactive output suppresses successful and cached tasks
         *   and prints only failures (failed tasks always render in full —
         *   in CI as expanded log blocks), equivalent to
         *   `--output-style=quiet`; and
         * - the interactive TUI auto-closes a few seconds after a clean run
         *   via a countdown dialog. A run with any failure stays open so the
         *   user can inspect it.
         *
         * The explicit `--output-style` CLI flag overrides the output side,
         * a per-target `options.outputStyle` overrides both, and
         * `tui.autoExit` overrides the auto-close countdown.
         *
         * Default: `false` — every task's output is echoed and the TUI waits
         * for the user. Set to `true` to opt into quiet, auto-closing runs.
         */
        quietOnSuccess?: boolean;

        /**
         * One knob controlling auto-start of missing service deps.
         * - `auto` (default in TTY): pick by task — `dev` → ephemeral,
         *   others → persistent.
         * - `ephemeral`: services die with the run (no registry entry).
         * - `persistent`: services persist across runs in the registry.
         * - `off` (default in CI / non-TTY): print diagnostics and abort.
         */
        services?: "auto" | "ephemeral" | "off" | "persistent";
    };

    /**
     * Target JS runtime for this workspace/project — `"node"` (default) or
     * `"bun"`. Overridden by the `--runtime` flag and the `VIS_RUNTIME` env
     * var; falls back to lockfile detection when unset. Part of the
     * cross-runtime multi-tool (see `rfc/design-runtime-multitool.md`).
     */
    runtime?: RuntimeId;

    /**
     * Options for `vis sbom`. `ecosystems` opts in ecosystems that the BOM otherwise leaves out:
     * Maven, Gradle, Hex, Go, Dart, Swift, NuGet and Zig. An ecosystem is also included when its
     * discover key (`maven.discover`, `go.discover`, ...) is on. Presence of a lock file or manifest
     * alone does not include it; `vis sbom` reports such ecosystems on stderr instead.
     * @example
     * ```
     * sbom: { ecosystems: ["go", "zig"] }
     * ```
     */
    sbom?: {
        ecosystems?: ("dart" | "go" | "gradle" | "hex" | "maven" | "nuget" | "swift" | "zig")[];
    };

    /**
     * Cascading scoped-task blocks. Each block may narrow its tasks to a
     * subset of projects via `match`. Blocks are evaluated in order; later
     * blocks override earlier ones when the same field is set.
     *
     * Match predicates are additive — if `match` is omitted, the block applies
     * to every project.
     * @example
     * ```
     * scopedTasks: [
     *   { match: { tags: ["frontend"] }, tasks: { build: { cache: true } } },
     *   { match: { projectType: "library" }, tasks: { lint: { cache: true } } },
     * ]
     * ```
     */
    scopedTasks?: ScopedTasksBlock[];

    /**
     * Default options for `vis secrets`. CLI flags always take precedence;
     * this block provides workspace-wide defaults so teams can commit config
     * once and every invocation picks it up.
     */
    secrets?: {
        /** Path to a baseline of previously-triaged findings (relative to workspace root). */
        baseline?: string;

        /** Where the ruleset comes from. Omit for the bundled gitleaks default. */
        config?: {
            /** Layer the user's rules on top of the bundled ruleset. Default: `true`. */
            extendBundled?: boolean;
            /** Inline rule overrides. Wins over `path` when both are set. */
            inline?: {
                allowlist?: unknown;
                allowlists?: unknown[];
                description?: string;
                rules?: unknown[];
                title?: string;
            };
            /** Path to a JSON config (gitleaks-compatible). */
            path?: string;
            /** Bundled presets layered on top of the default ruleset (e.g. `"weak-passwords"`). */
            presets?: string[];
        };

        /** Redact secret values in findings. */
        redact?: boolean;

        /** Rule-id filters applied after scanning. */
        rules?: {
            /** Drop findings whose ruleId matches. */
            exclude?: string[];
            /** Only report findings whose ruleId matches. */
            include?: string[];
        };

        /** Walker / filesystem traversal. */
        walk?: {
            /**
             * Paths to additional `.gitignore`-syntax files (e.g. `.secretsignore`).
             */
            excludeFromFiles?: string[];

            /**
             * Gitignore-syntax patterns (supports negation, directory markers, leading `/`).
             * Applied on top of `.gitignore`.
             */
            excludePatterns?: string[];
            /** Respect `.gitignore`. Default: `true`. */
            gitignore?: boolean;
            /** Include hidden (dotfile) entries. Default: `false`. */
            includeHidden?: boolean;
            /** Max file size in bytes. Default 10 MiB. */
            maxFileSize?: number;
        };
    };

    /**
     * Supply chain security settings.
     * These settings are inspired by pnpm's security features and are applied
     * universally across all package managers (pnpm, npm, yarn, bun).
     *
     * For pnpm users: these map directly to pnpm-workspace.yaml settings.
     * For npm/yarn/bun users: vis enforces these at the vis layer since
     * those package managers lack native support.
     */
    security?: Inline<VisSecurityConfig>;

    /**
     * Share the cache between sibling git worktrees. When the workspace is a
     * linked worktree (created with `git worktree add`), the cache root is
     * relocated from `&lt;linkedRoot>/node_modules/.cache/vis` to the *main*
     * worktree's `node_modules/.cache/vis`. Multiple parallel agents working in
     * sibling worktrees then share a single cache instead of rebuilding the
     * same hash N times.
     *
     * Single-checkout repos (where `.git` is a directory) are unaffected.
     *
     * Set to `false` to opt out — useful when worktrees deliberately need
     * independent caches, e.g. for hermetic experiments.
     * @default true
     */
    sharedWorktreeCache?: boolean;

    /** sort-package-json command defaults */
    sortPackageJson?: {
        /** Discover `.editorconfig` for indent / line-ending defaults (default: true). */
        editorconfig?: boolean;
        /** Collapse `bugs: { url }` to the bare string form when `url` is the only field (default: true). */
        formatBugs?: boolean;
        /** Collapse `repository: { type, url }` to the GitHub `owner/repo` shorthand (default: true). */
        formatRepository?: boolean;
        /** Sort `exports` condition keys in canonical order (default: true). */
        sortExports?: boolean;
        /** Alphabetize script commands (default: false) */
        sortScripts?: boolean;
    };

    /**
     * Sponsorship notice shown after successful commands.
     *
     * vis prints a one-line "consider sponsoring visulima" notice at most
     * once every 14 days (skipped in CI, non-TTY, and when
     * `VIS_NO_SPONSOR=1` is set). Set `enabled: false` to silence it
     * permanently for this workspace.
     * @example
     * ```
     * sponsor: { enabled: false }
     * ```
     */
    sponsor?: {
        /**
         * Show the sponsor notice on successful command completion.
         * @default true
         */
        enabled?: boolean;
    };

    /**
     * Staged file patterns and commands (replaces lint-staged).
     *
     * Accepts all lint-staged config forms:
     * - `string` or `string[]` commands
     * - Sync/async functions returning `string | string[]`
     * - `{ title, task }` objects for named side-effect tasks
     * - `{ command, perPackage }` to run a command once per owning workspace package (cwd = that package dir), and `{ command, cwd }` to pin a command to a fixed directory
     * - Mixed arrays of strings and functions
     * - A top-level generate-task function
     */
    staged?: StagedConfig;

    /**
     * When `true`, every task command is scanned for `${VAR}` / `$VAR`
     * references before spawn. If a referenced var is unset in the
     * task's effective env (envFile + service env + per-task `env` +
     * `process.env`), the task fails with an actionable error
     * naming the missing variable, instead of letting the shell
     * silently substitute an empty string.
     *
     * Override per run with `--strict-env` / `--no-strict-env`.
     * Override per target with `options.strictEnv`.
     * @default false
     */
    strictEnv?: boolean;

    /**
     * Swift packages (a `Package.swift` directory under the root) as task projects.
     * Off by default. Commands are `swift build`, `swift test`, and a `swift-format lint --strict` check.
     */
    swift?: { discover?: boolean };

    /**
     * Named bundles of target dependencies, referenceable from any task's
     * `dependsOn`. `dependsOn: [{ group: "lint" }]` expands to every entry
     * in the named group; nested groups are resolved recursively and a
     * cycle raises during discovery.
     */
    taskGroups?: Record<string, (string | { dependencies?: boolean; projects?: string | string[]; target: string } | { group: string })[]>;

    /**
     * Task runner options forwarded verbatim to `defaultTaskRunner`.
     *
     * Includes `remoteCache` (HTTP or REAPI gRPC backend), `cacheDirectory`,
     * `parallel`, `globalEnv`, `globalInputs`, etc.
     * See `TaskRunnerOptions` for the full surface.
     */
    taskRunner?: Partial<TaskRunnerOptions>;

    /**
     * Workspace-wide task defaults keyed by target name. Applied universally
     * to every project that exposes a matching target. Use `scopedTasks` when
     * defaults should only apply to a subset of projects.
     */
    tasks?: Record<string, Partial<VisTargetConfiguration>>;

    /**
     * Toolchain (Node / pnpm / python / rust / ...) management. vis
     * delegates to whichever version manager (proto, mise, fnm, volta,
     * asdf, nvm, corepack) the developer already has — it does not ship
     * its own.
     *
     * Re-exported from `./toolchain` so the public config type stays
     * in lockstep with the resolver implementation. `self-activate` is
     * narrowed out of `preferredManager` here — it's auto-resolved for
     * pnpm/yarn `packageManager` pins and isn't meaningful as an
     * override.
     */
    toolchain?: Omit<InternalToolchainConfig, "preferredManager"> & {
        readonly preferredManager?: Exclude<VersionManagerName, "self-activate">;
    };

    /** Terminal UI configuration */
    tui?: {
        /**
         * Auto-exit the TUI after tasks complete.
         * - `false`: Stay open until the user presses `q` (default)
         * - `true`: Show quit dialog with 3-second countdown after completion
         * - `number`: Show quit dialog with custom countdown in seconds
         */
        autoExit?: boolean | number;
    };

    /** Update command defaults */
    update?: Inline<VisUpdateConfig>;

    /**
     * Minimum vis CLI version required by this workspace. When the
     * running vis binary is older than this constraint, vis exits with
     * an actionable error before executing any command.
     *
     * Accepts a semver range string (e.g. `">=1.0.0"`, `"^1.2.0"`).
     * @example ">=1.0.0"
     */
    versionConstraint?: string;

    /**
     * Zig packages as task projects. Off by default: the workspace root's
     * `build.zig.zon` and its in-workspace `.path` dependencies get build, test and
     * format-check targets only when this is set. The root itself is not a task project.
     */
    zig?: { discover?: boolean };
}

export type { CodeownersConfig, CodeownersSource, OwnersEntry } from "./types/codeowners";
export type { LintFmtAdapterOverride } from "./types/lint";
export type { NativeAuditExclusions, PolicyName } from "./types/policies";
export { POLICY_NAMES } from "./types/policies";
export type { ExtraCustomType, PackageJson, PackageJsonIndex, ProjectJson, ProjectOptionsIndex, ScopedTasksBlock, VisProjectConfiguration, VisTaskConfig, VisTaskConfigIndex } from "./types/project";
