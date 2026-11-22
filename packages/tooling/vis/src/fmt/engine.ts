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

/**
 * Decides what `vis fmt` runs. The bundled oxfmt is the only formatter that runs when it is chosen,
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
 * @returns `bundled` to run the bundled oxfmt, `adapters` to keep the adapter orchestration.
 * @throws {VisUserError} When `fmt.engine` is `"oxfmt"` while `fmt.adapters.oxfmt.enabled` or `builtin` is `false`.
 */
export const selectFmtEngine = ({ builtin, detected, engine = "auto", oxfmtEnabled }: SelectFmtEngineInput): "adapters" | "bundled" => {
    if (engine === "oxfmt") {
        if (!oxfmtEnabled) {
            throw new VisUserError('vis.config fmt: `engine: "oxfmt"` and `adapters.oxfmt.enabled: false` contradict each other.');
        }

        if (builtin === false) {
            throw new VisUserError('vis.config fmt: `engine: "oxfmt"` and `adapters.oxfmt.builtin: false` contradict each other.');
        }

        return "bundled";
    }

    if (engine === "prettier" || builtin === false || !oxfmtEnabled) {
        return "adapters";
    }

    return OTHER_FORMATTERS.some((id) => detected.includes(id)) ? "adapters" : "bundled";
};
