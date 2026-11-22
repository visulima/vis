import { isAccessibleSync } from "@visulima/fs";
import { join, relative } from "@visulima/path";

import type { VisConfig } from "../config/types";
import { VisUserError } from "../errors/vis-user-error";
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

/** Globs are resolved against the workspace root, and oxfmt rejects one that climbs out of it. */
const assertInsideRoot = (location: string, patterns: ReadonlyArray<string>): void => {
    for (const pattern of patterns) {
        if (pattern.replace(/^!/, "").split(/[/\\]/).includes("..")) {
            throw new VisUserError(`vis.config ${location}: "${pattern}" must not contain "..". Patterns are relative to the workspace root.`);
        }
    }
};

const validateFmtGlobs = (fmtConfig: NonNullable<ResolveFmtOptionsInput["fmtConfig"]>): void => {
    assertInsideRoot("fmt.ignorePatterns", fmtConfig.ignorePatterns ?? []);

    for (const [index, override] of (fmtConfig.overrides ?? []).entries()) {
        assertInsideRoot(`fmt.overrides[${String(index)}].files`, [override.files].flat());
        assertInsideRoot(`fmt.overrides[${String(index)}].excludeFiles`, [override.excludeFiles ?? []].flat());
    }
};

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
 * @throws When the Prettier config is the chosen source but cannot be read, or a `vis.config` glob contains `..`.
 */
export const resolveFmtOptions = async ({ fmtConfig, loadModule, prettierDeclared = false, root }: ResolveFmtOptionsInput): Promise<FmtResolution> => {
    const oxfmtFile = findOxfmtConfigFile(root);
    const prettierFile = findPrettierConfigFile(root);
    const display = (file: string): string => relative(root, file);

    if (hasVisConfigOptions(fmtConfig)) {
        validateFmtGlobs(fmtConfig);

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

        warnings.push(...nestedConfigWarnings(root));

        warnings.push(...scopedWidthWarnings(scoped));

        return { config, file: found!.file, source: "prettier", warnings };
    }

    if (prettierDeclared) {
        // oxfmt defaults to 100 columns and sorts package.json; Prettier does neither. Same mapping as an empty config.
        const { scoped, universal } = readEditorconfigPrintWidth(root);
        const { config } = mapPrettierConfig({}, { editorconfigPrintWidth: universal });

        return { config, source: "prettier-defaults", warnings: [...scopedWidthWarnings(scoped), ...nestedConfigWarnings(root)] };
    }

    return { source: "defaults", warnings: nestedConfigWarnings(root) };
};

const scopedWidthWarnings = (scoped: ReadonlyArray<string>): string[] =>
    (scoped.length > 0 ? [`.editorconfig sets max_line_length only for ${scoped.join(", ")}; those sections are not applied.`] : []);

/** Prettier applies the nearest config to each file, so a config below the root changes formatting wherever it is not read. */
const nestedConfigWarnings = (root: string): string[] => {
    const nested = findNestedPrettierConfigs(root);

    if (nested.length === 0) {
        return [];
    }

    const more = nested.length > 1 ? ` and ${String(nested.length - 1)} more` : "";

    return [`Only the root Prettier config is read; ${relative(root, nested[0]!)}${more} in a subdirectory ${nested.length > 1 ? "are" : "is"} ignored.`];
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
