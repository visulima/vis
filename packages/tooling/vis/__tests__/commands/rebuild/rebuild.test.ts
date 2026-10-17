import { beforeEach, describe, expect, it, vi } from "vitest";

const pm = vi.hoisted(() => {
    return {
        resolveInstaller: vi.fn(),
        runPmSubcommand: vi.fn(),
    };
});

vi.mock(import("../../../src/pm/pm-runner"), () => pm);

const { default: rebuildExecute } = await import("../../../src/commands/rebuild/handler");

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe("vis rebuild", () => {
    beforeEach(() => {
        pm.resolveInstaller.mockReset();
        pm.runPmSubcommand.mockReset();
        process.exitCode = undefined;
    });

    it("rejects yarn 1, which has no rebuild, instead of exiting 0", async () => {
        expect.assertions(2);

        pm.resolveInstaller.mockReturnValue({ name: "yarn", version: "1.22.19" });

        await expect(rebuildExecute({ logger, options: {}, workspaceRoot: "/tmp/ws" } as never)).rejects.toThrow("yarn 1 has no `rebuild`");
        expect(pm.runPmSubcommand).not.toHaveBeenCalled();
    });

    it("runs rebuild through the detected package manager", async () => {
        expect.assertions(2);

        const installer = { name: "pnpm", version: "10.0.0" };

        pm.resolveInstaller.mockReturnValue(installer);
        pm.runPmSubcommand.mockReturnValue(0);

        await rebuildExecute({ logger, options: {}, workspaceRoot: "/tmp/ws" } as never);

        expect(pm.runPmSubcommand).toHaveBeenCalledWith(installer, "rebuild", [], "/tmp/ws", logger);
        expect(process.exitCode).toBeUndefined();
    });

    it("propagates a failing rebuild's exit code", async () => {
        expect.assertions(1);

        pm.resolveInstaller.mockReturnValue({ name: "npm", version: "10.0.0" });
        pm.runPmSubcommand.mockReturnValue(2);

        await rebuildExecute({ logger, options: {}, workspaceRoot: "/tmp/ws" } as never);

        expect(process.exitCode).toBe(2);

        process.exitCode = undefined;
    });
});
