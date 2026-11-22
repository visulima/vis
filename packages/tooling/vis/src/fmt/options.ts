import type { FormatConfig, OxfmtOverrideConfig, Oxfmtrc } from "oxfmt";

/** Formatting options accepted by oxfmt, as declared by the `oxfmt` package. */
export type OxfmtOptions = FormatConfig;

/** A per-glob options override, in oxfmt's own shape. */
export type FmtOverride = OxfmtOverrideConfig;

/** A complete oxfmt config object: options, `overrides`, `ignorePatterns` and the oxfmt-only extras. */
export type OxfmtConfig = Oxfmtrc;

/**
 * Which engine `vis fmt` uses.
 * - `auto`: the bundled oxfmt, unless the workspace uses biome, dprint or ruff format.
 * - `oxfmt`: always the bundled oxfmt.
 * - `prettier`: the detected-adapter orchestration, with Prettier staying in charge.
 */
export type FmtEngine = "auto" | "oxfmt" | "prettier";

/** Where the options of a bundled-oxfmt run came from. */
export type FmtConfigSourceKind = "defaults" | "oxfmtrc" | "prettier" | "prettier-defaults" | "vis.config" | "vite-config";

/** A config source that exists but is not used because a higher one won. */
export interface FmtIgnoredSource {
    /** Absolute path of the file. */
    file: string;
    source: FmtConfigSourceKind;
}

/**
 * Config files oxfmt discovers on its own in a directory (checked against oxfmt 0.79).
 * Narrower than `TOOL_SIGNATURES.oxfmt.configFiles`: a name oxfmt does not discover would be
 * treated as "present" here and then silently formatted with defaults.
 */
export const OXFMT_DISCOVERED_CONFIG_FILES: ReadonlyArray<string> = [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts"];

/** Loads a JS/TS module by absolute path and returns its namespace. Injected so the readers stay unit-testable. */
export type ModuleLoader = (absolutePath: string) => Promise<Record<string, unknown>>;
