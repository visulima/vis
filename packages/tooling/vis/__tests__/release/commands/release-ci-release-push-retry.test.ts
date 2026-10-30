/**
 * `vis release ci release --auto-publish` when the branch moves during the run:
 * real git, a bare `origin`, and a second clone that lands a commit between
 * the checkout and the version-commit push. Only the registry is stubbed.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** Test switches for the orchestrator wrapper below. */
const hooks: { failLockfileCheck: boolean; recovery?: (cwd: string) => void } = { failLockfileCheck: false };

vi.mock(import("../../../src/release/core/orchestrator"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/release/core/orchestrator")>();

    return {
        ...actual,
        buildContext: vi.fn(async (options: Parameters<typeof actual.buildContext>[0]) => {
            const context = await actual.buildContext(options);

            if (hooks.failLockfileCheck) {
                context.pm.verifyLockfile = async () => {
                    throw new Error("lockfile does not satisfy the manifests");
                };
            }

            return context;
        }),
        publishContext: vi.fn(async (context: Parameters<typeof actual.publishContext>[0], options: Parameters<typeof actual.publishContext>[1] = {}) =>
            actual.publishContext(context, { ...options, publishActionsOverride: new StubVersionActions() }),
        ),
        publishMissing: vi.fn(async (context: Parameters<typeof actual.publishMissing>[0]) => {
            // Stands in for a recovery wave: it leaves a bookkeeping commit behind.
            hooks.recovery?.(context.cwd);

            return { failed: [], missing: [], published: [], skipped: [], tags: [], tagsPushed: false, warnings: [] };
        }),
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

const DEFAULT_RUN = { autoPublish: true, generate: true };

const runRelease = async (cwd: string, options: Record<string, unknown> = DEFAULT_RUN): Promise<{ errors: string[]; info: string[] }> => {
    const errors: string[] = [];
    const info: string[] = [];
    const { default: execute } = await import("../../../src/commands/release/ci/release/handler");

    await execute({
        fs: testFs,
        logger: { error: (message: string) => errors.push(message), info: (message: string) => info.push(message), warn: () => {} },
        options,
        workspaceRoot: cwd,
    } as never);

    return { errors, info };
};

const remoteTags = (remote: string): string => git(remote, "tag", "--list");

/** Record the refs of every push `remote` receives from now on, one array per push. */
const recordPushes = (remote: string): (() => string[][]) => {
    const log = join(remote, "pushes.log");
    const hook = join(remote, "hooks", "post-receive");

    writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do echo "$ref" >> "${log}"; done\necho --- >> "${log}"\n`);
    chmodSync(hook, 0o755);

    return () => {
        let raw: string;

        try {
            raw = readFileSync(log, "utf8");
        } catch {
            return [];
        }

        return raw
            .split("---\n")
            .filter((push) => push.trim() !== "")
            .map((push) => push.trim().split("\n"));
    };
};

const branchPushes = (pushes: string[][]): number => pushes.filter((refs) => refs.includes("refs/heads/main")).length;

describe.skipIf(process.platform === "win32")("vis release ci release — the branch moved during the run", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-ci-push-retry-"));
        published.length = 0;
        hooks.failLockfileCheck = false;
        hooks.recovery = undefined;
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

    it("pushes the branch once and the tags once, and leaves no dedupe state behind without successWalk", async () => {
        expect.hasAssertions();

        const { remote, work } = setupFixture(root, { tagTarget: "source" });
        const pushes = recordPushes(remote);
        const before = git(remote, "rev-parse", "main");

        await runRelease(work);

        expect(process.exitCode ?? 0).toBe(0);
        expect(published).toStrictEqual(["@scope/a@1.1.0"]);
        expect(pushes()).toStrictEqual([["refs/heads/main"], ["refs/tags/@scope/a@1.1.0"]]);
        expect(git(remote, "rev-list", "--count", `${before}..main`)).toBe("1");
        expect(git(remote, "ls-tree", "-r", "--name-only", "main")).not.toContain("staged.json");
    });

    it("pushes floating major tags with the release tags, in one push", async () => {
        expect.hasAssertions();

        const { remote, work } = setupFixture(root, { floatingMajorTag: true, tagTarget: "source" });
        const pushes = recordPushes(remote);

        await runRelease(work);

        const tagPushes = pushes().filter((refs) => refs.some((ref) => ref.startsWith("refs/tags/")));

        expect(tagPushes.map((refs) => refs.toSorted())).toStrictEqual([["refs/tags/@scope/a@1.1.0", "refs/tags/scope-a-v1"]]);
    });

    it("lockInGit: commits the lock locally and pushes it with one more branch push at the end", async () => {
        expect.hasAssertions();

        const { remote, source, work } = setupFixture(root, { publish: { lockInGit: true, noRelease: true }, tagTarget: "source" });
        const pushes = recordPushes(remote);

        await runRelease(work);

        expect(process.exitCode ?? 0).toBe(0);
        expect(branchPushes(pushes())).toBe(2);
        // Not the lock commit that was HEAD while tagging.
        expect(git(remote, "rev-list", "-n1", "@scope/a@1.1.0")).toBe(source);
        expect(git(remote, "log", "--format=%s", "-3", "main")).toContain("chore(release): close publish lock [skip ci]");
        expect(git(remote, "rev-parse", "main")).toBe(git(work, "rev-parse", "HEAD"));
    });

    it("pushes what a recovery wave committed even when there is nothing new to release", async () => {
        expect.hasAssertions();

        const { remote, work } = setupFixture(root, { tagTarget: "source" });

        hooks.recovery = (cwd) => {
            commitFile(cwd, "recovered.txt", "state\n", "chore(release): record recovered state [skip ci]");
        };

        const { info } = await runRelease(work, { autoPublish: true, publishMissing: true });

        expect(info.join("\n")).toContain("No pending change files");
        expect(git(remote, "log", "-1", "--format=%s", "main")).toBe("chore(release): record recovered state [skip ci]");
    });

    it("aborts with nothing published when the regenerated lockfile fails the frozen check", async () => {
        expect.hasAssertions();

        const { remote, work } = setupFixture(root, { tagTarget: "source" });
        const before = git(remote, "rev-parse", "main");
        const tagsBefore = remoteTags(remote);

        hooks.failLockfileCheck = true;

        const { errors } = await runRelease(work);

        expect(process.exitCode).toBe(1);
        expect(errors.join("\n")).toContain("nothing was published");
        expect(published).toStrictEqual([]);
        expect(git(remote, "rev-parse", "main")).toBe(before);
        expect(remoteTags(remote)).toBe(tagsBefore);
    });

    it("lockInGit with release-commit tags: tags the version commit, which lands on the branch", async () => {
        expect.hasAssertions();

        const { remote, work } = setupFixture(root, { publish: { lockInGit: true, noRelease: true } });

        await runRelease(work);

        const tagged = git(remote, "rev-list", "-n1", "@scope/a@1.1.0");

        expect(process.exitCode ?? 0).toBe(0);
        expect(git(remote, "log", "-1", "--format=%s", tagged)).toMatch(/^release\(/u);
        expect(() => git(remote, "merge-base", "--is-ancestor", tagged, "main")).not.toThrow();
    });

    it("moves an existing floating major tag in the single tag push", async () => {
        expect.hasAssertions();

        const { remote, work } = setupFixture(root, { floatingMajorTag: true, tagTarget: "source" });

        await runRelease(work);

        expect(git(remote, "rev-list", "-n1", "scope-a-v1")).toBe(git(remote, "rev-list", "-n1", "@scope/a@1.1.0"));

        const second = commitFile(work, "packages/a/index.js", "export const a = 2;\n", "feat(a): add more");

        git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
        published.length = 0;
        __resetLookupMemoForTests();

        const { errors } = await runRelease(work);

        expect(errors).toStrictEqual([]);
        expect(process.exitCode ?? 0).toBe(0);
        expect(published).toStrictEqual(["@scope/a@1.2.0"]);
        expect(git(remote, "rev-list", "-n1", "scope-a-v1")).toBe(second);
    });
});
