import { describe, expect, it, vi } from "vitest";

import { applyRemoteCacheConfig } from "../../../src/commands/run/run-remote-cache";

describe(applyRemoteCacheConfig, () => {
    it("logs every remote cache failure at debug level and preserves a configured hook", async () => {
        expect.assertions(3);

        const configuredOnUploadError = vi.fn<(hash: string, error: unknown) => void>();
        const logger = {
            debug: vi.fn<(message: string) => void>(),
            info: vi.fn<(message: string) => void>(),
            warn: vi.fn<(message: string) => void>(),
        };
        const runnerOptions = {} as Parameters<typeof applyRemoteCacheConfig>[0]["runnerOptions"];

        await applyRemoteCacheConfig({
            configTaskRunner: {
                remoteCache: {
                    onUploadError: configuredOnUploadError,
                    url: "https://cache.example.com",
                },
            },
            logger: logger as never,
            options: {} as never,
            runnerOptions,
            workspaceRoot: "/tmp/workspace",
        });

        runnerOptions.remoteCache?.onUploadError?.("hash-1", new Error("connect ECONNREFUSED"));
        runnerOptions.remoteCache?.onUploadError?.("hash-2", "plain failure");

        expect(configuredOnUploadError).toHaveBeenCalledTimes(2);
        expect(logger.debug).toHaveBeenNthCalledWith(1, expect.stringContaining("connect ECONNREFUSED"));
        expect(logger.debug).toHaveBeenNthCalledWith(2, expect.stringContaining("plain failure"));
    });
});
