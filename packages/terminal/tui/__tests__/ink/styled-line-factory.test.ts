import { describe, expect, it } from "vitest";

import { styledLineWidth } from "../../src/ink/measure-text";
import { textToStyledLine } from "../../src/ink/styled-line-factory";

describe(textToStyledLine, () => {
    it("attaches a well-formed link to the text it wraps", () => {
        expect.assertions(3);

        const line = textToStyledLine("\u001B]8;id=a;https://example.com\u0007hi\u001B]8;;\u0007!");

        expect(line.getText()).toBe("hi!");
        expect(line.getLink(0)).toBe("https://example.com");
        expect(line.getLink(2)).toBeUndefined();
    });

    it.each([
        ["a control character in the URI", "\u001B]8;;https://exa\u0001mple.com\u0007"],
        ["an escaped ESC in the URI", "\u001B]8;;https://example.com/\u001B\u001Bx\u001B\\"],
        ["a missing separator", "\u001B]8;https://example.com\u0007"],
    ])("does not link text after an OSC 8 sequence with %s", (_name, sequence) => {
        expect.assertions(2);

        const line = textToStyledLine(`${sequence}hi`);

        expect(line.getText()).toBe("hi");
        expect(line.getLink(0)).toBeUndefined();
    });

    it("keeps an open link when a malformed OSC 8 sequence appears", () => {
        expect.assertions(1);

        const line = textToStyledLine("\u001B]8;;https://example.com\u0007a\u001B]8;broken\u0007b");

        expect(line.getLink(1)).toBe("https://example.com");
    });

    it("does not treat other OSC sequences that contain 8; as a link close", () => {
        expect.assertions(1);

        const line = textToStyledLine("\u001B]8;;https://example.com\u0007a\u001B]52;c;8;;\u0007b");

        expect(line.getLink(1)).toBe("https://example.com");
    });

    it("keeps a combining mark after a hyperlink sequence in its base cell", () => {
        expect.assertions(3);

        const line = textToStyledLine("\u001B]8;;https://example.com\u0007e\u001B]8;;\u0007\u0301x");

        expect(line).toHaveLength(2);
        expect(line.getValue(0)).toBe("e\u0301");
        expect(line.getValue(1)).toBe("x");
    });

    it("keeps a combining mark after an SGR sequence in its base cell", () => {
        expect.assertions(2);

        const line = textToStyledLine("e\u001B[1m\u0301x");

        expect(line).toHaveLength(2);
        expect(line.getValue(0)).toBe("e\u0301");
    });

    it("measures a combining mark after a hyperlink sequence as zero width", () => {
        expect.assertions(1);

        expect(styledLineWidth(textToStyledLine("\u001B]8;;https://example.com\u0007e\u001B]8;;\u0007\u0301x"))).toBe(2);
    });

    it("keeps consecutive combining marks separated by escape sequences in one cell", () => {
        expect.assertions(2);

        const line = textToStyledLine("e\u001B[1m\u0301\u001B[0m\u0302x");

        expect(line).toHaveLength(2);
        expect(line.getValue(0)).toBe("e\u0301\u0302");
    });

    it("rejects a malformed C1-introduced hyperlink", () => {
        expect.assertions(1);

        expect(textToStyledLine("\u009D8;https://example.com\u009Chi").getLink(0)).toBeUndefined();
    });
});
