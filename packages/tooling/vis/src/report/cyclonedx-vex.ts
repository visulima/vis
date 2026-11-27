/**
 * CycloneDX 1.7 VEX emitter — takes a BOM produced by `buildCycloneDxBom`
 * and stamps `vulnerabilities[]` onto it.
 *
 * Output is a single document that is BOTH an SBOM AND a VEX statement —
 * the shape Dependabot's CycloneDX consumer and most attestation tools
 * accept. Vulnerable components are matched by `purl` so the VEX
 * `affects[].ref` points at the same `bom-ref` the SBOM already declares.
 */

import { toNpmPurl } from "../sbom/purl";
import type { Component, CycloneDxBom, CycloneDxSeverity, CycloneDxVulnerability } from "../sbom/types";
import type { SecurityVulnerability } from "../security/advisories";
import { advisorySourceName, advisoryUri, cvssScore } from "./finding";

export interface CycloneDxVexFinding {
    acknowledged: boolean;
    packageName: string;
    packageVersion: string;
    vulnerability: SecurityVulnerability;
}

/** A package found only inside other packages: it has no entry in the lockfile, so the BOM does not list it. */
export interface CycloneDxBundledPackage {
    /** Each place a copy ships, outermost host first; the last host of a chain is the direct parent. */
    bundledIn?: ReadonlyArray<ReadonlyArray<{ name: string; version: string }>>;
    name: string;
    version: string;
}

export interface CycloneDxVexOptions {
    bom: CycloneDxBom;
    /** Packages found only inside other packages. They join the BOM as components their hosts depend on, so every `affects[].ref` resolves. */
    bundled?: ReadonlyArray<CycloneDxBundledPackage>;
    findings: CycloneDxVexFinding[];
    now?: Date;
}

const SEVERITY_MAP: Record<string, CycloneDxSeverity> = {
    CRITICAL: "critical",
    HIGH: "high",
    LOW: "low",
    MODERATE: "medium",
    UNKNOWN: "unknown",
};

const groupBy = <T, K extends string | number>(items: T[], key: (item: T) => K): Map<K, T[]> => {
    const map = new Map<K, T[]>();

    for (const item of items) {
        const k = key(item);
        const existing = map.get(k);

        if (existing) {
            existing.push(item);
        } else {
            map.set(k, [item]);
        }
    }

    return map;
};

/**
 * Build a `CycloneDxVulnerability` for every distinct advisory, with `affects[]`
 * pointing at the matching components' `bom-ref` (the purl by our convention).
 */
export const buildCycloneDxVulnerabilities = (findings: CycloneDxVexFinding[], now: Date = new Date()): CycloneDxVulnerability[] => {
    const byAdvisory = groupBy(findings, (f) => f.vulnerability.id);
    const timestamp = now.toISOString();

    return [...byAdvisory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([advisoryId, group]): CycloneDxVulnerability => {
            const sample = group[0]!.vulnerability;
            const severity = SEVERITY_MAP[sample.severity] ?? "unknown";
            const score = cvssScore(sample);

            const affectsByPkg = groupBy(group, (f) => f.packageName);

            const affects = [...affectsByPkg.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([packageName, items]) => {
                    const versions = [...new Set(items.map((f) => f.packageVersion))].sort();
                    // The bom-ref convention in `cyclonedx.ts` is the purl itself —
                    // match that so VEX references resolve against existing components.
                    const headRef = toNpmPurl(packageName, versions[0]!);

                    return {
                        ref: headRef,
                        versions: versions.map((version) => {
                            return { status: "affected" as const, version };
                        }),
                    };
                });

            // Aliases get serialized as `references[]` so consumers can resolve
            // GHSA↔CVE without re-querying OSV.
            const references = (sample.aliases ?? [])
                .filter((alias) => alias !== advisoryId)
                .map((alias) => {
                    return {
                        id: alias,
                        source: { name: advisorySourceName(alias), url: advisoryUri(alias) },
                    };
                });

            // VEX semantics: an acknowledged finding is one the user has triaged
            // and decided not to act on. `not_affected` + `code_not_reachable` is
            // the closest canonical state — without per-finding analysis notes we
            // can't distinguish further, and acknowledged-as-accepted-risk maps to
            // "we know, we are not patching."
            const anyAcknowledged = group.some((f) => f.acknowledged);
            const allAcknowledged = group.every((f) => f.acknowledged);
            const analysis: CycloneDxVulnerability["analysis"] = allAcknowledged
                ? { justification: "code_not_reachable", response: ["will_not_fix"], state: "not_affected" }
                : anyAcknowledged
                    ? { state: "in_triage" }
                    : undefined;

            const fixed = sample.fixedVersions ?? [];

            return {
                "bom-ref": `vuln:${advisoryId}`,
                id: advisoryId,
                source: { name: advisorySourceName(advisoryId), url: advisoryUri(advisoryId) },
                ...(references.length > 0 ? { references } : {}),
                description: sample.summary || `Advisory ${advisoryId}`,
                ratings: [
                    {
                        method: "CVSSv31",
                        score,
                        severity,
                        source: { name: advisorySourceName(advisoryId), url: advisoryUri(advisoryId) },
                    },
                ],
                ...(fixed.length > 0 ? { recommendation: `Upgrade to one of: ${fixed.join(", ")}` } : {}),
                affects,
                created: timestamp,
                published: timestamp,
                ...(analysis ? { analysis } : {}),
            };
        });
};

