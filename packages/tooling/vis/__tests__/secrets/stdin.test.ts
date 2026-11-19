import { mkdtempSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Toolbox } from "@visulima/cerebro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SecretsFlags } from "../../src/commands/secrets/flags";
import execute from "../../src/commands/secrets/handler";

// Split so secret scanners in the repo don't flag this fixture.
// eslint-disable-next-line no-useless-concat -- split so push protection doesn't flag the fake token
const FAKE_PAT = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";

interface RunResult {
    error: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    stdout: string[];
}

describe("vis secrets --stdin", () => {
    let stdout: string[];

    beforeEach(() => {
        stdout = [];
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

    const run = async (options: SecretsFlags, argument: string[] = [], content = ""): Promise<RunResult> => {
        const error = vi.fn();
        const exit = vi.fn();
        const root = mkdtempSync(join(tmpdir(), "vis-secrets-stdin-"));

        await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
            argument,
            console: { error, flush: vi.fn() },
            fs: { access },
            options: { format: "json", quiet: true, ...options },
            process: { cwd: root, exit, stdin: content } as Toolbox["process"],
            workspaceRoot: root,
        } as unknown as Partial<Toolbox>);

        return { error, exit, stdout };
    };

    it("scans piped content as the named virtual file", async () => {
        expect.assertions(4);

        const { exit, stdout: output } = await run({ stdin: "config/.env" }, [], `TOKEN=${FAKE_PAT}\n`);

        const findings = JSON.parse(output.join("")) as { file: string; ruleId: string }[];

        expect(findings).toHaveLength(1);
        expect(findings[0]?.file).toBe("config/.env");
        expect(findings[0]?.ruleId).toBe("github-pat");
        expect(exit).not.toHaveBeenCalled();
    }, 60_000);

    it("reports no findings for empty piped content", async () => {
        expect.assertions(2);

        const { stdout: output } = await run({ stdin: "empty.txt" });

        expect(JSON.parse(output.join(""))).toStrictEqual([]);
        expect(process.exitCode).toBeUndefined();
    }, 60_000);

    it("exits 2 when positional paths are passed with --stdin", async () => {
        expect.assertions(3);

        const { error, exit, stdout: output } = await run({ stdin: "config/.env" }, ["src"]);

        expect(error).toHaveBeenCalledWith(expect.stringContaining("explicit paths"));
        expect(exit).toHaveBeenCalledWith(2);
        expect(output).toStrictEqual([]);
    });

    it("exits 2 when another scan target is passed with --stdin", async () => {
        expect.assertions(2);

        const { error, exit } = await run({ history: true, stdin: "config/.env" });

        expect(error).toHaveBeenCalledWith(expect.stringContaining("--history"));
        expect(exit).toHaveBeenCalledWith(2);
    });
});
