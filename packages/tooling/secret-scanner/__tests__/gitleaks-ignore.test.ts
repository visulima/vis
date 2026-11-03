import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanGitHistoryDetailed, scanGitStaged } from "../src/git-scan";
import { GitleaksIgnore, maskSecret } from "../src/gitleaks-ignore";
import { scanDetailed, scanFilesDetailed } from "../src/index";
import type { Finding, ScanOptions } from "../src/types";

const SECRET = "TESTTOKEN_abcdefghij0123456789";
const OTHER = "TESTTOKEN_zyxwvutsrq9876543210";

const CONFIG = {
    rules: [{ description: "Fake token", id: "test-token", keywords: ["TESTTOKEN"], regex: String.raw`TESTTOKEN_[A-Za-z0-9]{20}` }],
    title: "test",
};

const finding = (overrides: Partial<Finding & { commit?: { sha: string } }> = {}): Finding & { commit?: { sha: string } } => {
    return {
        alternateMatches: [],
        confidence: "low",
        description: "",
        endColumn: 1,
        endLine: 3,
        entropy: 0,
        file: "src/a.ts",
        match: SECRET,
        ruleId: "test-token",
        secret: SECRET,
        startColumn: 1,
        startLine: 3,
        tags: [],
        ...overrides,
    };
};

const hermeticGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

const dirs: string[] = [];

const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "secret-scanner-gli-")));

    dirs.push(dir);

    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { force: true, recursive: true });
    }
});

describe("gitleaksIgnore parsing", () => {
    it("matches file:rule:line fingerprints and reports the others unused", () => {
        expect.assertions(3);

        const ignore = new GitleaksIgnore("# comment\nsrc/a.ts:test-token:3\nsrc/b.ts:test-token:3\n\n", "/repo");

        expect(ignore.match(finding(), ["/repo"])?.line).toBe(2);
        expect(ignore.match(finding({ startLine: 4 }), ["/repo"])).toBeUndefined();
        expect(ignore.unused().map((entry) => entry.raw)).toStrictEqual(["src/b.ts:test-token:3"]);
    });

    it("parses paths containing colons from the right", () => {
        expect.assertions(1);

        const ignore = new GitleaksIgnore("dir:with:colons/a.ts:test-token:3", "/repo");

        expect(ignore.match(finding({ file: "dir:with:colons/a.ts" }), ["/repo"])).toBeDefined();
    });

    it("matches commit fingerprints only against findings from that commit", () => {
        expect.assertions(4);

        const sha = "0123456789abcdef0123456789abcdef01234567";
        const ignore = new GitleaksIgnore(`${sha}:src/a.ts:test-token:3`, "/repo");

        expect(ignore.match(finding(), ["/repo"])).toBeUndefined();
        expect(ignore.unused()).toStrictEqual([]);
        expect(ignore.match(finding({ commit: { sha: "f".repeat(40) } }), ["/repo"])).toBeUndefined();
        expect(ignore.match(finding({ commit: { sha } }), ["/repo"])).toBeDefined();
    });

    it("supports * globs in any component", () => {
        expect.assertions(4);

        const ignore = new GitleaksIgnore("src/gen/*:test-token:*\n*:other-*:12", "/repo");

        expect(ignore.match(finding({ file: "src/gen/deep/x.ts", startLine: 99 }), ["/repo"])).toBeDefined();
        expect(ignore.match(finding({ file: "src/a.ts" }), ["/repo"])).toBeUndefined();
        expect(ignore.match(finding({ ruleId: "other-rule", startLine: 12 }), ["/repo"])).toBeDefined();
        expect(ignore.match(finding({ ruleId: "other-rule", startLine: 13 }), ["/repo"])).toBeUndefined();
    });

    it("supports secret-value entries with optional rule and path scope", () => {
        expect.assertions(6);

        const ignore = new GitleaksIgnore(
            [`secret:${SECRET}`, `rule:other:secret:${OTHER}`, `path:src/b.ts:secret:${OTHER}`, `path:src/c.ts:rule:test-token:secret:${OTHER}`].join("\n"),
            "/repo",
        );

        expect(ignore.hasSecretEntries).toBe(true);
        expect(ignore.match(finding({ file: "anywhere.ts" }), ["/repo"])?.line).toBe(1);
        expect(ignore.match(finding({ secret: OTHER }), ["/repo"])).toBeUndefined();
        expect(ignore.match(finding({ file: "src/b.ts", secret: OTHER }), ["/repo"])?.line).toBe(3);
        expect(ignore.match(finding({ file: "src/c.ts", secret: OTHER }), ["/repo"])?.line).toBe(4);
        expect(ignore.unused().map((entry) => entry.line)).toStrictEqual([2]);
    });

    it("reports lines it can't parse as invalid", () => {
        expect.assertions(1);

        const ignore = new GitleaksIgnore("not a fingerprint\nsrc/a.ts:rule:notanumber", "/repo");

        expect(ignore.invalid.map((entry) => entry.line)).toStrictEqual([1, 2]);
    });

    it("marks every matching entry used, not only the first", () => {
        expect.assertions(1);

        const ignore = new GitleaksIgnore(`src/a.ts:test-token:3\nsecret:${SECRET}`, "/repo");

        ignore.match(finding(), ["/repo"]);

        expect(ignore.unused({ includeCommitEntries: true })).toStrictEqual([]);
    });

    it("masks by characters, matching the native shape", () => {
        expect.assertions(3);

        expect(maskSecret("abc")).toBe("******");
        expect(maskSecret("abcdefghij")).toBe("abc****hij");
        expect(maskSecret("pässwörtxyz")).toBe("päs*****xyz");
    });
});

