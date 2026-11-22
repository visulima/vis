import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { Toolbox } from "@visulima/cerebro";
import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import execute from "../../../src/commands/fmt/handler";
import type { VisConfig } from "../../../src/config/types";
import { resolveOxfmtBin, TRANSIENT_CONFIG_PREFIX } from "../../../src/fmt/run-oxfmt";

/** `vis fmt` end to end with the real bundled oxfmt. Skipped when its platform binary is not installed. */
const oxfmtRuns = ((): boolean => {
    try {
        return spawnSync(process.execPath, [resolveOxfmtBin(), "--version"], { encoding: "utf8" }).status === 0;
    } catch {
        return false;
    }
})();

let root: string;
let previousExitCode: typeof process.exitCode;

const run = async (options: Record<string, unknown> = {}, fmt?: NonNullable<VisConfig["fmt"]>): Promise<string[]> => {
    const lines: string[] = [];
    const sink = (...args: unknown[]): void => {
        lines.push(args.join(" "));
    };

    await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
        logger: { debug: sink, error: sink, info: sink, warn: sink } as unknown as Console,
        options,
        visConfig: fmt === undefined ? {} : { fmt },
        workspaceRoot: root,
    });

    return lines;
};

const leftovers = (): string[] => readdirSync(root).filter((name) => name.startsWith(TRANSIENT_CONFIG_PREFIX));
const source = (): string => readFileSync(join(root, "a.ts"), "utf8");

describe("vis fmt (bundled oxfmt, end to end)", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-fmt-e2e-"));
        previousExitCode = process.exitCode;
        process.exitCode = undefined;
        writeFileSync(join(root, "a.ts"), 'const a = "x"\n');
    });

    afterEach(() => {
        process.exitCode = previousExitCode;
        rmSync(root, { force: true, recursive: true });
    });

    describe.skipIf(!oxfmtRuns)("vis fmt with the real bundled oxfmt", () => {
        it("formats a project with no formatter installed, using oxfmt defaults", async () => {
            expect.assertions(3);

            await run();

            expect(source()).toBe('const a = "x";\n');
            expect(process.exitCode).toBeUndefined();
            expect(leftovers()).toStrictEqual([]);
        });

        it("--check lists what would change, fails, and leaves the file alone", async () => {
            expect.assertions(4);

            const lines = await run({ check: true });

            expect(lines.join("\n")).toMatch(/no config found[\s\S]*Would change[\s\S]*a\.ts/);
            expect(source()).toBe('const a = "x"\n');
            expect(process.exitCode).toBe(1);
            expect(leftovers()).toStrictEqual([]);
        });

        it("--check passes on a formatted project", async () => {
            expect.assertions(2);

            writeFileSync(join(root, "a.ts"), 'const a = "x";\n');
            await run({ check: true });

            expect(process.exitCode).toBeUndefined();
            expect(leftovers()).toStrictEqual([]);
        });

        it("formats with the mapped Prettier config", async () => {
            expect.assertions(2);

            writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { prettier: "^3.0.0" }, name: "x" }));
            writeFileSync(join(root, ".prettierrc.json"), JSON.stringify({ semi: false, singleQuote: true }));

            await run();

            expect(source()).toBe("const a = 'x'\n");
            expect(leftovers()).toStrictEqual([]);
        });

        it("formats with vis.config fmt.options, and fmt.ignorePatterns keeps a file out", async () => {
            expect.assertions(3);

            writeFileSync(join(root, "b.ts"), 'const b = "y"\n');

            await run({}, { ignorePatterns: ["b.ts"], options: { semi: false, singleQuote: true } });

            expect(source()).toBe("const a = 'x'\n");
            expect(readFileSync(join(root, "b.ts"), "utf8")).toBe('const b = "y"\n');
            expect(leftovers()).toStrictEqual([]);
        });

        it("lets a discovered .oxfmtrc.json drive the run", async () => {
            expect.assertions(1);

            writeFileSync(join(root, ".oxfmtrc.json"), JSON.stringify({ semi: false }));

            await run();

            expect(source()).toBe('const a = "x"\n');
        });

        it("surfaces a syntax error as a failure with oxfmt's message", async () => {
            expect.assertions(3);

            writeFileSync(join(root, "bad.ts"), "const = ;;\n");

            const lines = await run();

            expect(process.exitCode).toBe(1);
            expect(lines.join("\n")).toContain("Unexpected token");
            expect(leftovers()).toStrictEqual([]);
        });
    });
});
