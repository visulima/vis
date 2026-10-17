/**
 * Writes one line of report output verbatim.
 *
 * Deliberately not `pail.info`: the pretty reporter frames every call in a
 * full-width timestamped rule plus a blank line, so a five-field stats
 * block rendered as ~20 terminal lines and the numbers scrolled the
 * directory path off screen. These lines are tabular data, not log events.
 */
export const printLine = (line: string): void => {
    process.stdout.write(`${line}\n`);
};

export const writeJsonLine = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`);
};
