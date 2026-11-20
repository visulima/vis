import {
    chmodSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Toolbox } from "@visulima/cerebro";
import type { Finding } from "@visulima/secret-scanner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SecretsFlags, VisSecretsConfig } from "../../src/commands/secrets/flags";
import execute from "../../src/commands/secrets/handler";
import { printFixResult } from "../../src/commands/secrets/report";
import { FIX_MASK, FIX_REPLACEMENT, fixSecrets } from "../../src/secrets/fix";

// eslint-disable-next-line no-useless-concat -- split so automated push protection doesn't flag the fixture
const PAT = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";

const dirs: string[] = [];

const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vis-secrets-fix-")));

    dirs.push(dir);

    return dir;
};

const byteOffset = (content: string, value: string): number => Buffer.byteLength(content.slice(0, content.indexOf(value)), "utf8");

const finding = (content: string, overrides: Partial<Finding> = {}): Finding => {
    const match = `const token = "${PAT}";`;

    return {
        alternateMatches: [],
        confidence: "low",
        description: "GitHub PAT",
        endColumn: 1,
        endLine: 1,
        entropy: 4,
        file: "a.ts",
        match,
        ruleId: "github-pat",
        secret: PAT,
        sourceSpan: {
            matchEnd: Buffer.byteLength(match, "utf8"),
            matchStart: 0,
            secretEnd: byteOffset(match, PAT) + Buffer.byteLength(PAT, "utf8"),
            secretStart: byteOffset(match, PAT),
        },
        startColumn: 1,
        startLine: 1,
        tags: [],
        ...overrides,
    };
};

