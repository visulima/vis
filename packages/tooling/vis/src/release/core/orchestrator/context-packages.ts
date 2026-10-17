import { VisReleaseError } from "../../errors";
import type { PackageManifest, PerPackageReleaseConfig, VisReleaseConfig, WorkspacePackage } from "../../types";
import { ecosystemPerPackage, isDiscoveryEnabled, RELEASE_ECOSYSTEMS } from "../ecosystems";
import type { PackageManagerAdapter } from "../package-managers/interface";
import { discoverPackages } from "../workspace";

export interface DiscoveredReleasePackages {
    packages: WorkspacePackage[];
    perPackageConfig: Map<string, PerPackageReleaseConfig>;
    projectsByEcosystem: Map<string, ReadonlyArray<unknown>>;
}

/**
 * Discover the workspace packages (via the active PM adapter) plus the
 * projects of every enabled release ecosystem, and validate their
 * versionFiles before any plan is built.
 */
export const discoverReleasePackages = async (pm: PackageManagerAdapter, config: VisReleaseConfig, cwd: string): Promise<DiscoveredReleasePackages> => {
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

    return { packages, perPackageConfig, projectsByEcosystem };
};
