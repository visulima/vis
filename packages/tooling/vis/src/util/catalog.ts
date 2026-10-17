import { isAccessibleSync, readJsonSync, writeJsonSync } from "@visulima/fs";
import { join } from "@visulima/path";

import { readPnpmWorkspacePatterns, resolveWorkspacePatterns } from "../config/workspace";
import { createBackup } from "./catalog/backup";
import { applyBunCatalogUpdates, hasBunCatalogs, readBunCatalogs } from "./catalog/bun";
import { DEFAULT_DEP_TYPES, parseCompositeCatalogName } from "./catalog/composite";
import { matchesFilters, matchesPattern, resolvePackageTarget } from "./catalog/patterns";
import { applyPnpmCatalogUpdates } from "./catalog/pnpm-updates";
import { hasPnpmCatalogs, readPnpmCatalogs } from "./catalog/pnpm-yaml";
import type { ApplyCatalogUpdatesOptions, InternalOutdatedOptions, OutdatedEntry, ReadCatalogOptions, UpdateTarget } from "./catalog/types";
import { extractPrefix, getUpdateType, isNewer, parseVersion } from "./catalog/version";
import { resolveIndentForExistingFile } from "./editorconfig";
import { setNestedField } from "./nested-field";

const getDepTypesToInclude = (options?: ReadCatalogOptions): string[] => {
    if (options?.dev) {
        return ["devDependencies"];
    }

    if (options?.prod) {
        return ["dependencies"];
    }

    if (options?.depFields && options.depFields.length > 0) {
        return options.depFields;
    }

    // peerDependencies are opt-in: bumping a peer is a behavior change for
    // every consumer of the package, so the user has to ask for it via
    // `--peer` rather than getting it silently merged into every update run.
    return options?.peer ? [...DEFAULT_DEP_TYPES, "peerDependencies"] : DEFAULT_DEP_TYPES;
};

const collectInternalPackageNames = (workspaceRoot: string, rootName: string | undefined, workspaceDirectories: string[]): Set<string> => {
    const names = new Set<string>();

    if (rootName) {
        names.add(rootName);
    }

    for (const directory of workspaceDirectories) {
        const pkgPath = join(workspaceRoot, directory, "package.json");

        if (isAccessibleSync(pkgPath)) {
            try {
                const pkg = readJsonSync(pkgPath) as { name?: string };

                if (pkg.name) {
                    names.add(pkg.name);
                }
            } catch {
                // skip invalid package.json
            }
        }
    }

    return names;
};

const getNestedField = (object: Record<string, unknown>, path: string): Record<string, string> | undefined => {
    const parts = path.split(".");
    let current: unknown = object;

    for (const part of parts) {
        if (current && typeof current === "object") {
            current = (current as Record<string, unknown>)[part];
        } else {
            return undefined;
        }
    }

    return typeof current === "object" && current !== null ? (current as Record<string, string>) : undefined;
};

const filterExternalDeps = (deps: Record<string, string>, internalNames: Set<string>): Map<string, string> => {
    const filtered = new Map<string, string>();

    for (const [name, range] of Object.entries(deps)) {
        if (internalNames.has(name)) {
            continue;
        }

        if (range.startsWith("workspace:") || range.startsWith("file:") || range.startsWith("link:") || range.startsWith("catalog:") || range.startsWith("$")) {
            continue;
        }

        filtered.set(name, range);
    }

    return filtered;
};

const scanDirectoryDeps = (
    workspaceRoot: string,
    directory: string,
    rootPkgPath: string,
    depTypes: string[],
    internalNames: Set<string>,
    catalogs: Map<string, Map<string, string>>,
): void => {
    const pkgPath = directory === "." ? rootPkgPath : join(workspaceRoot, directory, "package.json");

    if (!isAccessibleSync(pkgPath)) {
        return;
    }

    let pkg: Record<string, unknown>;

    try {
        pkg = readJsonSync(pkgPath) as Record<string, unknown>;
    } catch {
        return;
    }

    for (const depType of depTypes) {
        const deps = depType.includes(".") ? getNestedField(pkg, depType) : (pkg[depType] as Record<string, string> | undefined);

        if (!deps || typeof deps !== "object") {
            continue;
        }

        const filtered = filterExternalDeps(deps, internalNames);

        if (filtered.size > 0) {
            catalogs.set(`${directory}:${depType}`, filtered);
        }
    }
};

