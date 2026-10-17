import { isAccessibleSync, readJsonSync, writeJsonSync } from "@visulima/fs";
import { join } from "@visulima/path";

import { resolveIndentForExistingFile } from "../editorconfig";
import type { BunPackageJson, OutdatedEntry } from "./types";

const readPackageJsonSafe = (filePath: string): BunPackageJson | undefined => {
    if (!isAccessibleSync(filePath)) {
        return undefined;
    }

    try {
        return readJsonSync(filePath) as BunPackageJson;
    } catch {
        return undefined;
    }
};

export const hasBunCatalogs = (workspaceRoot: string): boolean => {
    const pkg = readPackageJsonSafe(join(workspaceRoot, "package.json"));

    return !!(pkg?.workspaces?.catalog || pkg?.workspaces?.catalogs);
};

export const parseBunCatalogs = (pkg: BunPackageJson): Map<string, Map<string, string>> => {
    const catalogs = new Map<string, Map<string, string>>();

    if (pkg.workspaces?.catalog && typeof pkg.workspaces.catalog === "object") {
        catalogs.set("default", new Map(Object.entries(pkg.workspaces.catalog)));
    }

    if (pkg.workspaces?.catalogs && typeof pkg.workspaces.catalogs === "object") {
        for (const [name, deps] of Object.entries(pkg.workspaces.catalogs)) {
            if (deps && typeof deps === "object") {
                catalogs.set(name, new Map(Object.entries(deps)));
            }
        }
    }

    return catalogs;
};

export const readBunCatalogs = (workspaceRoot: string): Map<string, Map<string, string>> => {
    const pkg = readPackageJsonSafe(join(workspaceRoot, "package.json"));

    if (!pkg) {
        return new Map();
    }

    return parseBunCatalogs(pkg);
};

export const applyBunCatalogUpdates = (workspaceRoot: string, updates: OutdatedEntry[], useEditorconfig?: boolean): void => {
    const filePath = join(workspaceRoot, "package.json");
    const pkg = readJsonSync(filePath) as BunPackageJson;

    for (const update of updates) {
        if (update.catalogName === "default") {
            if (pkg.workspaces?.catalog) {
                pkg.workspaces.catalog[update.packageName] = update.newRange;
            }
        } else {
            const catalogEntry = pkg.workspaces?.catalogs?.[update.catalogName];

            if (catalogEntry) {
                catalogEntry[update.packageName] = update.newRange;
            }
        }
    }

    writeJsonSync(filePath, pkg, { indent: resolveIndentForExistingFile(filePath, { useEditorconfig }), overwrite: true });
};
