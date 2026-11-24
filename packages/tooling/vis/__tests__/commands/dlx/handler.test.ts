import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maybeGateFirstRunMock = vi.fn(async () => {
    return { proceed: true };
});

vi.mock(import("../../../src/dlx/first-run"), () => {
    return { maybeGateFirstRun: maybeGateFirstRunMock };
});

const resolveInstallerMock = vi.fn(() => {
    return { name: "pnpm", version: "10.0.0" };
});
const runDlxMock = vi.fn(() => 0);

vi.mock(import("../../../src/pm/pm-runner"), () => {
    return { resolveInstaller: resolveInstallerMock, runDlx: runDlxMock };
});

const handlerPromise = import("../../../src/commands/dlx/handler");

const run = async (options: Record<string, unknown>, env: Record<string, string> = {}): Promise<void> => {
    const { default: execute } = await handlerPromise;

    await (execute as (toolbox: unknown) => Promise<void>)({
        argument: ["is-odd", "3"],
        logger: { error: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn() },
        options: { offline: false, shellMode: false, silent: false, yes: false, ...options },
        process: { cwd: "/work", env },
        visConfig: undefined,
        workspaceRoot: "/work",
    });
};

const gateOptions = (): { forceInfo: boolean; noInfo: boolean } => maybeGateFirstRunMock.mock.calls[0]?.[0] as unknown as { forceInfo: boolean; noInfo: boolean };

describe("dlx first-run gate options", () => {
    beforeEach(() => {
        maybeGateFirstRunMock.mockClear();
    });

    afterEach(() => {
        process.exitCode = undefined;
    });

    it("does not force the panel when neither --info nor --no-info is given", async () => {
        expect.assertions(2);

        await run({});

        expect(gateOptions().forceInfo).toBe(false);
        expect(gateOptions().noInfo).toBe(false);
    });

    it("forces the panel for --info", async () => {
        expect.assertions(2);

        await run({ info: true });

        expect(gateOptions().forceInfo).toBe(true);
        expect(gateOptions().noInfo).toBe(false);
    });

    it("suppresses the panel for --no-info", async () => {
        expect.assertions(2);

        await run({ info: false });

        expect(gateOptions().noInfo).toBe(true);
        expect(gateOptions().forceInfo).toBe(false);
    });

    it("suppresses the panel for VIS_DLX_NO_INFO", async () => {
        expect.assertions(1);

        await run({}, { VIS_DLX_NO_INFO: "1" });

        expect(gateOptions().noInfo).toBe(true);
    });
});
