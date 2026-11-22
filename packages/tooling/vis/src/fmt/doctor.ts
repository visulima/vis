import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { isAccessibleSync } from "@visulima/fs";
import { join, relative } from "@visulima/path";

import type { FmtConfigSourceKind } from "./options";
import type { FmtResolution } from "./resolve-options";
import { describeFmtSource } from "./resolve-options";
import { cachedConfigPath, hasGlobs, resolveOxfmtBin, TRANSIENT_CONFIG_PREFIX } from "./run-oxfmt";

export interface FmtDoctorOxfmt {
    /** Why the bundled oxfmt could not be resolved or started. */
    error?: string;
    /** Absolute path of the CLI entry. */
    path?: string;
    /** Whether the bundled oxfmt resolves and starts. */
    resolves: boolean;
    version?: string;
}

export interface FmtDoctorConfigFile {
    kind: "cache" | "none" | "root";
    /** Relative to the workspace root; for `root` the name carries a per-run id. */
    path?: string;
    reason: string;
}

export interface FmtDoctorReport {
    /** The config the bundled oxfmt formats with. Unset when the adapter orchestration runs. */
    config?: {
        /** Path relative to the workspace root, when the source is a file. */
        file?: string;
        label: string;
        source: FmtConfigSourceKind;
    };
    configFile: FmtDoctorConfigFile;
    /** `.editorconfig` in the workspace root, when there is one. */
    editorconfig?: string;
    engine: {
        /** Formatters the adapter orchestration runs. */
        adapters?: string[];
        kind: "adapters" | "bundled";
        reason: string;
    };
    /** Lower sources that exist and are not used. */
    ignoredSources: { file: string; source: FmtConfigSourceKind }[];
    /** `.gitignore` and `.prettierignore` in the workspace root; oxfmt skips what they list. */
    ignoreFiles: string[];
    oxfmt: FmtDoctorOxfmt;
    warnings: string[];
}

/**
 * Looks up the bundled oxfmt: the CLI entry, its version, and whether it starts (the platform binary is an
 * optional dependency, so a package that resolves can still fail to load).
 * @returns What was found, or why not.
 */
