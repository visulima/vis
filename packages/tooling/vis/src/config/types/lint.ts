/**
 * Per-adapter override applied by `vis lint` / `vis fmt`. Keyed by
 * adapter id under `lint.adapters` / `fmt.adapters`. Every field is
 * optional — set only what you need to change.
 */
export interface LintFmtAdapterOverride {
    /**
     * Set to `false` to skip this adapter even when its config file or
     * package.json entry is detected. Defaults to `true` (run when
     * detected).
     */
    enabled?: boolean;

    /**
     * Extra arguments appended verbatim to every invocation of this
     * adapter. Useful for tool-specific flags vis doesn't expose
     * directly (e.g. `eslint --rulesdir`).
     */
    extraArgs?: string[];
}
