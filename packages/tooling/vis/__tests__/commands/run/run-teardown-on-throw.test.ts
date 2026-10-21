import { beforeEach, describe, expect, it, vi } from "vitest";

import runExecute from "../../../src/commands/run/handler";

const state = vi.hoisted(() => {
    return {
        cleanup: { finish: vi.fn(), install: vi.fn() },
        createRunRuntime: vi.fn(),
    };
});

vi.mock(import("../../../src/commands/run/run-cleanup"), () => {
    return { createRunCleanup: () => state.cleanup };
});

vi.mock(import("../../../src/commands/run/run-runtime"), () => {
    return { createRunRuntime: state.createRunRuntime };
});

vi.mock(import("../../../src/commands/run/run-dry-run"), () => {
    return { printDryRunPlan: () => {} };
});

vi.mock(import("../../../src/commands/run/run-task-graph"), () => {
    return { finalizeRunTaskGraph: ({ taskGraph }: { taskGraph: unknown }) => taskGraph };
});

vi.mock(import("../../../src/commands/run/run-services"), () => {
    return {
        wireRunServices: async ({ initialTasks, taskGraph }: { initialTasks: unknown; taskGraph: unknown }) => {
            return { ephemeralPidFiles: [], initialTasks, injectedServiceIdSet: new Set(), registryStartedCount: 0, registryStartedIds: [], registryStartedPids: new Map(), serviceDockStore: null, serviceEnvByTaskId: new Map(), serviceEventBridge: null, serviceResult: {}, serviceRunDir: undefined, taskGraph };
        },
    };
});

vi.mock(import("../../../src/commands/run/run-preflight"), () => {
    return { runStartupPreflights: async () => {} };
});

vi.mock(import("../../../src/commands/run/run-selection"), () => {
    return { resolveRunSelection: async () => { return { affectedFiles: [], currentOs: "linux", forwardedArgs: [], projectsWithTarget: [], projectTargetIndex: new Map(), target: "build" }; } };
});

vi.mock(import("../../../src/commands/run/run-tasks"), () => {
    return { buildRunTasks: () => { return { initialTasks: [], persistentTasks: [], taskGraph: { tasks: {} } }; } };
});

vi.mock(import("../../../src/runtime/command-runtime"), () => {
    return { resolveCommandRuntime: () => {} };
});

vi.mock(import("../../../src/util/vis-paths"), () => {
    return { cleanupLegacyTaskRunnerLayout: () => {}, DEFAULT_WORKSPACE_CACHE_DIRECTORY: "node_modules/.cache/vis" };
});

vi.mock(import("../../../src/config/workspace"), () => {
    return {
        buildProjectGraph: () => { return {}; },
        discoverWorkspace: () => { return { config: {}, fileOwners: new Map(), packageJsons: [], projectOptions: {}, workspace: {} }; },
        loadVisTaskConfigsForWorkspace: async () => { return {}; },
    };
});

const toolbox = (): unknown => {
    return {
        argument: undefined,
        logger: { error: () => {}, info: () => {}, log: () => {}, warn: () => {} },
        options: { dryRun: false, stopServices: false },
        visConfig: {},
        workspaceRoot: "/ws",
    };
};

describe("vis run teardown", () => {
    beforeEach(() => {
        state.cleanup.finish.mockReset().mockResolvedValue(undefined);
        state.cleanup.install.mockReset();
        state.createRunRuntime.mockReset();
    });

    it("tears down services booted by this run when runtime setup throws", async () => {
        expect.assertions(3);

        state.createRunRuntime.mockRejectedValue(new Error("attestation failed"));

        await expect((runExecute as unknown as (tb: unknown) => Promise<void>)(toolbox())).rejects.toThrow("attestation failed");

        expect(state.cleanup.install).toHaveBeenCalledTimes(1);
        expect(state.cleanup.finish).toHaveBeenCalledTimes(1);
    });

    it("tears down services on a dry run, which returns before the runtime is built", async () => {
        expect.assertions(2);

        const tb = toolbox() as { options: { dryRun: boolean } };

        tb.options.dryRun = true;

        await (runExecute as unknown as (tb: unknown) => Promise<void>)(tb);

        expect(state.createRunRuntime).not.toHaveBeenCalled();
        expect(state.cleanup.finish).toHaveBeenCalledTimes(1);
    });
});
