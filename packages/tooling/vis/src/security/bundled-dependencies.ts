/**
 * Packages that ship inside another package.
 *
 * A package can declare `bundleDependencies`; the package manager then installs those dependencies inside it
 * (`node_modules/&lt;host>/node_modules/&lt;dep>`) and the lockfile does not list them, so an audit that reads only
 * the lockfile never sees them. This module reads them from disk instead.
 *
 * A host is any package of the lockfile that is present under `node_modules` (the same walk `manifests.ts` does,
 * which also finds the real directory under pnpm's `.pnpm/` store). Each bundled name is read from
 * `&lt;host>/node_modules/&lt;name>/package.json`, and a bundled package that itself bundles is followed.
 *
 * Some packages ship vendored copies of other packages with no declaration at all, in a `dist/compiled`-style
 * tree. A vendored directory whose manifest has a name and a version is scanned like a bundled copy. One with no
 * version has no version source, so it is never guessed: it is reported as unauditable.
 */

import { readdirSync } from "node:fs";

import { isAccessibleSync, readJsonSync } from "@visulima/fs";
import { join } from "@visulima/path";

import type { DependencyPath } from "./dependency-paths";
import type { BundledHost, InstalledPackage } from "./dependency-scan";
import type { PackageManifest } from "./manifests";
import { bundledDependencyNames, readNodeModulesManifests } from "./manifests";

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

export interface BundledScan {
    /** How many packages were found only inside another package (not in the lockfile). */
    bundledCount: number;
    /** The lockfile packages, then the packages found only inside another package. */
    installed: InstalledPackage[];
    unauditable: UnauditableEntry[];
}

/** Directories (relative to a host) that hold vendored copies of other packages. */
const VENDORED_DIRECTORIES: ReadonlyArray<string> = ["dist/compiled", "compiled"];

/** A bundled package can bundle too; stop well past anything a real tree holds. */
const MAX_DEPTH = 8;

/** Paths per finding, like the lockfile walk. */
const MAX_PATHS = 5;

/** A name that stays inside `node_modules` once joined to a path. */
const SAFE_NAME = /^(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*$/u;

interface Manifest {
    bundled?: string[];
    name: string;
    version: string;
}

const readManifest = (directory: string): Manifest | undefined => {
    try {
        const raw = readJsonSync(join(directory, "package.json")) as Record<string, unknown>;

        if (typeof raw.name !== "string" || raw.name.length === 0 || typeof raw.version !== "string" || raw.version.length === 0) {
            return undefined;
        }

        const bundled = bundledDependencyNames(raw);

        return { ...(bundled ? { bundled } : {}), name: raw.name, version: raw.version };
    } catch {
        return undefined;
    }
};

const listDirectories = (directory: string): string[] => {
    try {
        return readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => entry.name);
    } catch {
        return [];
    }
};

/** The `@scope/name` form of a directory under a vendored tree, or its entries when it is a scope directory. */
const vendoredPackageDirectories = (root: string): string[] => {
    const directories: string[] = [];

    for (const entry of listDirectories(root)) {
        if (entry.startsWith("@")) {
            for (const inner of listDirectories(join(root, entry))) {
                directories.push(join(root, entry, inner));
            }
        } else {
            directories.push(join(root, entry));
        }
    }

    return directories;
};

/** `host > bundled`: the chain a finding reports as where the package lives. */
export const formatBundledPath = (chain: ReadonlyArray<BundledHost>, name: string, version: string): string =>
    [...chain.map((host) => `${host.name}@${host.version}`), `${name}@${version}`].join(" > ");

/**
 * Finds the packages shipped inside the lockfile's packages. `locked` is the scanned lockfile set (already cut to
 * production when `--prod-only` is set, so the bundled copies of a dev-only host are never read). Returns it
 * with the bundled copies appended, deduplicated by `name@version`: a copy the lockfile also lists is not scanned
 * twice, but it keeps the hosts that ship it. Without a `node_modules` directory there is nothing to read.
 */
