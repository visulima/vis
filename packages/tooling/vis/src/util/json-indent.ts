const JSON_INDENT_REGEX = /\n(\s+)/;

/**
 * Sniff the indentation of a JSON document from its first indented line, in the
 * shape `JSON.stringify` takes: a space count, or the literal string for tabs.
 * Falls back to 2 when the content has no indented line.
 */
// eslint-disable-next-line sonarjs/function-return-type -- JSON.stringify's indent argument accepts either a number (space count) or a string (tab/whitespace literal); preserving both lets us round-trip tabs without dropping them
export const detectJsonIndent = (content: string): number | string => {
    const match = JSON_INDENT_REGEX.exec(content);

    if (!match) {
        return 2;
    }

    // Preserve tabs as-is; for spaces, return the count
    const indent = match[1];

    if (!indent) {
        return 2;
    }

    return indent.includes("\t") ? indent : indent.length;
};
