import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Toolbox } from "@visulima/cerebro";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretsFlags } from "../../src/commands/secrets/handler";
import execute, { assertHistoryFlags } from "../../src/commands/secrets/handler";
import { formatSkippedBlobs } from "../../src/secrets/format";

// Fake GitHub PAT matching the bundled `github-pat` rule.
const FAKE_PAT = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";

const GIT_REPO_ENV_KEYS = new Set(["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_WORK_TREE"]);
const hermeticGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_REPO_ENV_KEYS.has(key)));

const repos: string[] = [];

const createRepo = (): { git: (...arguments_: string[]) => string; repo: string } => {
    const repo = mkdtempSync(join(tmpdir(), "vis-secrets-git-"));

    repos.push(repo);

    const git = (...arguments_: string[]): string => execFileSync("git", arguments_, { cwd: repo, encoding: "utf8", env: hermeticGitEnv }).trim();

    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    git("config", "commit.gpgsign", "false");

    return { git, repo };
};

const runSecrets = async (options: SecretsFlags & { format?: string }, workspaceRoot: string): Promise<void> => {
    await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({ argument: [], options, workspaceRoot } as unknown as Partial<Toolbox>);
};

describe(assertHistoryFlags, () => {
    it("rejects history-only flags without --history", () => {
        expect.assertions(2);

        expect(() => {
            assertHistoryFlags({ all: true });
        }).toThrow(/--all only applies to git history scans/);
        expect(() => {
            assertHistoryFlags({ maxCommits: 5 });
        }).toThrow(/--max-commits/);
    });

    it("rejects --all combined with --history-range", () => {
        expect.assertions(1);

        expect(() => {
            assertHistoryFlags({ all: true, history: true, historyRange: "main..HEAD" });
        }).toThrow(/can't be combined with --history-range/);
    });

    it("accepts --all with --history", () => {
        expect.assertions(1);

        expect(() => {
            assertHistoryFlags({ all: true, history: true });
        }).not.toThrow();
    });
});

describe(formatSkippedBlobs, () => {
    it("summarises by reason and lists blobs with --verbose", () => {
        expect.assertions(2);

        const skipped = [
            { commit: "a".repeat(40), path: "logo.png", reason: "binary" as const, sha: "b".repeat(40) },
            { commit: "a".repeat(40), path: "gone.ts", reason: "missing" as const, sha: "c".repeat(40) },
        ];

        expect(formatSkippedBlobs(skipped, false)).toBe("2 blob(s) not scanned (binary: 1, missing: 1); use --verbose to list them");
        expect(formatSkippedBlobs(skipped, false, { verbose: true })).toContain("  - gone.ts [missing] aaaaaaaaaa cccccccccc");
    });
});

describe("vis secrets git modes", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;

        for (const repo of repos.splice(0)) {
            rmSync(repo, { force: true, recursive: true });
        }
    });

    it("--staged scans the index, not the working tree", async () => {
        expect.assertions(2);

        const { git, repo } = createRepo();

        writeFileSync(join(repo, "base.ts"), "export const a = 1;\n");
        git("add", ".");
        git("commit", "-q", "-m", "base");
        writeFileSync(join(repo, "staged.ts"), `t = "${FAKE_PAT}"\n`);
        git("add", "staged.ts");
        // Remove the secret from the working tree only; the index still holds it.
        writeFileSync(join(repo, "staged.ts"), "t = process.env.TOKEN\n");

        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

        await runSecrets({ format: "json", quiet: true, staged: true }, repo);

        const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
        const findings = JSON.parse(output) as { file: string; secret: string }[];

        expect(findings.map((finding) => finding.file)).toStrictEqual(["staged.ts"]);
        expect(process.exitCode).toBe(1);
    });

    it("--history fails when git cannot read an object", async () => {
        expect.assertions(1);

        const { git, repo } = createRepo();

        writeFileSync(join(repo, "app.ts"), `t = "${FAKE_PAT}"\n`);
        git("add", ".");
        git("commit", "-q", "-m", "add");

        const oid = git("rev-parse", "HEAD:app.ts");
        const objectFile = join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));

        chmodSync(objectFile, 0o644);
        writeFileSync(objectFile, "corrupt");
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);

        await expect(runSecrets({ format: "json", history: true, quiet: true }, repo)).rejects.toMatchObject({
            isVisUserError: true,
            message: expect.stringMatching(/git-history secret scan failed: .*could not read object/),
        });
    });
});
