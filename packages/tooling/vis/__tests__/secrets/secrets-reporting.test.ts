import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Toolbox } from "@visulima/cerebro";
import type { Finding, GitFinding } from "@visulima/secret-scanner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SecretsFlags } from "../../src/commands/secrets/handler";
import execute, { assertReportingFlags } from "../../src/commands/secrets/handler";
import { csvCell, emitSecretsCsv, emitSecretsGitlabCodeQuality, emitSecretsJUnit, gitleaksFingerprint } from "../../src/report/secrets";
import { writeBaseline } from "../../src/secrets/baseline";
import { toSarifUri } from "../../src/secrets/format";
import { formatSuppressed, formatUnusedIgnores, parseReportTargets } from "../../src/secrets/report";

// Fake GitHub PATs matching the bundled `github-pat` rule.
/* eslint-disable no-useless-concat -- split so GitHub push protection doesn't flag the fake tokens */
const PAT_A = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";
const PAT_B = "ghp_Zx9Yw8Vu7Ts6Rq5P" + "o4Nm3Lk2Ji1Hg0Fe9Dc8";
/* eslint-enable no-useless-concat */

const hermeticGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

const mode = (path: string): number => statSync(path).mode % 0o1000;

const finding = (overrides: Partial<GitFinding> = {}): Finding => {
    return {
        alternateMatches: [],
        confidence: "low",
        description: "GitHub PAT",
        endColumn: 50,
        endLine: 3,
        entropy: 4,
        file: "src/a.ts",
        match: `token = "${PAT_A}"`,
        ruleId: "github-pat",
        secret: PAT_A,
        startColumn: 10,
        startLine: 3,
        tags: [],
        ...overrides,
    };
};

const dirs: string[] = [];

const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vis-secrets-report-")));

    dirs.push(dir);

    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { force: true, recursive: true });
    }
});

describe("report emitters", () => {
    it("neutralises spreadsheet formulas and quotes CSV cells", () => {
        expect.assertions(5);

        expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
        expect(csvCell("@SUM(1)")).toBe("'@SUM(1)");
        expect(csvCell("-2+3")).toBe("'-2+3");
        expect(csvCell("a,\"b\"")).toBe("\"a,\"\"b\"\"\"");
        expect(csvCell("plain")).toBe("plain");
    });

    it("emits gitleaks CSV columns with commit metadata and an ignore fingerprint", () => {
        expect.assertions(3);

        const sha = "a".repeat(40);
        const csv = emitSecretsCsv([finding({ commit: { authorEmail: "e@x", authorName: "=HYPERLINK(1)", date: "2026-01-01", message: "add, token", sha } })]);
        const [header, row] = csv.split("\r\n");

        expect(header).toBe("RuleID,Commit,File,Secret,Match,StartLine,EndLine,StartColumn,EndColumn,Author,Message,Date,Email,Fingerprint,Tags");
        expect(row).toContain(",'=HYPERLINK(1),\"add, token\",");
        expect(row).toContain(`,${sha}:src/a.ts:github-pat:3,`);
    });

    it("emits one failing JUnit testcase per finding and strips XML-illegal characters", () => {
        expect.assertions(4);

        const xml = emitSecretsJUnit([finding({ description: "bad\u0001desc <x>" }), finding({ file: "b.ts" })], { now: new Date("2026-01-01T00:00:00Z") });

        expect(xml).toContain("<testsuites name=\"vis-secrets\" tests=\"2\" failures=\"2\"");
        expect(xml).toContain("message=\"baddesc &lt;x&gt;\"");
        expect(xml).not.toContain("\u0001");
        expect(emitSecretsJUnit([])).toContain("tests=\"0\" failures=\"0\"");
    });

    it("emits GitLab Code Quality issues without the secret and with stable distinct fingerprints", () => {
        expect.assertions(4);

        const issues = JSON.parse(emitSecretsGitlabCodeQuality([finding(), finding({ startLine: 9 })])) as Record<string, unknown>[];

        expect(issues[0]).toMatchObject({
            categories: ["Security"],
            check_name: "github-pat",
            location: { lines: { begin: 3, end: 3 }, path: "src/a.ts" },
            severity: "critical",
            type: "issue",
        });
        expect(JSON.stringify(issues)).not.toContain(PAT_A);
        expect(issues[0]?.["fingerprint"]).not.toBe(issues[1]?.["fingerprint"]);
        expect(JSON.parse(emitSecretsGitlabCodeQuality([finding()]))[0].fingerprint).toBe(issues[0]?.["fingerprint"]);
    });

    it("builds gitleaks fingerprints", () => {
        expect.assertions(2);

        expect(gitleaksFingerprint(finding())).toBe("src/a.ts:github-pat:3");
        expect(gitleaksFingerprint(finding({ commit: { sha: "abc" } as GitFinding["commit"] }))).toBe("abc:src/a.ts:github-pat:3");
    });
});