describe("gitleaksIgnore in scans", () => {
    const setup = (): { ignorePath: string; options: ScanOptions; root: string } => {
        const root = tempDir();

        mkdirSync(join(root, "src", "nested"), { recursive: true });
        writeFileSync(join(root, "src", "nested", "config.ts"), `const a = "${SECRET}";\nconst b = "${OTHER}";\n`);

        const ignorePath = join(root, ".gitleaksignore");

        writeFileSync(ignorePath, `src/nested/config.ts:test-token:1\nsrc/gone.ts:test-token:9\n`);

        return { ignorePath, options: { config: { extendBundled: false, inline: CONFIG }, gitleaksIgnore: ignorePath, walk: { includeHidden: true } }, root };
    };

    it("matches relative to the ignore file whatever the scan root spelling", async () => {
        expect.assertions(8);

        const { options, root } = setup();
        const cwd = process.cwd();
        // macOS: tmpdir is `/var/…`, a symlink to `/private/var/…`.
        const symlinkSpelling = root.startsWith("/private/") ? root.slice("/private".length) : root;

        try {
            process.chdir(root);

            for (const spelling of [".", root, join(root, "src"), symlinkSpelling]) {
                // eslint-disable-next-line no-await-in-loop -- Sequential: one scan per spelling of the root.
                const result = await scanDetailed([spelling], options);

                expect(result.findings.map((f) => f.secret)).toStrictEqual([OTHER]);
                expect(result.unusedIgnores.map((entry) => entry.raw)).toStrictEqual(["src/gone.ts:test-token:9"]);
            }
        } finally {
            process.chdir(cwd);
        }
    }, 30_000);

    it("applies to scanFiles paths relative to the cwd", async () => {
        expect.assertions(1);

        const { options, root } = setup();
        const cwd = process.cwd();

        try {
            process.chdir(join(root, "src"));

            const result = await scanFilesDetailed(["nested/config.ts"], options);

            expect(result.findings.map((f) => f.secret)).toStrictEqual([OTHER]);
        } finally {
            process.chdir(cwd);
        }
    }, 30_000);

    it("returns suppressed findings with their reason and entry", async () => {
        expect.assertions(3);

        const { options, root } = setup();
        const result = await scanDetailed([root], { ...options, reportSuppressed: true });

        expect(result.suppressed).toHaveLength(1);
        expect(result.suppressed[0]?.suppressedBy).toBe("gitleaksignore");
        expect(result.suppressed[0]?.suppressedByEntry?.line).toBe(1);
    }, 30_000);

    it("matches secret entries even when redacting, and still masks the output", async () => {
        expect.assertions(2);

        const { ignorePath, options, root } = setup();

        writeFileSync(ignorePath, `secret:${SECRET}\n`);

        const result = await scanDetailed([root], { ...options, redact: true });

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.secret).toBe(maskSecret(OTHER));
    }, 30_000);

    it("matches staged (absolute) and history (repo-relative) findings, including commit entries", async () => {
        expect.assertions(4);

        const root = tempDir();
        const git = (...arguments_: string[]): string => execFileSync("git", arguments_, { cwd: root, encoding: "utf8", env: hermeticGitEnv }).trim();

        git("init", "-q", "-b", "main");
        git("config", "user.email", "t@example.com");
        git("config", "user.name", "T");
        git("config", "commit.gpgsign", "false");
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "a.ts"), `const a = "${SECRET}";\n`);
        git("add", ".");
        git("commit", "-q", "-m", "add");

        const sha = git("rev-parse", "HEAD");
        const ignorePath = join(root, ".gitleaksignore");
        const options = { config: { extendBundled: false, inline: CONFIG }, cwd: join(root, "src"), gitleaksIgnore: ignorePath };

        writeFileSync(ignorePath, `${sha}:src/a.ts:test-token:1\n`);

        const history = await scanGitHistoryDetailed(options);

        expect(history.findings).toStrictEqual([]);
        expect(history.unusedIgnores).toStrictEqual([]);

        writeFileSync(join(root, "src", "a.ts"), `const a = "${OTHER}";\n`);
        git("add", ".");
        writeFileSync(ignorePath, `src/a.ts:test-token:1\n`);

        const staged = await scanGitStaged(options);

        expect(staged.findings).toStrictEqual([]);
        expect(staged.unusedIgnores).toStrictEqual([]);
    }, 30_000);
});

