/**
 * Escaping for GitHub Actions workflow commands (`::error file=…::message`).
 *
 * The runner parses these from stdout, so a `%`, a newline or a comma in a
 * finding must be percent-encoded or it terminates the command early.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 */

/** Message bodies need `%`, `\r` and `\n` encoded, in that order. */
export const encodeWorkflowMessage = (value: string): string => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** Property values are also comma-, colon- and equals-sensitive. */
export const encodeWorkflowProperty = (value: string): string =>
    encodeWorkflowMessage(value).replaceAll(",", "%2C").replaceAll(":", "%3A").replaceAll("=", "%3D");
