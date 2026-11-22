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

/**
 * `fmt.adapters.oxfmt`: the shared overrides plus the switch for the oxfmt that ships with vis.
 */
export interface OxfmtAdapterOverride extends LintFmtAdapterOverride {
    /**
     * Set to `false` to keep running the project's own `oxfmt` through the adapter orchestration
     * instead of the bundled one. Defaults to `true`.
     */
    builtin?: boolean;
}
