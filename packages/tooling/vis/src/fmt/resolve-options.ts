import { isAccessibleSync } from "@visulima/fs";
import { join, relative } from "@visulima/path";

import type { VisConfig } from "../config/types";
import { VisUserError } from "../errors/vis-user-error";
import type { FmtConfigSourceKind, FmtIgnoredSource, ModuleLoader, OxfmtConfig } from "./options";
import { OXFMT_DISCOVERED_CONFIG_FILES } from "./options";
import { findNestedPrettierConfigs, findPrettierConfigFile, mapPrettierConfig, readEditorconfigPrintWidth, readPrettierConfig, readPrettierIgnore } from "./prettier-config";
import { findViteConfigFile, readViteFmtConfig } from "./vite-config";

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
    /** Sources that exist but lose to the winner, highest first. Detected, never read. */
    ignored: FmtIgnoredSource[];
    source: FmtConfigSourceKind;
    warnings: string[];
}

const hasVisConfigOptions = (fmtConfig: ResolveFmtOptionsInput["fmtConfig"]): fmtConfig is NonNullable<ResolveFmtOptionsInput["fmtConfig"]> =>
    fmtConfig !== undefined && (fmtConfig.options !== undefined || fmtConfig.overrides !== undefined || fmtConfig.ignorePatterns !== undefined);

/** Globs are resolved against the workspace root, and oxfmt rejects one that climbs out of it. */
const assertInsideRoot = (origin: string, location: string, patterns: ReadonlyArray<string>): void => {
    for (const pattern of patterns) {
        if (pattern.replace(/^!/, "").split(/[/\\]/).includes("..")) {
            throw new VisUserError(`${origin} ${location}: "${pattern}" must not contain "..". Patterns are relative to the workspace root.`);
        }
    }
};

const validateGlobs = (origin: string, config: { ignorePatterns?: ReadonlyArray<string>; overrides?: ReadonlyArray<{ excludeFiles?: string | string[]; files: string | string[] }> }): void => {
    assertInsideRoot(origin, "fmt.ignorePatterns", config.ignorePatterns ?? []);

    for (const [index, override] of (config.overrides ?? []).entries()) {
        assertInsideRoot(origin, `fmt.overrides[${String(index)}].files`, [override.files].flat());
        assertInsideRoot(origin, `fmt.overrides[${String(index)}].excludeFiles`, [override.excludeFiles ?? []].flat());
    }
};

const findOxfmtConfigFile = (root: string): string | undefined => {
    const name = OXFMT_DISCOVERED_CONFIG_FILES.find((candidate) => isAccessibleSync(join(root, candidate)));

    return name === undefined ? undefined : join(root, name);
};

/**
 * Picks where the bundled oxfmt gets its options. The first source that exists is used whole, in this
 * order: `vis.config` `fmt.options` (with `fmt.overrides` and `fmt.ignorePatterns`), an oxfmt config
 * file or the `fmt` key of a Vite config (oxfmt does not read the latter outside the Vite+ toolchain, so
 * vis evaluates it; an oxfmt file wins over it), a Prettier config, oxfmt's defaults (Prettier's, when Prettier is declared but has no config,
 * so its 80-column width is kept). Sources are never merged. An `.oxfmtrc` or `oxfmt.config.*`
 * is only detected: oxfmt reads it itself.
 * @param input The `fmt` config, the workspace root and the JS/TS config loader.
 * @param input.fmtConfig `vis.config` `fmt` section.
 * @param input.loadModule Loads JS/TS Prettier configs.
 * @param input.prettierDeclared Whether Prettier is declared or detected, config file or not.
 * @param input.root Workspace root.
 * @returns The chosen source with the config to hand to oxfmt (if vis has to), and the warnings to print.
 * @throws When the Prettier config or the Vite `fmt` key is the chosen source but cannot be read, or a glob of `vis.config` or the Vite `fmt` key contains `..`.
 */
