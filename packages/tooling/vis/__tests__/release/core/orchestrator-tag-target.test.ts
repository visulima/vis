import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyContext, buildContext, publishContext } from "../../../src/release/core/orchestrator";
import type { PublishResult } from "../../../src/release/core/package-managers/interface";
import { VersionActions } from "../../../src/release/core/version-actions/interface";
import { __resetLookupMemoForTests } from "../../../src/release/core/version-resolver";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

class StubVersionActions extends VersionActions {
    public readonly id = "stub";

    public async readPublishedVersion(): Promise<string | undefined> {
        return undefined;
    }

    public async publish(): Promise<PublishResult> {
        return { alreadyPublished: false, output: "ok", published: true };
    }
}

/** `@scope/a@1.0.0` (tagged) with a pending minor change file, under `tagTarget: "source"`. */
const setupFixture = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "vis-tag-target-"));

    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "fixture-root", private: true, version: "0.0.0", workspaces: ["packages/*"] })}\n`);
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n.vis/release/.state.json\n");
    writeFileSync(
        join(cwd, "vis.config.cjs"),
        `module.exports = ${JSON.stringify({ release: { acknowledgeUnstable: true, defaultManaged: true, publish: { noRelease: true }, tagTarget: "source" } })};\n`,
    );
    mkdirSync(join(cwd, "packages", "a"), { recursive: true });
    writeFileSync(join(cwd, "packages", "a", "package.json"), `${JSON.stringify({ name: "@scope/a", version: "1.0.0" })}\n`);
    mkdirSync(join(cwd, ".vis", "release"), { recursive: true });
    writeFileSync(join(cwd, ".vis", "release", "minor-a.md"), `---\n"@scope/a": minor\n---\nadd a thing\n`);

    git(cwd, "init", "-q");
    git(cwd, "config", "user.email", "test@example.com");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "commit.gpgsign", "false");
    git(cwd, "config", "tag.gpgsign", "false");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", "chore: init");
    git(cwd, "tag", "@scope/a@1.0.0");
    writeFileSync(join(cwd, "README.md"), "later\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", "docs: readme");

    return cwd;
};

const trailerOf = (cwd: string, commit: string): string => git(cwd, "log", "-1", "--format=%(trailers:key=Release-Source,valueonly)", commit);

describe.skipIf(process.platform === "win32")("tagTarget: source", () => {
    let cwd: string;

    beforeEach(() => {
        __resetLookupMemoForTests();
        cwd = setupFixture();
    });

    afterEach(async () => {
        await rm(cwd, { force: true, recursive: true });
    });

    it("records the commit the wave was planned from and tags it", async () => {
        expect.hasAssertions();

        const source = git(cwd, "rev-parse", "HEAD");
        const ctx = await buildContext({ cwd });

        await applyContext(ctx, { commit: true });

        expect(trailerOf(cwd, "HEAD")).toBe(source);

        const result = await publishContext(ctx, { noPush: true, publishActionsOverride: new StubVersionActions() });

        expect(result.failed).toStrictEqual([]);
        expect(git(cwd, "rev-list", "-n1", "@scope/a@1.1.0")).toBe(source);
    });

    it("records the source it is given rather than HEAD", async () => {
        expect.hasAssertions();

        // `ci release` passes the commit it planned from: a recovery publish may
        // have committed bookkeeping on top of it that never reached the remote.
        const planned = git(cwd, "rev-parse", "HEAD~1");
        const ctx = await buildContext({ cwd });

        await applyContext(ctx, { commit: true, releaseSource: planned });

        expect(trailerOf(cwd, "HEAD")).toBe(planned);
    });

    it("tags nothing when the trailer names a commit that is not an ancestor", async () => {
        expect.hasAssertions();

        const ctx = await buildContext({ cwd });

        await applyContext(ctx, { commit: true });
        git(cwd, "commit", "-q", "--amend", "-m", "release(main): @scope/a@1.1.0 [skip ci]", "-m", "Release-Source: 0123456789abcdef0123456789abcdef01234567");

        const result = await publishContext(ctx, { noPush: true, publishActionsOverride: new StubVersionActions() });

        expect(result.failed).toStrictEqual([{ name: "_tagTarget", reason: expect.stringContaining("not an ancestor") }]);
        expect(git(cwd, "tag", "--list", "@scope/a@1.1.0")).toBe("");
    });
});
