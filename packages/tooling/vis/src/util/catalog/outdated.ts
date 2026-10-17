import { findCacheDirSync } from "@visulima/find-cache-dir";
import { ensureDirSync, isAccessibleSync, readJsonSync, writeJsonSync } from "@visulima/fs";
import { dirname, join } from "@visulima/path";
import { rcompare } from "semver";

import { advisoryKey } from "../../security/advisories";
import type { SecurityProvider } from "../../security/provider";
import { fetchAllReports } from "../../security/registry";
import type { AcceptedRisk, PackageReportData } from "../../security/socket-security";
import { findAcceptedRisk } from "../../security/socket-security";
import { fetchVulnerabilities } from "./osv";
import { matchesFilters, matchesPattern, resolvePackageTarget } from "./patterns";
import { fetchVersionsBatched } from "./registry";
import type { CatalogCheckOptions, CheckOutdatedResult, NpmrcConfig, OutdatedCache, OutdatedEntry, ParsedVersion, RegistryVersionInfo, ReleaseChannel, UpdateTarget } from "./types";
import { extractPrefix, formatVersionString, getUpdateType, isNewer, matchesReleaseChannel, parseVersion } from "./version";

export interface MaturityOptions {
    minimumReleaseAge?: number;
    minimumReleaseAgeExclude?: string[];
    packageName?: string;
    publishTimes?: Map<string, string>;
}

/** Returns true when a version is too new (published less than `minAgeMs` milliseconds ago). */
const isTooNew = (version: string, publishTimes: Map<string, string> | undefined, minAgeMs: number): boolean => {
    const publishDate = publishTimes?.get(version);

    if (!publishDate) {
        return false;
    }

    return Date.now() - new Date(publishDate).getTime() < minAgeMs;
};

/** Resolves the effective minimum age in milliseconds, returning 0 when age filtering is disabled. */
const resolveMinAgeMs = (maturity?: MaturityOptions): number => {
    if (!maturity?.minimumReleaseAge) {
        return 0;
    }

    const isExcluded = maturity.packageName && maturity.minimumReleaseAgeExclude?.some((p) => matchesPattern(maturity.packageName!, p));

    return isExcluded ? 0 : maturity.minimumReleaseAge * 60 * 1000;
};

/**
 * Resolve the effective release-channel filter — bridges the legacy
 * `includePrerelease` boolean to the new `releaseChannel` enum so callers
 * can keep passing `--prerelease` without setting `--release-channel`.
 */
const resolveReleaseChannel = (includePrerelease: boolean, releaseChannel: ReleaseChannel | undefined): ReleaseChannel =>
    releaseChannel ?? (includePrerelease ? "any" : "stable");

/** Filters and sorts version candidates that are newer than `current`, optionally constrained by major/minor and maturity. */
const filterCandidates = (
    versions: string[],
    current: ParsedVersion,
    includePrerelease: boolean,
    minAgeMs: number,
    publishTimes: Map<string, string> | undefined,
    constraint?: (parsed: ParsedVersion) => boolean,
    releaseChannel?: ReleaseChannel,
): string | undefined => {
    const channel = resolveReleaseChannel(includePrerelease, releaseChannel);

    const best = versions
        .map((v) => {
            return { parsed: parseVersion(v), raw: v };
        })
        .filter((v): v is { parsed: ParsedVersion; raw: string } => {
            if (!v.parsed) {
                return false;
            }

            if (!matchesReleaseChannel(v.parsed, current, channel)) {
                return false;
            }

            if (!isNewer(current, v.parsed)) {
                return false;
            }

            if (minAgeMs && isTooNew(v.raw, publishTimes, minAgeMs)) {
                return false;
            }

            return constraint ? constraint(v.parsed) : true;
        })
        .toSorted((a, b) => rcompare(a.raw, b.raw));

    return best[0]?.raw;
};

