import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildContext, publishContext } from "../../../src/release/core/orchestrator";
import type { PublishResult } from "../../../src/release/core/package-managers/interface";
import type { PublishContext } from "../../../src/release/core/version-actions/interface";
import { VersionActions } from "../../../src/release/core/version-actions/interface";

const remote = vi.hoisted(() => {
    return {
        detectRemoteProvider: vi.fn(),
        detectRepoSlug: vi.fn(),
    };
});

vi.mock(import("../../../src/release/core/remote/detect"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        createRemoteClient: () => {
            return { detectRepoSlug: remote.detectRepoSlug };
        },
        detectRemoteProvider: remote.detectRemoteProvider,
    };
});

// Only the network-facing push check is stubbed; the remote is still a real
// git remote so `git remote get-url --push origin` runs for real.
vi.mock(import("../../../src/release/core/git"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        getCurrentBranch: async () => "main",
        resolvePushCredentials: async () => undefined,
        verifyPushAccess: async () => undefined,
    };
});

class StubVersionActions extends VersionActions {
    public readonly id = "stub";

    public readonly calls: string[] = [];

    public async readPublishedVersion(): Promise<string | undefined> {
        return undefined;
    }

    public async publish(context: PublishContext): Promise<PublishResult> {
        this.calls.push(context.pkg.name);

        return { alreadyPublished: false, output: "ok", published: true };
    }
}

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
};

const setupFixture = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "vis-orch-preflight-"));

    writeJson(join(cwd, "package.json"), { name: "fixture-root", packageManager: "pnpm@10.0.0", private: true, version: "0.0.0", workspaces: ["packages/*"] });
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

    mkdirSync(join(cwd, "packages", "a"), { recursive: true });
    writeJson(join(cwd, "packages", "a", "package.json"), { name: "@scope/a", version: "1.0.0" });

    mkdirSync(join(cwd, ".vis", "release"), { recursive: true });
    writeFileSync(join(cwd, ".vis", "release", "feat.md"), `---\n"@scope/a": minor\n---\nbody\n`);
    writeFileSync(
        join(cwd, "vis.config.cjs"),
        `module.exports = ${JSON.stringify({ release: { acknowledgeUnstable: true, defaultManaged: true } }, null, 4)};\n`,
    );

    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/acme/repo.git"], { cwd });

    return cwd;
};

describe("orchestrator: publish preflight reports failures instead of rejecting", () => {
    let cwd: string;

    beforeEach(() => {
        cwd = setupFixture();
        remote.detectRemoteProvider.mockReset();
        remote.detectRepoSlug.mockReset();
    });

    afterEach(async () => {
        await rm(cwd, { force: true, recursive: true });
    });

    it("records a _preflight failure when the release-PR check cannot reach the remote", async () => {
        expect.hasAssertions();

        const actions = new StubVersionActions();
        const ctx = await buildContext({
            config: { acknowledgeUnstable: true, defaultManaged: true },
            cwd,
            firstRelease: true,
        });

        // Only the version-pr channel runs the open-release-PR check.
        Object.assign(ctx, { channel: { mode: "version-pr" } });
        remote.detectRemoteProvider.mockRejectedValue(new Error("remote unreachable"));

        const result = await publishContext(ctx, { noPush: true, noTag: true, publishActionsOverride: actions });

        expect(actions.calls).toStrictEqual([]);
        expect(result.published).toStrictEqual([]);
        expect(result.failed).toStrictEqual([expect.objectContaining({ name: "_preflight", reason: expect.stringContaining("remote unreachable") })]);
    });

    it("records a _preflight failure when the push-rule check cannot resolve the repo", async () => {
        expect.hasAssertions();

        const actions = new StubVersionActions();
        const ctx = await buildContext({
            config: { acknowledgeUnstable: true, defaultManaged: true },
            cwd,
            firstRelease: true,
        });

        remote.detectRemoteProvider.mockResolvedValue("github");
        remote.detectRepoSlug.mockRejectedValue(new Error("slug lookup failed"));

        const result = await publishContext(ctx, { noTag: true, publishActionsOverride: actions });

        expect(actions.calls).toStrictEqual([]);
        expect(result.published).toStrictEqual([]);
        expect(result.failed).toStrictEqual([expect.objectContaining({ name: "_preflight", reason: expect.stringContaining("slug lookup failed") })]);
    });
});
