import { DEFAULT_CONFIG } from "../../config";
import type { VisReleaseConfig } from "../../types";

const mergeConfig = (...sources: VisReleaseConfig[]): VisReleaseConfig => {
    let merged: VisReleaseConfig = { ...DEFAULT_CONFIG };

    for (const source of sources) {
        merged = { ...merged, ...source };
    }

    return merged;
};

/**
 * Load the `release` block of vis.config.ts and merge it, over the
 * defaults, with the inline config override.
 */
export const loadReleaseConfig = async (cwd: string, inlineConfig: VisReleaseConfig | undefined): Promise<VisReleaseConfig> => {
    // Load vis.config.ts → extract `release` block → merge with inline options.
    // Missing config is fine (treat as empty); a present-but-broken config must
    // surface so we don't silently version/publish with the wrong settings.
    let fileConfig: VisReleaseConfig = {};

    try {
        const { loadVisConfig } = await import("../../../config/config");
        const visConfig = await loadVisConfig(cwd);

        if (visConfig.release) {
            fileConfig = visConfig.release;
        }
    } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        const message = (error as Error).message ?? "";
        const isMissing = code === "ENOENT" || code === "MODULE_NOT_FOUND" || /cannot find module/i.test(message);

        if (!isMissing) {
            throw error;
        }
    }

    return mergeConfig(fileConfig, inlineConfig ?? {});
};