describe("vis secrets --fix", () => {
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

        for (const dir of dirs.splice(0)) {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    const runSecrets = async (options: SecretsFlags, root: string, visConfig?: VisSecretsConfig, args: string[] = []): Promise<void> => {
        await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
            argument: args,
            fs: { access, mkdir, readdir, readFile, rm, stat, writeFile },
            options: { format: "text", quiet: true, ...options },
            process: { cwd: root } as Toolbox["process"],
            visConfig,
            workspaceRoot: root,
        });
    };

    it.skipIf(process.platform === "win32")(
        "rewrites the secret span without leaking it and prints only a masked diff",
        { timeout: 60_000 },
        async () => {
            expect.assertions(9);

            const root = tempDir();
            const file = join(root, "a.ts");
            const content = `\uFEFFconst token = "${PAT}";\r\nconst other = 1;\r\n`;

            writeFileSync(file, content);
            chmodSync(file, 0o640);

            await runSecrets({ fix: true, quiet: false }, root);

            expect(readFileSync(file, "utf8")).toBe(content.replace(PAT, FIX_REPLACEMENT));
            expect(stdout.join("")).toBe("");
            expect(stderr.join("")).not.toContain(PAT);
            expect(stderr.join("")).toContain(`a.ts:1 github-pat: ${FIX_MASK} -> ${FIX_REPLACEMENT}`);
            expect(stderr.join("")).toContain("Replaced 1 secret(s) in 1 file(s).");
            expect(existsSync(join(root, ".secrets-baseline.json"))).toBe(false);
            expect(readdirSync(root).sort()).toStrictEqual(["a.ts"]);
            expect(statSync(file).mode % 0o1_0000).toBe(0o640);
            expect(process.exitCode).toBeUndefined();
        },
    );

    it("resolves findings relative to a positional directory scan root", { timeout: 60_000 }, async () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "src", "a.ts");
        const content = `const token = "${PAT}";\n`;

        mkdirSync(join(root, "src"));
        writeFileSync(file, content);

        await runSecrets({ fix: true }, root, undefined, ["src"]);

        expect(readFileSync(file, "utf8")).toBe(content.replace(PAT, FIX_REPLACEMENT));
        expect(stderr.join("")).not.toContain(PAT);
        expect(readdirSync(root).sort()).toStrictEqual(["src"]);
    });

    it("resolves a finding whose file is the positional scan root itself", { timeout: 60_000 }, async () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "src", "a.ts");
        const content = `const token = "${PAT}";\n`;

        mkdirSync(join(root, "src"));
        writeFileSync(file, content);

        await runSecrets({ fix: true }, root, undefined, ["src/a.ts"]);

        expect(readFileSync(file, "utf8")).toBe(content.replace(PAT, FIX_REPLACEMENT));
        expect(stderr.join("")).toContain("src/a.ts:1 github-pat:");
        expect(stderr.join("")).not.toContain(PAT);
    });

    it("previews the same change without writing in --dry-run", { timeout: 60_000 }, async () => {
        expect.assertions(4);

        const root = tempDir();
        const file = join(root, "a.ts");
        const content = `const token = "${PAT}";\n`;

        writeFileSync(file, content);

        await runSecrets({ dryRun: true, fix: true, quiet: false }, root);

        expect(readFileSync(file, "utf8")).toBe(content);
        expect(stderr.join("")).toContain(`${FIX_REPLACEMENT} (dry-run)`);
        expect(stderr.join("")).toContain("Would replace 1 secret(s) in 1 file(s).");
        expect(stderr.join("")).not.toContain(PAT);
    });

    it("skips findings without a trusted span instead of guessing from columns", () => {
        expect.assertions(4);

        const root = tempDir();
        const file = join(root, "a.ts");
        const content = `const token = "${PAT}";\n`;

        writeFileSync(file, content);

        const result = fixSecrets(
            [
                finding(content),
                finding(content, { ruleId: "no-span", sourceSpan: undefined, spanUnavailableReason: "decoded content" }),
                finding(content, { ruleId: "no-reason", sourceSpan: undefined }),
            ],
            root,
            false,
        );

        expect(result.replacements).toBe(1);
        expect(result.skipped).toStrictEqual([
            { file: "a.ts", line: 1, reason: "decoded content", ruleId: "no-span" },
            { file: "a.ts", line: 1, reason: "no trusted byte span", ruleId: "no-reason" },
        ]);
        expect(readFileSync(file, "utf8")).toContain(FIX_REPLACEMENT);
        expect(readFileSync(file, "utf8")).not.toContain(PAT);
    });

    it("skips a span whose bytes no longer match the file", () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "a.ts");
        const content = `const token = "${PAT}";\n`;

        writeFileSync(file, content);

        const result = fixSecrets(
            [finding(content, { ruleId: "bad-span", sourceSpan: { matchEnd: content.length, matchStart: 0, secretEnd: 5, secretStart: 0 } })],
            root,
            false,
        );

        expect(result.skipped).toStrictEqual([{ file: "a.ts", line: 1, reason: "span does not match file", ruleId: "bad-span" }]);
        expect(result.replacements).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(content);
    });

    it("skips paths that escape the workspace", () => {
        expect.assertions(2);

        const root = tempDir();
        const result = fixSecrets([finding("const token = 1;\n", { file: "../outside.ts" })], root, false);

        expect(result.skipped).toStrictEqual([{ file: "../outside.ts", line: 1, reason: "outside workspace", ruleId: "github-pat" }]);
        expect(result.replacements).toBe(0);
    });

    it.skipIf(process.platform === "win32")("treats a backslash in a file name literally instead of as a separator", () => {
        expect.assertions(3);

        const root = tempDir();
        const content = `const token = "${PAT}";\n`;

        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "a.ts"), content);
        writeFileSync(join(root, String.raw`src\a.ts`), content);

        const result = fixSecrets([finding(content, { file: String.raw`src\a.ts` })], root, false);

        expect(result.changedFiles).toBe(1);
        expect(readFileSync(join(root, String.raw`src\a.ts`), "utf8")).toBe(content.replace(PAT, FIX_REPLACEMENT));
        expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(content);
    });

    it("reports files the scanner could not read instead of claiming a clean scan", () => {
        expect.assertions(2);

        printFixResult({ changedFiles: 0, edits: [], replacements: 0, skipped: [] }, 2, false, false);

        expect(stderr.join("")).toContain("2 file(s) were not scanned");
        expect(stderr.join("")).not.toBe("No secrets detected.\n");
    });

    const spanOf = (content: string, value: string): NonNullable<Finding["sourceSpan"]> => {
        const start = byteOffset(content, value);
        const end = start + Buffer.byteLength(value, "utf8");

        return { matchEnd: end, matchStart: start, secretEnd: end, secretStart: start };
    };

    it("replaces overlapping spans once as their union and reports both findings as fixed", () => {
        expect.assertions(5);

        const root = tempDir();
        const file = join(root, "a.ts");
        const content = `const token = "${PAT}";\n`;
        const quoted = `"${PAT}"`;

        writeFileSync(file, content);

        const outer = finding(content, { ruleId: "generic-api-key", secret: quoted, sourceSpan: spanOf(content, quoted) });
        const result = fixSecrets([outer, finding(content)], root, false);

        expect(result.skipped).toStrictEqual([]);
        expect(result.replacements).toBe(1);
        expect(result.edits).toStrictEqual([{ file: "a.ts", line: 1, ruleId: "generic-api-key, github-pat" }]);
        expect(readFileSync(file, "utf8")).toBe(`const token = ${FIX_REPLACEMENT};\n`);
        expect(JSON.stringify(result)).not.toContain(PAT);
    });

    it("leaves no tail when a longer span overlaps a shorter one", () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "a.ts");
        const longer = `${PAT}TAIL1234`;
        const content = `const token = "${longer}";\n`;

        writeFileSync(file, content);

        const result = fixSecrets([finding(content), finding(content, { ruleId: "long", secret: longer, sourceSpan: spanOf(content, longer) })], root, false);

        expect(result.skipped).toStrictEqual([]);
        expect(readFileSync(file, "utf8")).toBe(`const token = "${FIX_REPLACEMENT}";\n`);
        expect(readFileSync(file, "utf8")).not.toContain("TAIL1234");
    });

    it("rewrites the dependencies of a composite finding too", () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "a.ts");
        const dependency = "AKIAZ7QW3RT5YU2IOPLM";
        const content = `id = ${dependency}\nconst token = "${PAT}";\n`;

        writeFileSync(file, content);

        const required = { endColumn: 1, endLine: 1, match: dependency, ruleId: "aws-key-id", secret: dependency, sourceSpan: spanOf(content, dependency), startColumn: 1, startLine: 1 };
        const result = fixSecrets([{ ...finding(content), requiredFindings: [required], sourceSpan: spanOf(content, PAT) }], root, false);

        expect(result.skipped).toStrictEqual([]);
        expect(readFileSync(file, "utf8")).toBe(`id = ${FIX_REPLACEMENT}\nconst token = "${FIX_REPLACEMENT}";\n`);
        expect(result.replacements).toBe(2);
    });

    it("skips read-only files instead of replacing them", () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "a.ts");
        const content = `const token = "${PAT}";\n`;

        writeFileSync(file, content);
        chmodSync(file, 0o444);

        const result = fixSecrets([finding(content)], root, false);

        expect(result.skipped).toStrictEqual([{ file: "a.ts", line: 1, reason: "read-only file", ruleId: "github-pat" }]);
        expect(readFileSync(file, "utf8")).toBe(content);
        expect(statSync(file).mode % 0o1_0000).toBe(0o444);
    });

    it("skips symlinks instead of replacing the link with a regular file", () => {
        expect.assertions(3);

        const root = tempDir();
        const target = join(root, "target.ts");
        const link = join(root, "link.ts");
        const content = `const token = "${PAT}";\n`;

        writeFileSync(target, content);
        symlinkSync(target, link);

        const result = fixSecrets([finding(content, { file: "link.ts" })], root, false);

        expect(result.skipped).toStrictEqual([{ file: "link.ts", line: 1, reason: "symbolic link", ruleId: "github-pat" }]);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, "utf8")).toBe(content);
    });

    it("skips a symlinked parent that escapes the workspace", { timeout: 60_000 }, async () => {
        expect.assertions(4);

        const root = tempDir();
        const outside = tempDir();
        const file = join(outside, "a.ts");
        const content = `const token = "${PAT}";\n`;

        writeFileSync(file, content);
        symlinkSync(outside, join(root, "link"), "dir");

        await runSecrets({ fix: true }, root, undefined, ["link/a.ts"]);

        expect(readFileSync(file, "utf8")).toBe(content);
        expect(stderr.join("")).toContain("outside workspace");
        expect(stderr.join("")).not.toContain(PAT);
        expect(process.exitCode).toBe(1);
    });

    it("rejects multiple positional paths in fix mode", async () => {
        expect.assertions(1);

        const root = tempDir();
        const file = join(root, "a.ts");

        writeFileSync(file, `const token = "${PAT}";\n`);

        await expect(runSecrets({ fix: true }, root, undefined, ["a.ts", "a.ts"])).rejects.toThrow(/at most one path/);
    });

    it("still rewrites when redaction is on by default or in config", { timeout: 60_000 }, async () => {
        expect.assertions(4);

        const root = tempDir();
        const file = join(root, "a.ts");
        const content = `const token = "${PAT}";\n`;

        writeFileSync(file, content);

        await runSecrets({ fix: true }, root, { secrets: { redact: true } });

        expect(readFileSync(file, "utf8")).toBe(content.replace(PAT, FIX_REPLACEMENT));
        expect(stderr.join("")).not.toContain(PAT);
        expect(stderr.join("")).not.toContain("ghp_aB3");
        expect(process.exitCode).toBeUndefined();
    });

    it("fixes a generic and a specific finding on the same token without false overlaps", { timeout: 60_000 }, async () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "a.env");
        const content = `api_key = "${PAT}"\n`;

        writeFileSync(file, content);

        await runSecrets({ fix: true }, root);

        expect(readFileSync(file, "utf8")).not.toContain(PAT);
        expect(stderr.join("")).not.toContain("overlapping");
        expect(process.exitCode).toBeUndefined();
    });

    it("rewrites the unreported dependency of a composite rule", { timeout: 60_000 }, async () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "creds.env");
        const keyId = "AKIAZ7QW3RT5YU2IOPLM";
        // eslint-disable-next-line no-useless-concat -- split so automated push protection doesn't flag the fixture
        const secretKey = "wJalrXUtnFEMI/K7MDEN" + "G/bPxRfiCYzq8Rk2vN3d";
        const content = `aws_access_key_id = ${keyId}\naws_secret_access_key = ${secretKey}\n`;

        writeFileSync(file, content);

        await runSecrets({ fix: true }, root, {
            secrets: {
                config: {
                    extendBundled: false,
                    inline: {
                        rules: [
                            { id: "aws-key-id", keywords: ["akia"], regex: String.raw`\b((?:AKIA|ASIA)[A-Z0-9]{16})\b`, skipReport: true },
                            {
                                id: "aws-secret",
                                keywords: ["aws_secret_access_key"],
                                regex: String.raw`(?i)aws_secret_access_key\s*=\s*([A-Za-z0-9/+]{40})`,
                                required: [{ id: "aws-key-id", withinLines: 5 }],
                                secretGroup: 1,
                            },
                        ],
                    },
                },
            },
        } as VisSecretsConfig);

        const rewritten = readFileSync(file, "utf8");

        expect(rewritten).not.toContain(secretKey);
        expect(rewritten).not.toContain(keyId);
        expect(process.exitCode).toBeUndefined();
    });

    it("skips hard-linked files", () => {
        expect.assertions(3);

        const root = tempDir();
        const file = join(root, "a.ts");
        const content = `const token = "${PAT}";\n`;

        writeFileSync(file, content);
        linkSync(file, join(root, "b.ts"));

        const result = fixSecrets([finding(content)], root, false);

        expect(result.skipped).toStrictEqual([{ file: "a.ts", line: 1, reason: "hard-linked file", ruleId: "github-pat" }]);
        expect(readFileSync(file, "utf8")).toBe(content);
        expect(result.replacements).toBe(0);
    });

    it("rejects modes that could report or consume an unredacted secret", async () => {
        expect.assertions(16);

        const root = tempDir();
        const file = join(root, "a.ts");

        writeFileSync(file, `const token = "${PAT}";\n`);

        const incompatible: SecretsFlags[] = [
            { fix: true, redact: true },
            { fix: true, history: true },
            { fix: true, init: true },
            { fix: true, staged: true },
            { fix: true, listRules: true },
            { fix: true, listValidators: true },
            { fix: true, updateBaseline: true },
            { fix: true, replaceBaseline: true },
            { fix: true, report: ["json=out.json"] },
            { fix: true, logIgnored: true },
            { failOnUnreadable: true, fix: true },
            { failOnUnusedIgnores: true, fix: true },
            { fix: true, validate: true },
            { fix: true, format: "json" },
            { dryRun: true },
        ];

        for (const options of incompatible) {
            await expect(runSecrets(options, root)).rejects.toThrow(/--fix|--dry-run/);
        }

        await expect(runSecrets({ fix: true }, root, { secrets: { config: { validate: true } } })).rejects.toThrow(/--validate/);
    });
});
