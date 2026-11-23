import { hasAnsiControlCharacters, parseOsc8Uri, tokenizeAnsi } from "./ansi-tokenizer";

const sgrParametersRegex = /^[\d:;]*$/;

// C0 controls other than tab, newline and ESC (which starts every escape sequence), plus DEL.
// A stray BEL, backspace or carriage return in text moves or rings the terminal and overwrites
// neighbouring cells (a CRLF would punch through a box border), so none of them are kept.
// eslint-disable-next-line no-control-regex
const strayControlCharacters = /[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g;

const stripStrayControlCharacters = (text: string): string => text.replaceAll(strayControlCharacters, "");

// OSC 8 (hyperlinks) is the only OSC sequence the renderer needs. Every
// other OSC introducer is stripped so attacker-controlled text cannot
// hijack the terminal title (OSC 0/1/2), write the user's clipboard
// (OSC 52), query/set the palette (OSC 4/10/11), or pop a notification
// (OSC 9). A hyperlink is only kept when it is well-formed, so control
// bytes cannot ride along in its parameters or URI.

// Strip ANSI escape sequences that would conflict with Ink's layout.
// Preserved: SGR sequences (colors, bold, etc. - end with 'm') and
// OSC 8 hyperlink sequences (ESC ]8 / C1 OSC 8).
// Stripped: cursor movement, screen clearing, non-hyperlink OSC, and other
// control sequences.
const sanitizeAnsi = (text: string): string => {
    if (!hasAnsiControlCharacters(text)) {
        return stripStrayControlCharacters(text);
    }

    let output = "";

    for (const token of tokenizeAnsi(text)) {
        if (token.type === "text") {
            output += stripStrayControlCharacters(token.value);
            continue;
        }

        if (token.type === "osc" && parseOsc8Uri(token.value) !== undefined) {
            output += token.value;
            continue;
        }

        if (token.type === "csi" && token.finalCharacter === "m" && token.intermediateString === "" && sgrParametersRegex.test(token.parameterString)) {
            output += token.value;
        }
    }

    return output;
};

export default sanitizeAnsi;