export const findTargetVersion = (
    versions: string[],
    latest: string,
    currentRange: string,
    target: UpdateTarget,
    includePrerelease: boolean,
    maturity?: MaturityOptions,
    releaseChannel?: ReleaseChannel,
): string | undefined => {
    const current = parseVersion(currentRange);

    if (!current) {
        return undefined;
    }

    const minAgeMs = resolveMinAgeMs(maturity);
    const channel = resolveReleaseChannel(includePrerelease, releaseChannel);

    if (target === "latest") {
        const latestParsed = parseVersion(latest);

        if (!latestParsed) {
            return undefined;
        }

        if (!matchesReleaseChannel(latestParsed, current, channel)) {
            // Caller wanted "stable" / "same" but the dist-tag latest is on a
            // different channel — fall back to scanning the version list so
            // we don't miss a valid mature candidate just because npm pinned
            // `latest` at an off-channel release.
            return filterCandidates(versions, current, includePrerelease, minAgeMs, maturity?.publishTimes, undefined, channel);
        }

        if (!isNewer(current, latestParsed)) {
            return undefined;
        }

        if (!minAgeMs || !isTooNew(latest, maturity?.publishTimes, minAgeMs)) {
            return latest;
        }

        return filterCandidates(versions, current, includePrerelease, minAgeMs, maturity?.publishTimes, undefined, channel);
    }

    const constraint
        = target === "patch"
            ? (p: ParsedVersion): boolean => p.major === current.major && p.minor === current.minor
            : (p: ParsedVersion): boolean => p.major === current.major;

    return filterCandidates(versions, current, includePrerelease, minAgeMs, maturity?.publishTimes, constraint, channel);
};

const collectEntries = (
    catalogs: Map<string, Map<string, string>>,
    options: CatalogCheckOptions,
): { entries: { catalogName: string; packageName: string; range: string }[]; ignored: string[] } => {
    const entries: { catalogName: string; packageName: string; range: string }[] = [];
    const ignoredSet = new Set<string>();

    for (const [catalogName, deps] of catalogs) {
        for (const [packageName, range] of deps) {
            // Skip non-version protocols
            if (range.startsWith("workspace:") || range.startsWith("file:") || range.startsWith("link:") || range === "*") {
                continue;
            }

            // Skip pinned (exact) versions unless includeLocked is set
            if (!options.includeLocked) {
                const prefix = extractPrefix(range);

                if (!prefix) {
                    continue;
                }
            }

            // Check ignore list before other filters
            if (options.ignore.some((p) => matchesPattern(packageName, p))) {
                ignoredSet.add(packageName);
                continue;
            }

            if (matchesFilters(packageName, options.include, options.exclude)) {
                entries.push({ catalogName, packageName, range });
            }
        }
    }

    return { entries, ignored: [...ignoredSet] };
};

const buildOutdatedEntries = (
    entries: { catalogName: string; packageName: string; range: string }[],
    versionCache: Map<string, RegistryVersionInfo>,
    options: CatalogCheckOptions,
): OutdatedEntry[] => {
    const outdated: OutdatedEntry[] = [];

    for (const entry of entries) {
        const info = versionCache.get(entry.packageName);

        if (!info) {
            continue;
        }

        const effectiveTarget = resolvePackageTarget(entry.packageName, options.target, options.packageMode);
        const targetVersion = findTargetVersion(
            info.versions,
            info.latest,
            entry.range,
            effectiveTarget,
            options.includePrerelease,
            {
                minimumReleaseAge: options.minimumReleaseAge,
                minimumReleaseAgeExclude: options.minimumReleaseAgeExclude,
                packageName: entry.packageName,
                publishTimes: info.publishTimes,
            },
            options.releaseChannel,
        );

        if (!targetVersion) {
            continue;
        }

        const current = parseVersion(entry.range);
        const target = parseVersion(targetVersion);

        if (!current || !target) {
            continue;
        }

        const updateType = getUpdateType(current, target);

        if (updateType === "none") {
            continue;
        }

        const prefix = extractPrefix(entry.range);

        outdated.push({
            catalogName: entry.catalogName,
            currentRange: entry.range,
            newRange: `${prefix}${targetVersion}`,
            packageName: entry.packageName,
            targetVersion,
            updateType,
        });
    }

    return outdated;
};

