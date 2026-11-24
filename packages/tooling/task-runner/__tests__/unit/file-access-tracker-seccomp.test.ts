import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeSeccompTrackingResult } from "../../src/native-binding";

// The seccomp dispatch needs Linux, the native addon's `trackWithSeccomp` and a helper binary on disk.
// All three are stubbed so the dispatch runs on every host; no process is spawned.
vi.mock(import("node:os"), async (importOriginal) => {
    return { ...(await importOriginal()), platform: () => "linux" as const };
});
vi.mock(import("node:fs"), async (importOriginal) => {
    return { ...(await importOriginal()), accessSync: () => {} };
});

const trackWithSeccomp = vi.fn<(...args: unknown[]) => Promise<NativeSeccompTrackingResult>>();

vi.mock(import("../../src/native-binding"), async (importOriginal) => {
    return { ...(await importOriginal()), loadNativeBindings: () => ({ trackWithSeccomp }) as never };
});

const { FileAccessTracker } = await import("../../src/file-access-tracker");

describe("seccomp dispatch", () => {
    let workspaceRoot: string;

    beforeEach(async () => {
        // eslint-disable-next-line sonarjs/pseudo-random
        workspaceRoot = join(tmpdir(), `task-runner-seccomp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        await mkdir(workspaceRoot, { recursive: true });
        trackWithSeccomp.mockReset();
    });

    afterEach(async () => {
        await rm(workspaceRoot, { force: true, recursive: true });
    });

    const native = (extra: Partial<NativeSeccompTrackingResult> = {}): NativeSeccompTrackingResult => {
        return {
            accesses: [{ kind: "read", path: join(workspaceRoot, "input.txt") }],
            exitCode: 0,
            stderr: Buffer.from(""),
            stdout: Buffer.from("out"),
            ...extra,
        };
    };

    it("reports an incomplete trace as incomplete, and runs the command once", async () => {
        expect.assertions(4);

        trackWithSeccomp.mockResolvedValue(native({ incomplete: true }));

        const result = await new FileAccessTracker(workspaceRoot).track("echo hi", { cwd: workspaceRoot });

        // Not retried untracked: the command already ran, a second run would repeat its side effects.
        expect(trackWithSeccomp).toHaveBeenCalledTimes(1);
        expect(result.incomplete).toBe(true);
        expect(result.accesses).toHaveLength(1);
        expect(result.output).toBe("out");
    });

    it.each([[{ incomplete: false }], [{}]])("leaves a complete trace (%j) unflagged", async (extra) => {
        expect.assertions(2);

        trackWithSeccomp.mockResolvedValue(native(extra));

        const result = await new FileAccessTracker(workspaceRoot).track("echo hi", { cwd: workspaceRoot });

        expect(result.incomplete).toBeUndefined();
        expect(result.accesses).toHaveLength(1);
    });

    it("still degrades to an untracked run when the helper fails", async () => {
        expect.assertions(3);

        trackWithSeccomp.mockRejectedValue(new Error("seccomp tracker failed: supervisor stopped"));

        const result = await new FileAccessTracker(workspaceRoot).track("echo fallback", { cwd: workspaceRoot });

        expect(result.accesses).toStrictEqual([]);
        expect(result.incomplete).toBeUndefined();
        expect(result.output).toContain("fallback");
    });
});
