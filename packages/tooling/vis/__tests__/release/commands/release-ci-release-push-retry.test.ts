/**
 * `vis release ci release --auto-publish` when the branch moves during the run:
 * real git, a bare `origin`, and a second clone that lands a commit between
 * the checkout and the version-commit push. Only the registry is stubbed.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishResult } from "../../../src/release/core/package-managers/interface";
import type { PublishContext } from "../../../src/release/core/version-actions/interface";
import { VersionActions } from "../../../src/release/core/version-actions/interface";
import { __resetLookupMemoForTests } from "../../../src/release/core/version-resolver";

const testFs = { access, mkdir, readdir, readFile, rm, stat, writeFile } as never;

const published: string[] = [];

class StubVersionActions extends VersionActions {
    public readonly id = "stub";

    public async readPublishedVersion(): Promise<string | undefined> {
        return undefined;
    }

    public async publish(context: PublishContext): Promise<PublishResult> {
        published.push(`${context.pkg.name}@${context.release.newVersion}`);

        return { alreadyPublished: false, output: "ok", published: true };
    }
}

vi.mock(import("../../../src/release/core/orchestrator"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/release/core/orchestrator")>();

    return {
        ...actual,
        publishContext: vi.fn(async (context: Parameters<typeof actual.publishContext>[0], options: Parameters<typeof actual.publishContext>[1] = {}) =>
            actual.publishContext(context, { ...options, publishActionsOverride: new StubVersionActions() }),
        ),
    };
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const configure = (cwd: string): void => {
    git(cwd, "config", "user.email", "test@example.com");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "commit.gpgsign", "false");
    git(cwd, "config", "tag.gpgsign", "false");
};

const commitFile = (cwd: string, file: string, content: string, message: string): string => {
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", "--", file);
    git(cwd, "commit", "-qm", message);

    return git(cwd, "rev-parse", "HEAD");
};

/** `origin` with `@scope/a` and `@scope/b` at 1.0.0 (tagged); the checkout adds `feat(a)` and pushes it. */
const setupFixture = (root: string, release: Record<string, unknown>): { other: string; remote: string; source: string; work: string } => {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const other = join(root, "other");

    execFileSync("git", ["init", "-q", "--bare", "--initial-branch", "main", remote]);
    execFileSync("git", ["clone", "-q", remote, work], { stdio: "pipe" });
    configure(work);

    writeFileSync(
        join(work, "package.json"),
        `${JSON.stringify({ name: "fixture-root", private: true, version: "0.0.0", workspaces: ["packages/*"] }, null, 4)}\n`,
    );
    writeFileSync(join(work, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    // As `vis release init` writes it.
    writeFileSync(join(work, ".gitignore"), "node_modules\n.vis/release/.state.json\n.vis/release/.lock\n");
    writeFileSync(
        join(work, "vis.config.cjs"),
        `module.exports = ${JSON.stringify({ release: { acknowledgeUnstable: true, defaultManaged: true, publish: { noRelease: true }, ...release } }, null, 4)};\n`,
    );
    mkdirSync(join(work, ".vis", "release"), { recursive: true });
    writeFileSync(join(work, ".vis", "release", ".gitkeep"), "");

    for (const name of ["a", "b"]) {
        mkdirSync(join(work, "packages", name), { recursive: true });
        writeFileSync(join(work, "packages", name, "package.json"), `${JSON.stringify({ name: `@scope/${name}`, version: "1.0.0" }, null, 4)}\n`);
        writeFileSync(join(work, "packages", name, "index.js"), "export {};\n");
    }

    git(work, "add", ".");
    git(work, "commit", "-qm", "chore: init");
    git(work, "tag", "@scope/a@1.0.0");
    git(work, "tag", "@scope/b@1.0.0");

    const source = commitFile(work, "packages/a/index.js", "export const a = 1;\n", "feat(a): add a");

    git(work, "push", "-q", "--tags", "origin", "HEAD:refs/heads/main");
    execFileSync("git", ["clone", "-q", remote, other], { stdio: "pipe" });
    configure(other);

    return { other, remote, source, work };
};

/** Another merge lands on `main` while the release runs. */
const landConcurrentFix = (other: string): string => {
    const sha = commitFile(other, "packages/b/index.js", "export const b = 1;\n", "fix(b): fix b");

    git(other, "push", "-q", "origin", "HEAD:refs/heads/main");

    return sha;
};

const runRelease = async (cwd: string): Promise<{ errors: string[]; info: string[] }> => {
    const errors: string[] = [];
    const info: string[] = [];
    const { default: execute } = await import("../../../src/commands/release/ci/release/handler");

    await execute({
        fs: testFs,
        logger: { error: (message: string) => errors.push(message), info: (message: string) => info.push(message), warn: () => {} },
        options: { autoPublish: true, generate: true },
        workspaceRoot: cwd,
    } as never);

    return { errors, info };
};

const remoteTags = (remote: string): string => git(remote, "tag", "--list");

describe.skipIf(process.platform === "win32")("vis release ci release — the branch moved during the run", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-ci-push-retry-"));
        published.length = 0;
        process.exitCode = undefined;
        __resetLookupMemoForTests();
    });

    afterEach(async () => {
        await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
        process.exitCode = undefined;
    });

    it("tagTarget source: rebases the version commit, tags the source, and the next run releases the concurrent commit", async () => {
        expect.hasAssertions();

        const { other, remote, source, work } = setupFixture(root, { tagTarget: "source" });
        const concurrent = landConcurrentFix(other);

        const first = await runRelease(work);

        expect(first.errors).toStrictEqual([]);
        expect(process.exitCode ?? 0).toBe(0);
        expect(published).toStrictEqual(["@scope/a@1.1.0"]);
        expect(first.info.join("\n")).toContain("after 1 rebase(s)");

        // The version commit sits on top of the concurrent fix and names its source.
        // (The staged-registry bookkeeping commit may follow it.)
        const versionCommit = git(remote, "rev-parse", String.raw`main^{/^release\(main\)}`);

        expect(git(remote, "rev-parse", `${versionCommit}~1`)).toBe(concurrent);
        expect(git(remote, "log", "-1", "--format=%(trailers:key=Release-Source,valueonly)", versionCommit)).toBe(source);
        expect(git(remote, "rev-list", "-n1", "@scope/a@1.1.0")).toBe(source);

        published.length = 0;
        __resetLookupMemoForTests();

        const second = await runRelease(work);

        expect(second.errors).toStrictEqual([]);
        expect(published).toStrictEqual(["@scope/b@1.0.1"]);
    });

    it("tagTarget source: a push still rejected after pushRetries publishes nothing", async () => {
        expect.hasAssertions();

        const { other, remote, work } = setupFixture(root, { pushRetries: 0, tagTarget: "source" });
        const concurrent = landConcurrentFix(other);
        const tagsBefore = remoteTags(remote);

        const { errors } = await runRelease(work);

        expect(process.exitCode).toBe(1);
        expect(errors.join("\n")).toContain("nothing was published");
        expect(published).toStrictEqual([]);
        expect(git(remote, "rev-parse", "main")).toBe(concurrent);
        expect(remoteTags(remote)).toBe(tagsBefore);
    });

    it("tagTarget release-commit (default): refuses to rebase and points at tagTarget source", async () => {
        expect.hasAssertions();

        const { other, remote, work } = setupFixture(root, {});
        const concurrent = landConcurrentFix(other);
        const tagsBefore = remoteTags(remote);

        const { errors } = await runRelease(work);

        expect(process.exitCode).toBe(1);
        expect(errors.join("\n")).toContain(`release.tagTarget: "source"`);
        expect(published).toStrictEqual([]);
        expect(git(remote, "rev-parse", "main")).toBe(concurrent);
        expect(remoteTags(remote)).toBe(tagsBefore);
    });

    it("rejects pushRetries without tagTarget source before versioning anything", async () => {
        expect.hasAssertions();

        const { work } = setupFixture(root, { pushRetries: 3 });
        const head = git(work, "rev-parse", "HEAD");

        const { errors } = await runRelease(work);

        expect(process.exitCode).toBe(1);
        expect(errors.join("\n")).toContain(`needs release.tagTarget: "source"`);
        expect(git(work, "rev-parse", "HEAD")).toBe(head);
        expect(published).toStrictEqual([]);
    });
});
