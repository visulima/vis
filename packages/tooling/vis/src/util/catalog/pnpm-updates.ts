import { readFileSync, writeFileSync } from "@visulima/fs";
import { join } from "@visulima/path";

import { detectTopLevelSection, QUOTES_TRIM_REGEX } from "./pnpm-yaml";
import type { OutdatedEntry, YamlSection } from "./types";

const REGEX_SPECIAL_CHARS_REGEX = /[.*+?^${}()|[\]\\]/g;

const buildLineMatchRegex = (packageName: string, range: string): RegExp => {
    const escapedName = packageName.replaceAll(REGEX_SPECIAL_CHARS_REGEX, String.raw`\$&`);
    const escapedRange = range.replaceAll(REGEX_SPECIAL_CHARS_REGEX, String.raw`\$&`);

    return new RegExp(String.raw`^(?:'${escapedName}'|"${escapedName}"|${escapedName}):\s*['"]?${escapedRange}['"]?`);
};

const lineMatchesPackage = (trimmed: string, packageName: string, range: string): boolean => {
    const regex = buildLineMatchRegex(packageName, range);

    return regex.test(trimmed);
};

const buildUpdateMap = (updates: OutdatedEntry[]): Map<string, Map<string, { newRange: string; oldRange: string }>> => {
    const updateMap = new Map<string, Map<string, { newRange: string; oldRange: string }>>();

    for (const update of updates) {
        if (!updateMap.has(update.catalogName)) {
            updateMap.set(update.catalogName, new Map());
        }

        const catalogMap = updateMap.get(update.catalogName);

        if (catalogMap) {
            catalogMap.set(update.packageName, {
                newRange: update.newRange,
                oldRange: update.currentRange,
            });
        }
    }

    return updateMap;
};

const applyLineUpdate = (line: string, trimmed: string, catalogUpdates: Map<string, { newRange: string; oldRange: string }> | undefined): string => {
    if (!catalogUpdates) {
        return line;
    }

    for (const [pkgName, { newRange, oldRange }] of catalogUpdates) {
        if (lineMatchesPackage(trimmed, pkgName, oldRange)) {
            return line.replace(oldRange, newRange);
        }
    }

    return line;
};

const processYamlLineForUpdate = (
    line: string,
    section: YamlSection,
    currentCatalogName: string,
    updateMap: Map<string, Map<string, { newRange: string; oldRange: string }>>,
): string => {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
        return line;
    }

    if (section === "catalog" && indent >= 2) {
        return applyLineUpdate(line, trimmed, updateMap.get("default"));
    }

    if (section === "catalogs" && indent >= 4 && currentCatalogName) {
        return applyLineUpdate(line, trimmed, updateMap.get(currentCatalogName));
    }

    return line;
};

export const applyPnpmCatalogUpdates = (workspaceRoot: string, updates: OutdatedEntry[]): void => {
    const filePath = join(workspaceRoot, "pnpm-workspace.yaml");
    const content = readFileSync(filePath);
    const lines = content.split("\n");
    const updateMap = buildUpdateMap(updates);

    let section: YamlSection = "none";
    let currentCatalogName = "";
    const result: string[] = [];

    for (const line of lines) {
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;

        if (indent === 0 && trimmed.length > 0 && !trimmed.startsWith("#")) {
            section = detectTopLevelSection(trimmed);

            if (section === "catalogs") {
                currentCatalogName = "";
            }
        }

        if (section === "catalogs" && indent === 2 && trimmed.endsWith(":")) {
            currentCatalogName = trimmed.slice(0, -1).trim().replaceAll(QUOTES_TRIM_REGEX, "");
        }

        result.push(processYamlLineForUpdate(line, section, currentCatalogName, updateMap));
    }

    writeFileSync(filePath, result.join("\n"));
};
