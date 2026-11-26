import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runConcurrentFallback } from "../../src/concurrent-fallback";
import { runNativeConcurrent } from "../../src/concurrent-native";

vi.mock(import("../../src/concurrent-native"), () => {
    return { runNativeConcurrent: vi.fn<typeof runNativeConcurrent>(async () => { return { closeEvents: [], success: true }; }) };
});
vi.mock(import("../../src/concurrent-fallback"), () => {
    return { runConcurrentFallback: vi.fn<typeof runConcurrentFallback>(async () => { return { closeEvents: [], success: true }; }) };
});

// Imported after the mocks so each module resolves its runner to the mock.
const { runConcurrently } = await import("../../src/concurrent");
const { LEGACY_RUNNER_NOTICE, resolveConcurrentRunner } = await import("../../src/runner-switch");

const native = vi.mocked(runNativeConcurrent);
const fallback = vi.mocked(runConcurrentFallback);

describe("concurrent runner selection (VIS_CONCURRENT_RUNNER)", () => {
    let stderr: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        native.mockClear();
        fallback.mockClear();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        stderr.mockRestore();
    });

    it.each([undefined, "", "native", "NATIVE"])("should use the native runner when the variable is %j", async (value) => {
        expect.assertions(2);

        vi.stubEnv("VIS_CONCURRENT_RUNNER", value);

        await runConcurrently(["echo a"], { shellPath: "/bin/sh" });

        expect(native).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
    });

    it("should use the native runner for every input the JS spawner used to take", async () => {
        expect.assertions(2);

        vi.stubEnv("VIS_CONCURRENT_RUNNER", undefined);

        await runConcurrently(
            [
                { command: "a", stdin: "pipe" },
                { command: "b", stdin: "pty" },
                { command: "c", inheritEnv: false },
            ],
            { onEvent: () => {}, restart: { tries: 1 }, shellPath: "/bin/sh" },
        );

        expect(native).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
    });

    it("should use the JS spawner for VIS_CONCURRENT_RUNNER=js and say so once", async () => {
        expect.assertions(4);

        vi.stubEnv("VIS_CONCURRENT_RUNNER", "js");

        await runConcurrently(["echo a"], { shellPath: "/bin/sh" });
        await runConcurrently(["echo b"], { shellPath: "/bin/sh" });

        expect(fallback).toHaveBeenCalledTimes(2);
        expect(native).not.toHaveBeenCalled();
        expect(stderr.mock.calls.filter(([text]) => text === `${LEGACY_RUNNER_NOTICE}\n`)).toHaveLength(1);
        expect(LEGACY_RUNNER_NOTICE).toContain("removed in the next release");
    });

    it("should ignore an unknown value, warn, and use the native runner", async () => {
        expect.assertions(3);

        vi.stubEnv("VIS_CONCURRENT_RUNNER", "rust-please");

        expect(resolveConcurrentRunner()).toBe("native");

        await runConcurrently(["echo a"], { shellPath: "/bin/sh" });

        expect(native).toHaveBeenCalledTimes(1);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("rust-please"));
    });
});
