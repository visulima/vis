import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModuleLoader } from "../../src/fmt/options";
import { describeFmtSource, resolveFmtOptions } from "../../src/fmt/resolve-options";

let root: string;

const loadModule: ModuleLoader = async (path) => (await import(pathToFileURL(path).href)) as Record<string, unknown>;

const write = (name: string, content: string): void => {
    writeFileSync(join(root, name), content);
};

describe("fmt option resolution", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-fmt-resolve-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    describe(resolveFmtOptions, () => {
        it("falls back to oxfmt defaults when no source exists", async () => {
            expect.assertions(4);

            const resolution = await resolveFmtOptions({ loadModule, root });

            expect(resolution.source).toBe("defaults");
            expect(resolution.config).toBeUndefined();
            expect(resolution.file).toBeUndefined();
            expect(resolution.warnings).toStrictEqual([]);
        });

        it("uses vis.config fmt.options whole, with fmt.overrides and fmt.ignorePatterns", async () => {
            expect.assertions(3);

            const resolution = await resolveFmtOptions({
                fmtConfig: { ignorePatterns: ["dist"], options: { semi: false }, overrides: [{ files: ["*.md"], options: { printWidth: 60 } }] },
                loadModule,
                root,
            });

            expect(resolution.source).toBe("vis.config");
            expect(resolution.config).toStrictEqual({ ignorePatterns: ["dist"], overrides: [{ files: ["*.md"], options: { printWidth: 60 } }], semi: false });
            expect(resolution.warnings).toStrictEqual([]);
        });

        it.each([
            ["only fmt.options", { options: { semi: false } }, { semi: false }],
            ["only fmt.overrides", { overrides: [{ files: ["*.md"], options: { semi: false } }] }, { overrides: [{ files: ["*.md"], options: { semi: false } }] }],
            ["only fmt.ignorePatterns", { ignorePatterns: ["dist"] }, { ignorePatterns: ["dist"] }],
            ["an empty fmt.options", { options: {} }, {}],
        ])("treats %s as an existing vis.config source", async (_name, fmtConfig, expected) => {
            expect.assertions(2);

            const resolution = await resolveFmtOptions({ fmtConfig, loadModule, root });

            expect(resolution.source).toBe("vis.config");
            expect(resolution.config).toStrictEqual(expected);
        });

        it("does not treat fmt keys that are not options as a source", async () => {
            expect.assertions(1);

            const { source } = await resolveFmtOptions({ fmtConfig: { engine: "oxfmt" }, loadModule, root });

            expect(source).toBe("defaults");
        });

        it.each([".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts"])("detects %s without parsing it", async (name) => {
            expect.assertions(4);

            write(name, "this is not valid json or ts");

            const resolution = await resolveFmtOptions({ loadModule, root });

            expect(resolution.source).toBe("oxfmtrc");
            expect(resolution.file).toBe(join(root, name));
            expect(resolution.config).toBeUndefined();
            expect(resolution.warnings).toStrictEqual([]);
        });

        it.each([".oxfmtrc", ".oxfmtrc.ts", "oxfmt.config.js", "oxfmt.config.mjs", "oxfmt.config.cjs", "oxfmt.config.json"])(
            "does not count %s, which oxfmt does not discover",
            async (name) => {
                expect.assertions(1);

                write(name, "{}");

                const { source } = await resolveFmtOptions({ loadModule, root });

                expect(source).toBe("defaults");
            },
        );

        it("maps the Prettier config when it is the first source", async () => {
            expect.assertions(4);

            write(".prettierrc.json", JSON.stringify({ semi: false }));
            write(".prettierignore", "dist\n");

            const resolution = await resolveFmtOptions({ loadModule, root });

            expect(resolution.source).toBe("prettier");
            expect(resolution.file).toBe(join(root, ".prettierrc.json"));
            expect(resolution.config).toStrictEqual({ ignorePatterns: ["dist"], printWidth: 80, semi: false, sortPackageJson: false });
            expect(resolution.warnings).toStrictEqual([expect.stringContaining("printWidth")]);
        });

        it("takes printWidth from a universal .editorconfig section and notes glob-scoped ones", async () => {
            expect.assertions(3);

            write(".prettierrc.json", "{}");
            write(".editorconfig", "[*]\nmax_line_length = 120\n[*.md]\nmax_line_length = 60\n");

            const resolution = await resolveFmtOptions({ loadModule, root });

            expect(resolution.config?.printWidth).toBe(120);
            expect(resolution.warnings).toHaveLength(1);
            expect(resolution.warnings[0]).toContain("*.md");
        });

        it("prefers .oxfmtrc over Prettier and warns once, naming both", async () => {
            expect.assertions(4);

            write(".oxfmtrc.json", "{}");
            write(".prettierrc.json", "{}");

            const resolution = await resolveFmtOptions({ loadModule, root });

            expect(resolution.source).toBe("oxfmtrc");
            expect(resolution.config).toBeUndefined();
            expect(resolution.warnings).toHaveLength(1);
            expect(resolution.warnings[0]).toMatch(/\.oxfmtrc\.json.*\.prettierrc\.json|\.prettierrc\.json.*\.oxfmtrc\.json/);
        });

        it("prefers vis.config over .oxfmtrc and Prettier, with one warning naming every ignored source", async () => {
            expect.assertions(4);

            write(".oxfmtrc.json", "{}");
            write(".prettierrc.json", "{}");

            const resolution = await resolveFmtOptions({ fmtConfig: { options: { semi: false } }, loadModule, root });

            expect(resolution.source).toBe("vis.config");
            expect(resolution.warnings).toHaveLength(1);
            expect(resolution.warnings[0]).toContain(".oxfmtrc.json");
            expect(resolution.warnings[0]).toContain(".prettierrc.json");
        });

        it("prefers vis.config over Prettier alone", async () => {
            expect.assertions(3);

            write(".prettierrc.json", "{}");

            const resolution = await resolveFmtOptions({ fmtConfig: { options: {} }, loadModule, root });

            expect(resolution.source).toBe("vis.config");
            expect(resolution.warnings).toHaveLength(1);
            expect(resolution.warnings[0]).toContain(".prettierrc.json");
        });

        it("does not merge sources: an .oxfmtrc that is chosen carries nothing from the Prettier config", async () => {
            expect.assertions(1);

            write(".oxfmtrc.json", JSON.stringify({ semi: true }));
            write(".prettierrc.json", JSON.stringify({ printWidth: 80, semi: false }));

            const { config } = await resolveFmtOptions({ loadModule, root });

            expect(config).toBeUndefined();
        });

        it("does not read a Prettier config that is ignored, so a broken one cannot fail the run", async () => {
            expect.assertions(1);

            write(".oxfmtrc.json", "{}");
            write(".prettierrc.json", "{ nope");

            await expect(resolveFmtOptions({ loadModule, root })).resolves.toMatchObject({ source: "oxfmtrc" });
        });

        it("fails with a message-only error when the chosen Prettier config is broken", async () => {
            expect.assertions(1);

            write(".prettierrc.json", "{ nope");

            await expect(resolveFmtOptions({ loadModule, root })).rejects.toThrow(/\.prettierrc\.json/);
        });
    });

    describe(describeFmtSource, () => {
        it("names each source for the run notice", () => {
            expect.assertions(4);

            expect(describeFmtSource({ source: "vis.config", warnings: [] }, root)).toBe("vis.config fmt.options");
            expect(describeFmtSource({ file: join(root, ".oxfmtrc.json"), source: "oxfmtrc", warnings: [] }, root)).toBe(".oxfmtrc.json");
            expect(describeFmtSource({ file: join(root, ".prettierrc.json"), source: "prettier", warnings: [] }, root)).toBe(".prettierrc.json (mapped to oxfmt options)");
            expect(describeFmtSource({ source: "defaults", warnings: [] }, root)).toBe("oxfmt defaults");
        });
    });
});
