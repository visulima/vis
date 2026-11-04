import semver from "semver";

import type { PlannedRelease, WorkspacePackage } from "../../types";
import type { CommandRunner } from "../package-managers/interface";
import type { OrchestratorContext } from "./context";

/** `true` = the registry has the version, `false` = it does not, `undefined` = could not tell. */
export type RegistryProbe = (pkg: WorkspacePackage, version: string, registry: string | undefined) => Promise<boolean | undefined>;

/**
 * Ask npm whether `name@version` exists, from the directory the publish runs
 * in (the workspace root) so both read the same `.npmrc` registry + auth. Only a definite answer counts: npm ≥ 10 exits
 * E404 for a missing version, older npm exits 0 with empty output. Any other
 * failure (auth, network) is "unknown", and an unknown is never published.
 */
export const npmRegistryProbe
    = (runner: CommandRunner, cwd: string): RegistryProbe =>
        async (pkg, version, registry) => {
            const args = ["view", `${pkg.name}@${version}`, "version"];

            if (registry) {
                args.push("--registry", registry);
            }

            const result = await runner.run("npm", args, { cwd, silent: true });

            if (result.exitCode === 0) {
                return result.stdout.trim() !== "";
            }

            return /\bE404\b/.test(`${result.stdout}\n${result.stderr}`) ? false : undefined;
        };

/** A runtime dependency of a release that no version on the registry satisfies. */
export interface UnreleasedDependency {
    dependency: string;
    /** The range the published manifest will carry. */
    range: string;
    /** `true` when the registry could not be asked; an unconfirmed dependency blocks like a missing one. */
    unknown: boolean;
}

/**
 * The range a dependent's published manifest carries for a workspace dependency, the way pnpm rewrites
 * `workspace:` at pack time. `undefined` for protocols whose target can't be read here (`catalog:`, `npm:`,
 * `file:`, …): those are not judged.
 */
const publishedRange = (spec: string, dependencyVersion: string): string | undefined => {
    let range = spec;

    if (spec.startsWith("workspace:")) {
        const target = spec.slice("workspace:".length);

        range = target === "*" ? dependencyVersion : target === "^" || target === "~" ? `${target}${dependencyVersion}` : target;
    }

    return semver.validRange(range, { includePrerelease: true }) === null ? undefined : range;
};

/**
 * Every release whose runtime dependencies (`dependencies`, `peerDependencies`, `optionalDependencies`) on
 * other workspace packages resolve to nothing on the registry. A dependency released in the same wave is
 * fine: dependencies publish first, and a dependent of one that fails is skipped by the wave itself.
 * Anything else must already be published, or the dependent would reach the registry uninstallable.
 */
export const findUnreleasedDependencies = async (
    context: OrchestratorContext,
    releases: ReadonlyArray<PlannedRelease>,
    options: { registryProbe?: RegistryProbe; runner: CommandRunner },
): Promise<Map<string, UnreleasedDependency[]>> => {
    const probe = options.registryProbe ?? npmRegistryProbe(options.runner, context.cwd);
    const inWave = new Set(releases.map((release) => release.name));
    const answers = new Map<string, Promise<boolean | undefined>>();
    const checks: { dependency: string; key: string; name: string; range: string }[] = [];

    for (const release of releases) {
        const pkg = context.depGraph.getPackage(release.name);

        if (!pkg || pkg.private || pkg.ecosystem !== undefined || context.perPackageConfig.get(pkg.name)?.skipNpmPublish === true) {
            continue;
        }

        for (const dep of context.depGraph.getDependencies(pkg.name)) {
            const depPkg = context.depGraph.getPackage(dep.name);

            // A private dependency never reaches the registry by design; publishing it is not this guard's call.
            if (dep.kind === "devDependencies" || inWave.has(dep.name) || !depPkg || depPkg.private || depPkg.ecosystem !== undefined) {
                continue;
            }

            const range = publishedRange(dep.range, depPkg.version);

            if (range === undefined) {
                continue;
            }

            const key = `${dep.name}@${range}`;

            // Started together: a cascade wave can ask about dozens of dependencies.
            if (!answers.has(key)) {
                answers.set(key, probe(depPkg, range, context.perPackageConfig.get(dep.name)?.registry));
            }

            checks.push({ dependency: dep.name, key, name: pkg.name, range });
        }
    }

    const found = new Map<string, UnreleasedDependency[]>();

    for (const check of checks) {
        const onRegistry = await answers.get(check.key);

        if (onRegistry !== true) {
            found.set(check.name, [...(found.get(check.name) ?? []), { dependency: check.dependency, range: check.range, unknown: onRegistry === undefined }]);
        }
    }

    return found;
};

/** One line per blocked release, for an error message. */
export const describeUnreleasedDependencies = (found: ReadonlyMap<string, UnreleasedDependency[]>): string =>
    [...found]
        .map(
            ([name, deps]) =>
                `${name} needs ${deps.map((dep) => `${dep.dependency}@${dep.range}${dep.unknown ? " (registry did not answer)" : ""}`).join(", ")}`,
        )
        .join("\n  - ");
