import { getManifestData } from "@socketsecurity/registry";

import type { PmInfo } from "../../pm/overrides";
import { buildE18eEntries, buildSocketEntries, markCodemodAvailability } from "./replacements";

/** The package manager the entries are built for. `buildSocketEntries` only reads it to search a lockfile, which stays empty here. */
const PM: PmInfo = { name: "pnpm", version: "latest" };

/**
 * The replacement data the native `vis optimize` (`native/cli/src/optimize/`) reports from, built by the same
 * functions the Node handler uses, for every package the manifests know. The native side keeps the entries whose
 * package is a dependency of the workspace, in this order, which is the Node filter.
 *
 * - `e18e`: the `module-replacements` entries, as `[category, package, replacement, hasCodemod]`. Empty while the
 *   installed manifests have no `moduleReplacements` list, which is the only shape the handler reads.
 * - `socket`: the `@socketregistry` overrides, as `[package, replacement, spec, pinnedSpec]`.
 */
export const buildNativeOptimizeTables = async (): Promise<{
    e18e: [string, string, string, boolean][];
    socket: [string, string, string, string][];
}> => {
    const manifest = (getManifestData("npm") ?? []) as [string, { package: string }][];
    const everything = new Set(manifest.map(([, data]) => data.package));
    const e18e = buildE18eEntries();

    await markCodemodAvailability(e18e);

    const socket = buildSocketEntries(everything, "", PM, false);
    const pinned = buildSocketEntries(everything, "", PM, true);

    return {
        e18e: e18e.map((entry) => [entry.category, entry.packageName, entry.replacement, entry.hasCodemod]),
        socket: socket.map((entry, index) => [entry.packageName, entry.replacement, entry.overrideSpec ?? "", pinned[index]?.overrideSpec ?? ""]),
    };
};

/** The text of `native/cli/src/optimize-tables.json`. */
export const renderNativeOptimizeTables = async (): Promise<string> => `${JSON.stringify(await buildNativeOptimizeTables(), undefined, 4)}\n`;
