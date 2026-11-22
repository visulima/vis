import { unlinkSync, writeFileSync } from "node:fs";

import { isAccessibleSync, readFileSync } from "@visulima/fs";
import { join, relative } from "@visulima/path";

import { findVisConfigFile } from "../../config/config";
import { VisUserError } from "../../errors/vis-user-error";
import type { ModuleLoader } from "../../fmt/options";
import { OXFMT_DISCOVERED_CONFIG_FILES } from "../../fmt/options";
import {
    findNestedPrettierConfigs,
    KNOWN_PLUGINS,
    mapPrettierConfig,
    PRETTIER_CONFIG_FILES,
    readEditorconfigPrintWidth,
    readPrettierConfig,
    readPrettierIgnore,
} from "../../fmt/prettier-config";
import { importTs } from "../../runtime/ts-loader";
import { TOOL_SIGNATURES } from "../../util/tool-signatures";
import { backupFile } from "./backup";
import { detectJsonIndent, readJsonFile } from "./json";
import type { MigrateLogger, MigrationReport } from "./types";
import { addManualStep, addMigrationWarning, bumpPerMigration } from "./types";

const MIGRATION_ID = "prettier";

const PRETTIER_IGNORE_FILE = ".prettierignore";
const DEFINE_CONFIG_RE = /(defineConfig\(\{)/;
const EXPORT_DEFAULT_RE = /(export\s+default\s+\{)/;
const FMT_KEY_RE = /^\s*fmt\s*:/m;

/** A Prettier plugin package: `prettier-plugin-*`, `@scope/prettier-plugin-*` or `@prettier/plugin-*`. */
const PLUGIN_PACKAGE_RE = /^(?:@[^/]+\/)?prettier-plugin-|^@prettier\/plugin-/;

interface PackageJsonShape {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    prettier?: unknown;
    scripts?: Record<string, string>;
}

interface ScriptRewrite {
    from: string;
    name: string;
    to: string;
}

interface UnrewrittenScript {
    name: string;
    value: string;
}

export interface PrettierPlan {
    /** Root Prettier config files that exist (never `package.json`). */
    configFiles: string[];
    /** `.prettierignore` exists in the root. */
    ignoreFile: boolean;
    /** Plugin packages with no oxfmt equivalent; they stay in `package.json`. */
    keptPlugins: string[];
    /** `package.json` has a `prettier` key. */
    packageJsonKey: boolean;
    /** Dependencies to drop from `package.json`. */
    removeDependencies: string[];
    rewrites: ScriptRewrite[];
    /** Scripts that still run Prettier and could not be rewritten exactly. */
    unrewritten: UnrewrittenScript[];
}

// Scripts -----------------------------------------------------------

/** Runner prefixes in front of `prettier`, longest first. */
const RUNNER_PREFIXES: ReadonlyArray<ReadonlyArray<string>> = [["npm", "exec", "--"], ["npm", "exec"], ["pnpm", "exec"], ["yarn", "exec"], ["bun", "x"], ["bunx"], ["npx"], ["pnpm"], ["yarn"]];

const ENV_ASSIGNMENT_RE = /^[A-Z_][A-Z0-9_]*=\S*$/;
const TOKEN_RE = /(?:[^\s"']|"[^"]*"|'[^']*')+/g;
/** A word `prettier` that is not part of a longer name or path (`prettier-plugin-x`, `.prettierrc`, `prettier/prettier`). */
const STANDALONE_PRETTIER_RE = /(?<![\w@/.-])prettier(?![\w/.-])/;
const GLOB_CHARACTER_RE = /[*?[\]{}()!]/;

/**
 * Splits a script at `&amp;&amp;`, `||`, `;` and `|` outside quotes. Returns the segments and the separators between them
 * (`[segment, separator, segment, …]`), or `undefined` when a quote is left open.
 */
const splitScript = (script: string): string[] | undefined => {
    const parts: string[] = [];
    let current = "";
    let quote: string | undefined;

    for (let index = 0; index < script.length; index += 1) {
        const character = script[index]!;

        if (quote !== undefined) {
            current += character;

            if (character === "\\" && quote === '"') {
                current += script[index + 1] ?? "";
                index += 1;
            } else if (character === quote) {
                quote = undefined;
            }

            continue;
        }

        if (character === '"' || character === "'") {
            quote = character;
            current += character;

            continue;
        }

        const pair = script.slice(index, index + 2);
        const separator = pair === "&&" || pair === "||" ? pair : character === ";" || character === "|" ? character : undefined;

        if (separator === undefined) {
            current += character;

            continue;
        }

        parts.push(current, separator);
        current = "";
        index += separator.length - 1;
    }

    parts.push(current);

    return quote === undefined ? parts : undefined;
};

/** Flags `vis fmt` makes redundant: oxfmt skips files it cannot format on its own. */
const REDUNDANT_FLAGS = new Set(["--ignore-unknown", "-u"]);

type SegmentResult = { kind: "other" } | { kind: "rewritten"; value: string } | { kind: "unsupported" };

const rewriteSegment = (segment: string, orchestrated: boolean): SegmentResult => {
    const tokens = segment.match(TOKEN_RE) ?? [];
    let index = 0;

    while (index < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[index]!)) {
        index += 1;
    }

    const envPrefix = tokens.slice(0, index);
    const runner = RUNNER_PREFIXES.find((prefix) => prefix.every((part, offset) => tokens[index + offset] === part) && tokens[index + prefix.length] === "prettier");

    index += runner ? runner.length : 0;

    if (tokens[index] !== "prettier") {
        return { kind: "other" };
    }

    const rest = tokens.slice(index + 1);

    // Text outside every token (an unbalanced or escaped quote) cannot be reproduced.
    if (/\S/.test(segment.replaceAll(TOKEN_RE, ""))) {
        return { kind: "unsupported" };
    }

    let mode: "check" | "write" | undefined;
    const paths: string[] = [];

    for (const token of rest) {
        if (token === "--write" || token === "-w" || token === "--check" || token === "-c") {
            const next = token === "--write" || token === "-w" ? "write" : "check";

            if (mode !== undefined) {
                return { kind: "unsupported" };
            }

            mode = next;
        } else if (token.startsWith("-")) {
            if (!REDUNDANT_FLAGS.has(token)) {
                return { kind: "unsupported" };
            }
        } else {
            paths.push(token);
        }
    }

    if (mode === undefined) {
        return { kind: "unsupported" };
    }

    // `vis fmt` formats the whole workspace without paths. With the bundled oxfmt any other path goes to oxfmt as given;
    // the adapter orchestration routes by extension and drops directories and globs, so only explicit files are safe there.
    if (paths.includes(".") && paths.length > 1) {
        return { kind: "unsupported" };
    }

    if (orchestrated && paths.some((path) => path !== "." && (GLOB_CHARACTER_RE.test(path) || !/\.\w+["']?$/.test(path)))) {
        return { kind: "unsupported" };
    }

    return {
        kind: "rewritten",
        value: [...envPrefix, "vis", "fmt", ...(mode === "check" ? ["--check"] : []), ...paths.filter((path) => path !== ".")].join(" "),
    };
};

/**
 * Rewrites the `prettier --write` / `prettier --check` calls in a script to `vis fmt` / `vis fmt --check`,
 * keeping the paths and any environment prefix. The script is left alone when a call uses an option that
 * `vis fmt` cannot reproduce exactly (any flag but `--ignore-unknown`, no mode flag, both mode flags), or still has a `prettier`
 * word after the rewrite (a call in a shape it does not recognise).
 * `orchestrated` marks a workspace where biome, dprint or ruff keeps `vis fmt` on the adapter orchestration.
 * @param script The script text.
 * @returns The new text, `unchanged` for a script without a Prettier call, or `unsupported` when a call cannot be rewritten.
 */
export const rewritePrettierScript = (script: string, { orchestrated = false }: { orchestrated?: boolean } = {}): { status: "rewritten" | "unchanged" | "unsupported"; value: string } => {
    const parts = splitScript(script);

    if (parts === undefined) {
        return STANDALONE_PRETTIER_RE.test(script) ? { status: "unsupported", value: script } : { status: "unchanged", value: script };
    }

    let rewritten = false;

    for (let index = 0; index < parts.length; index += 2) {
        const result = rewriteSegment(parts[index]!.trim(), orchestrated);

        if (result.kind === "unsupported") {
            return { status: "unsupported", value: script };
        }

        if (result.kind === "rewritten") {
            const original = parts[index]!;
            const leading = original.slice(0, original.length - original.trimStart().length);
            const trailing = original.slice(original.trimEnd().length);

            parts[index] = `${leading}${result.value}${trailing}`;
            rewritten = true;
        }
    }

    const value = rewritten ? parts.join("") : script;

    // A Prettier call this does not recognise (`yarn run prettier`, `cross-env X=1 prettier`, a call inside `if … then`) still needs the binary.
    if (STANDALONE_PRETTIER_RE.test(value)) {
        return { status: "unsupported", value: script };
    }

    return rewritten ? { status: "rewritten", value } : { status: "unchanged", value: script };
};

// Detection ---------------------------------------------------------

const readPackageJson = (root: string): PackageJsonShape | undefined => {
    const path = join(root, "package.json");

    return isAccessibleSync(path) ? readJsonFile<PackageJsonShape>(path) : undefined;
};

/** Whether biome, dprint or ruff in the workspace keep `vis fmt` on the adapter orchestration instead of the bundled oxfmt. */
const usesOtherFormatter = (root: string): boolean => {
    const pkg = readPackageJson(root);
    const names = new Set(Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }));

    return [TOOL_SIGNATURES.biome, TOOL_SIGNATURES.dprint, TOOL_SIGNATURES.ruff].some(
        (signature) => signature.packageNames.some((name) => names.has(name)) || signature.configFiles.some((file) => isAccessibleSync(join(root, file))),
    );
};

/**
 * Looks at the root for everything the Prettier step would change, without reading the Prettier config.
 * @param root Workspace root.
 * @returns What exists and what would be removed or rewritten; every list is empty once the step has run.
 */
export const planPrettierMigration = (root: string): PrettierPlan => {
    const orchestrated = usesOtherFormatter(root);
    const pkg = readPackageJson(root);
    const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const names = Object.keys(dependencies);

    const coveredPlugins = names.filter((name) => KNOWN_PLUGINS.has(name));
    const keptPlugins = names.filter((name) => PLUGIN_PACKAGE_RE.test(name) && !KNOWN_PLUGINS.has(name));

    const rewrites: ScriptRewrite[] = [];
    const unrewritten: UnrewrittenScript[] = [];

    for (const [name, value] of Object.entries(pkg?.scripts ?? {})) {
        if (typeof value !== "string") {
            continue;
        }

        const result = rewritePrettierScript(value, { orchestrated });

        if (result.status === "rewritten") {
            rewrites.push({ from: value, name, to: result.value });
        } else if (result.status === "unsupported") {
            unrewritten.push({ name, value });
        }
    }

    // `prettier` stays while something still needs the binary: a plugin oxfmt does not cover or a script that could not be rewritten.
    const prettierRemovable = keptPlugins.length === 0 && unrewritten.length === 0;
    const removeDependencies = [...coveredPlugins, ...(prettierRemovable && "prettier" in dependencies ? ["prettier"] : [])];

    return {
        configFiles: PRETTIER_CONFIG_FILES.filter((file) => file !== "package.json" && isAccessibleSync(join(root, file))).map((file) => join(root, file)),
        ignoreFile: isAccessibleSync(join(root, PRETTIER_IGNORE_FILE)),
        keptPlugins,
        packageJsonKey: pkg?.prettier !== undefined,
        removeDependencies,
        rewrites,
        unrewritten,
    };
};

const isActionable = (plan: PrettierPlan): boolean =>
    plan.configFiles.length > 0 || plan.ignoreFile || plan.packageJsonKey || plan.removeDependencies.length > 0 || plan.rewrites.length > 0;

/**
 * Whether the workspace has a Prettier config, a `.prettierignore`, the `prettier` dependency or a script
 * the step would change. False again after the step has run.
 * @param root Workspace root.
 * @returns `true` when there is something to migrate.
 */
export const detectPrettier = (root: string): boolean => isActionable(planPrettierMigration(root));

// vis.config --------------------------------------------------------

interface FmtBlock {
    ignorePatterns?: string[];
    options: Record<string, unknown>;
    overrides?: unknown[];
}

/** `fmt: { … }` as TypeScript source, indented for the top level of the config object, without a trailing comma. */
export const renderFmtSnippet = (fmt: FmtBlock): string => {
    const lines = JSON.stringify({ fmt }, undefined, 4).split("\n").slice(1, -1);

    return lines.map((line) => line.replace(/^(\s*)"([A-Z_$][\w$]*)":/i, "$1$2:")).join("\n");
};

type VisConfigFmtState = "configured" | "none" | "oxfmtrc" | "present";

const visConfigFmtState = (root: string, visConfig: { fmt?: Record<string, unknown> } | undefined): VisConfigFmtState => {
    const fmt = visConfig?.fmt;

    if (fmt !== undefined && (fmt.options !== undefined || fmt.overrides !== undefined || fmt.ignorePatterns !== undefined)) {
        return "configured";
    }

    // An oxfmt config file wins over the Prettier config in the resolver, so mapping Prettier into vis.config would outrank it.
    if (OXFMT_DISCOVERED_CONFIG_FILES.some((file) => isAccessibleSync(join(root, file)))) {
        return "oxfmtrc";
    }

    if (fmt !== undefined) {
        return "present";
    }

    const configPath = findVisConfigFile(root);

    return configPath !== undefined && FMT_KEY_RE.test(readFileSync(configPath)) ? "present" : "none";
};

const insertionPattern = (content: string): RegExp | undefined => (DEFINE_CONFIG_RE.test(content) ? DEFINE_CONFIG_RE : EXPORT_DEFAULT_RE.test(content) ? EXPORT_DEFAULT_RE : undefined);

/** A new `vis.config.ts` can always be written; an existing file needs a `defineConfig({` or `export default {` to insert after. */
const canInsertFmt = (root: string): boolean => {
    const configPath = findVisConfigFile(root);

    return configPath === undefined || insertionPattern(readFileSync(configPath)) !== undefined;
};

/** Adds the `fmt` block to `vis.config`, creating the file when there is none. Call only when {@link canInsertFmt} holds. */
const insertFmtIntoVisConfig = (root: string, snippet: string, logger: MigrateLogger, report: MigrationReport): void => {
    const configPath = findVisConfigFile(root);

    if (configPath === undefined) {
        const newPath = join(root, "vis.config.ts");

        writeFileSync(newPath, `import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({\n${snippet},\n});\n`, "utf8");
        logger.info(`Created ${newPath} with the fmt config`);

        return;
    }

    const content = readFileSync(configPath);

    backupFile(configPath, report);
    writeFileSync(configPath, content.replace(insertionPattern(content)!, (_match, opening: string) => `${opening}\n${snippet},`), "utf8");
    logger.info(`Merged the fmt config into ${configPath}`);
};

// package.json ------------------------------------------------------

const applyPackageJson = (root: string, plan: PrettierPlan, useEditorconfig: boolean | undefined, report: MigrationReport): void => {
    const path = join(root, "package.json");

    if (!isAccessibleSync(path)) {
        return;
    }

    const content = readFileSync(path);
    const pkg = JSON.parse(content) as PackageJsonShape;
    let modified = false;

    if (pkg.prettier !== undefined) {
        delete pkg.prettier;
        bumpPerMigration(report, MIGRATION_ID, "removedConfigCount");
        modified = true;
    }

    for (const field of ["dependencies", "devDependencies"] as const) {
        const block = pkg[field];

        for (const name of plan.removeDependencies) {
            if (block?.[name] !== undefined) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `name` comes from the plan's fixed list of package names
                delete block[name];
                bumpPerMigration(report, MIGRATION_ID, "removedPackageCount");
                modified = true;
            }
        }
    }

    for (const { name, to } of plan.rewrites) {
        if (pkg.scripts?.[name] !== undefined) {
            pkg.scripts[name] = to;
            bumpPerMigration(report, MIGRATION_ID, "rewrittenScriptCount");
            modified = true;
        }
    }

    if (modified) {
        backupFile(path, report);
        writeFileSync(path, `${JSON.stringify(pkg, undefined, detectJsonIndent(path, content, { useEditorconfig }))}\n`, "utf8");
    }
};

const removeFiles = (files: string[], report: MigrationReport): void => {
    for (const file of files) {
        backupFile(file, report);
        unlinkSync(file);
        bumpPerMigration(report, MIGRATION_ID, "removedConfigCount");
    }
};

// Step --------------------------------------------------------------

const PIN_NOTE = "is pinned to 80";

/**
 * Moves the Prettier setup into `vis.config`: the config (mapped to oxfmt options), `.prettierignore`,
 * the Prettier config files, the `prettier` and covered plugin packages, and `prettier --write|--check` scripts.
 * Nothing is deleted unless the `fmt` block was written first (or `vis.config` already has `fmt.options`).
 * @param root Workspace root.
 * @param options Step options.
 * @param options.dryRun Log what would change and touch nothing.
 * @param options.silent Suppress info logs.
 * @param options.useEditorconfig Take the `package.json` indent from `.editorconfig`.
 * @param options.visConfig The loaded `vis.config`, to tell whether `fmt.options` already exist.
 * @param options.visConfig.fmt The `fmt` block of the loaded config.
 * @param logger Logger for user feedback.
 * @param report Shared migration report.
 * @param loadModule Loads a JS/TS Prettier config.
 * @returns `true` when something was migrated or previewed.
 */
export const migratePrettier = async (
    root: string,
    options: { dryRun: boolean; silent?: boolean; useEditorconfig?: boolean; visConfig?: { fmt?: Record<string, unknown> } },
    logger: MigrateLogger,
    report: MigrationReport,
    loadModule: ModuleLoader = importTs,
): Promise<boolean> => {
    const plan = planPrettierMigration(root);

    if (!isActionable(plan)) {
        if (!options.silent) {
            logger.info("No Prettier configuration found — nothing to migrate.");
        }

        return false;
    }

    const state = visConfigFmtState(root, options.visConfig);
    const writable = state === "configured" || state === "oxfmtrc" || (state === "none" && canInsertFmt(root));
    let snippet = "";

    if (state === "configured" || state === "oxfmtrc") {
        addMigrationWarning(
            report,
            state === "oxfmtrc"
                ? "An oxfmt config file exists and wins over the Prettier config, so the Prettier config was not mapped (the Prettier files are backed up and removed)."
                : "vis.config already has fmt options; they win over the Prettier config, so it was not mapped (the Prettier files are backed up and removed).",
        );
    } else {
        let found;

        try {
            found = await readPrettierConfig(root, loadModule);
        } catch (error) {
            if (!(error instanceof VisUserError)) {
                throw error;
            }

            addMigrationWarning(report, error.message);
            addManualStep(report, `Fix the Prettier config and re-run \`vis migrate prettier\`, or move it into vis.config fmt.options by hand (${error.message})`);

            return false;
        }

        const { scoped, universal } = readEditorconfigPrintWidth(root);
        const { config, warnings } = mapPrettierConfig(found?.config ?? {}, {
            editorconfigPrintWidth: universal,
            ignorePatterns: readPrettierIgnore(root),
            sourceFile: found?.file,
        });
        const { associations, ignorePatterns, overrides, ...mappedOptions } = config;

        snippet = renderFmtSnippet({
            options: mappedOptions,
            ...(overrides !== undefined && overrides.length > 0 ? { overrides } : {}),
            ...(ignorePatterns !== undefined && ignorePatterns.length > 0 ? { ignorePatterns } : {}),
        });

        if (!writable) {
            const reason
                = state === "present" ? 'vis.config already has a "fmt" block without options' : "vis.config has no `defineConfig({` or `export default {` to insert into";

            addMigrationWarning(report, `${reason}; the Prettier config was not moved and nothing was removed.`);
            addManualStep(report, `Add this to vis.config, then re-run \`vis migrate prettier\`:\n${snippet}`);
            logger.warn(`${reason} — please add the fmt config manually; nothing was removed.`);

            return false;
        }

        for (const warning of warnings) {
            if (warning.includes(PIN_NOTE)) {
                addMigrationWarning(report, `Prettier: ${warning}`);
            } else {
                addManualStep(report, `Prettier option not carried over: ${warning}`);
            }
        }

        if (Array.isArray(associations) && associations.length > 0) {
            addManualStep(
                report,
                `Prettier overrides set a "parser" for ${JSON.stringify(associations)}; vis.config fmt has no place for oxfmt "associations" yet, so they were not carried over and those files are formatted by their extension.`,
            );
        }

        if (scoped.length > 0) {
            addManualStep(report, `.editorconfig sets max_line_length only for ${scoped.join(", ")}; those sections are not applied.`);
        }
    }

    const nested = findNestedPrettierConfigs(root);

    if (nested.length > 0) {
        addManualStep(report, `Only the root Prettier config was migrated; ${String(nested.length)} nested config(s) are not read by oxfmt (for example ${relative(root, nested[0]!)}).`);
    }

    if (options.visConfig?.fmt?.engine === "prettier") {
        addManualStep(report, 'vis.config sets fmt.engine to "prettier", so `vis fmt` keeps running Prettier; remove that setting to use the bundled oxfmt.');
    }

    for (const plugin of plan.keptPlugins) {
        addManualStep(report, `${plugin} has no oxfmt equivalent: it stays in package.json and is not applied by \`vis fmt\`.`);
    }

    for (const { name, value } of plan.unrewritten) {
        addManualStep(report, `Script "${name}" (${value}) still runs Prettier with options \`vis fmt\` cannot reproduce; replace it by hand with \`vis fmt\` or \`vis fmt --check\`.`);
    }

    if (typeof readPackageJson(root)?.prettier === "string") {
        addManualStep(report, "package.json#prettier named a shared config package; remove that package if nothing else uses it.");
    }

    addManualStep(report, "Run `vis fmt --check` and review the diff: oxfmt output can differ from Prettier.");

    if (plan.removeDependencies.length > 0) {
        addManualStep(report, "Update the lockfile with your package manager's install command.");
        addManualStep(report, "Check git hooks, CI workflows, vis.config `staged` commands, workspace package scripts and editor settings for direct `prettier` calls.");
    }

    if (options.dryRun) {
        if (!options.silent) {
            if (state === "none") {
                logger.info("[dry-run] Would add this fmt config to vis.config.ts:");
                logger.info(snippet);
            } else {
                logger.info("[dry-run] An existing fmt or oxfmt config wins; the Prettier config would not be mapped.");
            }

            for (const file of plan.configFiles) {
                logger.info(`[dry-run] Would remove ${relative(root, file)} (backup .bak)`);
            }

            if (plan.ignoreFile) {
                logger.info(`[dry-run] Would remove ${PRETTIER_IGNORE_FILE} (backup .bak)`);
            }

            if (plan.removeDependencies.length > 0) {
                logger.info(`[dry-run] Would remove from package.json: ${plan.removeDependencies.join(", ")}`);
            }

            for (const { from, name, to } of plan.rewrites) {
                logger.info(`[dry-run] Would rewrite script "${name}": ${from} → ${to}`);
            }
        }

        return true;
    }

    if (state === "none") {
        insertFmtIntoVisConfig(root, snippet, logger, report);
    }

    removeFiles([...plan.configFiles, ...(plan.ignoreFile ? [join(root, PRETTIER_IGNORE_FILE)] : [])], report);
    applyPackageJson(root, plan, options.useEditorconfig, report);

    return true;
};
