import { describe, expect, it, vi } from "vitest";

const pm = vi.hoisted(() => { return { detectPm: vi.fn(() => { return { name: "pnpm", version: "10.0.0" }; }) }; });

vi.mock(import("../../../src/pm/pm-runner"), () => pm);

const { default: envExecute } = await import("../../../src/commands/env/handler");

describe("vis env", () => {
    it("reports node, the directory, the workspace, and the package manager", async () => {
        expect.assertions(4);

        const logger = { info: vi.fn() };

        await envExecute({ logger, workspaceRoot: "/repo" } as never);

        const lines = logger.info.mock.calls.map(([line]) => String(line));

        expect(lines.find((line) => line.startsWith("node"))).toContain(process.version);
        expect(lines.find((line) => line.startsWith("workspace"))).toContain("/repo");
        expect(lines.find((line) => line.startsWith("pm"))).toContain("pnpm 10.0.0");
        expect(pm.detectPm).toHaveBeenCalledWith(process.cwd());
    });

    it("says so when no workspace is found", async () => {
        expect.assertions(1);

        const logger = { info: vi.fn() };

        await envExecute({ logger, workspaceRoot: undefined } as never);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("not found from this directory"));
    });
});
