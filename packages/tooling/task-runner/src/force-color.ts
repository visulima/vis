/**
 * The colour policy for child processes, shared by both spawners.
 *
 * Order of precedence for `FORCE_COLOR`: the caller's own `env`, then the parent
 * `process.env` (when the child inherits it), then the default. The default is
 * `"1"`, and only when this process's stdout is a terminal and `NO_COLOR` (as the
 * child will see it) is unset or empty. Otherwise the child gets no `FORCE_COLOR`
 * at all: forcing colour into piped, CI or `NO_COLOR` runs breaks tools that match
 * their output as plain text. A caller passing `FORCE_COLOR=0` is never overridden;
 * see voidzero-dev/vite-task#379.
 */

/**
 * `"1"` when colour should be forced into children, `undefined` otherwise.
 * Colour is forced only for an interactive runner whose caller has not
 * asked for plain output (`NO_COLOR`, non-empty, per no-color.org).
 */
const defaultForceColor = (env: NodeJS.ProcessEnv): string | undefined => {
    const noColor = env["NO_COLOR"];
    const colorDisabled = noColor !== undefined && noColor !== "";

    return process.stdout.isTTY && !colorDisabled ? "1" : undefined;
};

/**
 * The `FORCE_COLOR` value a child should get, or `undefined` for none.
 *
 * `extras` are variables the spawner adds on top of `configEnv` (a pty's `TERM`); they take part
 * in the `NO_COLOR` lookup because they end up in the child's environment.
 * `inheritEnv: false` means the caller already built the whole child environment, so the parent
 * environment is not a source for any of it.
 */
const forceColorFor = (
    configEnv: NodeJS.ProcessEnv | undefined,
    extras: Record<string, string> | undefined,
    inheritEnv: boolean | undefined = true,
): string | undefined => {
    const parentEnv: NodeJS.ProcessEnv = inheritEnv ? process.env : {};

    return configEnv?.["FORCE_COLOR"] ?? parentEnv["FORCE_COLOR"] ?? defaultForceColor({ ...parentEnv, ...configEnv, ...extras });
};

export { forceColorFor };
