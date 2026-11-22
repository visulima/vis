import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectPrettier, migratePrettier, planPrettierMigration, renderFmtSnippet, rewritePrettierScript } from "../../../src/commands/migrate/prettier";
import { MIGRATIONS } from "../../../src/commands/migrate/registry";
import { createMigrationReport } from "../../../src/commands/migrate/types";
import type { ModuleLoader } from "../../../src/fmt/options";
import { cleanupTemporaryDirectory, createMockLogger, createTemporaryDirectory } from "../../test-helpers";

const loadModule: ModuleLoader = async (path) => (await import(pathToFileURL(path).href)) as Record<string, unknown>;

describe("migrate-prettier", () => {
    let root: string;

    const write = (name: string, content: string): void => {
        writeFileSync(join(root, name), content);
    };
    const writePackage = (pkg: Record<string, unknown>): void => {
        write("package.json", JSON.stringify({ name: "x", ...pkg }, undefined, 2));
    };
    const readPackage = (): Record<string, any> => JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;
    const visConfig = (): string => readFileSync(join(root, "vis.config.ts"), "utf8");
    const run = async (dryRun = false, extra: { visConfig?: { fmt?: Record<string, unknown> } } = {}) => {
        const logger = createMockLogger();
        const report = createMigrationReport();
        const result = await migratePrettier(root, { dryRun, ...extra }, logger, report, loadModule);

        return { logger, report, result };
    };

    beforeEach(() => {
        root = createTemporaryDirectory("vis-migrate-prettier-");
    });

    afterEach(() => {
        cleanupTemporaryDirectory(root);
    });

    describe(rewritePrettierScript, () => {
        it.each([
            ["prettier --write .", "vis fmt"],
            ["prettier --check .", "vis fmt --check"],
            ["prettier -w src test", "vis fmt src test"],
            ["prettier -c \"src/**/*.ts\"", "vis fmt --check \"src/**/*.ts\""],
            ["pnpm exec prettier --write --ignore-unknown .", "vis fmt"],
            ["npx prettier --check .", "vis fmt --check"],
            ["CI=1 yarn prettier --check src", "CI=1 vis fmt --check src"],
            ["pnpm lint && prettier --check . || echo fail", "pnpm lint && vis fmt --check || echo fail"],
            [String.raw`prettier --write "src/**/*.+(js|ts)" && echo "a && b"`, String.raw`vis fmt "src/**/*.+(js|ts)" && echo "a && b"`],
            ["prettier --write 'a b/c.ts'", "vis fmt 'a b/c.ts'"],
        ])("rewrites %s", (input, expected) => {
            expect.assertions(2);

            const result = rewritePrettierScript(input);

            expect(result.status).toBe("rewritten");
            expect(result.value).toBe(expected);
        });

        it.each([
            "yarn run prettier --check .",
            "pnpm dlx prettier --check .",
            "npx --no-install prettier --check .",
            "cross-env X=1 prettier --check .",
            "if test -f x; then prettier --check .; fi",
            "(prettier --check .)",
            "echo prettier",
            'prettier --write "src/**/*.ts',
            String.raw`prettier --write "a\"b.ts"`,
            "prettier --write . src",
        ])("treats %s as a Prettier call it cannot rewrite", (input) => {
            expect.assertions(2);

            const result = rewritePrettierScript(input);

            expect(result.status).toBe("unsupported");
            expect(result.value).toBe(input);
        });

        it("only rewrites explicit files when biome, dprint or ruff keep the adapter orchestration", () => {
            expect.assertions(4);

            const orchestrated = { orchestrated: true };

            expect(rewritePrettierScript("prettier --write .", orchestrated).value).toBe("vis fmt");
            expect(rewritePrettierScript("prettier --write src/a.ts test/b.ts", orchestrated).value).toBe("vis fmt src/a.ts test/b.ts");
            expect(rewritePrettierScript("prettier --write src", orchestrated).status).toBe("unsupported");
            expect(rewritePrettierScript('prettier --write "src/**/*.ts"', orchestrated).status).toBe("unsupported");
        });

        it.each(["prettier --write --cache .", "prettier .", "prettier --list-different .", "prettier --check --write .", "prettier --write --config x.json ."])(
            "leaves %s alone as unsupported",
            (input) => {
                expect.assertions(2);

                const result = rewritePrettierScript(input);

                expect(result.status).toBe("unsupported");
                expect(result.value).toBe(input);
            },
        );

        it("ignores scripts that do not run prettier", () => {
            expect.assertions(2);

            expect(rewritePrettierScript("eslint --config prettier.config.js . && tsc").status).toBe("unchanged");
            expect(rewritePrettierScript("eslint . && tsc -p prettier-plugin-x").status).toBe("unchanged");
        });
    });

    describe(renderFmtSnippet, () => {
        it("unquotes keys at the start of a line but keeps values and glob keys intact", () => {
            expect.assertions(1);

            expect(renderFmtSnippet({ ignorePatterns: ["a\":b"], options: { printWidth: 80 } })).toBe(
                ["    fmt: {", "        ignorePatterns: [", String.raw`            "a\":b"`, "        ],", "        options: {", "            printWidth: 80", "        }", "    }"].join("\n"),
            );
        });
    });

    describe("detection", () => {
        it("finds nothing in an empty workspace", () => {
            expect.assertions(1);

            expect(detectPrettier(root)).toBe(false);
        });

        it.each([
            [".prettierrc", "{}"],
            [".prettierrc.json", "{}"],
            [".prettierrc.yaml", "semi: false\n"],
            ["prettier.config.mjs", "export default {};\n"],
            [".prettierignore", "dist\n"],
        ])("detects %s", (name, content) => {
            expect.assertions(1);

            write(name, content);

            expect(detectPrettier(root)).toBe(true);
        });

        it("detects package.json#prettier, the dependency and a rewritable script", () => {
            expect.assertions(3);

            writePackage({ prettier: { semi: false } });

            expect(detectPrettier(root)).toBe(true);

            writePackage({ devDependencies: { prettier: "^3.0.0" } });

            expect(detectPrettier(root)).toBe(true);

            writePackage({ scripts: { format: "prettier --write ." } });

            expect(detectPrettier(root)).toBe(true);
        });

        it("is registered in the migration list", () => {
            expect.assertions(1);

            expect(MIGRATIONS.map(({ id }) => id)).toContain("prettier");
        });
    });

    describe("config formats", () => {
        it.each([
            [".prettierrc", JSON.stringify({ semi: false, singleQuote: true })],
            [".prettierrc", "semi: false\nsingleQuote: true\n"],
            [".prettierrc.json", JSON.stringify({ semi: false, singleQuote: true })],
            [".prettierrc.yaml", "semi: false\nsingleQuote: true\n"],
            ["prettier.config.mjs", "export default { semi: false, singleQuote: true };\n"],
        ])("migrates %s into vis.config.ts and removes the file", async (name, content) => {
            expect.assertions(7);

            write(name, content);

            const { report, result } = await run();

            expect(result).toBe(true);
            expect(existsSync(join(root, name))).toBe(false);
            expect(existsSync(join(root, `${name}.bak`))).toBe(true);
            expect(visConfig()).toContain("semi: false");
            expect(visConfig()).toContain("singleQuote: true");
            expect(visConfig()).toContain("printWidth: 80");
            expect(report.removedConfigCount).toBe(1);
        });

        it("migrates a prettier.config.js ES module config", async () => {
            expect.assertions(2);

            // A `.js` config is evaluated as ESM only with a module package.
            writePackage({ type: "module" });
            write("prettier.config.js", "export default { semi: false };\n");

            await run();

            expect(visConfig()).toContain("semi: false");
            expect(existsSync(join(root, "prettier.config.js"))).toBe(false);
        });

        it("migrates package.json#prettier and keeps the rest of package.json", async () => {
            expect.assertions(5);

            writePackage({ prettier: { tabWidth: 4 }, scripts: { test: "vitest" } });

            const { report } = await run();

            const pkg = readPackage();

            expect(pkg.prettier).toBeUndefined();
            expect(pkg.scripts.test).toBe("vitest");
            expect(visConfig()).toContain("tabWidth: 4");
            expect(existsSync(join(root, "package.json.bak"))).toBe(true);
            expect(report.removedConfigCount).toBe(1);
        });

        it("maps overrides and .prettierignore", async () => {
            expect.assertions(5);

            write(".prettierrc.json", JSON.stringify({ overrides: [{ files: "*.md", options: { proseWrap: "always" } }] }));
            write(".prettierignore", "# build\ndist\ncoverage/\n");

            await run();

            const config = visConfig();

            expect(config).toContain("overrides: [");
            expect(config).toContain('"*.md"');
            expect(config).toContain("proseWrap");
            expect(config).toContain('"dist"');
            expect(existsSync(join(root, ".prettierignore"))).toBe(false);
        });

        it("keeps a `$` in a pattern intact when inserting into an existing vis.config.ts", async () => {
            expect.assertions(3);

            write("vis.config.ts", 'import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({\n    tasks: {},\n});\n');
            write(".prettierrc.json", "{}");
            write(".prettierignore", "$&-file\n");

            await run();

            expect(visConfig()).toContain('"$&-file"');
            expect(visConfig()).toContain("tasks: {}");
            expect(existsSync(join(root, "vis.config.ts.bak"))).toBe(true);
        });

        it("writes a printWidth of 80 when none is set and uses the editorconfig width when there is one", async () => {
            expect.assertions(2);

            write(".prettierrc.json", "{}");
            write(".editorconfig", "root = true\n\n[*]\nmax_line_length = 120\n");

            await run();

            expect(visConfig()).toContain("printWidth: 120");
            expect(visConfig()).not.toContain("printWidth: 80");
        });

        it("writes the Prettier defaults when only the dependency is declared", async () => {
            expect.assertions(3);

            writePackage({ devDependencies: { prettier: "^3.0.0" } });

            await run();

            expect(visConfig()).toContain("printWidth: 80");
            expect(visConfig()).toContain("sortPackageJson: false");
            expect(readPackage().devDependencies?.prettier).toBeUndefined();
        });
    });

    describe("report", () => {
        it("lists every dropped option and plugin in manualSteps", async () => {
            expect.assertions(5);

            write(".prettierrc.json", JSON.stringify({ endOfLine: "auto", experimentalTernaries: true, plugins: ["prettier-plugin-foo"], semi: false }));

            const { report } = await run();

            const steps = report.manualSteps.join("\n");

            expect(steps).toContain('"endOfLine": "auto"');
            expect(steps).toContain("experimentalTernaries");
            expect(steps).toContain("prettier-plugin-foo");
            expect(steps).toContain("vis fmt --check");
            expect(visConfig()).not.toContain("experimentalTernaries");
        });

        it("reports a parser override that cannot be written", async () => {
            expect.assertions(2);

            write(".prettierrc.json", JSON.stringify({ overrides: [{ files: "*.component.html", options: { parser: "angular" } }] }));

            const { report } = await run();

            expect(report.manualSteps.join("\n")).toContain("associations");
            expect(visConfig()).not.toContain("associations");
        });

        it("reports a nested Prettier config", async () => {
            expect.assertions(1);

            write(".prettierrc.json", "{}");
            writeFileSync(join(root, "package.json"), "{}");

            mkdirSync(join(root, "packages", "a"), { recursive: true });
            writeFileSync(join(root, "packages", "a", ".prettierrc.json"), "{}");

            const { report } = await run();

            expect(report.manualSteps.join("\n")).toContain("nested");
        });

        it("warns about a printWidth pin instead of listing a manual step for it", async () => {
            expect.assertions(2);

            write(".prettierrc.json", JSON.stringify({ semi: false }));

            const { report } = await run();

            expect(report.warnings.join("\n")).toContain("pinned to 80");
            expect(report.manualSteps.join("\n")).not.toContain("pinned to 80");
        });
    });

    describe("package.json", () => {
        it("removes prettier and the covered plugins, and rewrites scripts", async () => {
            expect.assertions(8);

            writePackage({
                devDependencies: { prettier: "^3", "prettier-plugin-packagejson": "^2", "prettier-plugin-tailwindcss": "^0.6", typescript: "^5" },
                scripts: { format: "prettier --write .", "format:check": "prettier --check .", lint: "eslint ." },
            });
            write(".prettierrc.json", JSON.stringify({ plugins: ["prettier-plugin-tailwindcss"], tailwindConfig: "./tailwind.config.js" }));

            const { report } = await run();

            const pkg = readPackage();

            expect(pkg.devDependencies).toStrictEqual({ typescript: "^5" });
            expect(pkg.scripts).toStrictEqual({ format: "vis fmt", "format:check": "vis fmt --check", lint: "eslint ." });
            expect(report.removedPackageCount).toBe(3);
            expect(report.rewrittenScriptCount).toBe(2);
            expect(report.perMigration.prettier).toStrictEqual({ removedConfigCount: 1, removedPackageCount: 3, rewrittenScriptCount: 2 });
            expect(visConfig()).toContain("sortTailwindcss");
            expect(visConfig()).toContain('config: "./tailwind.config.js"');
            expect(report.backupsCreated.some((file) => file.endsWith("package.json.bak"))).toBe(true);
        });

        it("keeps a plugin without an oxfmt equivalent, keeps prettier and lists the plugin", async () => {
            expect.assertions(4);

            writePackage({
                devDependencies: { prettier: "^3", "prettier-plugin-organize-imports": "^4", "prettier-plugin-tailwindcss": "^0.6" },
                scripts: { format: "prettier --write ." },
            });
            write(".prettierrc.json", "{}");

            const { report } = await run();

            const pkg = readPackage();

            expect(pkg.devDependencies).toStrictEqual({ prettier: "^3", "prettier-plugin-organize-imports": "^4" });
            expect(pkg.scripts.format).toBe("vis fmt");
            expect(report.manualSteps.join("\n")).toContain("prettier-plugin-organize-imports has no oxfmt equivalent");
            expect(report.removedPackageCount).toBe(1);
        });

        it("leaves a script alone that uses options vis fmt cannot reproduce, keeps prettier and lists the script", async () => {
            expect.assertions(4);

            writePackage({ devDependencies: { prettier: "^3" }, scripts: { format: "prettier --write --cache ." } });
            write(".prettierrc.json", "{}");

            const { report } = await run();

            const pkg = readPackage();

            expect(pkg.scripts.format).toBe("prettier --write --cache .");
            expect(pkg.devDependencies.prettier).toBe("^3");
            expect(report.manualSteps.join("\n")).toContain('Script "format"');
            expect(report.rewrittenScriptCount).toBe(0);
        });

        it("names a shared config package in the report", async () => {
            expect.assertions(1);

            writePackage({ devDependencies: { prettier: "^3" }, prettier: "./shared-prettier.cjs" });
            write("shared-prettier.cjs", "module.exports = { semi: false };\n");

            const { report } = await run();

            expect(report.manualSteps.join("\n")).toContain("shared config package");
        });
    });

    describe("vis.config", () => {
        it("creates vis.config.ts when there is none", async () => {
            expect.assertions(2);

            write(".prettierrc.json", "{}");

            await run();

            expect(visConfig()).toContain('import { defineConfig } from "@visulima/vis/config";');
            expect(visConfig()).toContain("fmt: {");
        });

        it("removes nothing when vis.config already has an fmt block without options", async () => {
            expect.assertions(4);

            write("vis.config.ts", "export default {\n    fmt: { adapters: {} },\n};\n");
            write(".prettierrc.json", "{}");
            writePackage({ devDependencies: { prettier: "^3" } });

            const { report, result } = await run();

            expect(result).toBe(false);
            expect(existsSync(join(root, ".prettierrc.json"))).toBe(true);
            expect(readPackage().devDependencies.prettier).toBe("^3");
            expect(report.manualSteps.join("\n")).toContain("printWidth");
        });

        it("removes nothing when an existing vis.config has nowhere to insert", async () => {
            expect.assertions(2);

            write("vis.config.ts", "const config = {};\nexport default config;\n");
            write(".prettierrc.json", "{}");

            const { result } = await run();

            expect(result).toBe(false);
            expect(existsSync(join(root, ".prettierrc.json"))).toBe(true);
        });

        it("cleans up but does not map when vis.config already has fmt options", async () => {
            expect.assertions(4);

            write("vis.config.ts", "export default {\n    fmt: { options: { semi: true } },\n};\n");
            write(".prettierrc.json", JSON.stringify({ semi: false }));

            const { report, result } = await run(false, { visConfig: { fmt: { options: { semi: true } } } });

            expect(result).toBe(true);
            expect(existsSync(join(root, ".prettierrc.json"))).toBe(false);
            expect(visConfig()).not.toContain("semi: false");
            expect(report.warnings.join("\n")).toContain("already has fmt options");
        });

        it("cleans up but does not map when an oxfmt config file exists, since it wins over the Prettier config", async () => {
            expect.assertions(4);

            write(".oxfmtrc.json", "{}");
            write(".prettierrc.json", JSON.stringify({ semi: false }));

            const { report, result } = await run();

            expect(result).toBe(true);
            expect(existsSync(join(root, ".prettierrc.json"))).toBe(false);
            expect(existsSync(join(root, "vis.config.ts"))).toBe(false);
            expect(report.warnings.join("\n")).toContain("oxfmt config file exists");
        });

        it("treats a one-line fmt key as an existing fmt block when the loaded config has one", async () => {
            expect.assertions(3);

            write("vis.config.ts", "export default defineConfig({ fmt: { adapters: {} } });\n");
            write(".prettierrc.json", "{}");

            const { result } = await run(false, { visConfig: { fmt: { adapters: {} } } });

            expect(result).toBe(false);
            expect(visConfig().match(/fmt\s*:/g)).toHaveLength(1);
            expect(existsSync(join(root, ".prettierrc.json"))).toBe(true);
        });

        it("points out fmt.engine \"prettier\"", async () => {
            expect.assertions(1);

            write(".prettierrc.json", "{}");

            const { report } = await run(false, { visConfig: { fmt: { engine: "prettier", options: {} } } });

            expect(report.manualSteps.join("\n")).toContain("fmt.engine");
        });

        it("fails softly when the Prettier config cannot be read", async () => {
            expect.assertions(3);

            write(".prettierrc.json", "{ not json");

            const { report, result } = await run();

            expect(result).toBe(false);
            expect(existsSync(join(root, ".prettierrc.json"))).toBe(true);
            expect(report.manualSteps.join("\n")).toContain("Fix the Prettier config");
        });
    });

    describe("dry run", () => {
        it("writes nothing and produces the same warnings and manual steps", async () => {
            expect.assertions(8);

            writePackage({ devDependencies: { prettier: "^3" }, scripts: { format: "prettier --write ." } });
            write(".prettierrc.json", JSON.stringify({ endOfLine: "auto" }));
            write(".prettierignore", "dist\n");

            const dry = await run(true);

            expect(dry.result).toBe(true);
            expect(existsSync(join(root, "vis.config.ts"))).toBe(false);
            expect(existsSync(join(root, ".prettierrc.json"))).toBe(true);
            expect(existsSync(join(root, ".prettierrc.json.bak"))).toBe(false);
            expect(readPackage().scripts.format).toBe("prettier --write .");
            expect(dry.report.backupsCreated).toHaveLength(0);
            expect(dry.logger.infoMessages.join("\n")).toContain("[dry-run] Would remove .prettierrc.json");

            const real = await run();

            expect({ manualSteps: dry.report.manualSteps, warnings: dry.report.warnings }).toStrictEqual({ manualSteps: real.report.manualSteps, warnings: real.report.warnings });
        });
    });

    describe("idempotency", () => {
        it("finds nothing to do on a second run", async () => {
            expect.assertions(5);

            writePackage({ devDependencies: { prettier: "^3" }, scripts: { format: "prettier --write ." } });
            write(".prettierrc.json", "{}");
            write(".prettierignore", "dist\n");

            await run();

            const afterFirst = visConfig();

            expect(detectPrettier(root)).toBe(false);

            const second = await run();

            expect(second.result).toBe(false);
            expect(second.report.manualSteps).toHaveLength(0);
            expect(visConfig()).toBe(afterFirst);
            expect(second.logger.infoMessages.join("\n")).toContain("nothing to migrate");
        });

        it("finds nothing to do on a second run when prettier had to stay", async () => {
            expect.assertions(2);

            writePackage({ devDependencies: { prettier: "^3", "prettier-plugin-organize-imports": "^4" } });
            write(".prettierrc.json", "{}");

            await run();

            expect(planPrettierMigration(root).removeDependencies).toStrictEqual([]);
            expect(detectPrettier(root)).toBe(false);
        });
    });
});
