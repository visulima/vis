import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Toolbox } from "@visulima/cerebro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SecretsFlags } from "../../src/commands/secrets/flags";
import execute from "../../src/commands/secrets/handler";

// pail logs only warnings and up under NODE_ENV=test, which hid the info /
// notice lines that leaked onto stdout. Log as the CLI does; this must run
// before the logger module is imported.
vi.hoisted(() => {
    process.env["PAIL_LOG_LEVEL"] = "informational";
});

// eslint-disable-next-line no-useless-concat -- split so GitHub push protection doesn't flag the fake token
const PAT = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";

const dirs: string[] = [];

describe("vis secrets machine-readable stdout", () => {
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

    const workspace = (content: string): string => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "vis-secrets-stdout-")));

        dirs.push(root);
        writeFileSync(join(root, "a.ts"), content);

        return root;
    };

    const runSecrets = async (options: SecretsFlags, root: string): Promise<void> => {
        await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
            argument: [],
            fs: { access, mkdir, readdir, readFile, rm, stat, writeFile },
            options,
            process: { cwd: root } as Toolbox["process"],
            workspaceRoot: root,
        });
    };

    it("keeps status lines off stdout with --format json and --report", async () => {
        expect.assertions(4);

        const root = workspace(`const a = "${PAT}";\n`);

        await runSecrets({ format: "json", report: ["csv=out.csv"] }, root);

        expect(JSON.parse(stdout.join(""))).toHaveLength(1);
        expect(stderr.join("")).toContain("Wrote csv report to out.csv");
        expect(stderr.join("")).toContain("Suppress individual lines");
        expect(readFileSync(join(root, "out.csv"), "utf8")).toContain("github-pat");
    }, 60_000);

    it("keeps status lines off stdout with --format sarif", async () => {
        expect.assertions(2);

        const root = workspace(`const a = "${PAT}";\n`);

        await runSecrets({ format: "sarif" }, root);

        expect((JSON.parse(stdout.join("")) as { version: string }).version).toBe("2.1.0");
        expect(stderr.join("")).toContain("1 potential secret(s) found");
    }, 60_000);

    it("keeps the clean-scan message off stdout", async () => {
        expect.assertions(2);

        const root = workspace("const a = 1;\n");

        await runSecrets({ format: "json" }, root);

        expect(JSON.parse(stdout.join(""))).toStrictEqual([]);
        expect(stderr.join("")).toContain("No secrets detected.");
    }, 60_000);
});
