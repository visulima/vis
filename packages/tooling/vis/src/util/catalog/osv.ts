import { advisoryKey } from "../../security/advisories";
import type { OsvBatchResponse, OsvVuln, SecurityVulnerability } from "./types";

const mapOsvSeverity = (vuln: OsvVuln): "CRITICAL" | "HIGH" | "LOW" | "MODERATE" | "UNKNOWN" => {
    // Try database_specific.severity first
    const databaseSeverity = vuln.database_specific?.severity?.toUpperCase();

    if (databaseSeverity === "CRITICAL" || databaseSeverity === "HIGH" || databaseSeverity === "MODERATE" || databaseSeverity === "LOW") {
        return databaseSeverity;
    }

    // Try CVSS score
    const cvss = vuln.severity?.find((s) => s.type === "CVSS_V3")?.score;

    if (cvss) {
        const score = Number.parseFloat(cvss);

        if (score >= 9) {
            return "CRITICAL";
        }

        if (score >= 7) {
            return "HIGH";
        }

        if (score >= 4) {
            return "MODERATE";
        }

        return "LOW";
    }

    return "UNKNOWN";
};

const mapOsvCvss = (vuln: OsvVuln): number | undefined => {
    const cvss = vuln.severity?.find((s) => s.type === "CVSS_V3")?.score;

    return cvss ? Number.parseFloat(cvss) : undefined;
};

const mapOsvFixedVersions = (vuln: OsvVuln): string[] => {
    const fixed: string[] = [];

    for (const affected of vuln.affected ?? []) {
        for (const range of affected.ranges ?? []) {
            for (const event of range.events ?? []) {
                if (event.fixed) {
                    fixed.push(event.fixed);
                }
            }
        }
    }

    return fixed;
};

const mapOsvVuln = (vuln: OsvVuln): SecurityVulnerability => {
    return {
        aliases: vuln.aliases?.length ? vuln.aliases : undefined,
        cvssScore: mapOsvCvss(vuln),
        fixedVersions: mapOsvFixedVersions(vuln),
        id: vuln.id,
        severity: mapOsvSeverity(vuln),
        summary: vuln.summary ?? "",
    };
};

export const fetchVulnerabilities = async (
    packages: { name: string; version: string }[],
    timeoutMs: number = 10_000,
): Promise<Map<string, SecurityVulnerability[]>> => {
    if (packages.length === 0) {
        return new Map();
    }

    const queries = packages.map((pkg) => {
        return {
            package: { ecosystem: "npm", name: pkg.name },
            version: pkg.version,
        };
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const response = await fetch("https://api.osv.dev/v1/querybatch", {
            body: JSON.stringify({ queries }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            signal: controller.signal,
        });

        if (!response.ok) {
            return new Map();
        }

        const data = (await response.json()) as OsvBatchResponse;
        const result = new Map<string, SecurityVulnerability[]>();

        for (const [index, packageInfo] of packages.entries()) {
            const vulns = data.results[index]?.vulns;

            if (vulns && vulns.length > 0) {
                result.set(
                    advisoryKey(packageInfo.name, packageInfo.version),
                    vulns.map((vuln) => mapOsvVuln(vuln)),
                );
            }
        }

        return result;
    } catch {
        // Graceful degradation: return empty on any failure
        return new Map();
    } finally {
        clearTimeout(timeout);
    }
};
