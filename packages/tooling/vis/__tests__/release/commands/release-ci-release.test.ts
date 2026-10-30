/**
 * Regression tests for `vis release ci release` idempotency (C7 fix).
 *
 * Two paths get the resume treatment:
 *
 *   1. version-pr mode with no pending change files:
 *        - `.state.json` absent → fresh "merge detected → publish" (no resume)
 *        - `.state.json` present → prior partial wave → publishContext({ resume: true })
 *
 *   2. auto-publish mode:
 *        - applyContext lands the version commit (durable)
 *        - publishContext is invoked with { resume: true } so a retry skips
 *          already-published packages instead of replaying.
 *
 * The tests stub `publishContext` to capture its invocation options and
 * assert the right `resume` flag is propagated.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stateFilePath } from "../../../src/release/core/state";

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
};

// The handler reads through the injected `toolbox.fs` (CerebroFs); node:fs/promises
// satisfies that surface for the methods it uses.
const testFs = { access, mkdir, readdir, readFile, rm, stat, writeFile } as never;

const writeVisConfigCjs = (cwd: string, releaseBlock: Record<string, unknown>): void => {
    const block = { release: { ...releaseBlock, acknowledgeUnstable: true } };

    writeFileSync(join(cwd, "vis.config.cjs"), `module.exports = ${JSON.stringify(block, null, 4)};\n`);
};

const setupFixture = (branch: string): string => {
    const cwd = mkdtempSync(join(tmpdir(), "vis-ci-release-"));

    writeJson(join(cwd, "package.json"), {
        name: "fixture-root",
        private: true,
        version: "0.0.0",
        workspaces: ["packages/*"],
    });

    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    mkdirSync(join(cwd, "packages"), { recursive: true });
    mkdirSync(join(cwd, "packages", "a"), { recursive: true });
    writeJson(join(cwd, "packages", "a", "package.json"), { name: "@scope/a", version: "1.0.0" });
    mkdirSync(join(cwd, ".vis", "release"), { recursive: true });

    execFileSync("git", ["init", "-q", "--initial-branch", branch], { cwd });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd });

    return cwd;
};

const publishOptionsCaptured: { resume?: boolean; tag?: string }[] = [];
const callOrder: string[] = [];
const pushBranchMock = vi.fn(async (..._args: unknown[]) => {
    callOrder.push("pushBranch");

    return 0;
});

type Entry = { name: string; reason: string };

const missingResult = {
    failed: [] as Entry[],
    missing: [] as unknown[],
    published: [],
    skipped: [] as Entry[],
    tags: [],
    tagsPushed: false,
    warnings: [] as string[],
};
const publishResult = {
    failed: [] as Entry[],
    published: [] as { name: string; version: string }[],
    skipped: [] as Entry[],
    tags: [] as string[],
    tagsPushed: false,
};
// Pushed onto the context's plan by the stubbed publish, the way the post-publish steps report.
const publishWarnings: string[] = [];
const publishMissingMock = vi.fn(async () => {
    callOrder.push("publishMissing");

    return missingResult;
});

// Stub publishContext + applyContext so the handler runs without touching
// npm / real publishing. We assert on the captured `resume` flag.
vi.mock(import("../../../src/release/core/orchestrator"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/release/core/orchestrator")>();

    return {
        ...actual,
        applyContext: vi.fn(async () => {
            return {
                changedFiles: [],
                deletedFiles: [],
                plan: { consumedChangeFiles: [], releases: [], warnings: [] },
            };
        }),
        publishContext: vi.fn(async (ctx: { plan: { warnings: string[] } }, options: { resume?: boolean; tag?: string } = {}) => {
            callOrder.push("publishContext");
            publishOptionsCaptured.push({ ...options });
            ctx.plan.warnings.push(...publishWarnings);

            return publishResult;
        }),
        publishMissing: publishMissingMock,
    };
});

// Avoid pushing inside the test.
vi.mock(import("../../../src/release/core/git"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/release/core/git")>();

    return {
        ...actual,
        getCurrentBranch: vi.fn(async () => "main"),
        // The fixture writes `vis.config.cjs` after the initial commit, so the
        // real probe would report a dirty tree and short-circuit the handler.
        listUncommittedPaths: vi.fn(async () => [] as string[]),
        pushBranchWithRebase: pushBranchMock,
    };
});

describe("vis release ci release — C7 publish idempotency", () => {
    let cwd: string | undefined;

    beforeEach(() => {
        cwd = undefined;
        publishOptionsCaptured.length = 0;
        callOrder.length = 0;
        missingResult.failed = [];
        missingResult.skipped = [];
        missingResult.warnings = [];
        publishResult.failed = [];
        publishResult.published = [];
        publishResult.skipped = [];
        publishWarnings.length = 0;
        process.exitCode = undefined;
        // Off by default: vis's own CI runs on GitHub Actions, and the fixtures' failures are not its annotations.
        vi.stubEnv("GITHUB_ACTIONS", "");
    });

    afterEach(async () => {
        if (cwd) {
            await rm(cwd, { force: true, recursive: true });
        }

        vi.clearAllMocks();
        vi.unstubAllEnvs();
    });

    it("version-pr mode with no pending files and no .state.json → publish without resume", async () => {
        expect.hasAssertions();

        cwd = setupFixture("main");

        // Configure main as version-pr channel — no pending files → assume merge.
        writeVisConfigCjs(cwd, {
            channels: { main: { mode: "version-pr", tag: "latest" } },
        });

        const { default: execute } = await import("../../../src/commands/release/ci/release/handler");

        await execute({
            fs: testFs,
            logger: { error: () => {}, info: () => {}, warn: () => {} },
            options: { channel: "main" },
            workspaceRoot: cwd,
        });

        expect(publishOptionsCaptured).toHaveLength(1);
        expect(publishOptionsCaptured[0]).toMatchObject({ resume: false });
        // Version-PR channels refuse to publish while the release PR is open.
        expect(callOrder).not.toContain("publishMissing");
    });

    it("version-pr mode with no pending files and .state.json present → publish with resume", async () => {
        expect.hasAssertions();

        cwd = setupFixture("main");

        writeVisConfigCjs(cwd, {
            channels: { main: { mode: "version-pr", tag: "latest" } },
        });

        // Plant a `.state.json` from a prior partial wave.
        await writeFile(
            stateFilePath(cwd, ".vis/release"),
            `${JSON.stringify({ applied: [], plan: [], published: [], pushed: false, startedAt: new Date().toISOString(), tagged: [], version: 1 }, null, 2)}\n`,
        );

        const { default: execute } = await import("../../../src/commands/release/ci/release/handler");

        await execute({
            fs: testFs,
            logger: { error: () => {}, info: () => {}, warn: () => {} },
            options: { channel: "main" },
            workspaceRoot: cwd,
        });

        expect(publishOptionsCaptured).toHaveLength(1);
        expect(publishOptionsCaptured[0]).toMatchObject({ resume: true });
    });

    it("auto-publish mode → applyContext then publishContext with resume:true", async () => {
        expect.hasAssertions();

        cwd = setupFixture("alpha");

        writeVisConfigCjs(cwd, {
            channels: { alpha: { mode: "auto-publish", prerelease: "alpha", tag: "alpha" } },
        });

        // Auto-publish only fires when there are pending change files.
        await writeFile(join(cwd, ".vis", "release", "change-1.md"), "---\n\"@scope/a\": minor\n---\nFeature\n");

        const { default: execute } = await import("../../../src/commands/release/ci/release/handler");

        await execute({
            fs: testFs,
            logger: { error: () => {}, info: () => {}, warn: () => {} },
            options: { channel: "alpha" },
            workspaceRoot: cwd,
        });

        expect(publishOptionsCaptured).toHaveLength(1);
        expect(publishOptionsCaptured[0]).toMatchObject({ resume: true, tag: "alpha" });
    });

    const silentLogger = { error: () => {}, info: () => {}, warn: () => {} };

    const runAutoPublish = async (options: Record<string, unknown> = {}, logger: typeof silentLogger = silentLogger): Promise<void> => {
        cwd = setupFixture("alpha");

        writeVisConfigCjs(cwd, {
            channels: { alpha: { mode: "auto-publish", prerelease: "alpha", tag: "alpha" } },
        });

        await writeFile(join(cwd, ".vis", "release", "change-1.md"), "---\n\"@scope/a\": minor\n---\nFeature\n");

        const { default: execute } = await import("../../../src/commands/release/ci/release/handler");

        await execute({
            fs: testFs,
            logger,
            options: { channel: "alpha", publishMissing: true, ...options },
            workspaceRoot: cwd,
        });
    };

    it("auto-publish mode → recovers missing versions, pushes the version commit, then publishes", async () => {
        expect.hasAssertions();

        await runAutoPublish();

        expect(callOrder).toStrictEqual(["publishMissing", "pushBranch", "publishContext"]);
    });

    it("auto-publish mode → publishes nothing when the version commit cannot be pushed", async () => {
        expect.hasAssertions();

        pushBranchMock.mockRejectedValueOnce(new Error("rejected"));

        await runAutoPublish();

        expect(callOrder).toStrictEqual(["publishMissing"]);
        expect(process.exitCode).toBe(1);
    });

    it("auto-publish mode → stops before a new wave when recovering a missing version fails", async () => {
        expect.hasAssertions();

        missingResult.failed = [{ name: "@scope/a", reason: "E403" }];

        await runAutoPublish();

        expect(callOrder).toStrictEqual(["publishMissing"]);
        expect(process.exitCode).toBe(2);
    });

    const captureLogger = (): { error: string[]; info: string[]; logger: { error: (m: string) => void; info: (m: string) => void; warn: (m: string) => void }; warn: string[] } => {
        const lines = { error: [] as string[], info: [] as string[], warn: [] as string[] };

        return {
            ...lines,
            logger: {
                error: (message: string) => lines.error.push(message),
                info: (message: string) => lines.info.push(message),
                warn: (message: string) => lines.warn.push(message),
            },
        };
    };

    it("auto-publish mode → logs every package with its reason and every post-publish warning", async () => {
        expect.hasAssertions();

        publishResult.published = [{ name: "@scope/a", version: "1.1.0-alpha.0" }];
        publishResult.skipped = [{ name: "@scope/b", reason: "already-published" }];
        publishResult.failed = [{ name: "@scope/c", reason: "npm publish exited 1: E403 Forbidden" }];
        publishWarnings.push("successWalk: could not comment on #42: HTTP 403");

        const log = captureLogger();

        await runAutoPublish({}, log.logger);

        expect(log.info).toContain("  [published] @scope/a@1.1.0-alpha.0 (dist-tag alpha)");
        expect(log.info).toContain("  [skipped]   @scope/b (already-published)");
        expect(log.error).toContain("  [failed]    @scope/c: npm publish exited 1: E403 Forbidden");
        expect(log.warn).toContain("  - successWalk: could not comment on #42: HTTP 403");
        expect(process.exitCode).toBe(2);
    });

    it("auto-publish mode → logs every recovery skip and the recovery's warnings", async () => {
        expect.hasAssertions();

        missingResult.skipped = [{ name: "@scope/a", reason: "already-published: tagged @scope/a@1.1.0" }];
        missingResult.warnings = ["successWalk: could not comment on #7: HTTP 502"];

        const log = captureLogger();

        await runAutoPublish({}, log.logger);

        expect(log.info).toContain("Recovery skipped @scope/a: already-published: tagged @scope/a@1.1.0.");
        expect(log.warn).toContain("  - successWalk: could not comment on #7: HTTP 502");
    });

    it("auto-publish mode → annotates failures and warnings on GitHub Actions", async () => {
        expect.hasAssertions();

        vi.stubEnv("GITHUB_ACTIONS", "true");
        publishResult.failed = [{ name: "@scope/c", reason: "npm publish exited 1:\nE403 100% Forbidden" }];
        publishWarnings.push("successWalk: could not comment on #42: HTTP 403");

        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        let written: string[];

        try {
            await runAutoPublish();
        } finally {
            // Read before restoring: mockRestore() clears the recorded calls.
            written = write.mock.calls.map(([chunk]) => String(chunk));
            write.mockRestore();
        }

        expect(written).toContain("::error::@scope/c: npm publish exited 1:%0AE403 100%25 Forbidden\n");
        expect(written).toContain("::warning::successWalk: could not comment on #42: HTTP 403\n");
    });

    it("--no-publish-missing skips the recovery", async () => {
        expect.hasAssertions();

        await runAutoPublish({ publishMissing: false });

        expect(callOrder).toStrictEqual(["pushBranch", "publishContext"]);
    });
});
