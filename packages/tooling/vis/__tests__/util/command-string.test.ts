import { describe, expect, it } from "vitest";

import { quoteArgument, splitCommandString } from "../../src/util/command-string";

describe(quoteArgument, () => {
    it.each([
        ["build"],
        ["{packages/a}^..."],
        ["/usr/local/bin/node"],
        [String.raw`C:\Program Files\nodejs\node.exe`],
        ["{my packages/a}^..."],
        ["say \"hi\""],
    ])("round-trips %j through splitCommandString", (value) => {
        expect.assertions(1);

        expect(splitCommandString(`run ${quoteArgument(value)} --flag`)).toStrictEqual(["run", value, "--flag"]);
    });

    it("leaves a token that needs no quoting bare", () => {
        expect.assertions(1);

        expect(quoteArgument("{packages/a}^...")).toBe("{packages/a}^...");
    });
});
