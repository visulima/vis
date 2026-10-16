export interface NativeAuditExclusions {
    /** Package names to exclude from audit (yarn berry only). */
    excludedPackages: string[];
    /** Advisory IDs to ignore (CVE-*, GHSA-*, or numeric IDs). */
    ignoredAdvisories: string[];
}

/**
 * The 8 Socket.dev-style supply-chain policies. Used in `security.policies`
 * and `security.acceptedRisks[*].policies`. Kept as a const tuple so callers
 * can import the runtime array (`POLICY_NAMES`) for iteration without
 * drifting from the union type.
 */
export const POLICY_NAMES = ["firstSeen", "installScripts", "license", "malware", "publisherChange", "score", "unexpectedDeps", "vulnerability"] as const;

export type PolicyName = (typeof POLICY_NAMES)[number];
