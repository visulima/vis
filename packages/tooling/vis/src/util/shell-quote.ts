/**
 * Shell quoting shared by the release and run commands. `sq` and `cmdq` are
 * the two primitives; `shellQuote` picks one by platform (or by an explicit
 * `isWindows` flag, which the release tokens use).
 */

/**
 * Wrap a string in POSIX single quotes, escaping embedded single quotes.
 * Safe to interpolate into `sh -c &lt;cmd&gt;` lines without injection risk.
 * Port of bumpy's `sq()` helper (RFC §19.4).
 * @example
 *   sq("hello")        // returns "'hello'"
 *   sq("it's fine")    // returns "'it'\\''s fine'"
 *   sq("$(rm -rf /)")  // returns "'$(rm -rf /)'"
 */
export const sq = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

/**
 * Windows `cmd.exe` analogue of {@link sq}. `cmd.exe` does not treat single
 * quotes as quoting characters, so `sq()` gives no protection there — a value
 * like a registry URL containing shell metacharacters would break out of its
 * argument slot. Wrapping in double quotes makes those metacharacters (pipe,
 * redirection, caret, parentheses, and whitespace) literal; embedded double
 * quotes are doubled per the cmd convention.
 *
 * Caveat: `%VAR%` / delayed-`!VAR!` expansion still happens inside double
 * quotes. That residual is acceptable because custom commands are gated behind
 * `allowCustomCommands`, and the substituted token values are the maintainer's
 * own (package name — charset-validated — version, tag, registry).
 * @example
 *   cmdq("hello")            // returns '"hello"'
 *   cmdq('say "hi"')         // returns '"say ""hi"""'
 */
export const cmdq = (value: string): string => `"${value.replaceAll(`"`, `""`)}"`;

/**
 * Quote a token value for whichever shell will run the command — `sh -c` on
 * POSIX, `cmd /c` on Windows. The orchestrator and shell action both pick the
 * shell from `process.platform`, so the quoting must match that decision.
 */
export const shellQuote = (value: string, isWindows: boolean = process.platform === "win32"): string => (isWindows ? cmdq(value) : sq(value));
