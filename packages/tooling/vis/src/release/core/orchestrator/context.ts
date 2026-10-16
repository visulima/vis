import semver from "semver";

import { DEFAULT_CONFIG } from "../../config";
import { VisReleaseError } from "../../errors";
import type { PackageManifest, PerPackageReleaseConfig, ReleasePlan, VisReleaseConfig, WorkspacePackage } from "../../types";
import { readChangeFiles } from "../change-file-reader";
import { detectCurrentBranch, resolveChannel } from "../channels";
import { DependencyGraph } from "../dep-graph";
import { ecosystemPerPackage, isDiscoveryEnabled, RELEASE_ECOSYSTEMS } from "../ecosystems";
import { createAdapter, detectPackageManager } from "../package-managers/detect";
import type { PackageManagerAdapter } from "../package-managers/interface";
import { assembleReleasePlan } from "../release-plan";
import { createShellRunner } from "../shell-runner";
import { discoverPackages } from "../workspace";

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
     *
     * Equivalent to `nx release --first-release` and release-please's
     * `bootstrap-sha` knob.
     */
    firstRelease: boolean;
    packages: WorkspacePackage[];
    perPackageConfig: Map<string, PerPackageReleaseConfig>;
    plan: ReleasePlan;
    pm: PackageManagerAdapter;

    /**
     * Snapshot of `&lt;changesDir>/pre.json` at the time `buildContext` ran.
     * Pinned here (M9 fix) so `applyContext` doesn't re-read the file —
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
     * "missing prior tag" failure path. Maps to `nx release --first-release`
     * and release-please's `bootstrap-sha` mechanism.
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

    // Load vis.config.ts → extract `release` block → merge with inline options.
    // Missing config is fine (treat as empty); a present-but-broken config must
    // surface so we don't silently version/publish with the wrong settings.
    let fileConfig: VisReleaseConfig = {};

    try {
        const { loadVisConfig } = await import("../../../config/config");
        const visConfig = await loadVisConfig(cwd);

        if (visConfig.release) {
            fileConfig = visConfig.release;
        }
    } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        const message = (error as Error).message ?? "";
        const isMissing = code === "ENOENT" || code === "MODULE_NOT_FOUND" || /cannot find module/i.test(message);

        if (!isMissing) {
            throw error;
        }
    }

    const config = mergeConfig(fileConfig, options.config ?? {});

    // Print unstable warning unless suppressed (RFC §21.2).
    if (!config.acknowledgeUnstable && process.env["VIS_RELEASE_SUPPRESS_UNSTABLE"] !== "1") {
        process.stderr.write(
            "[vis release] ⚠ This subsystem is flagged unstable. Set `release.acknowledgeUnstable: true` in vis.config.ts to suppress this warning. (RFC §21.2)\n",
        );
    }

    // Detect branch + channel
    const branch = options.channel ?? (await detectCurrentBranch(cwd, runner));
    const resolved = branch ? resolveChannel(branch, config.channels) : undefined;

    // Discover packages via the active PM adapter. Manifest reads run in
    // parallel (Promise.all + filter) — for a 49-package monorepo this cuts
    // ~150ms of sequential fs latency to ~10ms wall time.
    const fs = await import("node:fs/promises");
    const reader = {
        listPackages: async () => {
            const entries = await pm.listWorkspacePackages(cwd);

            const settled = await Promise.all(
                entries.map(async (entry) => {
                    const manifestPath = `${entry.path}/package.json`;

                    try {
                        const content = await fs.readFile(manifestPath, "utf8");
                        const manifest = JSON.parse(content) as PackageManifest;

                        return { manifest, manifestPath };
                    } catch {
                        // Safe to swallow: a PM adapter can list a stale workspace
                        // path (lockfile drift, partially-deleted package). Dropping
                        // it from discovery is the right call — releasing against a
                        // missing manifest would fail later anyway.
                        return undefined;
                    }
                }),
            );

            return settled.filter((entry): entry is { manifest: PackageManifest; manifestPath: string } => entry !== undefined);
        },
    };

    const discovered = await discoverPackages(reader, config, { cwd });
    const { perPackageConfig } = discovered;
    let { packages } = discovered;

    // Discovered ecosystems are added in table order. Each one claims directories from the packages and per-package config that
    // earlier ones have already added, so the loop runs one entry at a time.
    const projectsByEcosystem = new Map<string, ReadonlyArray<unknown>>();

    if (RELEASE_ECOSYSTEMS.some((eco) => isDiscoveryEnabled(config, eco))) {
        for (const eco of RELEASE_ECOSYSTEMS) {
            if (!isDiscoveryEnabled(config, eco)) {
                continue;
            }

            const claimedDirs = new Set<string>();

            for (const pkg of packages) {
                for (const dir of eco.claimedDirs(pkg, perPackageConfig.get(pkg.name) ?? {}, cwd)) {
                    claimedDirs.add(dir);
                }
            }

            const projects = await eco.discover({ claimedDirs, cwd });

            for (const project of projects) {
                const { name } = eco.toPackage(project);

                perPackageConfig.set(name, { ...ecosystemPerPackage(eco, project, cwd), ...config.packages?.[name] });
            }

            packages = [...packages, ...projects.map((project) => eco.toPackage(project))];
            projectsByEcosystem.set(eco.id, projects);
        }

        // Discovered modules are named by their own coordinates (bare `core`, `group:artifact`, …), so a
        // clash with an earlier package is an error for every ecosystem, not only Gradle. JS packages keep
        // their historic last-wins behaviour between themselves.
        const owners = new Map<string, WorkspacePackage>();

        for (const pkg of packages) {
            const prior = owners.get(pkg.name);

            if (prior !== undefined && pkg.ecosystem !== undefined) {
                throw new VisReleaseError({
                    code: "CONFIG_INVALID",
                    message: `${pkg.name} is discovered as a ${pkg.ecosystem} project, but ${prior.dir} already has that name. Rename one of them in config.packages.`,
                    packageName: pkg.name,
                });
            }

            owners.set(pkg.name, pkg);
        }
    }

    // Reject unsupported versionFiles before planning, so a config error never
    // reaches the point where writes are produced.
    {
        const { assertSupportedVersionFiles } = await import("../version-files");

        for (const [name, perPkg] of perPackageConfig) {
            assertSupportedVersionFiles(name, perPkg.versionFiles ?? []);
        }
    }
    const depGraph = new DependencyGraph(packages);

    // Read change files
    const { files: changeFiles } = await readChangeFiles({ changesDir: config.changesDir, cwd });

    // Pre-mode override: `vis release pre enter <tag>` writes a tracked
    // pre.json that pins the prerelease identifier regardless of branch
    // / channel. Channel-derived prerelease still applies when pre.json
    // is absent.
    //
    // Pre-mode tri-state effective-prerelease (C6 fix):
    //   - mode: "pre"          → force `preMode.tag` (changesets parity)
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

    // Catalog change-detection (changesets #1707, opt-in via
    // `release.detectCatalogChanges`). When enabled, we diff
    // `pnpm-workspace.yaml` at HEAD~1 vs HEAD; consumer packages of
    // any moved catalog entry are fed into the plan as patch bumps
    // tagged CATALOG_CHANGED.
    //
    // Soft-failures (no git repo, no HEAD~1, malformed YAML) surface
    // as plan warnings — we don't want a freshly-cloned greenfield
    // repo to fail the version step over a missing baseline.
    const catalogConsumerEntries: NonNullable<import("../release-plan").AssembleReleasePlanOptions["catalogConsumers"]>[number][] = [];
    const catalogWarnings: string[] = [];

    if (config.detectCatalogChanges === true) {
        try {
            const { detectCatalogChanges, findCatalogConsumers, parseCatalogs: parseCatalogSnapshot } = await import("../catalog-detector");
            const currentYaml = await pm.readCatalogYaml(cwd);
            const currentCatalogs = parseCatalogSnapshot(currentYaml);

            let prevYaml: string | undefined;

            try {
                const result = await runner.run("git", ["show", "HEAD~1:pnpm-workspace.yaml"], { cwd, silent: true });

                if (result.exitCode === 0) {
                    prevYaml = result.stdout;
                }
            } catch {
                // git unreachable / no prior commit — degrade to "no prior
                // snapshot" which surfaces every current catalog entry as
                // an addition. That's not actually useful for cascading
                // (additions don't move existing consumers), but keeping
                // the detector resilient means greenfield repos don't
                // throw here.
            }

            const prevCatalogs = parseCatalogSnapshot(prevYaml);
            const changes = detectCatalogChanges(prevCatalogs, currentCatalogs);

            // Only true bumps (both sides present and version differs)
            // cascade — additions / removals don't affect existing
            // consumers' resolved versions.
            const bumps = changes.filter((c) => c.oldVersion !== undefined && c.newVersion !== undefined);

            if (bumps.length > 0) {
                // Use the CURRENT catalog snapshot to find consumers —
                // we want the dependents of the catalog entry at HEAD
                // (the version that will be published), not the prior
                // wave's snapshot.
                const consumersIndex = findCatalogConsumers(packages, currentCatalogs);

                for (const change of bumps) {
                    const depTable = consumersIndex.get(change.catalog);
                    const consumers = depTable?.get(change.dep) ?? [];

                    for (const consumer of consumers) {
                        catalogConsumerEntries.push({
                            catalog: change.catalog,
                            dep: change.dep,
                            newVersion: change.newVersion,
                            oldVersion: change.oldVersion,
                            packageName: consumer.packageName,
                        });
                    }
                }

                if (catalogConsumerEntries.length > 0) {
                    catalogWarnings.push(
                        `Catalog change-detection: ${bumps.length} catalog dep(s) moved; ${catalogConsumerEntries.length} consumer-package patch bump(s) tagged CATALOG_CHANGED.`,
                    );
                }
            }
        } catch (error) {
            catalogWarnings.push(`Catalog change-detection skipped: ${(error as Error).message}.`);
        }
    }

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
        // M9: snapshot pre-mode here so applyContext doesn't race with a
        // concurrent `pre exit` between context-build and apply.
        preMode,
        projectsByEcosystem,
    };
};

const mergeConfig = (...sources: VisReleaseConfig[]): VisReleaseConfig => {
    let merged: VisReleaseConfig = { ...DEFAULT_CONFIG };

    for (const source of sources) {
        merged = { ...merged, ...source };
    }

    return merged;
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
