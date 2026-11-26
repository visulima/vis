import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { runConcurrently } from "../../src/concurrent";
import type { NativeProcessEvent, NativeProcessEventBatch } from "../../src/native-binding";
import { loadNativeBindings } from "../../src/native-binding";

const native = loadNativeBindings()!;
const addonEntry = fileURLToPath(new URL("../../index.js", import.meta.url));

describe("native concurrent runner (napi surface)", () => {
    describe("event callbacks", () => {
        it("hands the event itself to the runConcurrent callback as its first argument", async () => {
            expect.assertions(3);

            const calls: unknown[][] = [];

            await native.runConcurrent([{ command: "echo hi" }], {}, (...args: unknown[]) => {
                calls.push(args);
            });

            const kinds = calls.map(([event]) => (event as NativeProcessEvent | null)?.kind);

            expect(kinds).toContain("started");
            expect(kinds).toContain("stdout");
            expect(kinds).toContain("close");
        });

        it("hands the event itself to the runConcurrentBatch lifecycle callback", async () => {
            expect.assertions(2);

            const calls: unknown[][] = [];

            await native.runConcurrentBatch([{ command: "true" }], {}, (...args: unknown[]) => {
                calls.push(args);
            });

            const started = calls.map(([event]) => event as NativeProcessEvent | null).find((event) => event?.kind === "started");

            expect(started).toBeDefined();
            expect(started?.pid).toBeTypeOf("number");
        });
    });

    describe("option values", () => {
        it.each([
            ["killSignal", { killSignal: "SIGBOGUS" }, "SIGBOGUS"],
            ["successCondition", { successCondition: "sometimes" }, "sometimes"],
            ["killOthers", { killOthers: ["maybe"] }, "maybe"],
        ])("rejects an unknown %s and names the value", async (_name, options, value) => {
            expect.assertions(1);

            await expect(native.runConcurrentBatch([{ command: "true" }], options, null)).rejects.toThrow(value);
        });

        it("rejects an unknown stdin mode and names the value", async () => {
            expect.assertions(1);

            await expect(native.runConcurrentBatch([{ command: "true", stdin: "telepathy" }], {}, null)).rejects.toThrow("telepathy");
        });

        it("accepts a command name in mixed case for the success condition", async () => {
            expect.assertions(1);

            const result = await native.runConcurrentBatch(
                [
                    { command: "true", name: "MyApp" },
                    { command: "exit 3", name: "other" },
                ],
                { successCondition: "command-MyApp" },
                null,
            );

            expect(result.success).toBe(true);
        });
    });

    describe.skipIf(process.platform === "win32")("process-wide signal handling", () => {
        it("leaves SIGHUP at its default action after a native run", () => {
            expect.assertions(2);

            const script = `
                const addon = await import(${JSON.stringify(addonEntry)});
                await addon.runConcurrentBatch([{ command: "true" }], {}, null);
                process.kill(process.pid, "SIGHUP");
                setTimeout(() => { console.log("survived"); process.exit(0); }, 1500);
            `;
            const { signal, stdout } = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });

            expect(stdout).not.toContain("survived");
            expect(signal).toBe("SIGHUP");
        });
    });

    describe.skipIf(process.platform === "win32")("concurrentRun handle", () => {
        /** Start a run and resolve once `count` commands have reported a pid. */
        const startAndWait = async (commands: { command: string; name?: string }[], count: number, options = {}) => {
            const pids = new Map<number, number>();
            let seen: () => void = () => {};
            const allStarted = new Promise<void>((resolve) => {
                seen = resolve;
            });

            const run = native.startConcurrent(commands, options, (batch) => {
                for (const event of batch.events) {
                    if (event.kind === "started" && typeof event.pid === "number") {
                        pids.set(event.index, event.pid);

                        if (pids.size >= count) {
                            seen();
                        }
                    }
                }
            });

            await allStarted;

            return { pids, run };
        };

        const groupGone = async (pid: number): Promise<boolean> => {
            for (let attempt = 0; attempt < 30; attempt += 1) {
                try {
                    process.kill(-pid, 0);
                } catch {
                    return true;
                }

                // Polling: each attempt depends on the previous one finding the group still alive.
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => {
                    setTimeout(resolve, 100);
                });
            }

            return false;
        };

        it("aborts as an interrupt: exit code 0, killed, nothing queued is started, nothing is left", async () => {
            expect.assertions(5);

            const { pids, run } = await startAndWait(
                [
                    { command: "sleep 30", name: "a" },
                    { command: "sleep 30", name: "b" },
                    { command: "echo queued", name: "c" },
                ],
                2,
                { maxProcesses: 2 },
            );

            run.abort("interrupt");

            const result = await run.done();

            expect(result.closeEvents).toHaveLength(2);
            expect(result.closeEvents.map((event) => event.exitCode)).toStrictEqual([0, 0]);
            expect(result.closeEvents.every((event) => event.killed)).toBe(true);
            expect(result.success).toBe(true);

            const gone = await Promise.all([...pids.values()].map((pid) => groupGone(pid)));

            expect(gone).toStrictEqual([true, true]);
        });

        it("aborts as a termination: the exit codes stay", async () => {
            expect.assertions(3);

            const { run } = await startAndWait([{ command: "sleep 30" }], 1);

            run.abort("terminate");

            const result = await run.done();

            expect(result.closeEvents[0]!.exitCode).toBe(143);
            expect(result.closeEvents[0]!.killed).toBe(true);
            expect(result.success).toBe(false);
        });

        it("kills one command with a chosen signal and leaves the others", async () => {
            expect.assertions(4);

            const { run } = await startAndWait([{ command: "sleep 30" }, { command: "sleep 0.5" }], 2);

            expect(run.kill(0, "SIGKILL")).toBe(true);

            const result = await run.done();
            const byIndex = (index: number) => result.closeEvents.find((event) => event.index === index)!;

            expect(byIndex(0).exitCode).toBe(137);
            expect(byIndex(1).exitCode).toBe(0);
            expect(byIndex(1).killed).toBe(false);
        });

        it("tolerates done twice and abort or kill after the run has finished", async () => {
            expect.assertions(4);

            const run = native.startConcurrent([{ command: "true" }], {}, null);
            const first = await run.done();
            const second = await run.done();

            expect(second).toStrictEqual(first);
            expect(() => { run.abort("interrupt"); }).not.toThrow();
            expect(run.kill(0)).toBe(false);
            expect(first.success).toBe(true);
        });

        it("rejects bad arguments with the offending value in the message", async () => {
            expect.assertions(3);

            const { run } = await startAndWait([{ command: "sleep 30" }], 1);

            // @ts-expect-error -- exercising the runtime check
            expect(() => { run.abort("sideways"); }).toThrow("sideways");
            expect(() => run.kill(0, "SIGBOGUS")).toThrow("SIGBOGUS");

            run.abort("terminate");
            await run.done();

            expect(() => native.startConcurrent([{ command: "true" }], { killSignal: "SIGBOGUS" }, null)).toThrow("SIGBOGUS");
        });
    });

    describe("startConcurrent batches", () => {
        it("delivers the outcome as the last batch, after every event", async () => {
            expect.assertions(4);

            const batches: NativeProcessEventBatch[] = [];
            const run = native.startConcurrent([{ command: "seq 1 3000" }], { streamOutput: true }, (batch) => {
                batches.push(batch);
            });

            await run.done();
            // The callback runs on the JS thread; give the final batch the turn it needs.
            await vi.waitFor(() => {
                if (!batches.some((batch) => batch.result)) {
                    throw new Error("the final batch has not arrived");
                }
            });

            const last = batches.at(-1)!;
            const events = batches.flatMap((batch) => batch.events);

            expect(last.result?.success).toBe(true);
            expect(last.events).toHaveLength(0);
            expect(batches.slice(0, -1).every((batch) => batch.result === undefined && batch.error === undefined)).toBe(true);

            // Adjacent lines of a stream travel as one event (`count` lines joined with a newline).
            const lines = events.filter((event) => event.kind === "stdout").flatMap((event) => (event.count && event.count > 1 ? event.text!.split("\n") : [event.text]));

            expect(lines).toStrictEqual(Array.from({ length: 3000 }, (_, position) => String(position + 1)));
        });

        it("reports lines only when asked to", async () => {
            expect.assertions(2);

            const kinds: string[] = [];
            const run = native.startConcurrent([{ command: "echo hi" }], {}, (batch) => {
                kinds.push(...batch.events.map((event) => event.kind));
            });

            await run.done();
            await vi.waitFor(() => {
                if (!kinds.includes("close")) {
                    throw new Error("the close has not arrived");
                }
            });

            expect(kinds).toContain("started");
            expect(kinds).not.toContain("stdout");
        });
    });

    describe("write, resize and the pty options", () => {
        it("refuses a terminal size the terminal cannot take, naming it", async () => {
            expect.assertions(3);

            expect(() => native.startConcurrent([{ command: "true", ptySize: { cols: 0, rows: 24 }, stdin: "pty" }], {}, null)).toThrow("0x24");

            const run = native.startConcurrent([{ command: "true" }], {}, null);

            expect(() => run.resize(0, 80, 70_000)).toThrow("80x70000");

            await run.done();

            expect(run.resize(0, 80, 24)).toBe(false);
        });

        it("reports a write to a finished run as not delivered", async () => {
            expect.assertions(2);

            const run = native.startConcurrent([{ command: "true" }], {}, null);

            expect(run.write(0, "late")).toBe(true);

            await run.done();
            await vi.waitFor(() => {
                if (run.write(0, "later")) {
                    throw new Error("the run is still reachable");
                }
            });

            expect(run.write(0, "much later")).toBe(false);
        });
    });

    describe.skipIf(process.platform === "win32")("runConcurrently signal handling", () => {
        const pgrep = (pattern: string): string => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim();

        it("turns SIGINT into an interrupt for its own run only and removes its listeners afterwards", async () => {
            expect.assertions(4);

            const marker = "sleep 31.337";
            const before = { exit: process.listenerCount("exit"), sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };

            const running = runConcurrently([marker]);

            // Wait until the run has registered itself and its child is up.
            await vi.waitFor(() => {
                if (process.listenerCount("SIGINT") !== before.sigint + 1 || pgrep(marker) === "") {
                    throw new Error("the run has not started yet");
                }
            });

            // Call only this run's listener (the last one added); other listeners, such as the test runner's own, stay out of it.
            const listener = process.listeners("SIGINT").at(-1) as () => void;

            listener();

            const result = await running;

            expect(result.closeEvents[0]).toMatchObject({ exitCode: 0, killed: true });
            expect(process.listenerCount("SIGINT")).toBe(before.sigint);
            expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
            expect(process.listenerCount("exit")).toBe(before.exit);
        });
    });
});
