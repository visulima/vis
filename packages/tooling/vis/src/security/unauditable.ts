/**
 * Packages a scan knew were there and could not check.
 *
 * Kept free of runtime imports so the report emitters (the HTML one is bundled inline) can use it.
 */

/** Why a package could not be scanned. */
export type UnauditableKind = "bundled-unreadable" | "vendored";

/** A host that ships packages the scan could not check. */
export interface UnauditableEntry {
    /** How many packages. */
    count: number;
    /** The host, as `name@version`. */
    host: string;
    kind: UnauditableKind;
    /** Where inside the host they are, relative to it (`dist/compiled`, `node_modules`). */
    location: string;
    /** The names, for a bundled package whose manifest cannot be read. */
    names?: string[];
}

/**
 * One line that says what was not scanned and why, for the table, the HTML report and SARIF notes:
 * `next@16.3.8 vendors 126 packages without versions (dist/compiled)`.
 */
export const describeUnauditable = (entry: UnauditableEntry): string => {
    const noun = entry.count === 1 ? "package" : "packages";

    return entry.kind === "vendored"
        ? `${entry.host} vendors ${String(entry.count)} ${noun} without versions (${entry.location})`
        : `${entry.host} bundles ${String(entry.count)} ${noun} whose manifest cannot be read (${(entry.names ?? []).join(", ")})`;
};