const readPackageJsonDeps = (workspaceRoot: string, options?: ReadCatalogOptions): Map<string, Map<string, string>> => {
    const catalogs = new Map<string, Map<string, string>>();
    const rootPkgPath = join(workspaceRoot, "package.json");

    if (!isAccessibleSync(rootPkgPath)) {
        return catalogs;
    }

    const rootPkg = readJsonSync(rootPkgPath) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        name?: string;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        workspaces?: string[] | { catalog?: Record<string, string>; packages?: string[] };
    };

    // Prefer pnpm-workspace.yaml when present — pnpm exclusions (`!dir/**`)
    // only live there, and reading package.json#workspaces first would lose
    // them for monorepos that ship both files (the npm field is kept for
    // editor / Yarn Berry / npm-classic compatibility, not as the source of
    // truth). Mirrors the order used in sort-package-json/handler.ts.
    let workspaceDirectories: string[] = [];
    const pnpmPatterns = readPnpmWorkspacePatterns(workspaceRoot);

    if (pnpmPatterns) {
        workspaceDirectories = resolveWorkspacePatterns(workspaceRoot, pnpmPatterns);
    } else {
        const workspacesField = rootPkg.workspaces;

        if (workspacesField) {
            const patterns = Array.isArray(workspacesField) ? workspacesField : workspacesField.packages;

            if (patterns) {
                workspaceDirectories = resolveWorkspacePatterns(workspaceRoot, patterns);
            }
        }
    }

    // When `--include-internal` is on, treat workspace-owned names as if
    // they were external — the registry pass will then check them like any
    // other dep. The non-protocol filter inside `filterExternalDeps`
    // (workspace:/file:/link:/catalog:) still applies, so live workspace
    // links don't leak in.
    const internalNames = options?.includeInternal ? new Set<string>() : collectInternalPackageNames(workspaceRoot, rootPkg.name, workspaceDirectories);
    const depTypes = getDepTypesToInclude(options);
    const directoriesToScan = [".", ...workspaceDirectories];

    for (const directory of directoriesToScan) {
        scanDirectoryDeps(workspaceRoot, directory, rootPkgPath, depTypes, internalNames, catalogs);
    }

    return catalogs;
};

const hasPackageJsonDeps = (workspaceRoot: string): boolean => {
    const pkgPath = join(workspaceRoot, "package.json");

    if (!isAccessibleSync(pkgPath)) {
        return false;
    }

    try {
        const pkg = readJsonSync(pkgPath) as Record<string, unknown>;

        return !!(
            pkg.dependencies
            || pkg.devDependencies
            || pkg.peerDependencies
            || pkg.optionalDependencies
            || pkg.overrides
            || pkg.resolutions
            || getNestedField(pkg, "pnpm.overrides")
        );
    } catch {
        return false;
    }
};

const applyPackageJsonUpdates = (workspaceRoot: string, updates: OutdatedEntry[], useEditorconfig?: boolean): void => {
    const byFile = new Map<string, { depType: string; newRange: string; packageName: string }[]>();

    for (const update of updates) {
        const parsed = parseCompositeCatalogName(update.catalogName);

        if (!parsed) {
            continue;
        }

        const filePath = parsed.relativePath === "." ? join(workspaceRoot, "package.json") : join(workspaceRoot, parsed.relativePath, "package.json");

        if (!byFile.has(filePath)) {
            byFile.set(filePath, []);
        }

        const fileList = byFile.get(filePath);

        if (fileList) {
            fileList.push({ depType: parsed.depType, newRange: update.newRange, packageName: update.packageName });
        }
    }

    for (const [filePath, fileUpdates] of byFile) {
        const pkg = readJsonSync(filePath) as Record<string, Record<string, string>>;

        for (const { depType, newRange, packageName } of fileUpdates) {
            if (depType.includes(".")) {
                setNestedField(pkg, depType, packageName, newRange);
            } else if (pkg[depType]) {
                pkg[depType][packageName] = newRange;
            }
        }

        writeJsonSync(filePath, pkg, { indent: resolveIndentForExistingFile(filePath, { useEditorconfig }), overwrite: true });
    }
};

const hasCatalogs = (workspaceRoot: string, packageManager?: string): boolean => {
    if (packageManager === "bun") {
        return hasBunCatalogs(workspaceRoot) || hasPackageJsonDeps(workspaceRoot);
    }

    if (packageManager === "npm" || packageManager === "yarn") {
        return hasPackageJsonDeps(workspaceRoot);
    }

    // pnpm: try catalogs first, fall back to package.json deps
    return hasPnpmCatalogs(workspaceRoot) || hasPackageJsonDeps(workspaceRoot);
};

