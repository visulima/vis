import semver from "semver";

import { VisReleaseError } from "../../errors";
import type { PerPackageReleaseConfig, ReleasePlan, VisReleaseConfig, WorkspacePackage } from "../../types";
import { readChangeFiles } from "../change-file-reader";
import { detectCurrentBranch, resolveChannel } from "../channels";
import { DependencyGraph } from "../dep-graph";
import { createAdapter, detectPackageManager } from "../package-managers/detect";
import type { PackageManagerAdapter } from "../package-managers/interface";
import { assembleReleasePlan } from "../release-plan";
import { createShellRunner } from "../shell-runner";
import { detectCatalogConsumers } from "./context-catalog";
import { loadReleaseConfig } from "./context-config";
import { discoverReleasePackages } from "./context-packages";

export interface OrchestratorContext {
    branch?: string;
    channel?: { mode: "auto-publish" | "version-pr"; prerelease?: string; tag: string };
    config: VisReleaseConfig;
    cwd: string;
    depGraph: DependencyGraph;

    /**
     * Greenfield / first-time release flag. When set:
     *   - currentVersionResolver is forced to "disk"
     *   - per-package remote tag-collision checks are skipped
     *   - missing prior tags are treated as the bootstrap case, not an error.
     */
    firstRelease: boolean;
    packages: WorkspacePackage[];
    perPackageConfig: Map<string, PerPackageReleaseConfig>;
    plan: ReleasePlan;
    pm: PackageManagerAdapter;

    /**
     * Snapshot of `&lt;changesDir>/pre.json` at the time `buildContext` ran.
     * Pinned here so `applyContext` doesn't re-read the file —
     * otherwise a concurrent `vis release pre exit` between `buildContext`
     * and `applyContext` could leave the version computed as a prerelease
     * while exit-pending cleanup also fires. Undefined when no pre.json
     * exists.
     */
    preMode?: import("../pre-mode").PreModeFile;

    /** Projects each discovered ecosystem produced, keyed by its id (`maven`, `gradle`, ...). An id is absent when its discover flag is off. */
    projectsByEcosystem?: ReadonlyMap<string, ReadonlyArray<unknown>>;
}

export interface BuildContextOptions {
    /** Override branch detection. */
    channel?: string;
    /** Inline config override (merged on top of vis.config.ts's `release` block). */
    config?: VisReleaseConfig;
    /** Workspace root. Default: process.cwd(). */
    cwd?: string;

    /**
     * Treat this run as the first release on a greenfield monorepo (or a
     * freshly-added package). Forces `currentVersionResolver: "disk"`,
     * skips tag-collision checks against the remote, and bypasses any
     * "missing prior tag" failure path.
     */
    firstRelease?: boolean;
    /** Limit to packages matching these globs (post-discovery filter). */
    projects?: string[];

    /**
     * Skip the configured `currentVersionResolver` and force every
     * package to the manifest (disk) version. Set this from read-only
     * command handlers (`vis release plan` / `status` / `doctor`) so
     * they don't fire N parallel `npm view` / `cargo search` / git-tag
     * probes per invocation — those commands don't need a registry-
     * accurate baseline.
     *
     * `version`/`publish`/`ci release` leave this unset so they DO
     * consult the configured resolver for accurate bump computation.
     */
    skipRegistryLookup?: boolean;
}

/**
 * Build the full context: load vis.config.ts → extract release block →
 * merge with inline options → discover packages → parse change files →
 * assemble plan.
 *
 * Reusable across `vis release status` (read-only print), `vis release version`
 * (apply to disk), `vis release publish` (publish), `vis release plan` (json).
 */