const inspectBundledOxfmt = (): FmtDoctorOxfmt => {
    let path: string;
    let version: string | undefined;

    try {
        path = resolveOxfmtBin();
        version = (JSON.parse(readFileSync(createRequire(import.meta.url).resolve("oxfmt/package.json"), "utf8")) as { version?: string }).version;
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), resolves: false };
    }

    const probe = spawnSync(process.execPath, [path, "--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });

    if (probe.status !== 0) {
        return { error: (probe.stderr || probe.error?.message || "it exited without a version").trim(), path, resolves: false, version };
    }

    return { path, resolves: true, version };
};

const describeConfigFile = (resolution: FmtResolution): FmtDoctorConfigFile => {
    if (resolution.config === undefined) {
        return {
            kind: "none",
            reason:
                resolution.source === "oxfmtrc"
                    ? "oxfmt reads its own config file, so vis writes none"
                    : "oxfmt runs on its defaults, so vis writes no config file",
        };
    }

    if (hasGlobs(resolution.config)) {
        return {
            kind: "root",
            path: `${TRANSIENT_CONFIG_PREFIX}<pid>-<id>.json`,
            reason:
                "the config has ignorePatterns or overrides, which oxfmt reads relative to the config file's directory: it is written to the workspace root for the run and removed afterwards",
        };
    }

    return {
        kind: "cache",
        path: cachedConfigPath(resolution.config),
        reason: "the config has no ignorePatterns or overrides, so it is kept in the vis cache, named by a hash of its content",
    };
};

const configSourceFile = (resolution: FmtResolution, root: string, visConfigFile: string | undefined): string | undefined => {
    const file = resolution.source === "vis.config" ? visConfigFile : resolution.file;

    return file === undefined ? undefined : relative(root, file);
};

export interface CollectFmtDoctorInput {
    /** Formatters detected for the adapter orchestration, after `enabled: false` was applied. */
    adapters: ReadonlyArray<string>;
    engine: { engine: "adapters" | "bundled"; reason: string };
    /** Set when the bundled oxfmt runs. */
    resolution?: FmtResolution;
    root: string;
    /** Absolute path of the `vis.config` file the `fmt` section came from, when there is one. */
    visConfigFile?: string;
}

/**
 * Gathers what `vis fmt --doctor` prints. Formats nothing and writes nothing.
 * @param input The engine decision, the resolved config (when the bundled oxfmt runs) and the workspace root.
 * @param input.adapters Detected formatters.
 * @param input.engine The engine decision.
 * @param input.resolution The resolved options source.
 * @param input.root Workspace root.
 * @param input.visConfigFile The `vis.config` file, shown as the path of a `vis.config` source.
 * @returns The report.
 */
export const collectFmtDoctor = ({ adapters, engine, resolution, root, visConfigFile }: CollectFmtDoctorInput): FmtDoctorReport => {
    const bundled = engine.engine === "bundled";
    const present = (name: string): string | undefined => (isAccessibleSync(join(root, name)) ? name : undefined);

    return {
        config:
            resolution === undefined
                ? undefined
                : {
                    file: configSourceFile(resolution, root, visConfigFile),
                    label: describeFmtSource(resolution, root),
                    source: resolution.source,
                },
        configFile:
            bundled && resolution !== undefined
                ? describeConfigFile(resolution)
                : { kind: "none", reason: "each detected formatter reads its own config, so vis writes none" },
        editorconfig: present(".editorconfig"),
        engine: { adapters: bundled ? undefined : [...adapters], kind: engine.engine, reason: engine.reason },
        ignoredSources: (resolution?.ignored ?? []).map(({ file, source }) => { return { file: relative(root, file), source }; }),
        ignoreFiles: [present(".gitignore"), present(".prettierignore")].filter((name): name is string => name !== undefined),
        oxfmt: inspectBundledOxfmt(),
        warnings: resolution?.warnings ?? [],
    };
};

const SOURCE_NAMES: Record<FmtConfigSourceKind, string> = {
    defaults: "oxfmt defaults",
    oxfmtrc: "oxfmt config file",
    prettier: "Prettier config",
    "prettier-defaults": "Prettier defaults",
    "vis.config": "vis.config fmt.options",
    "vite-config": "fmt key of the Vite config",
};

/**
 * Renders the report as plain text lines.
 * @param report What {@link collectFmtDoctor} gathered.
 * @returns One line per entry, ready to print.
 */
export const formatFmtDoctor = (report: FmtDoctorReport): string[] => {
    const lines: string[] = [
        `Engine: ${report.engine.kind === "bundled" ? "bundled oxfmt" : `adapter orchestration (${report.engine.adapters?.join(", ") || "no formatter detected"})`}`,
        `  why: ${report.engine.reason}`,
    ];

    if (report.config === undefined) {
        lines.push("Config source: not applicable, the detected formatters read their own config");
    } else {
        lines.push(`Config source: ${report.config.label}${report.config.source === "vis.config" && report.config.file !== undefined ? ` (${report.config.file})` : ""}`);

        if (report.ignoredSources.length === 0) {
            lines.push("  ignored lower sources: none");
        } else {
            lines.push("  ignored lower sources:");

            for (const { file, source } of report.ignoredSources) {
                lines.push(`    - ${file} (${SOURCE_NAMES[source]})`);
            }
        }
    }

    lines.push(
        report.oxfmt.resolves
            ? `Bundled oxfmt: resolves, version ${report.oxfmt.version ?? "unknown"} (${report.oxfmt.path})`
            : `Bundled oxfmt: does not run${report.oxfmt.version === undefined ? "" : ` (version ${report.oxfmt.version})`}: ${report.oxfmt.error ?? "unknown error"}`,
        `Config file: ${report.configFile.kind === "none" ? "none" : `${report.configFile.kind === "cache" ? "cache" : "workspace root"}, ${report.configFile.path}`}`,
        `  why: ${report.configFile.reason}`,
        `.editorconfig: ${report.editorconfig ?? "none in the workspace root"}${report.editorconfig !== undefined && report.engine.kind === "bundled" ? " (read by oxfmt)" : ""}`,
        `Ignore files: ${report.ignoreFiles.length === 0 ? "none in the workspace root" : `${report.ignoreFiles.join(", ")}${report.engine.kind === "bundled" ? " (oxfmt skips what they list)" : ""}`}`,
    );

    for (const warning of report.warnings) {
        lines.push(`Warning: ${warning}`);
    }

    return lines;
};
