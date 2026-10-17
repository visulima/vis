import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runExecute = vi.hoisted(() => vi.fn());

vi.mock(import("../../../src/commands/run/handler"), () => { return { default: runExecute }; });

const { runDev } = await import("../../../src/commands/dev/handler");
const { runBuild } = await import("../../../src/commands/build/handler");

describe("vis dev and vis build with no target", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(realpathSync(tmpdir()), "vis-dev-offer-"));
        mkdirSync(join(root, "node_modules"), { recursive: true });
        mkdirSync(join(root, "packages", "app"), { recursive: true });
        writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
        writeFileSync(join(root, "packages", "app", "package.json"), JSON.stringify({ name: "@fix/app", scripts: {} }));
        runExecute.mockReset();
        process.exitCode = undefined;
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
        process.exitCode = undefined;
    });

    const toolbox = (workspaceRoot: string) =>
        ({
            argument: [],
            fs: { access, readFile, writeFile },
            logger: { info: vi.fn() },
            options: {},
            rawUnknown: [],
            visConfig: undefined,
            workspaceRoot,
        }) as never;

    it("runs the dev target without prompting when a package already defines it", async () => {
        expect.assertions(2);

        writeFileSync(join(root, "packages", "app", "package.json"), JSON.stringify({ name: "@fix/app", scripts: { dev: "node server.js" } }));
        const cwd = process.cwd();

        process.chdir(join(root, "packages", "app"));

        try {
            await runDev(toolbox(root), { definesTarget: async () => true, install: () => 0, isInteractive: () => false });
        } finally {
            process.chdir(cwd);
        }

        expect(runExecute).toHaveBeenCalledTimes(1);
        expect(runExecute.mock.calls[0][0].argument).toStrictEqual(["dev"]);
    });

    it("errors for build in a non-interactive run, and does not run the target", async () => {
        expect.assertions(2);

        const cwd = process.cwd();

        process.chdir(join(root, "packages", "app"));

        try {
            await expect(runBuild(toolbox(root), { definesTarget: async () => false, install: () => 0, isInteractive: () => false })).rejects.toThrow("vis add -D @rslib/core");
        } finally {
            process.chdir(cwd);
        }

        expect(runExecute).not.toHaveBeenCalled();
    });
});
