import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

import { ensureDirSync, isAccessibleSync, readFileSync } from "@visulima/fs";
import { join } from "@visulima/path";

import { resolveIndentForFile } from "../../util/editorconfig";
import { rewriteHuskyScript, VIS_HOOK_INSTALL } from "../migrate/constants";
import type { PackageManagerType } from "../migrate/types";
import type { InstallResult } from "./constants";
import { DEFAULT_HOOKS_DIRECTORY, HOOKS } from "./constants";
import { installHooks } from "./install";

const HUSKY_DIRECTORIES = [".husky", ".config/husky"];

const COMMON_SH_SOURCE_RE = /^\. "\$\(dirname "\$0"\)\/common\.sh"\s*/m;

const HUSKY_SH_SOURCE_RE = /^\. "\$\(dirname "\$0"\)\/_\/husky\.sh"\s*/m;

/**
 * Detects which husky directory is in use, if any.
 */
const detectHuskyDirectory = (root: string): string | undefined => {
    for (const directory of HUSKY_DIRECTORIES) {
        if (isAccessibleSync(join(root, directory)) && statSync(join(root, directory)).isDirectory()) {
            return directory;
        }
    }

    return undefined;
};

/**
 * Reads user-defined hook scripts from a husky directory.
 * Returns only actual hook files (skips `_/`, `common.sh`, and non-hook files).
 */
const readHuskyHooks = (root: string, huskyDirectory: string): Map<string, string> => {
    const hooks = new Map<string, string>();
    const fullPath = join(root, huskyDirectory);
    const hookNames = new Set<string>(HOOKS);

    for (const entry of readdirSync(fullPath)) {
        if (entry === "_" || entry === ".gitignore" || entry.startsWith(".")) {
            continue;
        }

        const entryPath = join(fullPath, entry);

        if (!statSync(entryPath).isFile()) {
            continue;
        }

        // Only migrate known hook names and common.sh
        if (!hookNames.has(entry) && entry !== "common.sh") {
            continue;
        }

        hooks.set(entry, readFileSync(entryPath));
    }

    return hooks;
};

/**
 * Transforms a husky hook script for vis.
 * Removes husky's own `_/husky.sh` sourcing, which vis never provides. The
 * `common.sh` sourcing line stays when `keepCommonSh` is set, because the
 * migrated copy is written next to the hooks and resolves via `$0`. Otherwise
 * that line would point at nothing and is removed.
 */
const transformHookScript = (content: string, keepCommonSh = false): string => {
    const withoutHusky = content.replace(HUSKY_SH_SOURCE_RE, "");

    return keepCommonSh ? withoutHusky : withoutHusky.replace(COMMON_SH_SOURCE_RE, "");
};

/**
 * Detects the package manager used in the project.
 */
const detectPackageManager = (root: string): PackageManagerType => {
    if (isAccessibleSync(join(root, "pnpm-lock.yaml")) || isAccessibleSync(join(root, "pnpm-workspace.yaml"))) {
        return "pnpm";
    }

    if (isAccessibleSync(join(root, "yarn.lock"))) {
        return "yarn";
    }

    if (isAccessibleSync(join(root, "bun.lockb")) || isAccessibleSync(join(root, "bun.lock"))) {
        return "bun";
    }

    return "npm";
};

/**
 * Uninstalls the husky package via the detected package manager.
 */
const uninstallHuskyPackage = (root: string, logger: Console): boolean => {
    const packageManager = detectPackageManager(root);

    const removeCommands: Record<string, string[]> = {
        bun: ["bun", "remove", "husky"],
        npm: ["npm", "uninstall", "husky"],
        pnpm: ["pnpm", "remove", "husky"],
        yarn: ["yarn", "remove", "husky"],
    };

    const [command, ...spawnArgs] = removeCommands[packageManager] as [string, ...string[]];

    logger.info(`Removing husky package via ${packageManager}...`);

    const result = spawnSync(command, spawnArgs, {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
    });

    if (result.status !== 0) {
        logger.info(`Warning: failed to remove husky via ${packageManager} (${result.stderr?.trim() ?? "unknown error"})`);

        return false;
    }

    return true;
};

/**
 * Process a single script entry and apply husky cleanup.
 * Returns a description of the change, or undefined if unchanged.
 */
const processScript = (scripts: Record<string, string>, scriptName: string, scriptValue: string, installCommand: string): string | undefined => {
    const rewritten = rewriteHuskyScript(scriptValue, installCommand);

    if (rewritten === scriptValue) {
        return undefined;
    }

    scripts[scriptName] = rewritten;

    return scriptValue.includes(VIS_HOOK_INSTALL)
        ? `updated "${scriptName}" script`
        : `replaced husky with "${installCommand}" in "${scriptName}" script`;
};

/**
 * Replaces husky install calls in package.json scripts with `vis hook install`.
 */