/**
 * Attach vulnerabilities to an existing CycloneDX BOM in-place semantics:
 * returns a *new* BOM object so callers can keep the original immutable.
 */
export const emitCycloneDxVex = (options: CycloneDxVexOptions): CycloneDxBom => {
    const vulnerabilities = buildCycloneDxVulnerabilities(options.findings, options.now);

    return {
        ...addBundledComponents(options.bom, options.bundled ?? []),
        vulnerabilities,
    };
};

/**
 * Adds the packages that ship inside other packages to a BOM: one component each (`bom-ref` is the purl, like
 * every other component) and a dependency edge from the package that ships it. A host the BOM does not list is
 * added too, so no edge points at a missing component. Returns the BOM itself when there is nothing to add.
 */
const addBundledComponents = (bom: CycloneDxBom, bundled: ReadonlyArray<CycloneDxBundledPackage>): CycloneDxBom => {
    if (bundled.length === 0) {
        return bom;
    }

    const known = new Set((bom.components ?? []).map((component) => component["bom-ref"]));
    const added: Component[] = [];
    const edges = new Map<string, Set<string>>();

    const ensure = (name: string, version: string): string => {
        const ref = toNpmPurl(name, version);

        if (!known.has(ref)) {
            known.add(ref);
            added.push({ "bom-ref": ref, name, purl: ref, scope: "required", type: "library", version });
        }

        return ref;
    };

    for (const pkg of bundled) {
        const ref = ensure(pkg.name, pkg.version);

        for (const chain of pkg.bundledIn ?? []) {
            const parent = chain.at(-1);

            if (!parent) {
                continue;
            }

            const parentRef = ensure(parent.name, parent.version);
            const children = edges.get(parentRef);

            if (children) {
                children.add(ref);
            } else {
                edges.set(parentRef, new Set([ref]));
            }
        }
    }

    const dependencies = (bom.dependencies ?? []).map((dependency) => {
        const children = edges.get(dependency.ref);

        if (!children) {
            return dependency;
        }

        edges.delete(dependency.ref);

        return { ...dependency, dependsOn: [...new Set([...(dependency.dependsOn ?? []), ...children])].toSorted() };
    });

    for (const [ref, children] of edges) {
        dependencies.push({ dependsOn: [...children].toSorted(), ref });
    }

    return {
        ...bom,
        components: [...(bom.components ?? []), ...added.toSorted((a, b) => (a["bom-ref"] ?? "").localeCompare(b["bom-ref"] ?? ""))],
        dependencies: dependencies.toSorted((a, b) => a.ref.localeCompare(b.ref)),
    };
};
