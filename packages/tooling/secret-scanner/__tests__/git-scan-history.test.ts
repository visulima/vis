/* eslint-disable no-useless-concat -- fake tokens are split so GitHub push protection does not flag the fixtures */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { scanGitHistory, scanGitHistoryDetailed, scanGitStaged } from "../src/git-scan";
import { scanString } from "../src/index";

// Fake GitHub PATs (`ghp_` + 36 base62 chars) matching the bundled `github-pat` rule.
const SECRET_A = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";
const SECRET_B = "ghp_Zx9Yw8Vu7Ts6Rq5P" + "o4Nm3Lk2Ji1Hg0Fe9Dc8";
const SECRET_C = "ghp_Qw1Er2Ty3Ui4Op5A" + "s6Df7Gh8Jk9Lz0Xc1Vb2";
const SECRET_D = "ghp_Mn3Bv4Cx5Za6Sd7F" + "g8Hj9Kl0Po1Iu2Yt3Re4";

const GIT_REPO_ENV_KEYS = new Set(["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_WORK_TREE"]);
const hermeticGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_REPO_ENV_KEYS.has(key)));

const repos: string[] = [];

const createRepo = (): { git: (...arguments_: string[]) => string; repo: string; write: (file: string, content: string) => void } => {
    const repo = mkdtempSync(join(tmpdir(), "secret-scanner-git-history-"));

    repos.push(repo);

    const git = (...arguments_: string[]): string => execFileSync("git", arguments_, { cwd: repo, encoding: "utf8", env: hermeticGitEnv }).trim();

    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    git("config", "commit.gpgsign", "false");

    return {
        git,
        repo,
        write: (file, content) => {
            writeFileSync(join(repo, file), content);
        },
    };
};

const objectPath = (repo: string, oid: string): string => join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));

const secretsOf = (findings: { secret: string }[], secret: string): number => findings.filter((finding) => finding.secret === secret).length;

beforeAll(async () => {
    // Warm the Rust regex JIT once so the first scan doesn't time out.
    await scanString("warmup", "warmup.txt");
}, 120_000);

afterEach(() => {
    for (const repo of repos.splice(0)) {
        rmSync(repo, { force: true, recursive: true });
    }
});

describe("scanGitHistory dedup", () => {
    it("reports a long-lived secret once, at the commit that introduced it", async () => {
        expect.assertions(2);

        const { git, write } = createRepo();

        write("config.ts", `export const token = "${SECRET_A}";\n`);
        git("add", ".");
        git("commit", "-q", "-m", "add token");

        for (let index = 1; index <= 3; index += 1) {
            write("config.ts", `export const token = "${SECRET_A}";\nexport const port${String(index)} = ${String(index)};\n`);
            git("commit", "-q", "-am", `edit ${String(index)}`);
        }

        // Rename plus edit: the parent version is looked up under the old path.
        git("mv", "config.ts", "settings.ts");
        write("settings.ts", `// moved\nexport const token = "${SECRET_A}";\n`);
        git("commit", "-q", "-am", "rename");

        const findings = await scanGitHistory({ cwd: git("rev-parse", "--show-toplevel") });
        const hits = findings.filter((finding) => finding.secret === SECRET_A);

        expect(hits).toHaveLength(1);
        expect(hits[0]!.commit.message).toBe("add token");
    });

    it("reports a second secret added to a file that already had one", async () => {
        expect.assertions(2);

        const { git, repo, write } = createRepo();

        write("config.ts", `a = "${SECRET_A}"\n`);
        git("add", ".");
        git("commit", "-q", "-m", "first");
        write("config.ts", `a = "${SECRET_A}"\nb = "${SECRET_B}"\n`);
        git("commit", "-q", "-am", "second");

        const findings = await scanGitHistory({ cwd: repo });

        expect(secretsOf(findings, SECRET_A)).toBe(1);
        expect(findings.find((finding) => finding.secret === SECRET_B)?.commit.message).toBe("second");
    });

    it("redacts output without collapsing distinct secrets", async () => {
        expect.assertions(2);

        const { git, repo, write } = createRepo();

        write("config.ts", `a = "${SECRET_A}"\n`);
        git("add", ".");
        git("commit", "-q", "-m", "first");
        write("config.ts", `a = "${SECRET_A}"\nb = "${SECRET_B}"\n`);
        git("commit", "-q", "-am", "second");

        const findings = await scanGitHistory({ cwd: repo, redact: true });

        expect(findings).toHaveLength(2);
        expect(findings.every((finding) => !finding.secret.includes(SECRET_A.slice(4)) && !finding.secret.includes(SECRET_B.slice(4)))).toBe(true);
    });
});

