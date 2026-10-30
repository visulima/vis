import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RegistryProbe } from "../../../src/release/core/orchestrator";
import { buildContext, findMissingReleases, publishMissing } from "../../../src/release/core/orchestrator";
import type { PublishResult } from "../../../src/release/core/package-managers/interface";
import { createShellRunner } from "../../../src/release/core/shell-runner";
import type { PublishContext } from "../../../src/release/core/version-actions/interface";
import { VersionActions } from "../../../src/release/core/version-actions/interface";
import { __resetLookupMemoForTests, resolveLastReleaseRef } from "../../../src/release/core/version-resolver";

// What the post-publish steps (success walk, notifications, forge releases)
// would report: they push onto the plan the publish was handed.
const postPublishWarnings: string[] = [];

vi.mock(import("../../../src/release/core/orchestrator/publish"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        publishContext: async (...args: Parameters<typeof actual.publishContext>) => {
            const result = await actual.publishContext(...args);

            args[0].plan.warnings.push(...postPublishWarnings);

            return result;
        },
    };
});

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
};

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commitAll = (cwd: string, message: string): string => {
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", message);

    return git(cwd, "rev-parse", "HEAD");
};

/**
 * The trace of a partly failed wave: tags a@1.0.0 / b@1.0.0, then a release
 * commit bumping both to 1.1.0 where only a published (so only a is tagged).
 */
const setupFixture = (): { cwd: string; releaseCommit: string } => {
    const cwd = mkdtempSync(join(tmpdir(), "vis-missing-"));

    writeJson(join(cwd, "package.json"), { name: "fixture-root", packageManager: "pnpm@10.0.0", private: true, version: "0.0.0", workspaces: ["packages/*"] });
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(
        join(cwd, "vis.config.cjs"),
        `module.exports = ${JSON.stringify({ release: { acknowledgeUnstable: true, currentVersionResolver: "git-tag", defaultManaged: true } })};\n`,
    );

    for (const name of ["a", "b"]) {
        mkdirSync(join(cwd, "packages", name), { recursive: true });
        writeJson(join(cwd, "packages", name, "package.json"), { name: `@scope/${name}`, version: "1.0.0" });
    }

    git(cwd, "init", "-q");
    git(cwd, "config", "user.email", "test@example.com");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "tag.gpgsign", "false");
    commitAll(cwd, "init");
    git(cwd, "tag", "@scope/a@1.0.0");
    git(cwd, "tag", "@scope/b@1.0.0");

    for (const name of ["a", "b"]) {
        writeJson(join(cwd, "packages", name, "package.json"), { name: `@scope/${name}`, version: "1.1.0" });
    }

    const releaseCommit = commitAll(cwd, "chore(release): publish [skip ci]");

    git(cwd, "tag", "@scope/a@1.1.0");

    return { cwd, releaseCommit };
};

class StubVersionActions extends VersionActions {
    public readonly id = "stub";

    public readonly calls: string[] = [];

    public readonly types: string[] = [];

    public constructor(private readonly failWith?: string) {
        super();
    }

    public async readPublishedVersion(): Promise<string | undefined> {
        return undefined;
    }

    public async publish(context: PublishContext): Promise<PublishResult> {
        if (this.failWith !== undefined) {
            throw new Error(this.failWith);
        }

        this.calls.push(`${context.pkg.name}@${context.release.newVersion}@${context.tag ?? "latest"}`);
        this.types.push(context.release.type);

        return { alreadyPublished: false, output: "ok", published: true };
    }
}

const notOnRegistry: RegistryProbe = async () => false;

