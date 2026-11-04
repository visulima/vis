import type { Task } from "@visulima/task-runner";
import { describe, expect, it } from "vitest";

import { createConcurrentExecutor } from "../../../src/commands/run/executor";

describe("empty-command target", () => {
    // project.json aliases (`{ "command": "", "dependsOn": [...] }`) rely on this: the
    // documented way to make a target stand for other projects' targets.
    it("passes without spawning anything, so an alias succeeds once its dependencies do", async () => {
        expect.assertions(2);

        const execute = createConcurrentExecutor({ resolveCommand: () => "", workspaceRoot: "/repo" } as unknown as Parameters<typeof createConcurrentExecutor>[0]);
        const task = { id: "root:e2e", overrides: {}, projectRoot: ".", target: { project: "root", target: "e2e" } } as unknown as Task;

        const result = await execute(task, {});

        expect(result.code).toBe(0);
        expect(result.terminalOutput).toBe("No command configured for root:e2e");
    });
});
