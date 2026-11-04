/**
 * Minimal quote-aware argv splitter. Handles single and double quotes,
 * backslash escapes (both outside and inside double quotes, matching
 * POSIX shell semantics), and collapses runs of whitespace — enough for
 * the shell-like syntax users put in their staged config without
 * dragging in `string-argv`.
 *
 * Inside single quotes everything is literal (POSIX semantics). Inside
 * double quotes, `\"` and `\\` are interpreted; other backslash
 * sequences are preserved verbatim.
 *
 * Throws on an unterminated quote; callers map that to their own error or
 * treat the command as unparseable.
 */
export const splitCommandString = (input: string): string[] => {
    const tokens: string[] = [];
    let buffer = "";
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < input.length; i += 1) {
        const character = input[i];

        if (character === undefined) {
            break;
        }

        // Backslash escapes: outside any quotes, escape the next character verbatim.
        // Inside double quotes, only `\"` and `\\` are recognised; other sequences keep the backslash.
        // Inside single quotes backslashes are literal (POSIX sh behaviour).
        if (character === "\\" && !inSingle && i + 1 < input.length) {
            const next = input[i + 1];

            if (next !== undefined) {
                if (inDouble && next !== "\"" && next !== "\\") {
                    buffer += character;
                    buffer += next;
                } else {
                    buffer += next;
                }

                i += 1;

                continue;
            }
        }

        if (character === "\"" && !inSingle) {
            inDouble = !inDouble;

            continue;
        }

        if (character === "'" && !inDouble) {
            inSingle = !inSingle;

            continue;
        }

        if (!inSingle && !inDouble && /\s/.test(character)) {
            if (buffer.length > 0) {
                tokens.push(buffer);
                buffer = "";
            }

            continue;
        }

        buffer += character;
    }

    if (inSingle || inDouble) {
        throw new Error(`Unterminated ${inSingle ? "single" : "double"} quote in command: ${input}`);
    }

    if (buffer.length > 0) {
        tokens.push(buffer);
    }

    return tokens;
};

/**
 * The inverse of {@link splitCommandString} for one token: returns it bare
 * when it needs no quoting, and double-quoted with `\\` and `"` escaped
 * otherwise.
 */
export const quoteArgument = (value: string): string => (/^[\w./:@^{}-]+$/.test(value) ? value : `"${value.replaceAll("\\", "\\\\").replaceAll("\"", String.raw`\"`)}"`);
