import { findCacheDirSync } from "@visulima/find-cache-dir";
import { ensureDirSync, isAccessibleSync, readFileSync, removeSync, walkSync, writeFileSync } from "@visulima/fs";
import { basename, dirname, join } from "@visulima/path";

import { parseCompositeCatalogName } from "./composite";
import type { OutdatedEntry } from "./types";

/**
 * Returns the backup directory inside node_modules/.cache/vis/backup.
 * Throws if the cache directory cannot be resolved (e.g., no node_modules).
 */
const getBackupDir = (workspaceRoot: string): string => {
    const cacheDir = findCacheDirSync("vis", { create: true, cwd: workspaceRoot });

    if (!cacheDir) {
        throw new Error("Cannot resolve cache directory. Ensure node_modules exists in your workspace. Run your package manager's install command first.");
    }

    return join(cacheDir, "backup");
};

const getCatalogFilePath = (workspaceRoot: string, packageManager?: string): string => {
    if (packageManager === "bun") {
        return join(workspaceRoot, "package.json");
    }

    return join(workspaceRoot, "pnpm-workspace.yaml");
};

const createPackageJsonBackup = (workspaceRoot: string, updates: OutdatedEntry[]): string | undefined => {
    const backupDirectory = getBackupDir(workspaceRoot);
    const filesToBackup = new Set<string>();

    for (const update of updates) {
        const parsed = parseCompositeCatalogName(update.catalogName);

        if (parsed) {
            filesToBackup.add(parsed.relativePath === "." ? "package.json" : join(parsed.relativePath, "package.json"));
        }
    }

    if (filesToBackup.size === 0) {
        return undefined;
    }

    ensureDirSync(backupDirectory);

    for (const relativePath of filesToBackup) {
        const sourcePath = join(workspaceRoot, relativePath);

        if (isAccessibleSync(sourcePath)) {
            const destinationPath = join(backupDirectory, relativePath);
            const destinationDirectory = dirname(destinationPath);

            ensureDirSync(destinationDirectory);
            writeFileSync(destinationPath, readFileSync(sourcePath));
        }
    }

    return backupDirectory;
};

/**
 * Returns the cached backup path for the catalog source file (pnpm/bun).
 * The .bak lives inside node_modules/.cache/vis/backup/ so it's already
 * gitignored alongside the per-package backups.
 */
const getCatalogBackupPath = (workspaceRoot: string, packageManager?: string): string => {
    const filePath = getCatalogFilePath(workspaceRoot, packageManager);
    const backupDirectory = getBackupDir(workspaceRoot);

    return join(backupDirectory, `${basename(filePath)}.bak`);
};

export const createBackup = (workspaceRoot: string, packageManager?: string, updates?: OutdatedEntry[]): string | undefined => {
    if ((packageManager === "npm" || packageManager === "yarn") && updates) {
        return createPackageJsonBackup(workspaceRoot, updates);
    }

    let catalogBackupPath: string | undefined;

    const filePath = getCatalogFilePath(workspaceRoot, packageManager);

    if (isAccessibleSync(filePath)) {
        catalogBackupPath = getCatalogBackupPath(workspaceRoot, packageManager);
        ensureDirSync(dirname(catalogBackupPath));
        writeFileSync(catalogBackupPath, readFileSync(filePath));
    }

    // Also backup package.json files that have direct (non-catalog) deps
    if (updates) {
        const pkgJsonUpdates = updates.filter((u) => parseCompositeCatalogName(u.catalogName));

        if (pkgJsonUpdates.length > 0) {
            createPackageJsonBackup(workspaceRoot, pkgJsonUpdates);
        }
    }

    return catalogBackupPath;
};

const restorePackageJsonBackup = (workspaceRoot: string): boolean => {
    const backupDirectory = getBackupDir(workspaceRoot);

    if (!isAccessibleSync(backupDirectory)) {
        return false;
    }

    for (const entry of walkSync(backupDirectory, { includeDirs: false })) {
        const relativePath = entry.path.slice(backupDirectory.length + 1);
        const destinationPath = join(workspaceRoot, relativePath);

        writeFileSync(destinationPath, readFileSync(entry.path));
    }

    removeSync(backupDirectory);

    return true;
};

export const restoreFromBackup = (workspaceRoot: string, packageManager?: string): boolean => {
    if (packageManager === "npm" || packageManager === "yarn") {
        return restorePackageJsonBackup(workspaceRoot);
    }

    const filePath = getCatalogFilePath(workspaceRoot, packageManager);
    const backupPath = getCatalogBackupPath(workspaceRoot, packageManager);

    if (!isAccessibleSync(backupPath)) {
        return false;
    }

    const content = readFileSync(backupPath);

    writeFileSync(filePath, content);

    return true;
};

export const hasBackup = (workspaceRoot: string, packageManager?: string): boolean => {
    if (packageManager === "npm" || packageManager === "yarn") {
        try {
            const backupDir = getBackupDir(workspaceRoot);

            return isAccessibleSync(backupDir);
        } catch {
            return false;
        }
    }

    try {
        return isAccessibleSync(getCatalogBackupPath(workspaceRoot, packageManager));
    } catch {
        return false;
    }
};
