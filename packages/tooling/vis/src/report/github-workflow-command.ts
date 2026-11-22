/**
 * GitHub Actions workflow commands (`::error file=…::message`).
 *
 * The runner parses these from stdout, so a `%`, a newline or a comma in a
 * finding must be percent-encoded or it terminates the command early. The
 * runner decodes only `%25 %0D %0A` in messages and additionally `%3A %2C` in
 * properties, so `=` is left as is.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 */

const encodeMessage = (value: string): string => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const encodeProperty = (value: string): string => encodeMessage(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

/** Annotation properties are emitted in this order, whatever the caller's key order. */
const PROPERTY_ORDER = ["file", "line", "endLine", "col", "endColumn", "title"];

const rank = (key: string): number => {
    const index = PROPERTY_ORDER.indexOf(key);

    return index === -1 ? PROPERTY_ORDER.length : index;
};

/** One newline-terminated workflow command; `undefined` properties are skipped. */
export const workflowCommand = (command: string, properties: Record<string, number | string | undefined>, message: string): string => {
    const encoded = Object.entries(properties)
        .toSorted(([a], [b]) => rank(a) - rank(b))
        .filter((entry): entry is [string, number | string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${encodeProperty(String(value))}`)
        .join(",");

    return `::${command}${encoded ? ` ${encoded}` : ""}::${encodeMessage(message)}\n`;
};
