import { getManifestData } from "@socketsecurity/registry";
import microUtilitiesManifest from "module-replacements/manifests/micro-utilities.json" with { type: "json" };
import nativeManifest from "module-replacements/manifests/native.json" with { type: "json" };
import preferredManifest from "module-replacements/manifests/preferred.json" with { type: "json" };
import { coerce } from "semver";

import type { PmInfo } from "../../pm/overrides";
import { lockfileContainsPackage } from "../../pm/overrides";
import type { OptimizeEntry } from "../../tui/components/optimize/optimize-store";

interface ManifestEntryData {
    categories?: string[];
    deprecated?: boolean;
    name: string;
    package: string;
    version: string;
}

type ManifestEntry = [string, ManifestEntryData];

/**
 * `module-replacements` manifest shape (v3+). The package was reshaped
 * to a single flat `moduleReplacements` array; entries fall into three
 * variants distinguished by `type`:
 *
 * - `simple` — inline replacement string
 * - `native` — replaceable with a built-in API at the given Node version
 * - `documented` — guidance lives at an external doc path
 */
interface E18eEntry {
    category?: string;
    docPath?: string;
    mdnPath?: string;
    moduleName: string;
    nodeVersion?: string;
    replacement?: string;
    type: "documented" | "native" | "simple";
}

interface E18eManifest {
    moduleReplacements: E18eEntry[];
}

// Upstream e18e module-replacements docs — slug-keyed markdown files.
const E18E_DOC_BASE_URL = "https://github.com/es-tooling/module-replacements/blob/main/docs/modules";

const buildE18eDocUrl = (docPath: string): string => `${E18E_DOC_BASE_URL}/${docPath}.md`;

/**
 * Builds a human-readable replacement hint for an e18e entry.
 * Each variant carries its replacement guidance under a different key.
 *
 * `documented` entries deliberately point at the migration guide rather than
 * echoing the bare `docPath` slug (which is sometimes the package name
 * itself — e.g. `chalk` → "See chalk", which reads as if the package were
 * its own replacement).
 */
const e18eReplacementHint = (entry: E18eEntry): string => {
    if (entry.type === "simple" && entry.replacement) {
        return entry.replacement;
    }

    if (entry.type === "native") {
        const minNode = entry.nodeVersion ? ` (Node ${entry.nodeVersion}+)` : "";

        return entry.replacement ? `${entry.replacement}${minNode}` : `Native API${minNode}`;
    }

    if (entry.type === "documented" && entry.docPath) {
        return "see migration guide";
    }

    return "";
};

/**
 * Scans deps against e18e module-replacements manifests. Without `allDeps` it lists every entry the manifests
 * hold, which is what the native `vis optimize` embeds (`native-tables.ts`).
 */
export const buildE18eEntries = (allDeps?: Set<string>): OptimizeEntry[] => {
    const entries: OptimizeEntry[] = [];

    const scanManifest = (manifest: E18eManifest, category: "micro-utility" | "native" | "preferred"): void => {
        const list = manifest.moduleReplacements;

        if (!Array.isArray(list)) {
            return;
        }

        for (const entry of list) {
            if (allDeps && !allDeps.has(entry.moduleName)) {
                continue;
            }

            entries.push({
                category,
                docUrl: entry.type === "documented" && entry.docPath ? buildE18eDocUrl(entry.docPath) : undefined,
                hasCodemod: false, // filled in below
                overrideSpec: undefined,
                packageName: entry.moduleName,
                replacement: e18eReplacementHint(entry),
            });
        }
    };

    scanManifest(nativeManifest as unknown as E18eManifest, "native");
    scanManifest(preferredManifest as unknown as E18eManifest, "preferred");
    scanManifest(microUtilitiesManifest as unknown as E18eManifest, "micro-utility");

    return entries;
};

/** Scans deps against `@socketregistry` manifest. */
export const buildSocketEntries = (allDeps: Set<string>, lockText: string, pm: PmInfo, pin: boolean): OptimizeEntry[] => {
    const manifest = (getManifestData("npm") ?? []) as ManifestEntry[];
    const entries: OptimizeEntry[] = [];

    for (const [, data] of manifest) {
        if (data.deprecated) {
            continue;
        }

        const inDeps = allDeps.has(data.package);
        const inLockfile = lockText ? lockfileContainsPackage(lockText, data.package, pm.name) : false;

        if (!inDeps && !inLockfile) {
            continue;
        }

        const major = coerce(data.version)?.major;

        if (major === undefined) {
            continue;
        }

        const spec = pin ? `npm:${data.name}@${data.version}` : `npm:${data.name}@^${String(major)}`;

        entries.push({
            category: "socket",
            hasCodemod: false,
            overrideSpec: spec,
            packageName: data.package,
            replacement: data.name,
        });
    }

    return entries;
};

type CodemodFactory = (options: Record<string, never>) => { transform: (options_: { file: { filename: string; source: string } }) => Promise<string> | string };

/** Cached codemods map — loaded once on first use. */
let cachedCodemods: Record<string, CodemodFactory> | undefined;

export const loadCodemods = async (): Promise<Record<string, CodemodFactory>> => {
    if (cachedCodemods) {
        return cachedCodemods;
    }

    try {
        const sdk = (await import("module-replacements-codemods")) as { codemods: Record<string, CodemodFactory> };

        cachedCodemods = sdk.codemods;

        return cachedCodemods;
    } catch {
        return {};
    }
};

/** Marks e18e entries that have codemods available. */
export const markCodemodAvailability = async (entries: OptimizeEntry[]): Promise<void> => {
    try {
        const codemods = await loadCodemods();

        for (const entry of entries) {
            if (entry.category !== "socket" && codemods[entry.packageName]) {
                entry.hasCodemod = true;
            }
        }
    } catch {
        // module-replacements-codemods not installed or failed
    }
};
