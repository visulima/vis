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
 * `module-replacements` manifest shape (v3.4+): every manifest holds a `replacements` record (what a package can be
 * swapped for, keyed by id) and a `mappings` record (which package maps to which replacement ids).
 */
type KnownUrl = string | { id: string; type: "e18e" | "mdn" | "node" };

interface E18eReplacement {
    description?: string;
    engines?: { engine: string; minVersion?: string }[];
    id: string;
    replacementModule?: string;
    type: "documented" | "native" | "removal" | "simple";
    url?: KnownUrl;
}

interface E18eMapping {
    moduleName: string;
    replacements: string[];
    type: "module";
    url?: KnownUrl;
}

interface E18eManifest {
    mappings: Record<string, E18eMapping>;
    replacements: Record<string, E18eReplacement>;
}

// Upstream e18e module-replacements docs — slug-keyed markdown files.
const E18E_DOC_BASE_URL = "https://github.com/es-tooling/module-replacements/blob/main/docs/modules";

const KNOWN_URL_BASES = { e18e: `${E18E_DOC_BASE_URL}/`, mdn: "https://developer.mozilla.org/en-US/docs/", node: "https://nodejs.org/" } as const;

const knownUrlToString = (url: KnownUrl | undefined): string | undefined => {
    if (!url) {
        return undefined;
    }

    if (typeof url === "string") {
        return url;
    }

    return `${KNOWN_URL_BASES[url.type]}${url.id}${url.type === "e18e" ? ".md" : ""}`;
};

/**
 * Builds a human-readable replacement hint for one replacement a mapping points at.
 * Each variant carries its guidance under a different key.
 */
const e18eReplacementHint = (replacement: E18eReplacement): string => {
    if (replacement.type === "simple") {
        return replacement.description ?? "";
    }

    if (replacement.type === "native") {
        const minNode = replacement.engines?.find((engine) => engine.engine === "nodejs")?.minVersion;
        const suffix = minNode ? ` (Node ${minNode}+)` : "";

        return `${replacement.id}${suffix}`;
    }

    if (replacement.type === "documented") {
        return replacement.replacementModule ?? "";
    }

    // `removal`: the package is not needed at all.
    return "no longer needed";
};

/**
 * Scans deps against e18e module-replacements manifests. Without `allDeps` it lists every entry the manifests
 * hold, which is what the native `vis optimize` embeds (`native-tables.ts`).
 */
export const buildE18eEntries = (allDeps?: Set<string>): OptimizeEntry[] => {
    const entries: OptimizeEntry[] = [];

    const scanManifest = (manifest: E18eManifest, category: "micro-utility" | "native" | "preferred"): void => {
        const { mappings, replacements } = manifest;

        if (!mappings || !replacements) {
            return;
        }

        for (const mapping of Object.values(mappings)) {
            if (allDeps && !allDeps.has(mapping.moduleName)) {
                continue;
            }

            const targets = mapping.replacements.map((id) => replacements[id]).filter((target): target is E18eReplacement => target !== undefined);

            entries.push({
                category,
                docUrl: knownUrlToString(mapping.url ?? targets.find((target) => target.url)?.url),
                hasCodemod: false, // filled in below
                overrideSpec: undefined,
                packageName: mapping.moduleName,
                replacement: [...new Set(targets.map((target) => e18eReplacementHint(target)).filter(Boolean))].join(", "),
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
