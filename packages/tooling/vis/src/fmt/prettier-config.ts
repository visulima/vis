import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { isAccessibleSync, readJsonSync } from "@visulima/fs";
import { readJson5Sync } from "@visulima/fs/json5";
import { readTomlSync } from "@visulima/fs/toml";
import { readYamlSync } from "@visulima/fs/yaml";
import { basename, extname, join } from "@visulima/path";

import { VisUserError } from "../errors/vis-user-error";
import type { ModuleLoader, OxfmtConfig } from "./options";

/** Prettier's own search order for a root config. `package.json` only counts when it has a `prettier` key. */
const PRETTIER_CONFIG_FILES: ReadonlyArray<string> = [
    "package.json",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    ".prettierrc.json5",
    ".prettierrc.js",
    ".prettierrc.ts",
    ".prettierrc.mjs",
    ".prettierrc.mts",
    ".prettierrc.cjs",
    ".prettierrc.cts",
    "prettier.config.js",
    "prettier.config.ts",
    "prettier.config.mjs",
    "prettier.config.mts",
    "prettier.config.cjs",
    "prettier.config.cts",
    ".prettierrc.toml",
];

const SCRIPT_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readPackageJson = (file: string): Record<string, unknown> | undefined => {
    try {
        const parsed = readJsonSync(file) as unknown;

        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Finds the root Prettier config, in Prettier's own search order. Nested configs are not looked at.
 * @param root Workspace root.
 * @returns The absolute path of the first config found, or `undefined`.
 */
export const findPrettierConfigFile = (root: string): string | undefined => {
    for (const name of PRETTIER_CONFIG_FILES) {
        const file = join(root, name);

        if (!isAccessibleSync(file)) {
            continue;
        }

        if (name === "package.json" && readPackageJson(file)?.prettier === undefined) {
            continue;
        }

        return file;
    }

    return undefined;
};

const readStructured = (file: string): unknown => {
    const name = basename(file);
    const extension = extname(file);

    if (name === "package.json") {
        return readPackageJson(file)?.prettier;
    }

    if (extension === ".json") {
        return JSON.parse(readFileSync(file, "utf8"));
    }

    if (extension === ".json5") {
        return readJson5Sync(file);
    }

    if (extension === ".toml") {
        return readTomlSync(file);
    }

    // `.prettierrc` may be JSON or YAML, and every JSON document is also valid YAML.
    return readYamlSync(file);
};

const loadScript = async (file: string, loadModule: ModuleLoader): Promise<unknown> => {
    const namespace = await loadModule(file);

    return "default" in namespace ? namespace.default : namespace;
};

const SKIPPED_DIRECTORIES = new Set([".git", ".vis", "build", "coverage", "dist", "node_modules"]);
const NESTED_SCAN_MAX_DEPTH = 6;
const NESTED_SCAN_MAX_DIRECTORIES = 2000;

/**
 * Finds Prettier configs below the root. Prettier applies the nearest config to each file, but only the
 * root config is mapped, so a nested one is a place where the formatting will change. The scan is bounded
 * and skips dependency and build directories.
 * @param root Workspace root.
 * @returns Absolute paths of the nested configs found.
 */
export const findNestedPrettierConfigs = (root: string): string[] => {
    const names = new Set(PRETTIER_CONFIG_FILES);
    const found: string[] = [];
    const queue: { depth: number; directory: string }[] = [{ depth: 0, directory: root }];
    let visited = 0;

    for (let next = queue.shift(); next !== undefined && visited < NESTED_SCAN_MAX_DIRECTORIES; next = queue.shift()) {
        visited += 1;

        let entries;

        try {
            entries = readdirSync(next.directory, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const path = join(next.directory, entry.name);

            if (entry.isDirectory()) {
                if (next.depth < NESTED_SCAN_MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
                    queue.push({ depth: next.depth + 1, directory: path });
                }
            } else if (next.depth > 0 && names.has(entry.name) && (entry.name !== "package.json" || readPackageJson(path)?.prettier !== undefined)) {
                found.push(path);
            }
        }
    }

    return found;
};

/**
 * Reads the root Prettier config (JSON, YAML, TOML, JSON5, `package.json#prettier`, or a JS/TS file).
 * A string config (a shared-config package name) is resolved from the config file's directory.
 * @param root Workspace root.
 * @param loadModule Loads JS/TS configs; injected so callers choose the TS loader.
 * @returns The config object and the file it came from, or `undefined` when there is no Prettier config.
 * @throws {VisUserError} When the config exists but cannot be read or is not an object.
 */
export const readPrettierConfig = async (root: string, loadModule: ModuleLoader): Promise<{ config: Record<string, unknown>; file: string } | undefined> => {
    const file = findPrettierConfigFile(root);

    if (file === undefined) {
        return undefined;
    }

    let config: unknown;

    try {
        config = SCRIPT_EXTENSIONS.has(extname(file)) ? await loadScript(file, loadModule) : readStructured(file);

        if (typeof config === "string") {
            config = await loadScript(createRequire(file).resolve(config), loadModule);
        }
    } catch (error) {
        throw new VisUserError(`Could not read the Prettier config ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    if (!isRecord(config)) {
        throw new VisUserError(`The Prettier config ${file} must be an object.`);
    }

    return { config, file };
};

/**
 * Reads the root `.prettierignore` as a list of patterns: blank lines and comments dropped.
 * @param root Workspace root.
 * @returns The patterns, or an empty list when there is no `.prettierignore`.
 */
export const readPrettierIgnore = (root: string): string[] => {
    const file = join(root, ".prettierignore");

    if (!isAccessibleSync(file)) {
        return [];
    }

    return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));
};

export interface EditorconfigWidth {
    /** Globs of the other sections that set `max_line_length`; they are not mapped. */
    scoped: string[];
    /** `max_line_length` from a `[*]` / `[**]` section. */
    universal?: number;
}

/**
 * Extracts `max_line_length` from `.editorconfig` text. Only a universal section can be applied
 * as one `printWidth`; sections scoped to a glob are reported so the caller can say they are not mapped.
 * @param text Content of an `.editorconfig` file.
 * @returns The universal value and the globs of the scoped sections that set one.
 */
export const parseEditorconfigMaxLineLength = (text: string): EditorconfigWidth => {
    const result: EditorconfigWidth = { scoped: [] };
    let section: string | undefined;

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();

        if (line.startsWith("#") || line.startsWith(";")) {
            continue;
        }

        const header = /^\[(.+)\]$/.exec(line);

        if (header) {
            [, section] = header;

            continue;
        }

        const property = /^max_line_length\s*[=:]\s*(\S+)$/i.exec(line);

        if (!property || section === undefined) {
            continue;
        }

        const width = Number.parseInt(property[1]!, 10);

        if (!Number.isInteger(width) || width <= 0) {
            continue;
        }

        if (section === "*" || section === "**") {
            result.universal = width;
        } else {
            result.scoped.push(section);
        }
    }

    return result;
};

/**
 * Reads `max_line_length` from the root `.editorconfig`.
 * @param root Workspace root.
 * @returns The parsed widths; empty when there is no `.editorconfig`.
 */
export const readEditorconfigPrintWidth = (root: string): EditorconfigWidth => {
    const file = join(root, ".editorconfig");

    return isAccessibleSync(file) ? parseEditorconfigMaxLineLength(readFileSync(file, "utf8")) : { scoped: [] };
};

const COPIED_OPTIONS = new Set([
    "arrowParens",
    "bracketSameLine",
    "bracketSpacing",
    "embeddedLanguageFormatting",
    "endOfLine",
    "experimentalOperatorPosition",
    "htmlWhitespaceSensitivity",
    "jsxSingleQuote",
    "objectWrap",
    "printWidth",
    "proseWrap",
    "quoteProps",
    "semi",
    "singleAttributePerLine",
    "singleQuote",
    "tabWidth",
    "trailingComma",
    "useTabs",
    "vueIndentScriptAndStyle",
]);

type OptionTransform = (prettierKey: string, value: unknown, warnings: string[]) => unknown;

interface NamespacedPlugin {
    /** oxfmt option name -> Prettier option name. */
    mapping: Record<string, string>;
    oxfmtKey: "astro" | "sortTailwindcss" | "svelte";
    plugin: string;
    transform?: OptionTransform;
}

const dropTailwindRegexes: OptionTransform = (prettierKey, value, warnings) => {
    if ((prettierKey !== "tailwindFunctions" && prettierKey !== "tailwindAttributes") || !Array.isArray(value)) {
        return value;
    }

    return value.filter((item) => {
        if (typeof item !== "string") {
            return false;
        }

        const isRegex = item.startsWith("/") && item.endsWith("/");

        if (isRegex) {
            warnings.push(`"${prettierKey}": the regular expression ${item} is not supported by oxfmt and was dropped.`);
        }

        return !isRegex;
    });
};

const astroCompressHtml: OptionTransform = (prettierKey, value) => {
    if (prettierKey !== "astroCompressHTML" || typeof value !== "boolean") {
        return value;
    }

    return value ? "html" : "none";
};

const NAMESPACED_PLUGINS: ReadonlyArray<NamespacedPlugin> = [
    {
        mapping: {
            attributes: "tailwindAttributes",
            config: "tailwindConfig",
            functions: "tailwindFunctions",
            preserveDuplicates: "tailwindPreserveDuplicates",
            preserveWhitespace: "tailwindPreserveWhitespace",
            stylesheet: "tailwindStylesheet",
        },
        oxfmtKey: "sortTailwindcss",
        plugin: "prettier-plugin-tailwindcss",
        transform: dropTailwindRegexes,
    },
    {
        mapping: { allowShorthand: "svelteAllowShorthand", indentScriptAndStyle: "svelteIndentScriptAndStyle", sortOrder: "svelteSortOrder" },
        oxfmtKey: "svelte",
        plugin: "prettier-plugin-svelte",
    },
    {
        mapping: { allowShorthand: "astroAllowShorthand", compressHTML: "astroCompressHTML", skipFrontmatter: "astroSkipFrontmatter" },
        oxfmtKey: "astro",
        plugin: "prettier-plugin-astro",
        transform: astroCompressHtml,
    },
];

const KNOWN_PLUGINS = new Set(["prettier-plugin-packagejson", ...NAMESPACED_PLUGINS.map(({ plugin }) => plugin)]);
const PLUGIN_OPTION_KEYS = new Set(NAMESPACED_PLUGINS.flatMap(({ mapping }) => Object.values(mapping)));

const PARSER_TO_LANGUAGE = new Map([
    ["acorn", "javascript"],
    ["angular", "angular-html"],
    ["astro", "astro"],
    ["babel", "javascript"],
    ["babel-ts", "typescript"],
    ["css", "css"],
    ["espree", "javascript"],
    ["glimmer", "handlebars"],
    ["graphql", "graphql"],
    ["html", "html"],
    ["json5", "json5"],
    ["json", "json"],
    ["jsonc", "jsonc"],
    ["less", "less"],
    ["markdown", "markdown"],
    ["mdx", "mdx"],
    ["meriyah", "javascript"],
    ["oxc", "javascript"],
    ["oxc-ts", "typescript"],
    ["remark", "markdown"],
    ["scss", "scss"],
    ["svelte", "svelte"],
    ["typescript", "typescript"],
    ["vue", "vue"],
    ["yaml", "yaml"],
    ["yuku", "javascript"],
    ["yuku-ts", "typescript"],
]);

const copyOptions = (options: Record<string, unknown>, warnings: string[], scope: string): Record<string, unknown> => {
    const copied: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(options)) {
        if (PLUGIN_OPTION_KEYS.has(key)) {
            continue;
        }

        if (!COPIED_OPTIONS.has(key)) {
            warnings.push(`${scope}"${key}" is not supported by oxfmt and was dropped.`);

            continue;
        }

        if (key === "endOfLine" && value === "auto") {
            warnings.push(`${scope}"endOfLine": "auto" is not supported by oxfmt and was dropped.`);

            continue;
        }

        copied[key] = value;
    }

    return copied;
};

const mapPluginOptions = (options: Record<string, unknown>, enabled: ReadonlySet<string>, warnings: string[], topLevel: boolean): Record<string, unknown> => {
    const mapped: Record<string, unknown> = {};

    for (const { mapping, oxfmtKey, plugin, transform } of NAMESPACED_PLUGINS) {
        if (!enabled.has(plugin)) {
            continue;
        }

        const section: Record<string, unknown> = {};

        for (const [oxfmtName, prettierName] of Object.entries(mapping)) {
            const value = options[prettierName];

            if (value !== undefined) {
                section[oxfmtName] = transform ? transform(prettierName, value, warnings) : value;
            }
        }

        if (topLevel || Object.keys(section).length > 0) {
            mapped[oxfmtKey] = section;
        }
    }

    return mapped;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

export interface MapPrettierContext {
    /** `max_line_length` of a universal `.editorconfig` section; used when Prettier's `printWidth` is unset. */
    editorconfigPrintWidth?: number;
    /** `.prettierignore` patterns, copied to `ignorePatterns`. */
    ignorePatterns?: ReadonlyArray<string>;
    /** The config file the options came from; a script config gets a "static values" warning. */
    sourceFile?: string;
}

/**
 * Maps a Prettier config to an oxfmt config. The result matches what `oxfmt --migrate prettier`
 * writes, except that an `.editorconfig` `max_line_length` replaces the pinned `printWidth` of 80.
 * @param prettier The parsed Prettier config.
 * @param context Inputs that live outside the config object.
 * @returns The oxfmt config and one warning per dropped option or plugin.
 */
export const mapPrettierConfig = (prettier: Record<string, unknown>, context: MapPrettierContext = {}): { config: OxfmtConfig; warnings: string[] } => {
    const warnings: string[] = [];
    const { overrides, plugins, ...options } = prettier;

    delete options.$schema;
    const enabledPlugins = new Set<string>();

    for (const plugin of Array.isArray(plugins) ? plugins : []) {
        if (typeof plugin === "string" && KNOWN_PLUGINS.has(plugin)) {
            enabledPlugins.add(plugin);
        } else if (typeof plugin === "string") {
            warnings.push(`The plugin "${plugin}" is not supported by oxfmt and was dropped.`);
        } else {
            warnings.push("A custom plugin module is not supported by oxfmt and was dropped.");
        }
    }

    const config: Record<string, unknown> = copyOptions(options, warnings, "");

    if (typeof config.printWidth !== "number") {
        config.printWidth = context.editorconfigPrintWidth ?? 80;

        if (context.editorconfigPrintWidth === undefined) {
            warnings.push('"printWidth" is not set in the Prettier config; it is pinned to 80 (the oxfmt default is 100).');
        }
    }

    config.sortPackageJson = enabledPlugins.has("prettier-plugin-packagejson") ? {} : false;
    Object.assign(config, mapPluginOptions(options, enabledPlugins, warnings, true));

    if (Array.isArray(overrides)) {
        const mappedOverrides: unknown[] = [];
        const associations: unknown[] = [];

        for (const entry of overrides) {
            if (!isRecord(entry)) {
                continue;
            }

            const globs = { files: asArray(entry.files), ...(entry.excludeFiles === undefined ? {} : { excludeFiles: asArray(entry.excludeFiles) }) };
            const { parser, ...rest } = isRecord(entry.options) ? entry.options : ({} as Record<string, unknown>);
            const language = typeof parser === "string" ? PARSER_TO_LANGUAGE.get(parser) : undefined;

            if (language) {
                associations.push({ ...globs, language });
            } else if (parser !== undefined) {
                warnings.push(`overrides: "parser": ${JSON.stringify(parser)} is not supported by oxfmt and was dropped.`);
            }

            const mapped = { ...copyOptions(rest, warnings, "overrides: "), ...mapPluginOptions(rest, enabledPlugins, warnings, false) };

            if (Object.keys(mapped).length > 0) {
                mappedOverrides.push({ ...globs, options: mapped });
            }
        }

        if (mappedOverrides.length > 0) {
            config.overrides = mappedOverrides;
        }

        if (associations.length > 0) {
            config.associations = associations;
        }
    }

    config.ignorePatterns = [...(context.ignorePatterns ?? [])];

    if (context.sourceFile !== undefined && SCRIPT_EXTENSIONS.has(extname(context.sourceFile))) {
        warnings.push(`${basename(context.sourceFile)} was evaluated and mapped as static values; logic in it is not preserved.`);
    }

    return { config, warnings };
};
