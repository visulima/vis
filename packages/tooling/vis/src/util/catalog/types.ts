import type { AcceptedRisk, PackageReportData } from "../../security/socket-security";

export type UpdateTarget = "latest" | "minor" | "patch";

export interface SecurityVulnerability {
    /** Alternate identifiers (CVE-*, GHSA-*, etc.) from the OSV database. */
    aliases?: string[];
    cvssScore?: number;
    fixedVersions: string[];
    id: string;
    severity: "CRITICAL" | "HIGH" | "LOW" | "MODERATE" | "UNKNOWN";
    summary: string;
}

export type SocketReport = Pick<PackageReportData, "alerts" | "license" | "score">;

export interface OutdatedEntry {
    acceptedRisk?: AcceptedRisk;
    catalogName: string;
    currentRange: string;

    /**
     * URL shown in the detail panel's LINKS section. When set (used by
     * adapted non-npm ecosystem entries) it replaces the default npmx.dev
     * link, which is meaningless for a workflow/Dockerfile reference.
     */
    detailUrl?: string;

    /**
     * Human-readable label rendered in place of `packageName` in the list /
     * detail / confirm UI. `packageName` stays the stable, unique key (the
     * check-set is keyed by it); adapted ecosystem entries use a `file:line`
     * key as `packageName` and the bare ref name (e.g. `actions/checkout`)
     * here.
     */
    displayName?: string;

    /**
     * `"ecosystem"` marks an adapted non-npm reference (GitHub Actions /
     * Docker / GitLab CI) so the detail panel can skip npm-only sections and
     * the apply path can route it to the ecosystem applier.
     */
    kind?: "ecosystem";
    newRange: string;
    packageName: string;
    socketReport?: SocketReport;
    targetVersion: string;
    updateType: "major" | "minor" | "patch";
    vulnerabilities?: SecurityVulnerability[];
}

export type ReleaseChannel = "any" | "same" | "stable";

export interface CatalogCheckOptions {
    exclude: string[];
    ignore: string[];
    include: string[];
    includeLocked: boolean;
    includePrerelease: boolean;
    /** Cap on simultaneous registry requests during outdated checks. Default 8. */
    maxConcurrentRequests?: number;
    minimumReleaseAge?: number;
    minimumReleaseAgeExclude?: string[];
    packageMode?: Record<string, UpdateTarget>;

    /**
     * Channel filter applied on top of `includePrerelease`. When unset, falls
     * back to `includePrerelease` (true → "any", false → "stable") so the
     * legacy `--prerelease` flag keeps working.
     */
    releaseChannel?: ReleaseChannel;
    security?: boolean;
    target: UpdateTarget;
}

export interface ReadCatalogOptions {
    depFields?: string[];
    dev?: boolean;

    /**
     * Skip the workspace-internal-name filter so the registry pass also
     * queries packages whose names are owned by the local monorepo.
     * Useful when the registry has fresher prereleases than what's pinned.
     */
    includeInternal?: boolean;
    /** Include `peerDependencies` in addition to runtime/dev/optional. */
    peer?: boolean;
    prod?: boolean;
}

export interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string;
}

export type YamlSection = "catalog" | "catalogs" | "none";

export interface BunPackageJson {
    workspaces?: {
        catalog?: Record<string, string>;
        catalogs?: Record<string, Record<string, string>>;
        packages?: string[];
    };
}

export interface InternalOutdatedOptions {
    depFields?: string[];
    dev?: boolean;
    exclude?: string[];
    ignore?: string[];
    include?: string[];
    packageMode?: Record<string, UpdateTarget>;
    /** Include `peerDependencies` in the internal-drift pass. Default: false. */
    peer?: boolean;
    prod?: boolean;
    target?: UpdateTarget;
}

export interface NpmrcConfig {
    authTokens: Map<string, string>;
    defaultRegistry: string;
    registries: Map<string, string>;
}

export interface RegistryVersionInfo {
    latest: string;
    /** Map of version string to ISO publish time (populated when minimumReleaseAge is set). */
    publishTimes?: Map<string, string>;
    versions: string[];
}

export interface OsvVuln {
    affected?: {
        ranges?: {
            events?: { fixed?: string; introduced?: string }[];
        }[];
    }[];
    aliases?: string[];
    database_specific?: { severity?: string };
    id: string;
    severity?: { score?: string; type?: string }[];
    summary?: string;
}

export interface OsvBatchResponse {
    results: { vulns?: OsvVuln[] }[];
}

export interface CheckOutdatedResult {
    /** Total number of unique packages checked (after filtering). */
    checkedCount: number;
    failed: string[];
    /** Packages that have newer versions on "latest" but were excluded by the target constraint. */
    filteredByTarget: OutdatedEntry[];
    ignored: string[];
    outdated: OutdatedEntry[];
}

export interface OutdatedCache {
    hash: string;
    result: CheckOutdatedResult;
    timestamp: number;
}

export interface ApplyCatalogUpdatesOptions {
    /** Disable `.editorconfig` indent discovery; falls back to file-content sniffing. */
    useEditorconfig?: boolean;
}

export interface ChangelogInfo {
    npmUrl: string;
    packageName: string;
    releaseUrl?: string;
    repoUrl?: string;
}
