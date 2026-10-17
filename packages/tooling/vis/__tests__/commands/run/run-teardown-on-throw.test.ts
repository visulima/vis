import { beforeEach, describe, expect, it, vi } from "vitest";

import runExecute from "../../../src/commands/run/handler";

const state = vi.hoisted(() => {
    return {
        cleanupEphemeralServices: vi.fn(),
        ctx: undefined as Record<string, unknown> | undefined,
        prepareRunRuntime: vi.fn(),
    };
});

// The phases before the runtime are stubbed; `injectMissingServices` plays the
// part of booting an ephemeral service by recording its pid file and run dir.
vi.mock(import("../../../src/commands/run/handler-parts/run-select"), () => {
    return {
        buildInitialTasks: () => false,
        loadRunWorkspace: async () => state.ctx,
        selectProjectsWithTarget: () => false,
        selectRunProjects: async () => false,
    };
});

vi.mock(import("../../../src/commands/run/handler-parts/run-graph"), () => {
    return {
        buildRunGraph: () => {},
        printDryRunPlan: () => false,
        runPreflightChecks: async () => {},
        shapeTaskGraph: () => {},
    };
});

vi.mock(import("../../../src/commands/run/handler-parts/run-services"), () => {
    return {
        attachRegisteredServices: async () => { return { satisfiedServices: [], serviceEnvByTaskId: new Map() }; },
        finalizeServiceGraph: () => {},
        injectMissingServices: () => {
            state.ctx!["ephemeralPidFiles"] = ["/ws/.vis/run/db.pid"];
            state.ctx!["serviceRunDir"] = "/ws/.vis/run";
        },
    };
});

vi.mock(import("../../../src/commands/run/handler-parts/run-runtime"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, prepareRunRuntime: state.prepareRunRuntime };
});

vi.mock(import("../../../src/commands/run/handler-parts/run-persistent-tasks"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, cleanupEphemeralServices: state.cleanupEphemeralServices };
});

describe("vis run teardown", () => {
    beforeEach(() => {
        state.ctx = {
            ephemeralPidFiles: [],
            options: { stopServices: false },
            registryStartedIds: [],
            registryStartedPids: new Map(),
            serviceEventBridge: null,
            serviceRunDir: undefined,
            workspaceRoot: "/ws",
        };
        state.cleanupEphemeralServices.mockReset();
        state.prepareRunRuntime.mockReset();
    });

    it("tears down services it booted when a run:before hook throws", async () => {
        expect.assertions(2);

        // A throwing `run:before` hook surfaces from inside prepareRunRuntime.
        state.prepareRunRuntime.mockRejectedValue(new Error("run:before boom"));

        const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} };

        await expect(
            runExecute({
                argument: ["test"],
                logger,
                options: {},
                visConfig: undefined,
                workspaceRoot: "/ws",
            } as never),
        ).rejects.toThrow("run:before boom");

        expect(state.cleanupEphemeralServices).toHaveBeenCalledWith(
            expect.objectContaining({ pidFiles: ["/ws/.vis/run/db.pid"], runDir: "/ws/.vis/run" }),
        );
    });
});
