import { afterEach, describe, expect, it, vi } from "vitest";

import postCommandPlugin from "../../src/plugins/post-command";
import { showMcpPromote } from "../../src/util/mcp-promote";
import { showTip } from "../../src/util/tips";

vi.mock(import("../../src/util/mcp-promote"), () => {
    return { showMcpPromote: vi.fn() };
});
vi.mock(import("../../src/util/sponsor"), () => {
    return { showSponsorNotice: vi.fn() };
});
vi.mock(import("../../src/util/tips"), () => {
    return { showTip: vi.fn() };
});

const runAfterCommand = async (effectiveArgs?: string[]) => {
    const upgradeCheck = vi.fn();
    const plugin = postCommandPlugin(upgradeCheck, effectiveArgs);

    await plugin.afterCommand?.({ visConfig: undefined, workspaceRoot: "/work/app" } as never, undefined);

    return upgradeCheck;
};

describe("post-command plugin", () => {
    const originalArgv = process.argv;

    afterEach(() => {
        process.argv = originalArgv;
        vi.clearAllMocks();
    });

    it("hands the hooks the command that ran when it is not the one on the command line", async () => {
        expect.assertions(3);

        // `vis cache` runs as `vis help cache`, so the `help` opt-outs have to apply to it.
        process.argv = ["node", "vis", "cache"];

        await runAfterCommand(["help", "cache"]);

        expect(showMcpPromote).toHaveBeenCalledWith(expect.objectContaining({ command: "help" }));
        expect(showTip).toHaveBeenCalledWith(expect.objectContaining({ args: ["help", "cache"], command: "help" }));
        expect(showMcpPromote).toHaveBeenCalledTimes(1);
    });

    it("reads the command line when no other arguments are given", async () => {
        expect.assertions(1);

        process.argv = ["node", "vis", "status"];

        await runAfterCommand();

        expect(showMcpPromote).toHaveBeenCalledWith(expect.objectContaining({ command: "status" }));
    });
});
