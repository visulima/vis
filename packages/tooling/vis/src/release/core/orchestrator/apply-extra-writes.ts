import { resolve } from "node:path";

import type { applyReleasePlan } from "../apply-release-plan";
import { RELEASE_PLAN_ORDER } from "../ecosystems";
import type { OrchestratorContext } from "./context";

/**
 * Apply extra-files rules, built-in versionFiles and the per-ecosystem
 * plans (Cargo first, then RELEASE_PLAN_ORDER) for every release, and
 * append the resulting writes to `applied`.
 */
export const applyExtraFileWrites = async (context: OrchestratorContext, applied: Awaited<ReturnType<typeof applyReleasePlan>>): Promise<void> => {
    // Apply extra-files rules and built-in versionFiles per release. Both
    // produce writes that are appended to the applied set so the existing
    // commit + dry-run code paths pick them up automatically.
    const extraFileWarnings: string[] = [];

    const { applyExtraFilesForRelease } = await import("../extra-files");
    const { applyVersionFilesForRelease } = await import("../version-files");
    const { cargoManifestPaths } = await import("../cargo-lock");

    const perReleaseResults = await Promise.all(
        context.plan.releases.map(async (release) => {
            const pkg = context.depGraph.getPackage(release.name);

            if (!pkg) {
                return { warnings: [], writes: [] };
            }

            const perPkgRules = context.perPackageConfig.get(release.name)?.extraFiles ?? [];
            const workspaceRules = context.config.publish?.extraFiles ?? [];
            const versionFiles = context.perPackageConfig.get(release.name)?.versionFiles ?? [];

            const hasExtraRules = perPkgRules.length > 0 || workspaceRules.length > 0;
            const extra = hasExtraRules
                ? await applyExtraFilesForRelease(context.cwd, pkg.dir, release.newVersion, release.name, workspaceRules, perPkgRules)
                : { warnings: [], writes: [] };

            // Runs after extraFiles and reads its output, so a file named by
            // both is rewritten once with both edits instead of the later write
            // silently discarding the earlier one.
            const versioned
                = versionFiles.length > 0
                    ? await applyVersionFilesForRelease(pkg.dir, versionFiles, release.newVersion, release.name, new Map(extra.writes.map((write) => [write.path, write.content])))
                    : { writes: [] };

            return { warnings: extra.warnings, writes: [...extra.writes, ...versioned.writes] };
        }),
    );

    // Cargo edits are planned once for the whole wave: crate versions,
    // dependents' requirements and Cargo.lock. Per-release steps started
    // from the original files, so two releases in one file (or one lock)
    // silently dropped each other's edit. Everything below reads and
    // writes one pending map.
    const pending = new Map<string, string>();
    const touched = new Set<string>();

    for (const result of perReleaseResults) {
        for (const write of result.writes) {
            pending.set(write.path, write.content);
            touched.add(write.path);
        }

        extraFileWarnings.push(...result.warnings);
    }

    const cargoCrates = context.packages.filter((pkg) => pkg.ecosystem === "cargo");
    const planReleases = context.plan.releases.flatMap((release) => {
        const pkg = context.depGraph.getPackage(release.name);

        // Python projects, Maven and Gradle modules have their own plans (planPythonWorkspace,
        // planMavenWorkspace, planGradleWorkspace); a uv.lock is not a Cargo.lock, and a pom or a build script is not one either.
        if (!pkg || (pkg.ecosystem !== undefined && pkg.ecosystem !== "cargo")) {
            return [];
        }

        const manifestPaths
            = pkg.ecosystem === "cargo" ? [pkg.manifestPath] : cargoManifestPaths(pkg.dir, context.perPackageConfig.get(release.name) ?? {});

        return manifestPaths.length > 0 || pkg.ecosystem === "cargo"
            ? [{ ecosystem: pkg.ecosystem, manifestPaths, name: release.name, newVersion: release.newVersion }]
            : [];
    });

    if (planReleases.length > 0) {
        // Every Cargo manifest a JS package claims is rescanned too, so a
        // dependent in a JS-owned crate still gets its requirement moved.
        const scanManifests = new Set(cargoCrates.map((pkg) => pkg.manifestPath));

        // A virtual root has no [package], so discovery never returns it, but its
        // [workspace.dependencies] requirements must still follow a bumped crate.
        if (cargoCrates.length > 0) {
            scanManifests.add(resolve(context.cwd, "Cargo.toml"));
        }

        for (const pkg of context.packages) {
            if (pkg.ecosystem === undefined) {
                for (const manifestPath of cargoManifestPaths(pkg.dir, context.perPackageConfig.get(pkg.name) ?? {})) {
                    scanManifests.add(manifestPath);
                }
            }
        }

        const { planCargoWorkspace } = await import("../cargo-plan");
        const cargo = await planCargoWorkspace({
            crateManifests: cargoCrates.map((pkg) => pkg.manifestPath),
            cwd: context.cwd,
            pending,
            releases: planReleases,
            // Other crates' requirements move only for discovered crates; a `cargo()` package keeps its lock in step.
            rewriteDependents: context.config.cargo?.discover === true,
            scanManifests: [...scanManifests],
        });

        for (const path of cargo.touched) {
            touched.add(path);
        }

        extraFileWarnings.push(...cargo.warnings);
    }

    // Cargo planned above: its release filter also covers JS packages that claim a Cargo manifest. The rest run in plan order.
    for (const eco of RELEASE_PLAN_ORDER) {
        const releases = context.plan.releases.flatMap((release) => {
            const pkg = context.depGraph.getPackage(release.name);

            return pkg?.ecosystem === eco.id ? [{ name: release.name, newVersion: release.newVersion }] : [];
        });

        if (releases.length === 0 || eco.plan === undefined) {
            continue;
        }

        const outcome = await eco.plan({ context, pending, projects: context.projectsByEcosystem?.get(eco.id) ?? [], releases });

        for (const path of outcome.touched) {
            touched.add(path);
        }

        extraFileWarnings.push(...outcome.warnings);
    }

    for (const path of touched) {
        applied.writes.push({ content: pending.get(path)!, path });
    }

    // Surface warnings through plan.warnings so they bubble up to
    // CI logs alongside the other release warnings.
    if (extraFileWarnings.length > 0) {
        context.plan.warnings.push(...extraFileWarnings);
    }
};