const enrichWithSecurity = async (
    outdated: OutdatedEntry[],
    entries: { catalogName: string; packageName: string; range: string }[],
    securityProviders?: ReadonlyArray<SecurityProvider>,
    acceptedRisks?: Record<string, AcceptedRisk>,
): Promise<void> => {
    // Check current versions for known vulnerabilities
    // One query per name and version: a package locked at two versions gets both checked.
    const packagesToScan = [
        ...new Map(
            entries.map((entry) => {
                const version = formatVersionString(parseVersion(entry.range));

                return [advisoryKey(entry.packageName, version), { name: entry.packageName, version }];
            }),
        ).values(),
    ].filter((p) => p.version);

    // Fetch OSV vulnerabilities and per-provider security reports in parallel.
    // `fetchAllReports` returns an empty map when no providers are configured,
    // so we always have a Map to read from below.
    const socketPromise: Promise<Map<string, PackageReportData>> | undefined
        = securityProviders && securityProviders.length > 0 ? fetchAllReports(securityProviders, packagesToScan) : undefined;

    const [vulnMap, socketReports] = await Promise.all([fetchVulnerabilities(packagesToScan), socketPromise]);

    for (const entry of outdated) {
        // Same version derivation as the query above, so the key matches what was looked up.
        const vulns = vulnMap.get(advisoryKey(entry.packageName, formatVersionString(parseVersion(entry.currentRange))));

        if (vulns && vulns.length > 0) {
            entry.vulnerabilities = vulns;
        }

        // Parse version once for both socket report and accepted risk lookups
        const parsed = parseVersion(entry.currentRange);
        const version = formatVersionString(parsed);

        // Attach Socket.dev report data if available
        if (socketReports) {
            const report = socketReports.get(`${entry.packageName}@${version}`);

            if (report) {
                entry.socketReport = {
                    alerts: report.alerts,
                    license: report.license,
                    score: report.score,
                };
            }
        }

        // Cross-reference accepted risks
        if (acceptedRisks) {
            const risk = findAcceptedRisk(entry.packageName, version, acceptedRisks);

            if (risk) {
                entry.acceptedRisk = risk;
            }
        }
    }
};

const OUTDATED_CACHE_TTL_MS = 60_000;

const computeCacheHash = (
    catalogs: Map<string, Map<string, string>>,
    options: CatalogCheckOptions,
    socketEnabled?: boolean,
    acceptedRiskKeys?: string[],
): string => {
    const parts: string[] = [];

    for (const [name, deps] of catalogs) {
        for (const [pkg, range] of deps) {
            parts.push(`${name}:${pkg}=${range}`);
        }
    }

    parts.push(
        `target=${options.target},pre=${String(options.includePrerelease)},chan=${options.releaseChannel ?? "_"},sec=${String(options.security ?? false)}`,
    );
    parts.push(`in=${options.include.join(",")},ex=${options.exclude.join(",")},ig=${options.ignore.join(",")}`);
    parts.push(`locked=${String(options.includeLocked)}`);
    parts.push(`mra=${String(options.minimumReleaseAge ?? 0)}`);

    if (options.packageMode) {
        const modeEntries = Object.entries(options.packageMode)
            .map(([k, v]) => `${k}=${v}`)
            .toSorted()
            .join(",");

        parts.push(`pkgMode=${modeEntries}`);
    }

    parts.push(`socket=${String(socketEnabled ?? false)}`);

    if (acceptedRiskKeys && acceptedRiskKeys.length > 0) {
        parts.push(`risks=${acceptedRiskKeys.toSorted().join(",")}`);
    }

    let hash = 5381;
    const joined = parts.join("|");

    for (let i = 0; i < joined.length; i++) {
        // eslint-disable-next-line no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point -- djb2 hash: bitwise int32 truncation and code-unit iteration are required for stable cache keys
        hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
    }

    return String(hash);
};