describe("scanGitHistory merges and refs", () => {
    it("finds a secret introduced while resolving a merge conflict, and reports a merged side-branch secret once", async () => {
        expect.assertions(5);

        const { git, repo, write } = createRepo();

        write("app.ts", "export const mode = 'base';\n");
        git("add", ".");
        git("commit", "-q", "-m", "base");

        git("checkout", "-q", "-b", "side");
        write("app.ts", "export const mode = 'side';\n");
        write("side.ts", `export const sideToken = "${SECRET_C}";\n`);
        git("add", ".");
        git("commit", "-q", "-m", "side change");

        git("checkout", "-q", "main");
        write("app.ts", "export const mode = 'main';\n");
        git("commit", "-q", "-am", "main change");

        try {
            git("merge", "-q", "--no-edit", "side");
        } catch {
            // Expected: both branches edited the same line.
        }

        write("app.ts", `export const mode = 'merged';\nexport const token = "${SECRET_B}";\n`);
        git("add", "app.ts");
        git("commit", "-q", "--no-edit", "-m", "merge side");

        // Guard the fixture: HEAD must be a real two-parent merge.
        expect(git("rev-list", "--parents", "-1", "HEAD").split(" ")).toHaveLength(3);

        const findings = await scanGitHistory({ cwd: repo });
        const mergeHit = findings.filter((finding) => finding.secret === SECRET_B);

        expect(mergeHit).toHaveLength(1);
        expect(mergeHit[0]!.commit.message).toBe("merge side");
        expect(secretsOf(findings, SECRET_C)).toBe(1);
        expect(findings.find((finding) => finding.secret === SECRET_C)?.commit.message).toBe("side change");
    });

    it("walks unmerged branches only with `all`", async () => {
        expect.assertions(3);

        const { git, repo, write } = createRepo();

        write("app.ts", "export const a = 1;\n");
        git("add", ".");
        git("commit", "-q", "-m", "base");
        git("checkout", "-q", "-b", "feature");
        write("leak.ts", `export const t = "${SECRET_D}";\n`);
        git("add", ".");
        git("commit", "-q", "-m", "feature leak");
        git("checkout", "-q", "main");

        expect(secretsOf(await scanGitHistory({ cwd: repo }), SECRET_D)).toBe(0);
        expect(secretsOf(await scanGitHistory({ all: true, cwd: repo }), SECRET_D)).toBe(1);
        await expect(scanGitHistory({ all: true, cwd: repo, range: "HEAD" })).rejects.toThrow(/cannot be combined/);
    });
});

describe("scanGitHistory commit allowlists", () => {
    it("skips commits in a global allowlist and drops per-rule findings for allowlisted commits", async () => {
        expect.assertions(4);

        const { git, repo, write } = createRepo();

        write("one.ts", `t = "${SECRET_A}"\n`);
        git("add", ".");
        git("commit", "-q", "-m", "one");

        const first = git("rev-parse", "HEAD");

        write("two.ts", `t = "${SECRET_B}"\nkey = TESTTOKEN_ABCDEFGHIJ0123456789\n`);
        git("add", ".");
        git("commit", "-q", "-m", "two");

        const second = git("rev-parse", "HEAD");

        const customRule = {
            allowlists: [{ commits: [second.toUpperCase()] }],
            id: "test-token",
            keywords: ["testtoken_"],
            regex: "TESTTOKEN_[A-Z0-9]{20}",
        };

        const baseline = await scanGitHistory({ config: { inline: { rules: [customRule] } }, cwd: repo });

        expect(baseline.some((finding) => finding.ruleId === "test-token")).toBe(false);
        expect(secretsOf(baseline, SECRET_B)).toBe(1);

        const allowlisted = await scanGitHistory({
            config: {
                inline: {
                    allowlists: [{ commits: [first] }, { commits: [second], targetRules: ["github-pat"] }],
                    rules: [customRule],
                },
            },
            cwd: repo,
        });

        expect(secretsOf(allowlisted, SECRET_A)).toBe(0);
        expect(secretsOf(allowlisted, SECRET_B)).toBe(0);
    });

    it("matches AND allowlists that combine commits with paths", async () => {
        expect.assertions(3);

        const { git, repo, write } = createRepo();

        write("fixture-one.ts", `t = "${SECRET_A}"\n`);
        git("add", ".");
        git("commit", "-q", "-m", "one");

        const first = git("rev-parse", "HEAD");

        write("fixture-two.ts", `t = "${SECRET_B}"\n`);
        git("add", ".");
        git("commit", "-q", "-m", "two");

        const options = {
            config: { inline: { allowlists: [{ commits: [first], condition: "AND", paths: ["^fixture-"] }] } },
            cwd: repo,
        };
        const findings = await scanGitHistory(options);

        // Listed commit + matching path: suppressed. Other commit: reported.
        expect(secretsOf(findings, SECRET_A)).toBe(0);
        expect(secretsOf(findings, SECRET_B)).toBe(1);

        // A working-tree scan has no commit, so the AND allowlist doesn't apply.
        const workingTree = await scanString(`t = "${SECRET_A}"\n`, "fixture-one.ts", { config: options.config });

        expect(secretsOf(workingTree, SECRET_A)).toBe(1);
    });
});

