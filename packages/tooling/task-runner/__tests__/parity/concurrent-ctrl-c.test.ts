/**
 * Ctrl+C against a real process: a CLI that runs commands through the built `runConcurrently`
 * gets SIGINT, exits 0 (a user interrupt is not a failure) and leaves no child behind, whether
 * the command is the shell's direct child or something it started in the background.
 *
 * The CLI imports `dist/`, so the test needs `pnpm exec packem build --development` first;
 * without a build it is skipped locally and fails on CI.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const posix = process.platform !== "win32";
const dist = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const cli = fileURLToPath(new URL("fixtures/ctrl-c-cli.mjs", import.meta.url));
const probe = fileURLToPath(new URL("fixtures/probe.cjs", import.meta.url));
const built = existsSync(dist);

const quote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;
const hangPid = `${quote(process.execPath)} ${quote(probe)} hang-pid`;

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

const waitUntil = async (condition: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (condition()) {
            return true;
        }

        // eslint-disable-next-line no-await-in-loop -- polling a process table entry
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
    }

    return condition();
};

/** Starts the mini CLI, waits for `ready` and the children's pids, sends SIGINT, and reports how it ended. */
const interrupt = async (commands: string[]): Promise<{ code: number | null; pids: number[]; signal: NodeJS.Signals | null }> => {
    const child = spawn(process.execPath, [cli, ...commands], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });

    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("close", (code, signal) => {
            resolve({ code, signal });
        });
    });

    await waitUntil(() => output.includes("ready") && (output.match(/pid:\d+/g) ?? []).length >= commands.length, 20_000);

    const pids = [...output.matchAll(/pid:(\d+)/g)].map((match) => Number(match[1]));

    child.kill("SIGINT");

    const outcome = await Promise.race([
        ended,
        new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("the CLI did not exit within 20 s of SIGINT"));
            }, 20_000).unref();
        }),
    ]);

    return { ...outcome, pids };
};

describe("a CLI running commands through runConcurrently, on Ctrl+C", () => {
    it("should exit 0 and leave no child behind", async ({ skip }) => {
        expect.assertions(4);

        skip(!posix || (!built && !process.env["CI"]));

        expect(built, "run `pnpm exec packem build --development` first").toBe(true);

        const { code, pids } = await interrupt([hangPid, `${hangPid} & wait`]);

        expect(code).toBe(0);
        expect(pids).toHaveLength(2);
        await expect(waitUntil(() => pids.every((pid) => !alive(pid)), 10_000)).resolves.toBe(true);
    });
});