const getOutdatedCachePath = (workspaceRoot: string): string | undefined => {
    const cacheDir = findCacheDirSync("vis", { create: true, cwd: workspaceRoot });

    return cacheDir ? join(cacheDir, "outdated-cache.json") : undefined;
};

const readOutdatedCache = (workspaceRoot: string, hash: string): CheckOutdatedResult | undefined => {
    const cachePath = getOutdatedCachePath(workspaceRoot);

    if (!cachePath || !isAccessibleSync(cachePath)) {
        return undefined;
    }

    try {
        const cache = readJsonSync(cachePath) as unknown as OutdatedCache;

        if (cache.hash === hash && Date.now() - cache.timestamp < OUTDATED_CACHE_TTL_MS) {
            return cache.result;
        }
    } catch {
        // Corrupt cache — ignore
    }

    return undefined;
};

const writeOutdatedCache = (workspaceRoot: string, hash: string, result: CheckOutdatedResult): void => {
    const cachePath = getOutdatedCachePath(workspaceRoot);

    if (!cachePath) {
        return;
    }

    try {
        ensureDirSync(dirname(cachePath));
        writeJsonSync(cachePath, { hash, result, timestamp: Date.now() } satisfies OutdatedCache);
    } catch {
        // Non-critical
    }
};

export const checkOutdated = async (
    catalogs: Map<string, Map<string, string>>,
    options: CatalogCheckOptions,
    npmrcConfig?: NpmrcConfig,
    onProgress?: (current: number, total: number) => void,
    workspaceRoot?: string,
    securityProviders?: ReadonlyArray<SecurityProvider>,
    acceptedRisks?: Record<string, AcceptedRisk>,
): Promise<CheckOutdatedResult> => {
    const hasSecurityProviders = Boolean(securityProviders && securityProviders.length > 0);
    const hash = computeCacheHash(catalogs, options, hasSecurityProviders, acceptedRisks ? Object.keys(acceptedRisks) : undefined);

    if (workspaceRoot) {
        const cached = readOutdatedCache(workspaceRoot, hash);

        if (cached) {
            return cached;
        }
    }

    const { entries, ignored } = collectEntries(catalogs, options);
    const uniquePackages = [...new Set(entries.map((entry) => entry.packageName))];

    const needPublishTimes = Boolean(options.minimumReleaseAge && options.minimumReleaseAge > 0);
    const { failed, versionCache } = await fetchVersionsBatched(uniquePackages, npmrcConfig, onProgress, needPublishTimes, options.maxConcurrentRequests);
    const outdated = buildOutdatedEntries(entries, versionCache, options);

    // Compute packages filtered out by target constraint (have updates on "latest" but not on current target)
    let filteredByTarget: OutdatedEntry[] = [];

    if (options.target !== "latest") {
        const outdatedNames = new Set(outdated.map((e) => e.packageName));
        const latestOptions = { ...options, packageMode: undefined, target: "latest" as UpdateTarget };
        const allLatest = buildOutdatedEntries(entries, versionCache, latestOptions);

        filteredByTarget = allLatest.filter((e) => !outdatedNames.has(e.packageName));
    }

    if ((options.security || hasSecurityProviders) && outdated.length > 0) {
        await enrichWithSecurity(outdated, entries, securityProviders, acceptedRisks);
    }

    const result = { checkedCount: uniquePackages.length, failed, filteredByTarget, ignored, outdated };

    if (workspaceRoot) {
        writeOutdatedCache(workspaceRoot, hash, result);
    }

    return result;
};
