import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { Toolbox } from "@visulima/cerebro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SecretsFlags } from "../../src/commands/secrets/flags";
import { stdinUsageError } from "../../src/commands/secrets/flags";
import execute from "../../src/commands/secrets/handler";
import { readStdinText } from "../../src/secrets/stdin";

// pail logs only warnings and up under NODE_ENV=test; log as the CLI does.
// This must run before the logger module is imported.
vi.hoisted(() => {
    process.env["PAIL_LOG_LEVEL"] = "informational";
});

// eslint-disable-next-line no-useless-concat -- split so GitHub push protection doesn't flag the fake token
const PAT = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";

const dirs: string[] = [];
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin") as PropertyDescriptor;

const feedStdin = (text: string): void => {
    Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([Buffer.from(text)]) });
};

describe(stdinUsageError, () => {
    it("accepts a named stdin scan and ignores runs without --stdin", () => {
        expect.assertions(2);

        expect(stdinUsageError({ stdin: "src/app.ts" }, false)).toBeUndefined();
        expect(stdinUsageError({}, true)).toBeUndefined();
    });

    it("needs a file name", () => {
        expect.assertions(3);

        expect(stdinUsageError({ stdin: "" }, false)).toMatch(/needs the file name/);
        expect(stdinUsageError({ stdin: true as unknown as string }, false)).toMatch(/needs the file name/);
        // cerebro parses a bare `--stdin` as null.
        expect(stdinUsageError({ stdin: null as unknown as string }, false)).toMatch(/needs the file name/);
    });

    it("rejects paths and other scan targets", () => {
        expect.assertions(5);

        expect(stdinUsageError({ stdin: "a.ts" }, true)).toMatch(/can't be combined with paths/);
        expect(stdinUsageError({ staged: true, stdin: "a.ts" }, false)).toMatch(/can't be combined with --staged/);
        expect(stdinUsageError({ init: true, maxArchiveDepth: 1, stdin: "a.ts" }, false)).toMatch(/--max-archive-depth, --init/);
        expect(stdinUsageError({ since: "main", stdin: "a.ts" }, false)).toMatch(/--since/);
        expect(stdinUsageError({ exclude: ["dist"], gitignore: false, stdin: "a.ts" }, false)).toMatch(/--exclude, --no-gitignore/);
    });
});

describe(readStdinText, () => {
    it("reads every chunk as UTF-8", async () => {
        expect.assertions(1);

        await expect(readStdinText(Readable.from([Buffer.from("héll"), Buffer.from("o")]), 100)).resolves.toStrictEqual({ kind: "ok", text: "héllo" });
    });

    it("stops reading input over the size cap", async () => {
        expect.assertions(2);

        await expect(readStdinText(Readable.from([Buffer.from("12345"), Buffer.from("6")]), 5)).resolves.toStrictEqual({ kind: "too-large" });
        await expect(readStdinText(Readable.from([Buffer.from("12345")]), 5)).resolves.toStrictEqual({ kind: "ok", text: "12345" });
    });
});

describe("vis secrets --stdin", () => {
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
        Object.defineProperty(process, "stdin", realStdin);
        process.exitCode = undefined;

        for (const dir of dirs.splice(0)) {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    const workspace = (): string => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "vis-secrets-stdin-")));

        dirs.push(root);

        return root;
    };

    const run = async (options: SecretsFlags, root: string, input: string, argument: string[] = []): Promise<void> => {
        feedStdin(input);

        await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
            argument,
            fs: { access, mkdir, readdir, readFile, rm, stat, writeFile },
            options,
            process: { cwd: root } as Toolbox["process"],
            workspaceRoot: root,
        });
    };

    it("reports findings under the given file name", async () => {
        expect.assertions(4);

        const root = workspace();

        await run({ format: "json", stdin: "src/app.ts" }, root, `const a = "${PAT}";\n`);

        const findings = JSON.parse(stdout.join("")) as { file: string; ruleId: string; startLine: number }[];

        expect(findings).toHaveLength(1);
        expect(findings[0]?.file).toBe("src/app.ts");
        expect(findings[0]?.ruleId).toBe("github-pat");
        expect(process.exitCode).toBe(1);
    }, 60_000);

    it("shows the piped text, not the file of the same name on disk, as context in the text view", async () => {
        expect.assertions(3);

        const root = workspace();

        writeFileSync(join(root, "a.ts"), "// stale content from disk\n");

        await run({ stdin: "a.ts" }, root, `// piped line\nconst a = "${PAT}";\n`);

        const output = stdout.join("");

        expect(output).toContain("a.ts");
        expect(output).toContain("// piped line");
        expect(output).not.toContain("stale content");
    }, 60_000);

    it("carries the file name into every report format", async () => {
        expect.assertions(5);

        const root = workspace();

        await run(
            { report: ["sarif=out.sarif", "csv=out.csv", "junit=out.xml", "gitlab-code-quality=out-gl.json"], stdin: "pkg/config.env" },
            root,
            `TOKEN="${PAT}"\n`,
        );

        expect(readFileSync(join(root, "out.sarif"), "utf8")).toContain("pkg/config.env");
        expect(readFileSync(join(root, "out.csv"), "utf8")).toContain("pkg/config.env");
        expect(readFileSync(join(root, "out.xml"), "utf8")).toContain("pkg/config.env");
        expect(readFileSync(join(root, "out-gl.json"), "utf8")).toContain("pkg/config.env");
        expect(stdout.join("")).toContain("pkg/config.env");
    }, 60_000);

    it("applies inline suppression, redaction and the baseline like a file scan", async () => {
        expect.assertions(5);

        const root = workspace();

        await run({ format: "json", stdin: "a.ts" }, root, `const a = "${PAT}"; // gitleaks:allow\n`);

        expect(JSON.parse(stdout.join(""))).toStrictEqual([]);

        stdout.length = 0;
        process.exitCode = undefined;
        await run({ format: "json", redact: true, stdin: "a.ts" }, root, `const a = "${PAT}";\n`);

        expect(stdout.join("")).not.toContain(PAT);
        expect(process.exitCode).toBe(1);

        process.exitCode = undefined;
        await run({ baseline: ".secrets-baseline.json", stdin: "a.ts", updateBaseline: true }, root, `const a = "${PAT}";\n`);

        stdout.length = 0;
        await run({ baseline: ".secrets-baseline.json", format: "json", stdin: "a.ts" }, root, `const a = "${PAT}";\n`);

        expect(JSON.parse(stdout.join(""))).toStrictEqual([]);
        expect(process.exitCode).toBeUndefined();
    }, 120_000);

    it("honours the root .gitleaksignore and a rule config like a file scan", async () => {
        expect.assertions(4);

        const root = workspace();

        writeFileSync(join(root, ".gitleaksignore"), "a.ts:github-pat:1\n");
        await run({ format: "json", stdin: "a.ts" }, root, `const a = "${PAT}";\n`);

        expect(JSON.parse(stdout.join(""))).toStrictEqual([]);

        stdout.length = 0;
        await run({ format: "json", stdin: "other.ts" }, root, `const a = "${PAT}";\n`);

        expect(JSON.parse(stdout.join(""))).toHaveLength(1);

        stdout.length = 0;
        process.exitCode = undefined;
        await run({ excludeRule: ["github-pat"], format: "json", stdin: "other.ts" }, root, `const a = "${PAT}";\n`);

        expect(JSON.parse(stdout.join(""))).toStrictEqual([]);
        expect(process.exitCode).toBeUndefined();
    }, 120_000);

    it("lists suppressed findings with --log-ignored", async () => {
        expect.assertions(1);

        const root = workspace();

        await run({ logIgnored: true, stdin: "a.ts" }, root, `const a = "${PAT}"; // gitleaks:allow\n`);

        expect(stderr.join("")).toContain("1 finding(s) suppressed");
    }, 60_000);

    it("skips input over --max-size instead of scanning it", async () => {
        expect.assertions(3);

        const root = workspace();

        await run({ format: "json", maxSize: 10, stdin: "big.ts" }, root, `const a = "${PAT}";\n`);

        expect(JSON.parse(stdout.join(""))).toStrictEqual([]);
        expect(stderr.join("")).toContain("1 file(s) not scanned (too-large: 1)");
        expect(process.exitCode).toBeUndefined();
    }, 60_000);

    it("exits 2 when combined with paths", async () => {
        expect.assertions(3);

        const root = workspace();

        await run({ stdin: "a.ts" }, root, `const a = "${PAT}";\n`, ["src"]);

        expect(process.exitCode).toBe(2);
        expect(stderr.join("")).toContain("can't be combined with paths");
        expect(stdout.join("")).toBe("");
    }, 60_000);
});