describe("scanGitHistory blob handling", () => {
    it("ignores textconv drivers, colour and quoting config", async () => {
        expect.assertions(2);

        const { git, repo, write } = createRepo();

        git("config", "color.ui", "always");
        git("config", "core.quotepath", "true");
        git("config", "diff.junk.textconv", "sh -c 'echo junk'");
        write(".gitattributes", "*.env diff=junk\n");
        write("schlüssel.env", `TOKEN=${SECRET_A}\n`);
        git("add", ".");
        git("commit", "-q", "-m", "add env");

        const findings = await scanGitHistory({ cwd: repo });

        expect(secretsOf(findings, SECRET_A)).toBe(1);
        expect(findings.find((finding) => finding.secret === SECRET_A)?.file).toBe("schlüssel.env");
    });

    it("skips binary blobs and reports missing ones", async () => {
        expect.assertions(3);

        const { git, repo, write } = createRepo();

        writeFileSync(join(repo, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`token=${SECRET_A}\n`)]));
        write("gone.ts", `t = "${SECRET_B}"\n`);
        git("add", ".");
        git("commit", "-q", "-m", "add files");

        const goneOid = git("rev-parse", "HEAD:gone.ts");

        rmSync(objectPath(repo, goneOid), { force: true });

        const result = await scanGitHistoryDetailed({ cwd: repo });

        expect(result.findings).toHaveLength(0);
        expect(result.skipped).toContainEqual(expect.objectContaining({ path: "blob.bin", reason: "binary" }));
        expect(result.skipped).toContainEqual(expect.objectContaining({ path: "gone.ts", reason: "missing", sha: goneOid }));
    });

    it("skips blobs above walk.maxFileSize", async () => {
        expect.assertions(1);

        const { git, repo, write } = createRepo();

        write("big.ts", `t = "${SECRET_A}"\n${"x".repeat(4096)}\n`);
        git("add", ".");
        git("commit", "-q", "-m", "big");

        const result = await scanGitHistoryDetailed({ cwd: repo, walk: { maxFileSize: 1024 } });

        expect(result.skipped).toStrictEqual([expect.objectContaining({ path: "big.ts", reason: "too-large" })]);
    });

    it("throws when git fails to read an object that exists", async () => {
        expect.assertions(1);

        const { git, repo, write } = createRepo();

        write("app.ts", `t = "${SECRET_A}"\n`);
        git("add", ".");
        git("commit", "-q", "-m", "add");

        const file = objectPath(repo, git("rev-parse", "HEAD:app.ts"));

        chmodSync(file, 0o644);
        writeFileSync(file, "corrupt");

        await expect(scanGitHistory({ cwd: repo })).rejects.toThrow(/could not read object/);
    });
});

describe(scanGitStaged, () => {
    it("scans the index, not the working tree", async () => {
        expect.assertions(4);

        const { git, repo, write } = createRepo();

        write("base.ts", "export const a = 1;\n");
        git("add", ".");
        git("commit", "-q", "-m", "base");

        // Staged secret, since removed from the working tree.
        write("staged.ts", `t = "${SECRET_A}"\n`);
        git("add", "staged.ts");
        write("staged.ts", "t = process.env.TOKEN\n");

        // Unstaged secret: won't be committed.
        write("base.ts", `t = "${SECRET_B}"\n`);

        const result = await scanGitStaged({ cwd: repo });

        expect(secretsOf(result.findings, SECRET_A)).toBe(1);
        expect(secretsOf(result.findings, SECRET_B)).toBe(0);
        expect(result.findings[0]!.file).toBe(join(repo, "staged.ts"));
        expect(result.skipped).toHaveLength(0);
    });

    it("honours walk.excludePatterns", async () => {
        expect.assertions(1);

        const { git, repo, write } = createRepo();

        write("staged.ts", `t = "${SECRET_A}"\n`);
        git("add", "staged.ts");

        const result = await scanGitStaged({ cwd: repo, walk: { excludePatterns: ["staged.ts"] } });

        expect(result.findings).toHaveLength(0);
    });
});
