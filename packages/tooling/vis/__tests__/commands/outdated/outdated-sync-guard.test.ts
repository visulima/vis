import { describe, expect, it, vi } from "vitest";

import outdatedExecute from "../../../src/commands/outdated/handler";

const SYNC_WITHOUT_CONFIG_PATTERN = /--sync requires --security-config/;

const toolbox = (options: Record<string, unknown>) =>
    ({
        argument: [],
        logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        options,
        visConfig: undefined,
        workspaceRoot: "/tmp/vis-check-guard",
    }) as never;

describe("vis outdated --sync", () => {
    it("rejects --sync when --security-config is absent", async () => {
        expect.assertions(1);

        // `--sync` only acts inside the security-config branch, so accepting it
        // alone is a command that reports success without doing the work.
        await expect(outdatedExecute(toolbox({ sync: true }))).rejects.toThrow(SYNC_WITHOUT_CONFIG_PATTERN);
    });

    it("does not reject --security-config on its own", async () => {
        expect.assertions(1);

        await expect(outdatedExecute(toolbox({ securityConfig: true }))).rejects.not.toThrow(SYNC_WITHOUT_CONFIG_PATTERN);
    });
});
