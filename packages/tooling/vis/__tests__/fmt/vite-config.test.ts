import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findViteConfigFile, VITE_CONFIG_FILES } from "../../src/fmt/vite-config";

let root: string;

describe(findViteConfigFile, () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-fmt-vite-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it.each(VITE_CONFIG_FILES)("finds %s when it carries a fmt key", (name) => {
        expect.assertions(1);

        writeFileSync(join(root, name), "export default { fmt: { semi: false } };\n");

        expect(findViteConfigFile(root)).toBe(join(root, name));
    });

    it.each([
        ["a shorthand key", "const fmt = {};\nexport default { fmt };\n"],
        ["a quoted key", 'export default { "fmt": {} };\n'],
        ["a key before more keys", "export default { fmt: {}, test: {} };\n"],
    ])("detects %s", (_name, source) => {
        expect.assertions(1);

        writeFileSync(join(root, "vite.config.ts"), source);

        expect(findViteConfigFile(root)).toBe(join(root, "vite.config.ts"));
    });

    it.each([
        ["no fmt at all", "export default { plugins: [] };\n"],
        ["fmt inside a longer word", "export default { fmtOnSave: true, fmts: [] };\n"],
        ["fmt in a comment", "// fmt is configured in .oxfmtrc.json\nexport default {};\n"],
    ])("ignores %s", (_name, source) => {
        expect.assertions(1);

        writeFileSync(join(root, "vite.config.ts"), source);

        expect(findViteConfigFile(root)).toBeUndefined();
    });

    it("returns undefined when there is no Vite config", () => {
        expect.assertions(1);

        expect(findViteConfigFile(root)).toBeUndefined();
    });
});
