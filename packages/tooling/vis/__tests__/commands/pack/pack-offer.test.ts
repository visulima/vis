import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CerebroFs } from "@visulima/cerebro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runExecute = vi.hoisted(() => vi.fn());

vi.mock(import("../../../src/commands/run/handler"), () => { return { default: runExecute }; });

const { runPack } = await import("../../../src/commands/pack/handler");

const fs = { access, mkdir, readFile, writeFile } as unknown as CerebroFs;

describe("vis pack", () => {
    let root: string;
    let app: string;

    beforeEach(() => {
        root = mkdtempSync(join(realpathSync(tmpdir()), "vis-pack-"));
        app = join(root, "packages", "lib");
        mkdirSync(join(root, "node_modules"), { recursive: true });
        mkdirSync(app, { recursive: true });
        writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
        writeFileSync(join(app, "package.json"), JSON.stringify({ name: "@fix/lib", scripts: {} }, undefined, 2));
        runExecute.mockReset();
        process.exitCode = undefined;
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
        process.exitCode = undefined;
    });

    const toolbox = (options: Record<string, unknown> = {}, argument: string[] = []) =>
        ({ argument, fs, logger: { info: vi.fn() }, options, rawUnknown: [], visConfig: undefined, workspaceRoot: root }) as never;

    const noTarget = async () => [{ name: "@fix/lib", root: app, targets: undefined }];
    const withPack = async () => [{ name: "@fix/lib", root: app, targets: { pack: {} } }];

    it("runs the pack target without prompting when a project already defines it", async () => {
        expect.assertions(2);

        await runPack(toolbox({}, ["--sourcemap"]), { install: () => 0, isInteractive: () => false, projects: withPack });

        // The current directory is not the workspace root here, so the selector is scoped to the package.
        expect(runExecute.mock.calls[0][0].argument).toStrictEqual(["~:pack", "--sourcemap"]);
        expect(process.exitCode).toBeUndefined();
    });

    it("errors in a non-interactive run, listing Rslib and packem with their install commands", async () => {
        expect.assertions(3);

        const install = vi.fn(() => 0);

        await expect(runPack(toolbox(), { install, isInteractive: () => false, projects: noTarget })).rejects.toThrow("vis add -D @rslib/core");
        await expect(runPack(toolbox(), { install, isInteractive: () => false, projects: noTarget })).rejects.toThrow("vis add -D @visulima/packem");
        expect(runExecute).not.toHaveBeenCalled();
    });

    it("installs packem with its transformer and typescript, writes the config and entry, then runs pack", async () => {
        expect.assertions(4);

        const install = vi.fn(() => 0);

        // Install is faked; the run is mocked. Only the offer's effects are checked here.
        await runPack(toolbox(), { install, isInteractive: () => true, projects: noTarget, readline: async () => "2" });

        expect(install.mock.calls.map(([name]) => name)).toStrictEqual(["@visulima/packem", "esbuild", "typescript"]);
        expect(readFileSync(join(app, "packem.config.ts"), "utf8")).toContain("emitESM: true");
        expect(readFileSync(join(app, "src", "index.ts"), "utf8")).toBe("export {};\n");
        expect(runExecute.mock.calls[0][0].argument).toStrictEqual(["~:pack"]);
    });
});