export const scanBundledDependencies = (workspaceRoot: string, locked: InstalledPackage[]): BundledScan => {
    const manifests = locked.length > 0 ? readNodeModulesManifests(workspaceRoot) : new Map<string, PackageManifest>();

    if (manifests.size === 0) {
        return { bundledCount: 0, installed: locked, unauditable: [] };
    }

    const lockedKeys = new Set(locked.map((pkg) => `${pkg.name}@${pkg.version}`));
    const lockedHosts = new Map<string, BundledHost[][]>();
    const bundledOnly = new Map<string, InstalledPackage>();
    const unauditable = new Map<string, UnauditableEntry>();

    const addUnauditable = (entry: UnauditableEntry): void => {
        const key = `${entry.host}|${entry.kind}|${entry.location}`;

        if (!unauditable.has(key)) {
            unauditable.set(key, entry);
        }
    };

    const record = (name: string, version: string, chain: BundledHost[], isDev: boolean): void => {
        const key = `${name}@${version}`;

        if (lockedKeys.has(key)) {
            const known = lockedHosts.get(key);

            if (known) {
                known.push(chain);
            } else {
                lockedHosts.set(key, [chain]);
            }

            return;
        }

        const existing = bundledOnly.get(key);

        if (existing) {
            existing.bundledIn?.push(chain);
        } else {
            bundledOnly.set(key, { bundledIn: [chain], bundledOnly: true, isDev, name, version });
        }
    };

    const visit = (host: { directory: string; isDev: boolean; name: string; version: string }, chain: BundledHost[], bundled: string[] | undefined, depth: number): void => {
        if (depth > MAX_DEPTH) {
            return;
        }

        const hostKey = `${host.name}@${host.version}`;
        const below = [...chain, { name: host.name, version: host.version }];
        const unreadable: string[] = [];

        for (const declared of bundled ?? []) {
            const directory = join(host.directory, "node_modules", declared);
            const child = SAFE_NAME.test(declared) ? readManifest(directory) : undefined;

            if (!child) {
                unreadable.push(declared);

                continue;
            }

            record(child.name, child.version, below, host.isDev);
            visit({ directory, isDev: host.isDev, name: child.name, version: child.version }, below, child.bundled, depth + 1);
        }

        if (unreadable.length > 0) {
            addUnauditable({ count: unreadable.length, host: hostKey, kind: "bundled-unreadable", location: "node_modules", names: unreadable.toSorted() });
        }

        for (const location of VENDORED_DIRECTORIES) {
            let unversioned = 0;

            for (const directory of vendoredPackageDirectories(join(host.directory, location))) {
                const vendored = isAccessibleSync(join(directory, "package.json")) ? readManifest(directory) : undefined;

                if (vendored) {
                    record(vendored.name, vendored.version, below, host.isDev);
                } else {
                    unversioned += 1;
                }
            }

            if (unversioned > 0) {
                addUnauditable({ count: unversioned, host: hostKey, kind: "vendored", location });
            }
        }
    };

    for (const pkg of locked) {
        const manifest = manifests.get(`${pkg.name}@${pkg.version}`);

        if (manifest) {
            visit({ directory: manifest.directory, isDev: pkg.isDev, name: pkg.name, version: pkg.version }, [], manifest.bundledDependencies, 0);
        }
    }

    const installed = locked.map((pkg) => {
        const hosts = lockedHosts.get(`${pkg.name}@${pkg.version}`);

        return hosts ? { ...pkg, bundledIn: hosts } : pkg;
    });

    return {
        bundledCount: bundledOnly.size,
        installed: [...installed, ...bundledOnly.values()],
        unauditable: [...unauditable.values()].toSorted((a, b) => a.host.localeCompare(b.host) || a.location.localeCompare(b.location) || a.kind.localeCompare(b.kind)),
    };
};

/**
 * The paths a finding in `pkg` reports: from a workspace root down to the host that ships it, then through any
 * hosts inside it, to the package. `pathsTo` gives the lockfile paths of a host; a host with none is shown
 * as the chain alone. A package the lockfile also lists keeps a few of its lockfile paths ahead of the bundled ones.
 */
export const bundledDependencyPaths = (
    pkg: { bundledIn?: ReadonlyArray<ReadonlyArray<BundledHost>>; name: string; version: string },
    lockfilePaths: ReadonlyArray<DependencyPath>,
    pathsTo: (host: BundledHost) => ReadonlyArray<DependencyPath>,
): DependencyPath[] => {
    if (!pkg.bundledIn || pkg.bundledIn.length === 0) {
        return [...lockfilePaths];
    }

    const self = { name: pkg.name, version: pkg.version };
    const bundled: DependencyPath[] = [];

    for (const chain of pkg.bundledIn) {
        const [top, ...inside] = chain;

        if (!top) {
            continue;
        }

        const toTop = pathsTo(top);

        for (const path of toTop.length > 0 ? toTop : [[top]]) {
            bundled.push([...path, ...inside, self]);
        }
    }

    const kept = lockfilePaths.length > 0 ? lockfilePaths.slice(0, MAX_PATHS - Math.min(2, bundled.length)) : [];

    return [...kept, ...bundled].slice(0, MAX_PATHS);
};
