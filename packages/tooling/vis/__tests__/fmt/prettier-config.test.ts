import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { dirname, join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModuleLoader } from "../../src/fmt/options";
import {
    findPrettierConfigFile,
    mapPrettierConfig,
    parseEditorconfigMaxLineLength,
    readEditorconfigPrintWidth,
    readPrettierConfig,
    readPrettierIgnore,
} from "../../src/fmt/prettier-config";
import { PRETTIER_CASES, UNSUPPORTED_BY_MIGRATE } from "./prettier-cases";

let root: string;

const write = (files: Record<string, string>): void => {
    for (const [name, content] of Object.entries(files)) {
        const path = join(root, name);

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
};

const loadModule: ModuleLoader = async (path) => (await import(pathToFileURL(path).href)) as Record<string, unknown>;

describe("prettier config", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-fmt-prettier-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    describe(mapPrettierConfig, () => {
        it("copies the options oxfmt shares with Prettier and pins printWidth to 80 and sortPackageJson to false", () => {
            expect.assertions(2);

            const { config, warnings } = mapPrettierConfig({ semi: false, singleQuote: true, tabWidth: 4 });

            expect(config).toStrictEqual({ ignorePatterns: [], printWidth: 80, semi: false, singleQuote: true, sortPackageJson: false, tabWidth: 4 });
            expect(warnings).toStrictEqual([expect.stringContaining("printWidth")]);
        });

        it("keeps an explicit printWidth without a warning", () => {
            expect.assertions(2);

            const { config, warnings } = mapPrettierConfig({ printWidth: 100 });

            expect(config.printWidth).toBe(100);
            expect(warnings).toStrictEqual([]);
        });

        it("uses the .editorconfig max_line_length when printWidth is unset", () => {
            expect.assertions(2);

            const { config, warnings } = mapPrettierConfig({}, { editorconfigPrintWidth: 120 });

            expect(config.printWidth).toBe(120);
            expect(warnings).toStrictEqual([]);
        });

        it("prefers an explicit printWidth over .editorconfig", () => {
            expect.assertions(1);

            expect(mapPrettierConfig({ printWidth: 90 }, { editorconfigPrintWidth: 120 }).config.printWidth).toBe(90);
        });

        it("drops endOfLine auto, experimentalTernaries, unknown options and unknown plugins with one warning each", () => {
            expect.assertions(7);

            const { config, warnings } = mapPrettierConfig({
                $schema: "x",
                endOfLine: "auto",
                experimentalTernaries: true,
                foo: 1,
                plugins: ["prettier-plugin-jsdoc", { languages: [] }],
                printWidth: 80,
            });

            expect(config).toStrictEqual({ ignorePatterns: [], printWidth: 80, sortPackageJson: false });
            expect(warnings).toHaveLength(5);
            expect(warnings.join("\n")).toContain("endOfLine");
            expect(warnings.join("\n")).toContain("experimentalTernaries");
            expect(warnings.join("\n")).toContain("foo");
            expect(warnings.join("\n")).toContain("prettier-plugin-jsdoc");
            expect(warnings.join("\n")).toContain("custom plugin module");
        });

        it("maps prettier-plugin-packagejson to sortPackageJson", () => {
            expect.assertions(1);

            expect(mapPrettierConfig({ plugins: ["prettier-plugin-packagejson"], printWidth: 80 }).config.sortPackageJson).toStrictEqual({});
        });

        it("maps prettier-plugin-tailwindcss options to sortTailwindcss and drops regex entries", () => {
            expect.assertions(2);

            const { config, warnings } = mapPrettierConfig({
                plugins: ["prettier-plugin-tailwindcss"],
                printWidth: 80,
                tailwindAttributes: ["x", "/^data-/"],
                tailwindConfig: "./tw.js",
                tailwindFunctions: ["cn"],
                tailwindPreserveDuplicates: true,
                tailwindPreserveWhitespace: true,
                tailwindStylesheet: "./app.css",
            });

            expect(config.sortTailwindcss).toStrictEqual({
                attributes: ["x"],
                config: "./tw.js",
                functions: ["cn"],
                preserveDuplicates: true,
                preserveWhitespace: true,
                stylesheet: "./app.css",
            });
            expect(warnings).toStrictEqual([expect.stringContaining("/^data-/")]);
        });

        it("emits an empty sortTailwindcss when the plugin has no options, and nothing without the plugin", () => {
            expect.assertions(2);

            expect(mapPrettierConfig({ plugins: ["prettier-plugin-tailwindcss"], printWidth: 80 }).config.sortTailwindcss).toStrictEqual({});
            expect(mapPrettierConfig({ printWidth: 80, tailwindConfig: "./tw.js" }).config).not.toHaveProperty("sortTailwindcss");
        });

        it("maps the svelte and astro plugins to their built-in options", () => {
            expect.assertions(2);

            const { config } = mapPrettierConfig({
                astroCompressHTML: true,
                plugins: ["prettier-plugin-svelte", "prettier-plugin-astro"],
                printWidth: 80,
                svelteSortOrder: "none",
            });

            expect(config.svelte).toStrictEqual({ sortOrder: "none" });
            expect(config.astro).toStrictEqual({ compressHTML: "html" });
        });

        it("maps overrides, parser to associations, and skips overrides with nothing left to apply", () => {
            expect.assertions(3);

            const { config, warnings } = mapPrettierConfig({
                overrides: [
                    { files: "*.md", options: { printWidth: 60 } },
                    { excludeFiles: "c.js", files: ["a.js"], options: { parser: "babel", semi: false } },
                    { files: "*.weird", options: { parser: "nope" } },
                    { files: "*.none" },
                ],
                printWidth: 80,
            });

            expect(config.overrides).toStrictEqual([
                { files: ["*.md"], options: { printWidth: 60 } },
                { excludeFiles: ["c.js"], files: ["a.js"], options: { semi: false } },
            ]);
            expect(config.associations).toStrictEqual([{ excludeFiles: ["c.js"], files: ["a.js"], language: "javascript" }]);
            expect(warnings).toStrictEqual([expect.stringContaining("nope")]);
        });

        it("turns .prettierignore lines into ignorePatterns", () => {
            expect.assertions(1);

            expect(mapPrettierConfig({ printWidth: 80 }, { ignorePatterns: ["dist", "!keep.js"] }).config.ignorePatterns).toStrictEqual(["dist", "!keep.js"]);
        });

        it("warns that a JS config was evaluated as static values", () => {
            expect.assertions(1);

            expect(mapPrettierConfig({ printWidth: 80 }, { sourceFile: "/p/prettier.config.mjs" }).warnings).toStrictEqual([expect.stringContaining("static values")]);
        });

        it("never mutates its input", () => {
            expect.assertions(1);

            const input = { overrides: [{ files: "*.md", options: { parser: "markdown", semi: false } }], plugins: ["prettier-plugin-packagejson"] };
            const copy = structuredClone(input);

            mapPrettierConfig(input);

            expect(input).toStrictEqual(copy);
        });
    });

    describe(parseEditorconfigMaxLineLength, () => {
        it("reads max_line_length from the universal section", () => {
            expect.assertions(1);

            expect(parseEditorconfigMaxLineLength("root = true\n\n[*]\nindent_size = 2\nmax_line_length = 120\n")).toStrictEqual({ scoped: [], universal: 120 });
        });

        it("lets a later universal section win, ignores off, and reports glob-scoped values separately", () => {
            expect.assertions(2);

            expect(parseEditorconfigMaxLineLength("[*]\nmax_line_length = 100\n[**]\nMax_Line_Length = 90\n")).toStrictEqual({ scoped: [], universal: 90 });
            expect(parseEditorconfigMaxLineLength("[*]\nmax_line_length = off\n[*.md]\nmax_line_length = 60\n# max_line_length = 1\n")).toStrictEqual({ scoped: ["*.md"] });
        });
    });

    describe(readEditorconfigPrintWidth, () => {
        it("returns undefined without a .editorconfig and the value with one", () => {
            expect.assertions(3);

            expect(readEditorconfigPrintWidth(root)).toStrictEqual({ scoped: [] });

            write({ ".editorconfig": "[*]\nmax_line_length = 110\n" });

            expect(readEditorconfigPrintWidth(root).universal).toBe(110);
            expect(readEditorconfigPrintWidth(root).scoped).toStrictEqual([]);
        });
    });

    describe(readPrettierIgnore, () => {
        it("keeps non-comment, non-blank lines trimmed", () => {
            expect.assertions(2);

            expect(readPrettierIgnore(root)).toStrictEqual([]);

            write({ ".prettierignore": "dist\n# c\n\n  foo/*.js  \n!keep.js\n" });

            expect(readPrettierIgnore(root)).toStrictEqual(["dist", "foo/*.js", "!keep.js"]);
        });
    });

    describe("reading Prettier config files", () => {
        it.each(PRETTIER_CASES.filter((entry) => !Object.keys(entry.files).includes("package.json")))("finds $name", ({ files }) => {
            expect.assertions(1);

            write(files);

            expect(findPrettierConfigFile(root)).toBeDefined();
        });

        it("finds nothing in an empty directory or a package.json without a prettier key", () => {
            expect.assertions(2);

            expect(findPrettierConfigFile(root)).toBeUndefined();

            write({ "package.json": "{}" });

            expect(findPrettierConfigFile(root)).toBeUndefined();
        });

        it.each(UNSUPPORTED_BY_MIGRATE)("reads $name and maps it", async ({ expected, files }) => {
            expect.assertions(1);

            write(files);

            const found = await readPrettierConfig(root, loadModule);
            const { config } = mapPrettierConfig(found!.config, { ignorePatterns: [], sourceFile: found!.file });

            expect(config).toMatchObject(expected);
        });

        it("reads package.json#prettier, and a string there resolves a shared config package", async () => {
            expect.assertions(2);

            write({ "package.json": JSON.stringify({ prettier: { semi: false } }) });

            const inline = await readPrettierConfig(root, loadModule);

            expect(inline?.config).toStrictEqual({ semi: false });

            write({
                "node_modules/shared-prettier/index.cjs": "module.exports = { tabWidth: 7 };\n",
                "node_modules/shared-prettier/package.json": JSON.stringify({ main: "index.cjs", name: "shared-prettier", version: "1.0.0" }),
                "package.json": JSON.stringify({ prettier: "shared-prettier" }),
            });

            const shared = await readPrettierConfig(root, loadModule);

            expect(shared?.config).toStrictEqual({ tabWidth: 7 });
        });

        it("follows Prettier's search order: package.json, then .prettierrc, then prettier.config.*", async () => {
            expect.assertions(2);

            write({ ".prettierrc.json": '{"tabWidth":2}', "prettier.config.mjs": "export default { tabWidth: 3 };\n" });

            const first = await readPrettierConfig(root, loadModule);

            expect(first?.config).toStrictEqual({ tabWidth: 2 });

            write({ "package.json": JSON.stringify({ prettier: { tabWidth: 1 } }) });

            const second = await readPrettierConfig(root, loadModule);

            expect(second?.config).toStrictEqual({ tabWidth: 1 });
        });

        it("throws a message-only error for an unreadable config", async () => {
            expect.assertions(1);

            write({ ".prettierrc.json": "{ nope" });

            await expect(readPrettierConfig(root, loadModule)).rejects.toThrow(/\.prettierrc\.json/);
        });

        it("rejects a config that is not an object", async () => {
            expect.assertions(1);

            write({ ".prettierrc.json": "[1]" });

            await expect(readPrettierConfig(root, loadModule)).rejects.toThrow(/must be an object/);
        });
    });
});