export const resolveFmtOptions = async ({ fmtConfig, loadModule, prettierDeclared = false, root }: ResolveFmtOptionsInput): Promise<FmtResolution> => {
    const oxfmtFile = findOxfmtConfigFile(root);
    const viteFile = findViteConfigFile(root);
    const prettierFile = findPrettierConfigFile(root);
    const display = (file: string): string => relative(root, file);
    const lower = (...candidates: (FmtIgnoredSource | undefined)[]): FmtIgnoredSource[] => candidates.filter((candidate): candidate is FmtIgnoredSource => candidate !== undefined);
    const oxfmtSource = oxfmtFile === undefined ? undefined : { file: oxfmtFile, source: "oxfmtrc" as const };
    const viteSource = viteFile === undefined ? undefined : { file: viteFile, source: "vite-config" as const };
    const prettierSource = prettierFile === undefined ? undefined : { file: prettierFile, source: "prettier" as const };

    if (hasVisConfigOptions(fmtConfig)) {
        validateGlobs("vis.config", fmtConfig);

        const ignored = lower(oxfmtSource, viteSource, prettierSource);
        const config: Record<string, unknown> = { ...fmtConfig.options };

        if (fmtConfig.overrides !== undefined) {
            config.overrides = [...fmtConfig.overrides];
        }

        if (fmtConfig.ignorePatterns !== undefined) {
            config.ignorePatterns = [...fmtConfig.ignorePatterns];
        }

        return {
            config,
            ignored,
            source: "vis.config",
            warnings: ignored.length > 0 ? [ignoredWarning("vis.config fmt.options", ignored.map(({ file }) => display(file)))] : [],
        };
    }

    // An oxfmt config file and the fmt key of a Vite config are one source: the oxfmt file wins, being oxfmt's own.
    if (oxfmtFile !== undefined) {
        const ignored = lower(viteSource, prettierSource);

        return {
            file: oxfmtFile,
            ignored,
            source: "oxfmtrc",
            warnings: ignored.length === 0 ? [] : [ignoredWarning(display(oxfmtFile), ignored.map(({ file }) => display(file)))],
        };
    }

    if (viteFile !== undefined) {
        const { config, warnings } = await readViteFmtConfig(viteFile, root, loadModule);

        if (config !== undefined) {
            validateGlobs(display(viteFile), config);

            const ignored = lower(prettierSource);

            return {
                config,
                file: viteFile,
                ignored,
                source: "vite-config",
                warnings: [...warnings, ...(ignored.length === 0 ? [] : [ignoredWarning(`the fmt key of ${display(viteFile)}`, ignored.map(({ file }) => display(file)))])],
            };
        }

        // The file only mentioned "fmt" (or exports a function): carry on with the next source, keeping what was said about it.
        const rest = await resolveFromPrettier({ loadModule, prettierDeclared, prettierFile, root });

        return { ...rest, warnings: [...warnings, ...rest.warnings] };
    }

    return resolveFromPrettier({ loadModule, prettierDeclared, prettierFile, root });
};

const resolveFromPrettier = async ({
    loadModule,
    prettierDeclared,
    prettierFile,
    root,
}: {
    loadModule: ModuleLoader;
    prettierDeclared: boolean;
    prettierFile: string | undefined;
    root: string;
}): Promise<FmtResolution> => {
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

        return { config, file: found!.file, ignored: [], source: "prettier", warnings };
    }

    if (prettierDeclared) {
        // oxfmt defaults to 100 columns and sorts package.json; Prettier does neither. Same mapping as an empty config.
        const { scoped, universal } = readEditorconfigPrintWidth(root);
        const { config } = mapPrettierConfig({}, { editorconfigPrintWidth: universal });

        return { config, ignored: [], source: "prettier-defaults", warnings: [...scopedWidthWarnings(scoped), ...nestedConfigWarnings(root)] };
    }

    return { ignored: [], source: "defaults", warnings: nestedConfigWarnings(root) };
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
    `Formatting options come from ${used}; ${ignored.join(" and ")} found but not used (the first source that exists is used whole: vis.config fmt.options, then .oxfmtrc.json / oxfmt.config.ts or the fmt key of vite.config.*, then the Prettier config).`;

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
        case "vite-config": {
            return `the fmt key of ${relative(root, resolution.file!)}`;
        }
        default: {
            return "vis.config fmt.options";
        }
    }
};
