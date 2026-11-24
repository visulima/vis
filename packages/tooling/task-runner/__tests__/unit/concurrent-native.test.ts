import { describe, expect, it, vi } from "vitest";

import { runNativeConcurrent } from "../../src/concurrent-native";
import type { NativeBindings, NativeConcurrentRun } from "../../src/native-binding";
import { loadNativeBindings } from "../../src/native-binding";
import type { ProcessEvent } from "../../src/types";

// The real addon, except where a test hands in a binding of its own for one call.
vi.mock(import('../../src/native-binding'), async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/native-binding")>();

    return { ...original, loadNativeBindings: vi.fn<typeof original.loadNativeBindings>(original.loadNativeBindings) };
});

const collect = async (
    commands: Parameters<typeof runNativeConcurrent>[0],
    options: Parameters<typeof runNativeConcurrent>[1] = {},
): Promise<{ events: ProcessEvent[]; result: Awaited<ReturnType<typeof runNativeConcurrent>> }> => {
    const events: ProcessEvent[] = [];
    const result = await runNativeConcurrent(commands, { ...options, onEvent: (event) => events.push(event) });

    return { events, result };
};

describe(runNativeConcurrent, () => {
    it("reports started, output and close events to onEvent, in order, with the same result", async () => {
        expect.assertions(7);

        const { events, result } = await collect([{ command: "echo one; echo two 1>&2", name: "talker" }]);

        expect(events.map((event) => event.kind)[0]).toBe("started");
        expect(events.at(-1)?.kind).toBe("close");
        expect(events.find((event) => event.kind === "started")?.pid).toBeTypeOf("number");
        expect(events.filter((event) => event.kind === "stdout").map((event) => event.text)).toStrictEqual(["one"]);
        expect(events.filter((event) => event.kind === "stderr").map((event) => event.text)).toStrictEqual(["two"]);
        expect(events.at(-1)).toMatchObject({ commandName: "talker", exitCode: 0, killed: false });
        expect(result).toMatchObject({ closeEvents: [{ command: "echo one; echo two 1>&2", exitCode: 0, index: 0, name: "talker" }], success: true });
    });

    it("does not stream output without an onEvent callback", async () => {
        expect.assertions(1);

        await expect(runNativeConcurrent([{ command: "echo quiet" }], {})).resolves.toMatchObject({ success: true });
    });

    // The result must never overtake an event: a caller reads its buffer straight after the await.
    it("has delivered every event by the time it resolves, however fast the child exits", async () => {
        expect.assertions(3);

        const lines = 10_000;
        let missing = 0;
        let outOfOrder = 0;
        let closeNotLast = 0;

        for (let round = 0; round < 25; round += 1) {
            // eslint-disable-next-line no-await-in-loop
            const { events } = await collect([{ command: `seq 1 ${lines}` }]);
            const numbers = events.filter((event) => event.kind === "stdout").map((event) => Number(event.text));

            if (numbers.length !== lines) {
                missing += 1;
            }

            if (numbers.some((value, position) => value !== position + 1)) {
                outOfOrder += 1;
            }

            if (events.at(-1)?.kind !== "close") {
                closeNotLast += 1;
            }
        }

        expect(missing).toBe(0);
        expect(outOfOrder).toBe(0);
        expect(closeNotLast).toBe(0);
    }, 60_000);

    describe.skipIf(process.platform === "win32")("the run handle's closures on the started event", () => {
        it("writes to a piped stdin after the command has started", async () => {
            expect.assertions(2);

            const events: ProcessEvent[] = [];

            await runNativeConcurrent([{ command: "read line; echo got:$line", stdin: "pipe" }], {
                onEvent: (event) => {
                    events.push(event);

                    if (event.kind === "started") {
                        expect(event.write).toBeTypeOf("function");

                        event.write?.("hello\n");
                    }
                },
            });

            expect(events.filter((event) => event.kind === "stdout").map((event) => event.text)).toContain("got:hello");
        });

        it("offers write and resize only where they can work, and kill everywhere", async () => {
            expect.assertions(6);

            const { events } = await collect([{ command: "true" }, { command: "true", stdin: "pipe" }, { command: "true", stdin: "pty" }], { maxProcesses: 0 });
            const started = (index: number) => events.find((event) => event.kind === "started" && event.index === index)!;

            expect([started(0).kill, started(1).kill, started(2).kill].every((kill) => typeof kill === "function")).toBe(true);
            expect(started(0).write).toBeUndefined();
            expect(started(1).write).toBeTypeOf("function");
            expect(started(1).resize).toBeUndefined();
            expect(started(2).write).toBeTypeOf("function");
            expect(started(2).resize).toBeTypeOf("function");
        });

        it("kills the command's process tree with the given signal, SIGTERM by default", async () => {
            expect.assertions(4);

            const kill = async (signal?: string) => {
                const result = await runNativeConcurrent([{ command: "sleep 30" }], {
                    onEvent: (event) => {
                        if (event.kind === "started") {
                            event.kill?.(signal);
                        }
                    },
                });

                return result.closeEvents[0]!;
            };

            const byDefault = await kill();
            const forced = await kill("SIGKILL");

            expect(byDefault).toMatchObject({ exitCode: 143, killed: true });
            expect(forced).toMatchObject({ exitCode: 137, killed: true });
            // An unknown signal name is ignored, as `process.kill` failing is in the JS spawner.
            await expect(
                runNativeConcurrent([{ command: "sleep 0.2" }], {
                    onEvent: (event) => {
                        if (event.kind === "started") {
                            event.kill?.("SIGBOGUS");
                        }
                    },
                }),
            ).resolves.toMatchObject({ success: true });
            expect(byDefault.index).toBe(0);
        });

        it("runs a command in a terminal that can be written to and resized", async () => {
            expect.assertions(3);

            const { events, result } = await (async () => {
                const seen: ProcessEvent[] = [];
                const outcome = await runNativeConcurrent([{ command: "read line; stty size; echo got:$line; test -t 1 && echo tty", ptySize: { cols: 90, rows: 20 }, stdin: "pty" }], {
                    onEvent: (event) => {
                        seen.push(event);

                        if (event.kind === "started") {
                            event.resize?.(100, 30);
                            event.write?.("typed\n");
                        }
                    },
                });

                return { events: seen, result: outcome };
            })();
            const output = events
                .filter((event) => event.kind === "stdout")
                .map((event) => event.text)
                .join("");

            expect(result.success).toBe(true);
            expect(output).toContain("got:typed");
            expect(output).toMatch(/tty/);
        });
    });

    describe("a run that fails outside the commands", () => {
        it("rejects with the reason instead of waiting forever, after delivering what came before", async () => {
            expect.assertions(2);

            const events: ProcessEvent[] = [];
            const run: NativeConcurrentRun = {
                abort: () => undefined,
                done: async () => { return { closeEvents: [], success: true }; },
                kill: () => true,
                resize: () => true,
                write: () => true,
            };
            const startConcurrent: NativeBindings["startConcurrent"] = (_commands, _options, onBatch) => {
                setTimeout(() => {
                    onBatch?.({ events: [{ index: 0, kind: "started", pid: 1 }] });
                    onBatch?.({ error: "the concurrent run ended without a result: boom", events: [] });
                }, 0);

                return run;
            };

            vi.mocked(loadNativeBindings).mockReturnValueOnce({ startConcurrent } as NativeBindings);

            await expect(runNativeConcurrent([{ command: "true" }], { onEvent: (event) => events.push(event) })).rejects.toThrow("boom");
            expect(events.map((event) => event.kind)).toStrictEqual(["started"]);
        });
    });
});
