import { isAccessibleSync, readFileSync } from "@visulima/fs";
import { join } from "@visulima/path";

import type { YamlSection } from "./types";

// sonarjs/regex-complexity -- cannot simplify without breaking YAML key:value parsing
// eslint-disable-next-line sonarjs/regex-complexity
const YAML_ENTRY_REGEX = /^(?:'([^']+)'|"([^"]+)"|([^:\s]+)):\s*(?:'([^']+)'|"([^"]+)"|(\S+))/;

const CATALOG_SECTION_REGEX = /^catalog:/m;

const CATALOGS_SECTION_REGEX = /^catalogs:/m;

export const QUOTES_TRIM_REGEX = /^['"]|['"]$/g;

const parseYamlEntry = (trimmed: string): [string, string] | undefined => {
    const match = YAML_ENTRY_REGEX.exec(trimmed);

    if (!match) {
        return undefined;
    }

    const key = match[1] ?? match[2] ?? match[3];
    const value = match[4] ?? match[5] ?? match[6];

    if (!key || !value) {
        return undefined;
    }

    return [key, value];
};

const setCatalogEntry = (catalogs: Map<string, Map<string, string>>, catalogName: string, key: string, value: string): void => {
    if (!catalogs.has(catalogName)) {
        catalogs.set(catalogName, new Map());
    }

    const catalog = catalogs.get(catalogName);

    if (catalog) {
        catalog.set(key, value);
    }
};

const parseCatalogSection = (catalogs: Map<string, Map<string, string>>, trimmed: string, indent: number): void => {
    if (indent < 2) {
        return;
    }

    const entry = parseYamlEntry(trimmed);

    if (entry) {
        setCatalogEntry(catalogs, "default", entry[0], entry[1]);
    }
};

const parseCatalogsSection = (catalogs: Map<string, Map<string, string>>, trimmed: string, indent: number, currentCatalogName: string): string => {
    if (indent === 2 && trimmed.endsWith(":")) {
        return trimmed.slice(0, -1).trim().replaceAll(QUOTES_TRIM_REGEX, "");
    }

    if (indent >= 4 && currentCatalogName) {
        const entry = parseYamlEntry(trimmed);

        if (entry) {
            setCatalogEntry(catalogs, currentCatalogName, entry[0], entry[1]);
        }
    }

    return currentCatalogName;
};

export const detectTopLevelSection = (trimmed: string): YamlSection => {
    if (trimmed === "catalog:" || trimmed.startsWith("catalog:")) {
        return "catalog";
    }

    if (trimmed === "catalogs:" || trimmed.startsWith("catalogs:")) {
        return "catalogs";
    }

    return "none";
};

export const parseCatalogsFromYaml = (content: string): Map<string, Map<string, string>> => {
    const catalogs = new Map<string, Map<string, string>>();

    let section: "catalog" | "catalogs" | "none" = "none";
    let currentCatalogName = "";

    for (const line of content.split("\n")) {
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;

        // Top-level keys (indent 0)
        if (indent === 0 && trimmed.length > 0 && !trimmed.startsWith("#")) {
            section = detectTopLevelSection(trimmed);

            if (section === "catalogs") {
                currentCatalogName = "";
            }

            continue;
        }

        if (trimmed.length === 0 || trimmed.startsWith("#")) {
            continue;
        }

        if (section === "catalog") {
            parseCatalogSection(catalogs, trimmed, indent);
        }

        if (section === "catalogs") {
            currentCatalogName = parseCatalogsSection(catalogs, trimmed, indent, currentCatalogName);
        }
    }

    return catalogs;
};

export const hasPnpmCatalogs = (workspaceRoot: string): boolean => {
    const filePath = join(workspaceRoot, "pnpm-workspace.yaml");

    if (!isAccessibleSync(filePath)) {
        return false;
    }

    const content = readFileSync(filePath);

    return CATALOG_SECTION_REGEX.test(content) || CATALOGS_SECTION_REGEX.test(content);
};

export const readPnpmCatalogs = (workspaceRoot: string): Map<string, Map<string, string>> => {
    const filePath = join(workspaceRoot, "pnpm-workspace.yaml");

    if (!isAccessibleSync(filePath)) {
        return new Map();
    }

    const content = readFileSync(filePath);

    return parseCatalogsFromYaml(content);
};
