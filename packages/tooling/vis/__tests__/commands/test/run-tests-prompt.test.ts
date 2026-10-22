import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTests } from "../../../src/commands/test/handler";

let root: string;
let cwd: string;

const toolbox = (options: Record<string, unknown> = {}) =>
    ({
        argument: [],
        fs: { readFile },
        logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        options: { watch: false, ...options },
        rawUnknown: [],
    }) as never;

/** Writes a fake `@rstest/core` whose bin prints its arguments and exits with `exitCode`. */
const writeFakeRstest = (exitCode: number): void => {
    const core = join(root, "node_modules", "@rstest", "core");

    mkdirSync(join(core, "bin"), { recursive: true });
    writeFileSync(join(core, "package.json"), JSON.stringify({ bin: { rstest: "./bin/rstest.js" } }));
    writeFileSync(join(core, "bin", "rstest.js"), `console.log("ARGS " + JSON.stringify(process.argv.slice(2)));process.exit(${String(exitCode)});`);
};

describe("runTests when no runner is installed", () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "vis-test-prompt-"));
        cwd = process.cwd();
        process.chdir(root);
        process.exitCode = undefined;
    });

    afterEach(async () => {
        process.chdir(cwd);
        process.exitCode = undefined;
        await rm(root, { force: true, recursive: true });
    });

    it("errors in a non-interactive run, listing each runner and its install command, and installs nothing", async () => {
        expect.assertions(2);

        const install = vi.fn(() => 0);

        await expect(runTests(toolbox(), { install, isInteractive: () => false })).rejects.toThrow("vis add -D @rstest/core");
        expect(install).not.toHaveBeenCalled();
    });

    it("cancels without installing when the user declines", async () => {
        expect.assertions(2);

        const install = vi.fn(() => 0);

        await expect(runTests(toolbox(), { install, isInteractive: () => true, readline: async () => "q" })).rejects.toThrow("No test runner selected");
        expect(install).not.toHaveBeenCalled();
    });

    it("installs the picked runner, then runs it with the forwarded arguments", async () => {
        expect.assertions(3);

        // The installer stands in for `vis add -D @rstest/core`: the runner appears on disk.
        const install = vi.fn((packageName: string) => {
            writeFakeRstest(0);

            return packageName === "@rstest/core" ? 0 : 1;
        });

        await runTests({ ...toolbox(), argument: ["a.test.ts"] } as never, { install, isInteractive: () => true, readline: async () => "2" });

        expect(install).toHaveBeenCalledWith("@rstest/core", process.cwd());
        expect(process.exitCode).toBeUndefined();
        expect(install).toHaveBeenCalledTimes(1);
    });

    it("does not run the runner when the install fails", async () => {
        expect.assertions(2);

        const install = vi.fn(() => 3);

        await runTests(toolbox(), { install, isInteractive: () => true, readline: async () => "2" });

        expect(process.exitCode).toBe(3);
        expect(install).toHaveBeenCalledTimes(1);
    });
});
