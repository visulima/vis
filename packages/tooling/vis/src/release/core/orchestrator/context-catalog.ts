import type { WorkspacePackage } from "../../types";
import type { PackageManagerAdapter } from "../package-managers/interface";
import type { AssembleReleasePlanOptions } from "../release-plan";
import type { createShellRunner } from "../shell-runner";

/**
 * Find the packages that consume a catalog entry whose version moved
 * between HEAD~1 and HEAD (`release.detectCatalogChanges`).
 */
export const detectCatalogConsumers = async (
    pm: PackageManagerAdapter,
    runner: ReturnType<typeof createShellRunner>,
    cwd: string,
    packages: WorkspacePackage[],
    enabled: boolean,
): Promise<{ entries: NonNullable<AssembleReleasePlanOptions["catalogConsumers"]>[number][]; warnings: string[] }> => {
    // Catalog change-detection (opt-in via
    // `release.detectCatalogChanges`). When enabled, we diff
    // `pnpm-workspace.yaml` at HEAD~1 vs HEAD; consumer packages of
    // any moved catalog entry are fed into the plan as patch bumps
    // tagged CATALOG_CHANGED.
    //
    // Soft-failures (no git repo, no HEAD~1, malformed YAML) surface
    // as plan warnings — we don't want a freshly-cloned greenfield
    // repo to fail the version step over a missing baseline.
    const catalogConsumerEntries: NonNullable<AssembleReleasePlanOptions["catalogConsumers"]>[number][] = [];
    const catalogWarnings: string[] = [];

    if (enabled) {
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

    return { entries: catalogConsumerEntries, warnings: catalogWarnings };
};
