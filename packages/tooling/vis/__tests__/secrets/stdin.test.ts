import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { Toolbox } from "@visulima/cerebro";
import { DEFAULT_MAX_FILE_SIZE } from "@visulima/secret-scanner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SecretsFlags } from "../../src/commands/secrets/flags";
import execute from "../../src/commands/secrets/handler";

// Split so secret scanners in the repo don't flag this fixture.
// eslint-disable-next-line no-useless-concat -- split so push protection doesn't flag the fake token
const FAKE_PAT = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";

const SECRET_LINE = `TOKEN=${FAKE_PAT}\n`;

interface Finding {
    file: string;
    ruleId: string;
}

interface RunInput {
    argument?: string[];
    chunks?: (Buffer | string)[];
    cwd?: string;
    isTTY?: boolean;
}

describe("vis secrets --stdin", () => {
    let stdout: string[];
    let root: string;

    beforeEach(() => {
        stdout = [];
        root = mkdtempSync(join(tmpdir(), "vis-secrets-stdin-"));
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
            stdout.push(String(chunk));

            return true;
        });
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        process.exitCode = undefined;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
    });

    const run = async (options: SecretsFlags, { argument = [], chunks = [], cwd = root, isTTY = false }: RunInput = {}): Promise<Finding[]> => {
        const stdin = Object.assign(Readable.from(chunks, { objectMode: false }), { isTTY });

        vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
        stdout.length = 0;

        await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
            argument,
            console: { error: vi.fn(), flush: vi.fn() },
            fs: { access },
            options: { format: "json", quiet: true, ...options },
            process: { cwd } as Toolbox["process"],
            workspaceRoot: root,
        } as unknown as Partial<Toolbox>);

        return JSON.parse(stdout.join("")) as Finding[];
    };

    const files = (findings: Finding[]): string[] => findings.map((finding) => finding.file);

    it("scans piped content as the named virtual file", async () => {
        expect.assertions(3);

        const findings = await run({ stdin: "config/.env" }, { chunks: [SECRET_LINE] });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.file).toBe("config/.env");
        expect(findings[0]?.ruleId).toBe("github-pat");
    }, 60_000);

    it("reports no findings for empty piped content", async () => {
        expect.assertions(2);

        await expect(run({ stdin: "empty.txt" })).resolves.toStrictEqual([]);
        expect(process.exitCode).toBeUndefined();
    }, 60_000);

    it("keeps multibyte characters that straddle chunk boundaries", async () => {
        expect.assertions(2);

        const bytes = Buffer.from(`# ééé\n${SECRET_LINE}`);

        // Split inside the first two-byte character.
        const findings = await run({ stdin: "a.env" }, { chunks: [bytes.subarray(0, 3), bytes.subarray(3)] });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.file).toBe("a.env");
    }, 60_000);

    describe("filename normalisation", () => {
        it("reports ./config/.env root-relative", async () => {
            expect.assertions(1);

            expect(files(await run({ stdin: "./config/.env" }, { chunks: [SECRET_LINE] }))).toStrictEqual(["config/.env"]);
        }, 60_000);

        it("reports an absolute path inside the workspace root-relative", async () => {
            expect.assertions(1);

            expect(files(await run({ stdin: join(root, "config", ".env") }, { chunks: [SECRET_LINE] }))).toStrictEqual(["config/.env"]);
        }, 60_000);

        it("reports a dotted in-root name root-relative", async () => {
            expect.assertions(1);

            expect(files(await run({ stdin: "..env" }, { chunks: [SECRET_LINE] }))).toStrictEqual(["..env"]);
        }, 60_000);

        it("resolves the name against the directory vis runs from", async () => {
            expect.assertions(1);

            const cwd = join(root, "packages", "app");

            mkdirSync(cwd, { recursive: true });

            expect(files(await run({ stdin: ".env" }, { chunks: [SECRET_LINE], cwd }))).toStrictEqual(["packages/app/.env"]);
        }, 60_000);

        it.each(["config/.env", "./config/.env", "sub/../config/.env"])("matches a root-relative baseline entry for %s", async (filename) => {
            expect.assertions(2);

            const [finding] = await run({ stdin: "config/.env" }, { chunks: [SECRET_LINE] });
            const baseline = join(root, ".secrets-baseline.json");

            writeFileSync(baseline, JSON.stringify([finding]));
            process.exitCode = undefined;

            await expect(run({ baseline, stdin: filename }, { chunks: [SECRET_LINE] })).resolves.toStrictEqual([]);
            expect(process.exitCode).toBeUndefined();
        }, 60_000);

        it("matches a .gitleaksignore fingerprint from a subdirectory run", async () => {
            expect.assertions(1);

            const cwd = join(root, "packages", "app");

            mkdirSync(cwd, { recursive: true });
            writeFileSync(join(root, ".gitleaksignore"), "packages/app/.env:github-pat:1\n");

            await expect(run({ stdin: ".env" }, { chunks: [SECRET_LINE], cwd })).resolves.toStrictEqual([]);
        }, 60_000);
    });

    describe("path excludes", () => {
        it("reports nothing for a name matched by --exclude", async () => {
            expect.assertions(2);

            await expect(run({ exclude: "dist/**", stdin: "dist/x.env" }, { chunks: [SECRET_LINE] })).resolves.toStrictEqual([]);
            expect(process.exitCode).toBeUndefined();
        }, 60_000);

        it("still reports a name the excludes do not match", async () => {
            expect.assertions(1);

            expect(files(await run({ exclude: "dist/**", stdin: "src/x.env" }, { chunks: [SECRET_LINE] }))).toStrictEqual(["src/x.env"]);
        }, 60_000);

        it("honours --exclude-from", async () => {
            expect.assertions(1);

            const ignoreFile = join(root, ".secretsignore");

            writeFileSync(ignoreFile, "config/\n");

            await expect(run({ excludeFrom: ignoreFile, stdin: "config/.env" }, { chunks: [SECRET_LINE] })).resolves.toStrictEqual([]);
        }, 60_000);

        it("matches the name root-relative when vis runs from a subdirectory", async () => {
            expect.assertions(1);

            const cwd = join(root, "packages", "app");

            mkdirSync(cwd, { recursive: true });

            await expect(run({ exclude: "packages/**", stdin: ".env" }, { chunks: [SECRET_LINE], cwd })).resolves.toStrictEqual([]);
        }, 60_000);
    });

    describe("usage errors", () => {
        it.each([
            ["a bare --stdin", null],
            ["--stdin=", ""],
        ])("rejects %s", async (_label, value) => {
            expect.assertions(1);

            await expect(run({ stdin: value })).rejects.toThrow("--stdin needs a filename");
        });

        it("rejects positional paths", async () => {
            expect.assertions(1);

            await expect(run({ stdin: "config/.env" }, { argument: ["src"] })).rejects.toThrow("explicit paths");
        });

        it("rejects another scan target", async () => {
            expect.assertions(1);

            await expect(run({ history: true, stdin: "config/.env" })).rejects.toThrow("--history");
        });

        it.each([
            ["--init", { init: true }],
            ["--list-rules", { listRules: true }],
            ["--update-baseline", { updateBaseline: true }],
            ["--replace-baseline", { replaceBaseline: true }],
            ["--log-ignored", { logIgnored: true }],
            ["--max-size", { maxSize: 100 }],
            ["--max-archive-depth", { maxArchiveDepth: 1 }],
            ["--fail-on-unreadable", { failOnUnreadable: true }],
            ["--fail-on-unused-ignores", { failOnUnusedIgnores: true }],
        ] satisfies [string, SecretsFlags][])("rejects %s", async (flag, extra) => {
            expect.assertions(1);

            await expect(run({ stdin: "config/.env", ...extra })).rejects.toThrow(flag);
        });

        it("stops reading input larger than the scanner's file size limit", async () => {
            expect.assertions(2);

            const chunk = Buffer.alloc(DEFAULT_MAX_FILE_SIZE / 2 + 1);
            let pulled = 0;
            const generate = function* (): Generator<Buffer> {
                while (pulled < 10) {
                    pulled += 1;

                    yield chunk;
                }
            };

            await expect(run({ stdin: "big.txt" }, { chunks: generate() as unknown as Buffer[] })).rejects.toThrow("--stdin input exceeds");
            expect(pulled).toBeLessThan(10);
        });

        it("fails fast when stdin is a terminal", async () => {
            expect.assertions(1);

            await expect(run({ stdin: ".env" }, { isTTY: true })).rejects.toThrow("--stdin expects piped input");
        });
    });
});
