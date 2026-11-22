import { isAccessibleSync } from "@visulima/fs";
import { join, relative } from "@visulima/path";

import type { VisConfig } from "../config/types";
import type { FmtConfigSourceKind, ModuleLoader, OxfmtConfig } from "./options";
import { OXFMT_DISCOVERED_CONFIG_FILES } from "./options";
import { findNestedPrettierConfigs, findPrettierConfigFile, mapPrettierConfig, readEditorconfigPrintWidth, readPrettierConfig, readPrettierIgnore } from "./prettier-config";

export interface ResolveFmtOptionsInput {
    /** `vis.config` `fmt` section. */
    fmtConfig?: NonNullable<VisConfig["fmt"]>;
    loadModule: ModuleLoader;

    /** Prettier is declared or detected in the workspace, with or without a config file. */
    prettierDeclared?: boolean;
    root: string;
}

export interface FmtResolution {
    /**
     * The config vis hands to oxfmt. Set for `vis.config` and Prettier; unset when oxfmt finds
     * its own config (`oxfmtrc`) or runs on its defaults.
     */
    config?: OxfmtConfig;
    /** The config file the source is, when it is a file. */
    file?: string;
    source: FmtConfigSourceKind;
    warnings: string[];
}

const hasVisConfigOptions = (fmtConfig: ResolveFmtOptionsInput["fmtConfig"]): fmtConfig is NonNullable<ResolveFmtOptionsInput["fmtConfig"]> =>
    fmtConfig !== undefined && (fmtConfig.options !== undefined || fmtConfig.overrides !== undefined || fmtConfig.ignorePatterns !== undefined);

const findOxfmtConfigFile = (root: string): string | undefined => {
    const name = OXFMT_DISCOVERED_CONFIG_FILES.find((candidate) => isAccessibleSync(join(root, candidate)));

    return name === undefined ? undefined : join(root, name);
};

/**
 * Picks where the bundled oxfmt gets its options. The first source that exists is used whole, in this
 * order: `vis.config` `fmt.options` (with `fmt.overrides` and `fmt.ignorePatterns`), an oxfmt config
 * file, a Prettier config, oxfmt's defaults (Prettier's, when Prettier is declared but has no config,
 * so its 80-column width is kept). Sources are never merged. An `.oxfmtrc` or `oxfmt.config.*`
 * is only detected: oxfmt reads it itself.
 * @param input The `fmt` config, the workspace root and the JS/TS config loader.
 * @param input.fmtConfig `vis.config` `fmt` section.
 * @param input.loadModule Loads JS/TS Prettier configs.
 * @param input.prettierDeclared Whether Prettier is declared or detected, config file or not.
 * @param input.root Workspace root.
 * @returns The chosen source with the config to hand to oxfmt (if vis has to), and the warnings to print.
 * @throws When the Prettier config is the chosen source but cannot be read.
 */
export const resolveFmtOptions = async ({ fmtConfig, loadModule, prettierDeclared = false, root }: ResolveFmtOptionsInput): Promise<FmtResolution> => {
    const oxfmtFile = findOxfmtConfigFile(root);
    const prettierFile = findPrettierConfigFile(root);
    const display = (file: string): string => relative(root, file);

    if (hasVisConfigOptions(fmtConfig)) {
        const ignored = [oxfmtFile, prettierFile].filter((file): file is string => file !== undefined).map((file) => display(file));
        const config: Record<string, unknown> = { ...fmtConfig.options };

        if (fmtConfig.overrides !== undefined) {
            config.overrides = [...fmtConfig.overrides];
        }

        if (fmtConfig.ignorePatterns !== undefined) {
            config.ignorePatterns = [...fmtConfig.ignorePatterns];
        }

        return {
            config,
            source: "vis.config",
            warnings: ignored.length > 0 ? [ignoredWarning("vis.config fmt.options", ignored)] : [],
        };
    }

    if (oxfmtFile !== undefined) {
        return {
            file: oxfmtFile,
            source: "oxfmtrc",
            warnings: prettierFile === undefined ? [] : [ignoredWarning(display(oxfmtFile), [display(prettierFile)])],
        };
    }

    if (prettierFile !== undefined) {
        const found = await readPrettierConfig(root, loadModule);
        const { scoped, universal } = readEditorconfigPrintWidth(root);
        const { config, warnings } = mapPrettierConfig(found!.config, {
            editorconfigPrintWidth: universal,
            ignorePatterns: readPrettierIgnore(root),
            sourceFile: found!.file,
        });

        const nested = findNestedPrettierConfigs(root);

        if (nested.length > 0) {
            const [first] = nested;
            const more = nested.length > 1 ? ` and ${String(nested.length - 1)} more` : "";

            warnings.push(`Only the root Prettier config is read; ${display(first!)}${more} in a subdirectory ${nested.length > 1 ? "are" : "is"} ignored.`);
        }

        if (scoped.length > 0) {
            warnings.push(`.editorconfig sets max_line_length only for ${scoped.join(", ")}; those sections are not applied.`);
        }

        return { config, file: found!.file, source: "prettier", warnings };
    }

    if (prettierDeclared) {
        // oxfmt defaults to 100 columns and sorts package.json; Prettier does neither. Same mapping as an empty config.
        const { scoped, universal } = readEditorconfigPrintWidth(root);
        const { config } = mapPrettierConfig({}, { editorconfigPrintWidth: universal });
        const warnings = scoped.length > 0 ? [`.editorconfig sets max_line_length only for ${scoped.join(", ")}; those sections are not applied.`] : [];

        return { config, source: "prettier-defaults", warnings };
    }

    return { source: "defaults", warnings: [] };
};

const ignoredWarning = (used: string, ignored: ReadonlyArray<string>): string =>
    `Formatting options come from ${used}; ${ignored.join(" and ")} found but not used (the first source that exists is used whole: vis.config fmt.options, then .oxfmtrc.json / oxfmt.config.ts, then the Prettier config).`;

/**
 * Names the winning source for the "formatting with …" notice.
 * @param resolution The resolved source.
 * @param root Workspace root, to show the config file relative to it.
 * @returns A short label.
 */
export const describeFmtSource = (resolution: FmtResolution, root: string): string => {
    switch (resolution.source) {
        case "defaults": {
            return "oxfmt defaults";
        }
        case "oxfmtrc": {
            return relative(root, resolution.file!);
        }
        case "prettier": {
            return `${relative(root, resolution.file!)} (mapped to oxfmt options)`;
        }
        case "prettier-defaults": {
            return "Prettier's defaults (Prettier is declared but has no config)";
        }
        default: {
            return "vis.config fmt.options";
        }
    }
};