const readCatalogs = (workspaceRoot: string, packageManager?: string, options?: ReadCatalogOptions): Map<string, Map<string, string>> => {
    let catalogs: Map<string, Map<string, string>>;

    if (packageManager === "bun") {
        catalogs = readBunCatalogs(workspaceRoot);
    } else if (packageManager === "npm" || packageManager === "yarn") {
        catalogs = new Map();
    } else {
        // pnpm
        catalogs = readPnpmCatalogs(workspaceRoot);
    }

    // Always merge in non-catalog package.json deps (direct version ranges)
    const pkgDeps = readPackageJsonDeps(workspaceRoot, options);

    for (const [key, deps] of pkgDeps) {
        if (!catalogs.has(key)) {
            catalogs.set(key, deps);
        }
    }

    return catalogs;
};

const collectInternalPackageVersions = (workspaceRoot: string, workspaceDirectories: string[]): Map<string, string> => {
    const versions = new Map<string, string>();

    for (const directory of workspaceDirectories) {
        const pkgPath = join(workspaceRoot, directory, "package.json");

        if (!isAccessibleSync(pkgPath)) {
            continue;
        }

        try {
            const pkg = readJsonSync(pkgPath) as { name?: string; version?: string };

            if (pkg.name && pkg.version) {
                versions.set(pkg.name, pkg.version);
            }
        } catch {
            // skip invalid package.json
        }
    }

    return versions;
};

/**
 * Find workspace-internal dependencies whose declared version range lags
 * behind the latest local workspace version. Used by `vis update` to bump
 * cross-package version pins (e.g. `"@visulima/fs": "5.0.0-alpha.13"`) to
 * match a freshly-released local version without waiting for the npm
 * registry to reflect the publish.
 *
 * Skips deps using non-version protocols (`workspace:`, `file:`, `link:`,
 * `catalog:`, `*`) since those resolve dynamically. Returns
 * {@link OutdatedEntry}s with composite catalog names (`{path}:{depType}`)
 * so {@link applyCatalogUpdates} routes them to per-package writes via
 * {@link applyPackageJsonUpdates}.
 */
const collectInternalOutdated = (workspaceRoot: string, options?: InternalOutdatedOptions): { ignored: string[]; outdated: OutdatedEntry[] } => {
    const rootPkgPath = join(workspaceRoot, "package.json");

    if (!isAccessibleSync(rootPkgPath)) {
        return { ignored: [], outdated: [] };
    }

    const rootPkg = readJsonSync(rootPkgPath) as {
        name?: string;
        workspaces?: string[] | { packages?: string[] };
    };

    let workspaceDirectories: string[] = [];
    const pnpmPatterns = readPnpmWorkspacePatterns(workspaceRoot);

    if (pnpmPatterns) {
        workspaceDirectories = resolveWorkspacePatterns(workspaceRoot, pnpmPatterns);
    } else {
        const workspacesField = rootPkg.workspaces;

        if (workspacesField) {
            const patterns = Array.isArray(workspacesField) ? workspacesField : workspacesField.packages;

            if (patterns) {
                workspaceDirectories = resolveWorkspacePatterns(workspaceRoot, patterns);
            }
        }
    }

    const internalVersions = collectInternalPackageVersions(workspaceRoot, workspaceDirectories);

    if (internalVersions.size === 0) {
        return { ignored: [], outdated: [] };
    }

    const depTypes = getDepTypesToInclude(options);
    const directoriesToScan = [".", ...workspaceDirectories];
    const include = options?.include ?? [];
    const exclude = options?.exclude ?? [];
    const ignore = options?.ignore ?? [];
    const target: UpdateTarget = options?.target ?? "latest";
    const ignoredSet = new Set<string>();
    const outdated: OutdatedEntry[] = [];

    for (const directory of directoriesToScan) {
        const pkgPath = directory === "." ? rootPkgPath : join(workspaceRoot, directory, "package.json");

        if (!isAccessibleSync(pkgPath)) {
            continue;
        }

        let pkg: Record<string, unknown>;

        try {
            pkg = readJsonSync(pkgPath) as Record<string, unknown>;
        } catch {
            continue;
        }

        for (const depType of depTypes) {
            const deps = depType.includes(".") ? getNestedField(pkg, depType) : (pkg[depType] as Record<string, string> | undefined);

            if (!deps || typeof deps !== "object") {
                continue;
            }

            for (const [name, range] of Object.entries(deps)) {
                const targetVersion = internalVersions.get(name);

                if (!targetVersion) {
                    continue;
                }

                if (
                    range.startsWith("workspace:")
                    || range.startsWith("file:")
                    || range.startsWith("link:")
                    || range.startsWith("catalog:")
                    || range.startsWith("$")
                    || range === "*"
                ) {
                    continue;
                }

                if (ignore.some((p) => matchesPattern(name, p))) {
                    ignoredSet.add(name);
                    continue;
                }

                if (!matchesFilters(name, include, exclude)) {
                    continue;
                }

                const currentParsed = parseVersion(range);
                const targetParsed = parseVersion(targetVersion);

                if (!currentParsed || !targetParsed) {
                    continue;
                }

                if (!isNewer(currentParsed, targetParsed)) {
                    continue;
                }

                const updateType = getUpdateType(currentParsed, targetParsed);

                if (updateType === "none") {
                    continue;
                }

                const effectiveTarget = resolvePackageTarget(name, target, options?.packageMode);

                if (effectiveTarget === "patch" && updateType !== "patch") {
                    continue;
                }

                if (effectiveTarget === "minor" && updateType === "major") {
                    continue;
                }

                const prefix = extractPrefix(range);

                outdated.push({
                    catalogName: `${directory}:${depType}`,
                    currentRange: range,
                    newRange: `${prefix}${targetVersion}`,
                    packageName: name,
                    targetVersion,
                    updateType,
                });
            }
        }
    }

    return { ignored: [...ignoredSet], outdated };
};

