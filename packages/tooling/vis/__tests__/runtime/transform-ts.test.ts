import { describe, expect, it } from "vitest";

import { transformTs } from "#native";

describe(transformTs, () => {
    it("transpiles TypeScript to JavaScript", () => {
        expect.assertions(1);

        const { code } = transformTs("/work/vis.config.ts", "const answer: number = 42;\nexport default answer;\n");

        expect(code).toContain("const answer = 42");
    });

    it("keeps the first line of a parse failure stable and names the location of the syntax error", () => {
        expect.assertions(2);

        const source = "export default {\n  name: \"x\",\n  value: ,\n};\n";
        let message = "";

        try {
            transformTs("/work/vis.config.ts", source);
        } catch (error) {
            message = (error as Error).message;
        }

        expect(message.split("\n")[0]).toBe("vis-native: failed to parse /work/vis.config.ts");
        expect(message).toContain("/work/vis.config.ts:3:10: ");
    });
});
