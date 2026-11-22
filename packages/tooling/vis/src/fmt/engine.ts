import { VisUserError } from "../errors/vis-user-error";
import type { FmtAdapterId } from "../lint-fmt/config-types";
import type { FmtEngine } from "./options";

export interface SelectFmtEngineInput {
    /** `fmt.adapters.oxfmt.builtin`. */
    builtin?: boolean;

    /** Formatters detected in the workspace, after `fmt.adapters.&lt;id>.enabled: false` was applied. */
    detected: ReadonlyArray<FmtAdapterId>;

    /** `fmt.engine`; defaults to `auto`. */
    engine?: FmtEngine;

    /** False when `fmt.adapters.oxfmt.enabled` is `false`. */
    oxfmtEnabled: boolean;
}

/** Formatters whose presence means the project picked something other than oxfmt or Prettier. */
const OTHER_FORMATTERS: ReadonlyArray<FmtAdapterId> = ["biome", "dprint", "ruff-fmt"];

export interface FmtEngineDecision {
    engine: "adapters" | "bundled";
    /** Why this engine, in a sentence. */
    reason: string;
}

/**
 * Decides what `vis fmt` runs, and why. The bundled oxfmt is the only formatter that runs when it is chosen,
 * so no file is formatted twice.
 * - `fmt.engine: "oxfmt"`: the bundled oxfmt.
 * - `fmt.engine: "prettier"` or `fmt.adapters.oxfmt.builtin: false`: the adapter orchestration.
 * - `fmt.adapters.oxfmt.enabled: false`: the adapter orchestration (oxfmt, bundled or not, is off).
 * - `auto`: the bundled oxfmt, unless biome, dprint or ruff format is detected.
 * @param input The `fmt` settings and the detected formatters.
 * @param input.builtin `fmt.adapters.oxfmt.builtin`.
 * @param input.detected Detected formatters, after `enabled: false` was applied.
 * @param input.engine `fmt.engine`; defaults to `auto`.
 * @param input.oxfmtEnabled False when `fmt.adapters.oxfmt.enabled` is `false`.
 * @returns The engine and the reason for it.
 * @throws {VisUserError} When `fmt.engine` is `"oxfmt"` while `fmt.adapters.oxfmt.enabled` or `builtin` is `false`.
 */
export const decideFmtEngine = ({ builtin, detected, engine = "auto", oxfmtEnabled }: SelectFmtEngineInput): FmtEngineDecision => {
    if (engine === "oxfmt") {
        if (!oxfmtEnabled) {
            throw new VisUserError('vis.config fmt: `engine: "oxfmt"` and `adapters.oxfmt.enabled: false` contradict each other.');
        }

        if (builtin === false) {
            throw new VisUserError('vis.config fmt: `engine: "oxfmt"` and `adapters.oxfmt.builtin: false` contradict each other.');
        }

        return { engine: "bundled", reason: 'fmt.engine is "oxfmt"' };
    }

    if (engine === "prettier") {
        return { engine: "adapters", reason: 'fmt.engine is "prettier"' };
    }

    if (builtin === false) {
        return { engine: "adapters", reason: "fmt.adapters.oxfmt.builtin is false" };
    }

    if (!oxfmtEnabled) {
        return { engine: "adapters", reason: "fmt.adapters.oxfmt.enabled is false" };
    }

    const other = OTHER_FORMATTERS.filter((id) => detected.includes(id));

    return other.length > 0
        ? { engine: "adapters", reason: `fmt.engine is "auto" and ${other.join(", ")} ${other.length > 1 ? "are" : "is"} detected` }
        : { engine: "bundled", reason: 'fmt.engine is "auto" and no formatter other than oxfmt or Prettier is detected' };
};

/**
 * Decides what `vis fmt` runs; see {@link decideFmtEngine} for the rules.
 * @param input The `fmt` settings and the detected formatters.
 * @returns `bundled` to run the bundled oxfmt, `adapters` to keep the adapter orchestration.
 * @throws {VisUserError} When `fmt.engine` is `"oxfmt"` while `fmt.adapters.oxfmt.enabled` or `builtin` is `false`.
 */
export const selectFmtEngine = (input: SelectFmtEngineInput): "adapters" | "bundled" => decideFmtEngine(input).engine;