const toFilterArray = (value: string | string[] | undefined): string[] => {
    if (!value) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
};

const applyCatalogUpdates = (
    workspaceRoot: string,
    updates: OutdatedEntry[],
    packageManager?: string,
    backup = true,
    options: ApplyCatalogUpdatesOptions = {},
): string | undefined => {
    const { useEditorconfig } = options;
    let backupPath: string | undefined;

    if (backup) {
        backupPath = createBackup(workspaceRoot, packageManager, updates);
    }

    // Split updates into catalog entries and direct package.json entries
    const catalogUpdates: OutdatedEntry[] = [];
    const pkgJsonUpdates: OutdatedEntry[] = [];

    for (const update of updates) {
        if (parseCompositeCatalogName(update.catalogName)) {
            pkgJsonUpdates.push(update);
        } else {
            catalogUpdates.push(update);
        }
    }

    // Apply catalog updates via the appropriate provider
    if (catalogUpdates.length > 0) {
        if (packageManager === "npm" || packageManager === "yarn") {
            applyPackageJsonUpdates(workspaceRoot, catalogUpdates, useEditorconfig);
        } else if (packageManager === "bun") {
            applyBunCatalogUpdates(workspaceRoot, catalogUpdates, useEditorconfig);
        } else {
            applyPnpmCatalogUpdates(workspaceRoot, catalogUpdates);
        }
    }

    // Apply direct package.json version updates
    if (pkgJsonUpdates.length > 0) {
        applyPackageJsonUpdates(workspaceRoot, pkgJsonUpdates, useEditorconfig);
    }

    return backupPath;
};

export { applyCatalogUpdates, applyPackageJsonUpdates, collectInternalOutdated, hasCatalogs, hasPackageJsonDeps, readCatalogs, readPackageJsonDeps, toFilterArray };

export { createBackup, hasBackup, restoreFromBackup } from "./catalog/backup";
export { detectJsonIndent, parseBunCatalogs } from "./catalog/bun";
export { fetchChangelogInfo } from "./catalog/changelog";
export { parseCompositeCatalogName } from "./catalog/composite";
export { formatOutdatedJson, formatOutdatedMinimal, formatOutdatedTable, formatSummary, groupByCatalog } from "./catalog/format";
export { getRegistryForPackage, loadNpmrc, parseNpmrc } from "./catalog/npmrc";
export { fetchVulnerabilities } from "./catalog/osv";
export type { MaturityOptions } from "./catalog/outdated";
export { checkOutdated, findTargetVersion } from "./catalog/outdated";
export { matchesFilters, matchesPattern, resolvePackageTarget } from "./catalog/patterns";
export { parseCatalogsFromYaml } from "./catalog/pnpm-yaml";
export { promptPackageSelection } from "./catalog/prompt";
export { fetchPackageVersions } from "./catalog/registry";
export type { ApplyCatalogUpdatesOptions, CatalogCheckOptions, ChangelogInfo, CheckOutdatedResult, NpmrcConfig, OutdatedEntry, ReadCatalogOptions, SecurityVulnerability, SocketReport, UpdateTarget } from "./catalog/types";
export { extractPrefix, getUpdateType, isNewer, parseVersion } from "./catalog/version";
