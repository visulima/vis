import { describe, expect, it, vi } from "vitest";

import { runWatchLoop } from "../../src/lint-fmt/watch-loop";
import { startWatcher } from "../../src/watch/watch";

vi.mock(import("../../src/watch/watch"), () => { return (({ startWatcher: vi.fn(() => { return { close: () => undefined }; }) })); });

describe("runWatchLoop ignore", () => {
    it("drops events for ignored paths even when their extension matches", async () => {
        expect.hasAssertions();

        const finished = runWatchLoop({
            extensions: ["json", "ts"],
            ignore: (path) => path.includes(".vis-fmt-"),
            initialFiles: undefined,
            label: "fmt",
            log: () => undefined,
            runCycle: async () => undefined,
            workspaceRoot: "/w",
        });

        await vi.waitFor(() => {
            expect(startWatcher).toHaveBeenCalledTimes(1);
        });

        const { filter } = vi.mocked(startWatcher).mock.calls[0]![0] as unknown as { filter: (path: string) => boolean };

        expect(filter("src/a.ts")).toBe(true);
        expect(filter(".vis-fmt-12-ab.json")).toBe(false);

        process.emit("SIGINT");
        await finished;
    });
});