describe("suppression in git scans", () => {
    const createRepo = (): { commit: (message: string) => void; root: string; write: (file: string, content: string) => void } => {
        const root = tempDir();
        const git = (...arguments_: string[]): string => execFileSync("git", arguments_, { cwd: root, encoding: "utf8", env: hermeticGitEnv }).trim();

        git("init", "-q", "-b", "main");
        git("config", "user.email", "t@example.com");
        git("config", "user.name", "T");
        git("config", "commit.gpgsign", "false");

        return {
            commit: (message) => {
                git("add", "-A");
                git("commit", "-q", "-m", message);
            },
            root,
            write: (file, content) => {
                writeFileSync(join(root, file), content);
            },
        };
    };

    it("reports a secret whose allow comment was removed, whether or not suppressed findings are requested", async () => {
        expect.assertions(4);

        const repo = createRepo();

        repo.write("a.ts", `const a = "${SECRET}"; // gitleaks:allow\n`);
        repo.commit("allowed");
        repo.write("a.ts", `const a = "${SECRET}";\nconst b = 1;\n`);
        repo.commit("comment removed");
        repo.write("a.ts", `const a = "${SECRET}";\nconst b = 2;\n`);
        repo.commit("unrelated edit");

        const options = { config: { extendBundled: false, inline: CONFIG }, cwd: repo.root };
        const plain = await scanGitHistoryDetailed(options);
        const audited = await scanGitHistoryDetailed({ ...options, reportSuppressed: true });

        expect(plain.findings.map((f) => f.commit.message)).toStrictEqual(["comment removed"]);
        expect(audited.findings.map((f) => f.commit.message)).toStrictEqual(["comment removed"]);
        // The inline-allowed match is logged once, at the commit that added it.
        expect(audited.suppressed.map((f) => [f.commit.message, f.suppressedBy])).toStrictEqual([["allowed", "inline-allow"]]);
        expect(plain.suppressed).toStrictEqual([]);
    }, 30_000);

    it("does not report the secret held by a scoped entry in the ignore file itself", async () => {
        expect.assertions(2);

        const repo = createRepo();
        const ignorePath = join(repo.root, ".gitleaksignore");

        repo.write("a.ts", `const a = "${SECRET}";\n`);
        repo.write(".gitleaksignore", `path:a.ts:secret:${SECRET}\n`);
        repo.commit("add");

        const options = { config: { extendBundled: false, inline: CONFIG }, cwd: repo.root, gitleaksIgnore: ignorePath };

        const history = await scanGitHistoryDetailed(options);

        expect(history.findings).toStrictEqual([]);

        repo.write("a.ts", "clean\n");
        writeFileSync(ignorePath, `path:a.ts:secret:${OTHER}\n`);
        execFileSync("git", ["add", "-A"], { cwd: repo.root, env: hermeticGitEnv });

        const staged = await scanGitStaged(options);

        expect(staged.findings).toStrictEqual([]);
    }, 30_000);
});