export const buildContext = async (options: BuildContextOptions = {}): Promise<OrchestratorContext> => {
    const cwd = options.cwd ?? process.cwd();
    const runner = createShellRunner();
    const pmId = await detectPackageManager(cwd, runner);
    const pm = createAdapter(pmId, runner);

    // Hard-fail if the active PM is below the minimum version (RFC §19.6).
    // Skipped if version detection itself fails (the PM may not be installed
    // — vis can still discover packages from the lockfile / manifest).
    const detectedVersion = await pm.detectVersion(cwd);

    if (detectedVersion && !supportsMinVersion(detectedVersion, pm.minVersion)) {
        throw new VisReleaseError({
            code: "PM_VERSION_TOO_LOW",
            hint: `pnpm install -g ${pm.id}@latest  (or your equivalent)`,
            message: `${pm.id} version ${detectedVersion} is below the required minimum ${pm.minVersion}. Upgrade ${pm.id} to enable release operations.`,
        });
    }

    const config = await loadReleaseConfig(cwd, options.config);

    // Print unstable warning unless suppressed (RFC §21.2).
    if (!config.acknowledgeUnstable && process.env["VIS_RELEASE_SUPPRESS_UNSTABLE"] !== "1") {
        process.stderr.write(
            "[vis release] ⚠ This subsystem is flagged unstable. Set `release.acknowledgeUnstable: true` in vis.config.ts to suppress this warning. (RFC §21.2)\n",
        );
    }

    // Detect branch + channel
    const branch = options.channel ?? (await detectCurrentBranch(cwd, runner));
    const resolved = branch ? resolveChannel(branch, config.channels) : undefined;

    const { packages, perPackageConfig, projectsByEcosystem } = await discoverReleasePackages(pm, config, cwd);
    const depGraph = new DependencyGraph(packages);

    // Read change files
    const { files: changeFiles } = await readChangeFiles({ changesDir: config.changesDir, cwd });

    // Pre-mode override: `vis release pre enter <tag>` writes a tracked
    // pre.json that pins the prerelease identifier regardless of branch
    // / channel. Channel-derived prerelease still applies when pre.json
    // is absent.
    //
    // Pre-mode tri-state effective-prerelease:
    //   - mode: "pre"          → force `preMode.tag`
    //   - mode: "exit-pending" → force `undefined` (consolidation = stable
    //                            bump); previously this fell through to
    //                            the channel's prerelease, which on an
    //                            alpha-channel branch produced an alpha
    //                            version AND deleted pre.json — leaving
    //                            no way to retry the consolidation.
    //   - undefined            → fall back to channel-derived prerelease.
    const { readPreMode } = await import("../pre-mode");
    const preMode = await readPreMode(cwd, config.changesDir ?? ".vis/release");
    let effectivePrerelease: string | undefined;

    if (preMode?.mode === "pre") {
        effectivePrerelease = preMode.tag;
    } else if (preMode?.mode === "exit-pending") {
        effectivePrerelease = undefined;
    } else {
        effectivePrerelease = resolved?.prerelease;
    }

    // Resolve current versions via the configured strategy (disk / registry /
    // git-tag). Runs before plan assembly so the plan stays a pure synchronous
    // function — the async lookups live one level up.
    const firstRelease = options.firstRelease === true;
    const { resolveCurrentVersionsForWorkspace } = await import("../version-resolver");
    const { versions: currentVersions, warnings: resolverWarnings } = await resolveCurrentVersionsForWorkspace(packages, depGraph, config, perPackageConfig, {
        cwd,
        firstRelease,
        pm,
        runner,
        // Read-only handlers (plan/status/doctor/etc.) pass true so
        // they don't fire N parallel registry probes. Default false
        // for the version/publish/ci-release paths that need an
        // accurate baseline.
        skipRegistryLookup: options.skipRegistryLookup === true,
    });

    const { entries: catalogConsumerEntries, warnings: catalogWarnings } = await detectCatalogConsumers(
        pm,
        runner,
        cwd,
        packages,
        config.detectCatalogChanges === true,
    );

    // Assemble plan
    const plan = assembleReleasePlan(changeFiles, depGraph, config, {
        bumpMinorPreMajor: config.bumpMinorPreMajor,
        bumpPatchForMinorPreMajor: config.bumpPatchForMinorPreMajor,
        catalogConsumers: catalogConsumerEntries,
        currentVersions,
        perPackageConfig,
        prerelease: effectivePrerelease,
    });

    if (catalogWarnings.length > 0) {
        plan.warnings.push(...catalogWarnings);
    }

    // Surface resolver fallbacks as plan warnings — operators want to see
    // "registry 404 → manifest" so they can debug staleness mid-pipeline.
    if (resolverWarnings.length > 0) {
        plan.warnings.push(...resolverWarnings);
    }

    if (firstRelease) {
        plan.warnings.push(
            "First-release mode: currentVersionResolver forced to \"disk\", remote tag-collision checks skipped. Drop --first-release after the initial wave lands.",
        );
    }

    // Surface pre-mode in the plan warnings so downstream handlers
    // / the sticky PR comment can show it to reviewers.
    if (preMode?.mode === "pre") {
        plan.warnings.push(
            `Pre-mode is ACTIVE (tag "${preMode.tag}"); every version produces a prerelease. Exit with \`vis release pre exit\` when ready to ship stable.`,
        );
    }

    if (preMode?.mode === "exit-pending") {
        plan.warnings.push(
            `Pre-mode is EXIT-PENDING (was "${preMode.tag}"); the next \`vis release version\` will consolidate the prerelease and delete pre.json.`,
        );
    }

    // Surface channel-overlap as a plan warning so CLI handlers / sticky-comment
    // formatters print it. First-listed wins, but other matches are suspicious.
    if (resolved?.overlapping && resolved.overlapping.length > 0) {
        plan.warnings.push(
            `Branch "${branch}" matches multiple channel patterns: "${resolved.branch}" (active) plus ${resolved.overlapping.map((p) => `"${p}"`).join(", ")}. Reorder channels in vis.config.ts if this is unintentional.`,
        );
    }

    // Optional project filter (post-plan, so the user sees the full plan but
    // version/publish only acts on the filtered subset).
    if (options.projects && options.projects.length > 0) {
        const { default: zeptomatch } = await import("zeptomatch");
        const globs = options.projects;

        plan.releases = plan.releases.filter((r) => globs.some((g) => r.name === g || zeptomatch(g, r.name)));
    }

    // Refuse a Go major the module path cannot carry before the plan is shown, not at apply time.
    {
        const goReleases = plan.releases.flatMap((release) => {
            const pkg = depGraph.getPackage(release.name);

            return pkg?.ecosystem === "go" ? [{ name: release.name, newVersion: release.newVersion }] : [];
        });

        if (goReleases.length > 0) {
            const { planGoWorkspace } = await import("../go-plan");

            planGoWorkspace({ projects: (projectsByEcosystem.get("go") ?? []) as Parameters<typeof planGoWorkspace>[0]["projects"], releases: goReleases });
        }
    }

    return {
        branch,
        channel: resolved ? { mode: resolved.mode, prerelease: resolved.prerelease, tag: resolved.tag } : undefined,
        config,
        cwd,
        depGraph,
        firstRelease,
        packages,
        perPackageConfig,
        plan,
        pm,
        // Snapshot pre-mode here so applyContext doesn't race with a
        // concurrent `pre exit` between context-build and apply.
        preMode,
        projectsByEcosystem,
    };
};

/**
 * `&lt;detected> >= &lt;minimum>` — uses semver.gte but tolerant of pre-release
 * suffixes that some PM `--version` outputs include (e.g. "11.5.1-rc.0").
 */
const supportsMinVersion = (detected: string, minimum: string): boolean => {
    const cleaned = semver.coerce(detected)?.version ?? detected;

    try {
        return semver.gte(cleaned, minimum);
    } catch {
        // If we can't parse the version, fail-open (don't block users on
        // exotic PM forks).
        return true;
    }
};
