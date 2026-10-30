import { describe, expect, it, vi } from "vitest";

import { releasePublish } from "../../src/release/api";

vi.mock(import("../../src/release/core/orchestrator"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        buildContext: vi.fn(async () => ({ plan: { consumedChangeFiles: [], releases: [], warnings: ["planning warning"] } } as never)),
        publishMissing: vi.fn(async () => {
            return { failed: [], missing: [], published: [], skipped: [], tags: [], tagsPushed: false, warnings: ["successWalk: recovery warning"] };
        }),
    };
});

describe(releasePublish, () => {
    it("returns the planning warnings alongside the recovery's with `missing: true`", async () => {
        expect.hasAssertions();

        const result = await releasePublish({ missing: true });

        expect(result.warnings).toStrictEqual(["planning warning", "successWalk: recovery warning"]);
    });
});