describe(toSarifUri, () => {
    it("percent-encodes each relative path segment", () => {
        expect.assertions(3);

        expect(toSarifUri("src/app.ts", "/repo")).toBe("src/app.ts");
        expect(toSarifUri("my dir/#1/100%.ts", "/repo")).toBe("my%20dir/%231/100%25.ts");
        expect(toSarifUri(String.raw`win\a b.ts`, "/repo")).toBe("win/a%20b.ts");
    });
});

describe(parseReportTargets, () => {
    it("parses <format>=<path> pairs", () => {
        expect.assertions(1);

        expect(parseReportTargets(["sarif=out/s.sarif", "csv=a=b.csv"])).toStrictEqual([
            { format: "sarif", path: "out/s.sarif" },
            { format: "csv", path: "a=b.csv" },
        ]);
    });

    it("rejects unknown formats, missing paths and duplicate files", () => {
        expect.assertions(3);

        expect(() => parseReportTargets(["xml=a"])).toThrow(/format must be one of/);
        expect(() => parseReportTargets(["sarif"])).toThrow(/needs a file path/);
        expect(() => parseReportTargets(["json=a", "csv=a"])).toThrow(/twice/);
    });
});

describe(assertReportingFlags, () => {
    it("rejects reporting flags in modes that produce no report", () => {
        expect.assertions(2);

        expect(() => {
            assertReportingFlags({ listRules: true, report: ["json=a"] }, false);
        }).toThrow(/--report only applies to a scan report and can't be combined with --list-rules/);
        expect(() => {
            assertReportingFlags({ logIgnored: true, updateBaseline: true }, false);
        }).toThrow(/--update-baseline/);
    });

    it("rejects --fail-on-unused-ignores on partial scans and without the ignore file", () => {
        expect.assertions(4);

        expect(() => {
            assertReportingFlags({ failOnUnusedIgnores: true, staged: true }, false);
        }).toThrow(/needs a full scan: with --staged/);
        expect(() => {
            assertReportingFlags({ failOnUnusedIgnores: true }, true);
        }).toThrow(/explicit paths/);
        expect(() => {
            assertReportingFlags({ failOnUnusedIgnores: true, gitleaksIgnore: false }, false);
        }).toThrow(/--no-gitleaks-ignore/);
        expect(() => {
            assertReportingFlags({ failOnUnusedIgnores: true, history: true }, false);
        }).not.toThrow();
    });
});

describe("diagnostic formatters", () => {
    it("never prints the secret of a secret-value ignore entry", () => {
        expect.assertions(2);

        const text = formatUnusedIgnores([{ kind: "secret", line: 4, raw: `secret:${PAT_A}` }], ".gitleaksignore", false);

        expect(text).toContain("line 4: <secret-value entry>");
        expect(text).not.toContain(PAT_A);
    });

    it("lists suppressed findings with their reason", () => {
        expect.assertions(1);

        const text = formatSuppressed(
            [{ ...finding(), suppressedBy: "gitleaksignore", suppressedByEntry: { kind: "fingerprint", line: 2, raw: "x" } }],
            "/repo",
            false,
        );

        expect(text).toContain("[github-pat] src/a.ts:github-pat:3 (gitleaksignore line 2)");
    });
});

describe(writeBaseline, () => {
    it.skipIf(process.platform === "win32")("writes 0600 unless the findings are redacted", () => {
        expect.assertions(3);

        const root = tempDir();
        const path = join(root, "nested", "baseline.json");

        writeBaseline([finding()], path, root);

        expect(mode(path)).toBe(0o600);

        chmodSync(path, 0o644);
        writeBaseline([finding()], path, root, { replace: true });

        expect(mode(path)).toBe(0o600);

        const redacted = join(root, "redacted.json");

        writeFileSync(redacted, "[]");
        chmodSync(redacted, 0o644);
        writeBaseline([finding()], redacted, root, { sensitive: false });

        expect(mode(redacted)).toBe(0o644);
    });
});

describe("vis secrets reporting (end-to-end)", () => {
    let stdout: string[];
    let stderr: string[];

    beforeEach(() => {
        stdout = [];
        stderr = [];
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
            stdout.push(String(chunk));

            return true;
        });
        vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            stderr.push(String(chunk));

            return true;
        });
        process.exitCode = undefined;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
    });

    const runSecrets = async (options: SecretsFlags, root: string, argument: string[] = []): Promise<void> => {
        await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
            argument,
            fs: { access, mkdir, readdir, readFile, rm, stat, writeFile },
            options: { format: "text", quiet: true, ...options },
            process: { cwd: root } as Toolbox["process"],
            workspaceRoot: root,
        });
    };

    const workspace = (): string => {
        const root = tempDir();

        writeFileSync(join(root, "a.ts"), `const a = "${PAT_A}";\nconst b = "${PAT_B}"; // gitleaks:allow\n`);

        return root;
    };

    it("auto-discovers .gitleaksignore, and --no-gitleaks-ignore turns it off", async () => {
        expect.assertions(3);

        const root = workspace();

        writeFileSync(join(root, ".gitleaksignore"), "a.ts:github-pat:1\n");

        await runSecrets({ format: "json" }, root);

        expect(JSON.parse(stdout.join(""))).toStrictEqual([]);
        expect(process.exitCode).toBeUndefined();

        stdout = [];
        await runSecrets({ format: "json", gitleaksIgnore: false }, root);

        expect(JSON.parse(stdout.join(""))).toHaveLength(1);
    }, 60_000);

    it("reports unused entries and fails on them with --fail-on-unused-ignores", async () => {
        expect.assertions(3);

        const root = workspace();

        writeFileSync(join(root, ".gitleaksignore"), "a.ts:github-pat:1\ngone.ts:github-pat:7\n");

        await runSecrets({ quiet: false }, root);

        expect(stderr.join("")).toContain("line 2: gone.ts:github-pat:7");
        expect(process.exitCode).toBeUndefined();

        await runSecrets({ failOnUnusedIgnores: true }, root);

        expect(process.exitCode).toBe(1);
    }, 60_000);

    it("doesn't call entries for files outside a --staged scan unused", async () => {
        expect.assertions(2);

        const root = workspace();
        const git = (...arguments_: string[]): string => execFileSync("git", arguments_, { cwd: root, encoding: "utf8", env: hermeticGitEnv });

        git("init", "-q", "-b", "main");
        writeFileSync(join(root, "staged.ts"), "clean\n");
        writeFileSync(join(root, ".gitleaksignore"), "a.ts:github-pat:1\n");
        git("add", "staged.ts");

        await runSecrets({ quiet: false, staged: true }, root);

        expect(stderr.join("")).not.toContain("unused");
        expect(process.exitCode).toBeUndefined();
    }, 60_000);

    it("--log-ignored lists suppressions and --no-inline-allow reports inline-allowed findings", async () => {
        expect.assertions(3);

        const root = workspace();

        writeFileSync(join(root, ".gitleaksignore"), "a.ts:github-pat:1\n");

        await runSecrets({ logIgnored: true }, root);

        const log = stderr.join("");

        expect(log).toContain("a.ts:github-pat:1 (gitleaksignore line 1)");
        expect(log).toContain("a.ts:github-pat:2 (inline-allow)");

        stdout = [];
        await runSecrets({ format: "json", inlineAllow: false }, root);

        expect((JSON.parse(stdout.join("")) as Finding[]).map((f) => f.startLine)).toStrictEqual([2]);
    }, 60_000);

    it("writes several report formats in one run, keeping stdout", async () => {
        expect.assertions(4);

        const root = workspace();

        await runSecrets({ format: "json", report: ["sarif=out/s.sarif", "csv=out/s.csv", "junit=out/s.xml", "gitlab-code-quality=out/gl.json"] }, root);

        expect(JSON.parse(stdout.join(""))).toHaveLength(1);
        expect(JSON.parse(readFileSync(join(root, "out", "s.sarif"), "utf8")).version).toBe("2.1.0");
        expect(readFileSync(join(root, "out", "s.csv"), "utf8")).toContain(PAT_A);
        expect(existsSync(join(root, "out", "s.xml")) && existsSync(join(root, "out", "gl.json"))).toBe(true);
    }, 60_000);

    it.skipIf(process.platform === "win32")(
        "writes report files owner-only unless redacted",
        async () => {
            expect.assertions(2);

            const root = workspace();

            await runSecrets({ report: ["csv=raw.csv"] }, root);

            expect(mode(join(root, "raw.csv"))).toBe(0o600);

            await runSecrets({ redact: true, report: ["csv=redacted.csv"] }, root);

            expect(mode(join(root, "redacted.csv"))).not.toBe(0o600);
        },
        60_000,
    );

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
        "--fail-on-unreadable fails a scan that couldn't read a file",
        async () => {
            expect.assertions(3);

            const root = workspace();
            const locked = join(root, "locked.ts");

            writeFileSync(locked, "nothing\n");
            chmodSync(locked, 0o000);

            try {
                await runSecrets({ gitleaksIgnore: false, quiet: false }, root);

                expect(stderr.join("")).toContain("1 file(s) not scanned (permission-denied: 1)");
                expect(process.exitCode).toBe(1); // the PAT on line 1

                writeFileSync(join(root, "a.ts"), "clean\n");
                process.exitCode = undefined;
                await runSecrets({ failOnUnreadable: true }, root);

                expect(process.exitCode).toBe(1);
            } finally {
                chmodSync(locked, 0o644);
            }
        },
        60_000,
    );
});
