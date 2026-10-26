const REGEX_SPECIAL_CHARS_RE = /[$()+.?[\\\]^{|}]/g;

/**
 * Compiles a pattern whose only wildcard is `*` into an anchored regex. `*`
 * matches any run of characters and everything else is literal.
 */
export const starGlobToRegExp = (pattern: string): RegExp => {
    // `**` matches the same as `*`, and collapsing runs avoids nested `.*` groups that backtrack badly on user input.
    const escaped = pattern.replaceAll(REGEX_SPECIAL_CHARS_RE, String.raw`\$&`).replaceAll(/\*+/g, ".*");

    return new RegExp(`^${escaped}$`);
};
