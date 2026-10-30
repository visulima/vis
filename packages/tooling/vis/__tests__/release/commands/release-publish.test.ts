import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const planWarnings: string[] = [];

vi.mock(import("../../../src/release/core/orchestrator"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        buildContext: vi.fn(async () => ({ plan: { consumedChangeFiles: [], releases: [{ name: "@scope/a" }], warnings: planWarnings } } as never)),
        publishContext: vi.fn(async (ctx: { plan: { warnings: string[] } }) => {
            ctx.plan.warnings.push("successWalk: could not comment on #42: HTTP 403");

            throw new Error("registry unreachable");
        }),
        publishMissing: vi.fn(async () => {
            return {
                failed: [],
                missing: [],
                published: [],
                skipped: [],
                tags: [],
                tagsPushed: false,
                warnings: [...planWarnings, "successWalk: could not comment on #7: HTTP 502"],
            };
        }),
    };
});

const run = async (options: Record<string, unknown>): Promise<{ error: string[]; warn: string[] }> => {
    const lines = { error: [] as string[], warn: [] as string[] };
    const { default: execute } = await import("../../../src/commands/release/publish/handler");

    await execute({
        logger: { error: (m: string) => lines.error.push(m), info: () => {}, warn: (m: string) => lines.warn.push(m) },
        options: { push: false, tag: "latest", ...options },
        workspaceRoot: "/nonexistent",
    } as never);

    return lines;
};

describe("vis release publish — warnings", () => {
    beforeEach(() => {
        // vis's own CI runs on GitHub Actions; keep the fixtures out of its annotations.
        vi.stubEnv("GITHUB_ACTIONS", "");
    });

    afterEach(() => {
        planWarnings.length = 0;
        process.exitCode = undefined;
        vi.unstubAllEnvs();
    });

    it("prints the warnings when the publish throws", async () => {
        expect.hasAssertions();

        planWarnings.push("catalog: planning warning");

        const lines = await run({});

        expect(lines.error).toContain("Publish failed: registry unreachable");
        expect(lines.warn).toContain("  - catalog: planning warning");
        expect(lines.warn).toContain("  - successWalk: could not comment on #42: HTTP 403");
        expect(process.exitCode).toBe(1);
    });

    it("prints a planning warning once with --missing", async () => {
        expect.hasAssertions();

        planWarnings.push("catalog: planning warning");

        const lines = await run({ missing: true });

        expect(lines.warn.filter((line) => line === "  - catalog: planning warning")).toHaveLength(1);
        expect(lines.warn).toContain("  - successWalk: could not comment on #7: HTTP 502");
    });
});