const cleanPackageJsonScripts = (
    root: string,
    useEditorconfig?: boolean,
    hooksDirectory: string = DEFAULT_HOOKS_DIRECTORY,
): { modified: boolean; removedScriptReferences: string[] } => {
    // Installs into a custom hooks directory must say so, or the next `vis hook install` moves core.hooksPath back to the default.
    const installCommand = hooksDirectory === DEFAULT_HOOKS_DIRECTORY ? VIS_HOOK_INSTALL : `${VIS_HOOK_INSTALL} --hooks-dir ${hooksDirectory}`;

    const packageJsonPath = join(root, "package.json");

    if (!isAccessibleSync(packageJsonPath)) {
        return { modified: false, removedScriptReferences: [] };
    }

    const content: string = readFileSync(packageJsonPath);
    const packageJson = JSON.parse(content) as Record<string, unknown>;
    const removedScriptReferences: string[] = [];
    const scripts = packageJson["scripts"] as Record<string, string> | undefined;

    if (scripts) {
        for (const [scriptName, scriptValue] of Object.entries(scripts)) {
            if (typeof scriptValue !== "string") {
                continue;
            }

            const change = processScript(scripts, scriptName, scriptValue, installCommand);

            if (change) {
                removedScriptReferences.push(change);
            }
        }
    }

    if (removedScriptReferences.length > 0) {
        const indent = resolveIndentForFile(packageJsonPath, content, { defaultIndent: "    ", useEditorconfig });

        writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, undefined, indent)}\n`, "utf8");
    }

    return { modified: removedScriptReferences.length > 0, removedScriptReferences };
};

/**
 * Migrates from husky to vis hooks.
 */
interface HuskyMigrateOptions {
    dryRun?: boolean;
    useEditorconfig?: boolean;
}

const migrateFromHusky = (root: string, hooksDirectory: string, logger: Console, options: HuskyMigrateOptions = {}): InstallResult => {
    const huskyDirectory = detectHuskyDirectory(root);
    const dryRun = options.dryRun === true;

    if (!huskyDirectory) {
        return { isError: true, message: "No husky installation found (.husky/ or .config/husky/)" };
    }

    logger.info(`Found husky at ${huskyDirectory}/`);

    const huskyHooks = readHuskyHooks(root, huskyDirectory);

    if (huskyHooks.size === 0) {
        logger.info("No user-defined hooks found in husky directory.");
    }

    if (!dryRun) {
        const checkResult = spawnSync("git", ["config", "--local", "core.hooksPath"]);
        const existingPath = checkResult.status === 0 ? checkResult.stdout?.toString().trim() : "";

        if (existingPath && (existingPath === ".husky/_" || existingPath.startsWith(".husky"))) {
            spawnSync("git", ["config", "--local", "--unset", "core.hooksPath"]);
        }

        const installResult = installHooks(hooksDirectory);

        if (installResult.isError) {
            return installResult;
        }

        if (installResult.message) {
            if (installResult.isWarning) {
                logger.warn(installResult.message);
            } else {
                logger.info(installResult.message);
            }
        }
    }

    const targetDirectory = join(root, hooksDirectory);

    if (!dryRun) {
        ensureDirSync(targetDirectory);
    }

    let migratedCount = 0;

    for (const [hookName, content] of huskyHooks) {
        if (hookName === "common.sh") {
            if (dryRun) {
                logger.info(`  (would copy) common.sh`);
            } else {
                writeFileSync(join(targetDirectory, hookName), content, { mode: 0o755 });
                logger.info("  Copied common.sh");
            }

            continue;
        }

        if (dryRun) {
            logger.info(`  (would migrate) ${hookName}`);
        } else {
            const transformed = transformHookScript(content, huskyHooks.has("common.sh"));

            writeFileSync(join(targetDirectory, hookName), transformed, { mode: 0o755 });
            logger.info(`  Migrated ${hookName}`);
        }

        migratedCount += 1;
    }

    if (dryRun) {
        logger.info(`  (would remove) husky npm package`);
        logger.info(`  (would replace) husky install calls in package.json scripts with "${VIS_HOOK_INSTALL}"`);
        logger.info(`  (would remove) ${huskyDirectory}/ directory`);
    } else {
        uninstallHuskyPackage(root, logger);

        const packageResult = cleanPackageJsonScripts(root, options.useEditorconfig, hooksDirectory);

        if (packageResult.modified) {
            logger.info("Updated package.json scripts:");

            for (const reference of packageResult.removedScriptReferences) {
                logger.info(`  ${reference}`);
            }
        }

        const huskyFullPath = join(root, huskyDirectory);

        rmSync(huskyFullPath, { force: true, recursive: true });
        logger.info(`Removed ${huskyDirectory}/`);
    }

    const verb = dryRun ? "would migrate" : "Migration complete:";

    return {
        isError: false,
        message: `${verb} ${migratedCount} hook${migratedCount === 1 ? "" : "s"} ${dryRun ? "from" : "migrated from"} ${huskyDirectory}/ to ${hooksDirectory}/`,
    };
};

export { cleanPackageJsonScripts, detectHuskyDirectory, detectPackageManager, migrateFromHusky, transformHookScript };
