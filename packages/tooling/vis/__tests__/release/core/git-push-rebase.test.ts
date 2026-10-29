import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pushBranchWithRebase } from "../../../src/release/core/git";
import type { CommandRunner } from "../../../src/release/core/package-managers/interface";
import { createShellRunner } from "../../../src/release/core/shell-runner";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];

const git = (cwd: string, ...args: string[]): string => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const commitFile = (cwd: string, file: string, content: string, message: string): string => {
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", "--", file);
    git(cwd, "commit", "-qm", message);

    return git(cwd, "rev-parse", "HEAD");
};

/**
 * A bare `origin`, the release checkout at `source` (already on origin) with a
 * version commit on top, and a second clone that moves the branch.
 */
const setup = (root: string): { other: string; remote: string; source: string; work: string } => {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const other = join(root, "other");

    execFileSync("git", ["init", "-q", "--bare", "--initial-branch", "main", remote]);
    execFileSync("git", ["clone", "-q", remote, work], { stdio: "pipe" });
    commitFile(work, "pnpm-lock.yaml", "lockfileVersion: 1\n", "chore: init");
    const source = commitFile(work, "a.txt", "a\n", "feat: a");

    git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
    execFileSync("git", ["clone", "-q", remote, other], { stdio: "pipe" });
    commitFile(work, "version.txt", "1.1.0\n", "release(main): a@1.1.0 [skip ci]");

    return { other, remote, source, work };
};

const moveBranch = (other: string, file: string, content: string): string => {
    git(other, "pull", "-q", "--rebase", "origin", "main");
    const sha = commitFile(other, file, content, `fix: ${file}`);

    git(other, "push", "-q", "origin", "HEAD:refs/heads/main");

    return sha;
};

describe.skipIf(process.platform === "win32")(pushBranchWithRebase, () => {
    let root: string;
    let repo: ReturnType<typeof setup>;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-push-rebase-"));
        repo = setup(root);
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it("rebases the version commit onto a moved branch and pushes it", async () => {
        expect.hasAssertions();

        const concurrent = moveBranch(repo.other, "b.txt", "b\n");
        const rebases = await pushBranchWithRebase({ cwd: repo.work, runner: createShellRunner() }, "main", { retries: 3, source: repo.source });

        expect(rebases).toBe(1);
        expect(git(repo.remote, "log", "-1", "--format=%s", "main")).toBe("release(main): a@1.1.0 [skip ci]");
        expect(git(repo.remote, "rev-parse", "main~1")).toBe(concurrent);
    });

    it("refuses to rebase with no retries and leaves the branch alone", async () => {
        expect.hasAssertions();

        const concurrent = moveBranch(repo.other, "b.txt", "b\n");

        await expect(pushBranchWithRebase({ cwd: repo.work, runner: createShellRunner() }, "main", { retries: 0, source: repo.source })).rejects.toMatchObject({
            hint: expect.stringContaining(`tagTarget: "source"`),
        });
        expect(git(repo.remote, "rev-parse", "main")).toBe(concurrent);
        expect(git(repo.work, "rev-parse", "HEAD~1")).toBe(repo.source);
    });

    it("gives up after the configured retries while the branch keeps moving", async () => {
        expect.hasAssertions();

        const real = createShellRunner();
        let moves = 0;
        // Every push attempt races one more commit onto the branch.
        const racing: CommandRunner = {
            ...real,
            run: async (command, args, options) => {
                if (command === "git" && args[0] === "push") {
                    moves += 1;
                    moveBranch(repo.other, `race-${moves}.txt`, `${moves}\n`);
                }

                return real.run(command, args, options);
            },
        };

        await expect(pushBranchWithRebase({ cwd: repo.work, runner: racing }, "main", { retries: 2, source: repo.source })).rejects.toThrow(
            /kept moving through 2 rebase/,
        );
        expect(moves).toBe(3);
        expect(git(repo.remote, "log", "-1", "--format=%s", "main")).toBe("fix: race-3.txt");
    });

    it("takes the branch's lockfile on a lockfile conflict and amends the regenerated one", async () => {
        expect.hasAssertions();

        git(repo.work, "reset", "-q", "--hard", repo.source);
        writeFileSync(join(repo.work, "pnpm-lock.yaml"), "lockfileVersion: release\n");
        writeFileSync(join(repo.work, "version.txt"), "1.1.0\n");
        git(repo.work, "add", "--", "pnpm-lock.yaml", "version.txt");
        git(repo.work, "commit", "-qm", "release(main): a@1.1.0 [skip ci]");
        moveBranch(repo.other, "pnpm-lock.yaml", "lockfileVersion: upstream\n");

        let lockfileSeenBySync = "";

        await pushBranchWithRebase({ cwd: repo.work, runner: createShellRunner() }, "main", {
            retries: 1,
            source: repo.source,
            syncLockfile: async () => {
                lockfileSeenBySync = git(repo.work, "show", "HEAD:pnpm-lock.yaml");
                writeFileSync(join(repo.work, "pnpm-lock.yaml"), "lockfileVersion: regenerated\n");
            },
        });

        expect(lockfileSeenBySync).toBe("lockfileVersion: upstream");
        expect(git(repo.remote, "show", "main:pnpm-lock.yaml")).toBe("lockfileVersion: regenerated");
        expect(git(repo.remote, "show", "main:version.txt")).toBe("1.1.0");
        expect(git(repo.remote, "log", "-1", "--format=%s", "main")).toBe("release(main): a@1.1.0 [skip ci]");
    });

    it("aborts on any other conflict and pushes nothing", async () => {
        expect.hasAssertions();

        const concurrent = moveBranch(repo.other, "version.txt", "someone else\n");
        const head = git(repo.work, "rev-parse", "HEAD");

        await expect(pushBranchWithRebase({ cwd: repo.work, runner: createShellRunner() }, "main", { retries: 3, source: repo.source })).rejects.toThrow(
            /conflicts in version\.txt/,
        );
        expect(git(repo.work, "rev-parse", "HEAD")).toBe(head);
        expect(git(repo.remote, "rev-parse", "main")).toBe(concurrent);
    });

    it("rebases with the configured identity when git has none", async () => {
        expect.hasAssertions();

        moveBranch(repo.other, "b.txt", "b\n");

        const home = join(root, "home");
        const saved = {
            GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"],
            GIT_CONFIG_NOSYSTEM: process.env["GIT_CONFIG_NOSYSTEM"],
            HOME: process.env["HOME"],
        };

        process.env["GIT_CONFIG_GLOBAL"] = join(home, "gitconfig");
        process.env["GIT_CONFIG_NOSYSTEM"] = "1";
        process.env["HOME"] = home;

        try {
            await pushBranchWithRebase({ cwd: repo.work, runner: createShellRunner() }, "main", {
                author: { email: "bot@example.com", name: "Release Bot" },
                retries: 1,
                source: repo.source,
            });
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) {
                    Reflect.deleteProperty(process.env, key);
                } else {
                    process.env[key] = value;
                }
            }
        }

        expect(git(repo.remote, "log", "-1", "--format=%cn <%ce>", "main")).toBe("Release Bot <bot@example.com>");
    });
});
