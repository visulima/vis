import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { Toolbox } from "@visulima/cerebro";
import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import execute from "../../../src/commands/fmt/handler";
import type { VisConfig } from "../../../src/config/types";
import { resolveOxfmtBin, TRANSIENT_CONFIG_PREFIX } from "../../../src/fmt/run-oxfmt";

/**
 * `.editorconfig` through `vis fmt`, with the real bundled oxfmt: the file is read by oxfmt itself, so it has
 * to reach the output whichever way vis hands the config over. Skipped when the platform binary is not installed.
 */
const oxfmtRuns = ((): boolean => {
    try {
        return spawnSync(process.execPath, [resolveOxfmtBin(), "--version"], { encoding: "utf8" }).status === 0;
    } catch {
        return false;
    }
})();

let root: string;
let previousExitCode: typeof process.exitCode;

const run = async (fmt?: NonNullable<VisConfig["fmt"]>): Promise<void> => {
    const sink = (): void => {};

    await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
        logger: { debug: sink, error: sink, info: sink, warn: sink } as unknown as Console,
        options: { quiet: true },
        visConfig: fmt === undefined ? {} : { fmt },
        workspaceRoot: root,
    });
};

/** How each winning source reaches oxfmt: a config file in the vis cache, in the workspace root, or one oxfmt discovers. */
const SOURCES: ReadonlyArray<[name: string, setup: () => Promise<void>, placement: () => boolean]> = [
    [
        "a config kept in the cache file",
        () => run({ options: { singleQuote: false } }),
        () => existsSync(join(root, "node_modules", ".cache", "vis", "fmt")) && readdirSync(root).every((name) => !name.startsWith(TRANSIENT_CONFIG_PREFIX)),
    ],
    [
        "a config with globs, in the root file",
        () => run({ ignorePatterns: ["ignored/**"], options: { singleQuote: false } }),
        () => !existsSync(join(root, "node_modules", ".cache", "vis", "fmt")) && readdirSync(root).every((name) => !name.startsWith(TRANSIENT_CONFIG_PREFIX)),
    ],
    [
        "a discovered .oxfmtrc.json",
        () => {
            writeFileSync(join(root, ".oxfmtrc.json"), JSON.stringify({ singleQuote: false }));

            return run();
        },
        () => !existsSync(join(root, "node_modules", ".cache", "vis", "fmt")),
    ],
];

const NESTED = "export function f() {\n  return {\n    value: 1,\n  };\n}\n";
const LONG = "const result = someFunction(argumentNumberOne, argumentNumberTwo);\n";

describe.skipIf(!oxfmtRuns)(".editorconfig through vis fmt (real bundled oxfmt)", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-fmt-editorconfig-"));
        previousExitCode = process.exitCode;
        process.exitCode = undefined;
    });

    afterEach(() => {
        process.exitCode = previousExitCode;
        rmSync(root, { force: true, recursive: true });
    });

    describe.each(SOURCES)("with %s as the winning source", (_name, setup, placement) => {
        it("applies indent_style = tab", async () => {
            expect.assertions(3);

            writeFileSync(join(root, ".editorconfig"), "root = true\n\n[*]\nindent_style = tab\n");
            writeFileSync(join(root, "a.ts"), NESTED);

            await setup();

            expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export function f() {\n\treturn {\n\t\tvalue: 1,\n\t};\n}\n");
            expect(process.exitCode).toBeUndefined();
            expect(placement()).toBe(true);
        });

        it("applies indent_size", async () => {
            expect.assertions(1);

            writeFileSync(join(root, ".editorconfig"), "root = true\n\n[*]\nindent_style = space\nindent_size = 4\n");
            writeFileSync(join(root, "a.ts"), NESTED);

            await setup();

            expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export function f() {\n    return {\n        value: 1,\n    };\n}\n");
        });

        it("applies tab_width when the indent size is `tab`", async () => {
            expect.assertions(1);

            writeFileSync(join(root, ".editorconfig"), "root = true\n\n[*]\nindent_style = space\nindent_size = tab\ntab_width = 3\n");
            writeFileSync(join(root, "a.ts"), NESTED);

            await setup();

            expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export function f() {\n   return {\n      value: 1,\n   };\n}\n");
        });

        it("applies max_line_length", async () => {
            expect.assertions(1);

            writeFileSync(join(root, ".editorconfig"), "root = true\n\n[*]\nmax_line_length = 40\n");
            writeFileSync(join(root, "a.ts"), LONG);

            await setup();

            expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const result = someFunction(\n  argumentNumberOne,\n  argumentNumberTwo,\n);\n");
        });

        it("leaves the file alone when there is no .editorconfig", async () => {
            expect.assertions(1);

            writeFileSync(join(root, "a.ts"), LONG);

            await setup();

            expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(LONG);
        });
    });

    it("lets an option the winning config sets take precedence over the .editorconfig", async () => {
        expect.assertions(1);

        writeFileSync(join(root, ".editorconfig"), "root = true\n\n[*]\nindent_style = space\nindent_size = 4\n");
        writeFileSync(join(root, "a.ts"), NESTED);

        await run({ options: { tabWidth: 8 } });

        expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export function f() {\n        return {\n                value: 1,\n        };\n}\n");
    });
});