describe.skipIf(process.platform === "win32")("publishMissing: recover a partly failed wave", () => {
    let cwd: string;
    let releaseCommit: string;

    beforeEach(() => {
        __resetLookupMemoForTests();
        ({ cwd, releaseCommit } = setupFixture());
    });

    afterEach(async () => {
        postPublishWarnings.length = 0;
        await rm(cwd, { force: true, recursive: true });
    });

    it("finds only the committed-but-untagged version, at the release commit", async () => {
        expect.hasAssertions();

        const ctx = await buildContext({ cwd });
        const found = await findMissingReleases(ctx, { registryProbe: notOnRegistry });

        expect(found.missing).toStrictEqual([
            { commit: releaseCommit, name: "@scope/b", onRegistry: false, previousVersion: "1.0.0", target: releaseCommit, version: "1.1.0" },
        ]);
    });

    it("publishes it and tags the release commit, so a later commit stays in the next release range", async () => {
        expect.hasAssertions();

        writeFileSync(join(cwd, "README.md"), "later\n");
        const later = commitAll(cwd, "feat: something after the failed wave");

        const actions = new StubVersionActions();
        const ctx = await buildContext({ cwd });
        const result = await publishMissing(ctx, { noPush: true, publishActionsOverride: actions, registryProbe: notOnRegistry, tag: "alpha" });

        expect(actions.calls).toStrictEqual(["@scope/b@1.1.0@alpha"]);
        // 1.0.0 → 1.1.0 is a minor release, not a patch.
        expect(actions.types).toStrictEqual(["minor"]);
        expect(result.failed).toStrictEqual([]);
        expect(result.tags).toStrictEqual(["@scope/b@1.1.0"]);
        expect(git(cwd, "rev-list", "-n1", "@scope/b@1.1.0")).toBe(releaseCommit);

        // The boundary `generate --since-last-release` walks from must not jump past `later`.
        const ref = await resolveLastReleaseRef({ cwd, packages: ctx.packages, runner: createShellRunner(), workspaceConfig: ctx.config });

        expect(ref.kind).toBe("tag");
        expect(git(cwd, "rev-list", "-n1", (ref as { ref: string }).ref)).toBe(releaseCommit);
        expect(git(cwd, "rev-list", `${releaseCommit}..HEAD`)).toBe(later);
    });

    it("lets the next plan in the same process continue from the recovered version", async () => {
        expect.hasAssertions();

        // The first context memoises @scope/b at its last tag, 1.0.0.
        const ctx = await buildContext({ cwd });

        await publishMissing(ctx, { noPush: true, publishActionsOverride: new StubVersionActions(), registryProbe: notOnRegistry });

        mkdirSync(join(cwd, ".vis", "release"), { recursive: true });
        writeFileSync(join(cwd, ".vis", "release", "fix-b.md"), `---\n"@scope/b": patch\n---\nfix\n`);

        const next = await buildContext({ cwd });

        expect(
            next.plan.releases.map(({ name, newVersion, oldVersion }) => {
                return { name, newVersion, oldVersion };
            }),
        ).toStrictEqual([{ name: "@scope/b", newVersion: "1.1.1", oldVersion: "1.1.0" }]);
    });

    it("returns the plan warnings, then the post-publish warnings of the recovered versions", async () => {
        expect.hasAssertions();

        postPublishWarnings.push("successWalk: could not comment on #42: HTTP 403");

        const ctx = await buildContext({ cwd });

        ctx.plan.warnings.push("catalog: planning warning");

        const result = await publishMissing(ctx, { noPush: true, publishActionsOverride: new StubVersionActions(), registryProbe: notOnRegistry });

        expect(result.warnings).toStrictEqual([...ctx.plan.warnings, "successWalk: could not comment on #42: HTTP 403"]);
        expect(result.warnings).toContain("catalog: planning warning");
        // A copy: the recovery's post-publish warnings stay out of the caller's plan.
        expect(ctx.plan.warnings).not.toContain("successWalk: could not comment on #42: HTTP 403");
    });

    it("lists a published version as completed", async () => {
        expect.hasAssertions();

        const result = await publishMissing(await buildContext({ cwd }), { noPush: true, publishActionsOverride: new StubVersionActions(), registryProbe: notOnRegistry });

        expect(result.completed.map((entry) => entry.name)).toStrictEqual(["@scope/b"]);
    });

    it("lists a version that failed to publish as failed, not completed", async () => {
        expect.hasAssertions();

        const result = await publishMissing(await buildContext({ cwd }), {
            noPush: true,
            publishActionsOverride: new StubVersionActions("E403 Forbidden"),
            registryProbe: notOnRegistry,
        });

        expect(result.missing.map((entry) => entry.name)).toStrictEqual(["@scope/b"]);
        expect(result.completed).toStrictEqual([]);
        expect(result.failed.map((entry) => entry.name)).toStrictEqual(["@scope/b"]);
    });

    it("lists a tagged version as completed", async () => {
        expect.hasAssertions();

        const result = await publishMissing(await buildContext({ cwd }), { noPush: true, registryProbe: async () => true });

        expect(result.completed.map((entry) => entry.name)).toStrictEqual(["@scope/b"]);
    });

    it("only tags a version the registry already has", async () => {
        expect.hasAssertions();

        writeFileSync(join(cwd, "README.md"), "later\n");
        commitAll(cwd, "docs: after the failed wave");

        const actions = new StubVersionActions();
        const ctx = await buildContext({ cwd });
        const result = await publishMissing(ctx, { noPush: true, publishActionsOverride: actions, registryProbe: async () => true });

        expect(actions.calls).toStrictEqual([]);
        expect(result.tags).toStrictEqual(["@scope/b@1.1.0"]);
        expect(git(cwd, "rev-list", "-n1", "@scope/b@1.1.0")).toBe(releaseCommit);
    });

    it("does nothing on a dry run", async () => {
        expect.hasAssertions();

        const actions = new StubVersionActions();
        const ctx = await buildContext({ cwd });
        const result = await publishMissing(ctx, { dryRun: true, publishActionsOverride: actions, registryProbe: async () => true });

        expect(result.missing.map((m) => m.name)).toStrictEqual(["@scope/b"]);
        expect(result.tags).toStrictEqual([]);
        expect(git(cwd, "tag", "--list", "@scope/b@1.1.0")).toBe("");
    });

    it("skips when the registry cannot say", async () => {
        expect.hasAssertions();

        const ctx = await buildContext({ cwd });
        const found = await findMissingReleases(ctx, { registryProbe: async () => undefined });

        expect(found.missing).toStrictEqual([]);
        expect(found.skipped[0]?.reason).toMatch(/could not confirm/);
    });

    it("skips when the package changed after the release commit", async () => {
        expect.hasAssertions();

        writeFileSync(join(cwd, "packages", "b", "index.js"), "export {};\n");
        commitAll(cwd, "fix: change b");

        const ctx = await buildContext({ cwd });
        const found = await findMissingReleases(ctx, { registryProbe: notOnRegistry });

        expect(found.missing).toStrictEqual([]);
        expect(found.skipped[0]?.reason).toMatch(/changed since/);
    });

    it("skips a version set by a commit that is not a release commit", async () => {
        expect.hasAssertions();

        writeJson(join(cwd, "packages", "b", "package.json"), { name: "@scope/b", version: "1.2.0" });
        commitAll(cwd, "feat: hand-bump b");

        const ctx = await buildContext({ cwd });
        const found = await findMissingReleases(ctx, { registryProbe: notOnRegistry });

        expect(found.missing).toStrictEqual([]);
        expect(found.skipped[0]?.reason).toMatch(/not a release commit/);
    });

    it("tags the commit a rebased release commit's Release-Source trailer names, keeping the commits under it in range", async () => {
        expect.hasAssertions();

        // `tagTarget: "source"` after a retried push: the wave was planned from
        // `source`, `concurrent` moved the branch, the release commit was rebased onto it.
        const source = git(cwd, "rev-parse", "HEAD~1");

        git(cwd, "reset", "-q", "--hard", source);
        git(cwd, "tag", "-d", "@scope/a@1.1.0");
        writeFileSync(join(cwd, "README.md"), "concurrent\n");
        const concurrent = commitAll(cwd, "feat: landed during the release");

        for (const name of ["a", "b"]) {
            writeJson(join(cwd, "packages", name, "package.json"), { name: `@scope/${name}`, version: "1.1.0" });
        }

        git(cwd, "add", "-A");
        git(cwd, "commit", "-qm", "release(main): version 2 packages [skip ci]", "-m", `Release-Source: ${source}`);
        git(cwd, "tag", "@scope/a@1.1.0", source);

        const ctx = await buildContext({ cwd });
        const result = await publishMissing(ctx, { noPush: true, publishActionsOverride: new StubVersionActions(), registryProbe: notOnRegistry });

        expect(result.tags).toStrictEqual(["@scope/b@1.1.0"]);
        expect(git(cwd, "rev-list", "-n1", "@scope/b@1.1.0")).toBe(source);

        const ref = await resolveLastReleaseRef({ cwd, packages: ctx.packages, runner: createShellRunner(), workspaceConfig: ctx.config });

        expect(git(cwd, "rev-list", `${(ref as { ref: string }).ref}..HEAD`)).toContain(concurrent);
    });

    it("skips a version whose Release-Source trailer is not an ancestor of the release commit", async () => {
        expect.hasAssertions();

        git(cwd, "commit", "-q", "--amend", "-m", "chore(release): publish [skip ci]", "-m", "Release-Source: 0123456789abcdef0123456789abcdef01234567");

        const ctx = await buildContext({ cwd });
        const found = await findMissingReleases(ctx, { registryProbe: notOnRegistry });

        expect(found.missing).toStrictEqual([]);
        expect(found.skipped[0]?.reason).toMatch(/not an ancestor/);
    });

    it("ignores a manifest version that is not ahead of the tags", async () => {
        expect.hasAssertions();

        git(cwd, "tag", "@scope/b@1.1.0");

        const ctx = await buildContext({ cwd });
        const found = await findMissingReleases(ctx, { registryProbe: notOnRegistry });

        expect(found).toStrictEqual({ missing: [], skipped: [] });
    });
});
