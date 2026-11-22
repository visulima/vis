import { readFileSync } from "node:fs";

import { isAccessibleSync } from "@visulima/fs";
import { join, relative } from "@visulima/path";

import { VisUserError } from "../errors/vis-user-error";
import type { ModuleLoader, OxfmtConfig } from "./options";

/** Vite config files in the order Vite itself looks for them. */
export const VITE_CONFIG_FILES: ReadonlyArray<string> = ["vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];

/** A `fmt` key in the source: `fmt: …`, a shorthand `fmt,` / `fmt }`, or a quoted `"fmt": …`. Cheap enough to run on every Vite project. */
const FMT_KEY = /\bfmt\s*[,:}]|["']fmt["']\s*:/;

/**
 * Finds the Vite config in the workspace root that mentions a `fmt` key. The file is only read as text:
 * a Vite project without a `fmt` key never has its config evaluated by `vis fmt`.
 * @param root Workspace root.
 * @returns Absolute path of the Vite config, or `undefined` when none mentions `fmt`.
 */
export const findViteConfigFile = (root: string): string | undefined => {
    for (const name of VITE_CONFIG_FILES) {
        const file = join(root, name);

        if (!isAccessibleSync(file)) {
            continue;
        }

        try {
            if (FMT_KEY.test(readFileSync(file, "utf8"))) {
                return file;
            }
        } catch {
            // Unreadable: treated as absent, the same as a missing file.
        }
    }

    return undefined;
};

export interface ViteFmtResult {
    /** The `fmt` object of the config's default export; unset when the export has no such key. */
    config?: OxfmtConfig;
    warnings: string[];
}

/**
 * Reads the `fmt` key of a Vite config's default export as an oxfmt config.
 * The config is evaluated once, with the repo's JS/TS loader; a config that exports a function (a
 * `defineConfig(({ mode }) => …)`) cannot be evaluated without Vite's arguments and is skipped with a warning.
 * @param file Absolute path of the Vite config.
 * @param root Workspace root, to show the file relative to it.
 * @param loadModule Loads JS/TS modules.
 * @returns The `fmt` object, if there is one, and the warnings to print.
 * @throws {VisUserError} When the file cannot be loaded or its `fmt` key is not an object.
 */
export const readViteFmtConfig = async (file: string, root: string, loadModule: ModuleLoader): Promise<ViteFmtResult> => {
    const name = relative(root, file);
    let exported: unknown;

    try {
        const loaded = await loadModule(file);

        exported = loaded.default;
    } catch (error) {
        throw new VisUserError(`Could not load ${name} to read its fmt key: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (typeof exported === "function") {
        return { warnings: [`${name} exports a function, so its fmt key is not read. Export an object, or move the options to vis.config fmt.options.`] };
    }

    if (typeof exported !== "object" || exported === null || !("fmt" in exported)) {
        return { warnings: [] };
    }

    const { fmt } = exported;

    if (typeof fmt !== "object" || fmt === null || Array.isArray(fmt)) {
        throw new VisUserError(`${name}: the "fmt" key must be an object of oxfmt options.`);
    }

    return { config: fmt as OxfmtConfig, warnings: [] };
};
