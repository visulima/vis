import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CiOutputStream } from "../../src/tui/ci-output-writer";
import { createCiOutputWriter, flushCiOutput, splitCiOutputChunks, writeCiOutput } from "../../src/tui/ci-output-writer";

/**
 * Poll `condition` until it holds. Polls instead of `vi.waitFor` so every
 * `expect` in a test runs exactly once and `expect.assertions` counts stay
 * exact.
 */
const waitForCondition = async (condition: () => boolean, timeoutMs = 2000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("waitForCondition: condition not met within the timeout");
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
    }
};

/** The events the fake stream's listener registry supports. */
type FakeStreamEvent = "close" | "drain" | "error";
type FakeStreamEventCloseOrError = "close" | "error";

/**
 * A controllable stand-in for `process.stdout` / `process.stderr`.
 * `accepting` toggles backpressure: `write()` records every chunk either
 * way and returns `false` while the pipe is "full", just like a real
 * stream whose internal buffer is over the high-water mark.
 */
const createFakeStream = () => {
    const closeListeners = new Set<(error?: Error) => void>();
    const drainListeners = new Set<(error?: Error) => void>();
    const errorListeners = new Set<(error?: Error) => void>();

    const state = {
        accepting: true,
        destroyCount: 0,
        destroyed: false,
        writes: [] as string[],
    };

    const emit = (event: FakeStreamEvent, error?: Error): void => {
        const listeners = event === "close" ? closeListeners : event === "drain" ? drainListeners : errorListeners;

        for (const listener of listeners) {
            listener(error);
        }
    };

    const stream = {
        destroy: (): void => {
            state.destroyed = true;
            state.destroyCount += 1;
        },
        off(event: FakeStreamEvent, listener: (error?: Error) => void): unknown {
            if (event === "close") {
                closeListeners.delete(listener);
            } else if (event === "drain") {
                drainListeners.delete(listener);
            } else {
                errorListeners.delete(listener);
            }

            return stream;
        },
        on(event: FakeStreamEventCloseOrError, listener: (error?: Error) => void): unknown {
            if (event === "close") {
                closeListeners.add(listener);
            } else {
                errorListeners.add(listener);
            }

            return stream;
        },
        once(event: FakeStreamEvent, listener: (error?: Error) => void): unknown {
            if (event === "close") {
                closeListeners.add(listener);
            } else if (event === "drain") {
                drainListeners.add(listener);
            } else {
                errorListeners.add(listener);
            }

            return stream;
        },
        write(chunk: string): boolean {
            state.writes.push(chunk);

            return state.accepting && !state.destroyed;
        },
    };

    return {
        close: (): void => {
            emit("close");
        },
        get destroyCount(): number {
            return state.destroyCount;
        },
        drain: (): void => {
            emit("drain");
        },
        error: (code: string): void => {
            const error = new Error(`write ${code}`) as Error & { code: string };

            error.code = code;
            emit("error", error);
        },
        setAccepting: (accepting: boolean): void => {
            state.accepting = accepting;
        },
        stream: stream as CiOutputStream,
        get writes(): string[] {
            return state.writes;
        },
    };
};

/** Thresholds small enough for real timers, still ordered: warn < reroute < drop. */
const fastThresholds = { chunkCodeUnits: 64, stallDropMs: 150, stallRerouteMs: 100, stallWarnMs: 50 };

describe(splitCiOutputChunks, () => {
    it("returns small text as a single chunk", () => {
        expect.assertions(1);

        expect(splitCiOutputChunks("hello", 64)).toStrictEqual(["hello"]);
    });

    it("caps every chunk at the limit and rejoins losslessly", () => {
        expect.assertions(2);

        const text = "a".repeat(200);

        const chunks = splitCiOutputChunks(text, 64);

        expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true);
        expect(chunks.join("")).toBe(text);
    });

    it("prefers a line boundary inside the window", () => {
        expect.assertions(2);

        const text = `${"a".repeat(40)}\n${"b".repeat(40)}`;

        const chunks = splitCiOutputChunks(text, 50);

        expect(chunks).toStrictEqual([`${"a".repeat(40)}\n`, "b".repeat(40)]);
        expect(chunks.every((chunk) => chunk.length <= 50)).toBe(true);
    });

    it("never splits a surrogate pair at a chunk boundary", () => {
        expect.assertions(2);

        // A 4-byte emoji (two UTF-16 code units) straddling the 64-unit window.
        const text = `${"a".repeat(63)}😀${"b".repeat(10)}`;

        const chunks = splitCiOutputChunks(text, 64);

        // No chunk may end on an unpaired high surrogate — that would encode
        // the pair's halves as replacement characters and corrupt the output.
        // A trailing lone surrogate reads as its own code point (< 0x10000).
        const endsOnHighSurrogate = chunks.some((chunk) => {
            const last = chunk.codePointAt(chunk.length - 1) ?? 0;

            return last >= 0xd8_00 && last <= 0xdb_ff;
        });

        expect(endsOnHighSurrogate).toBe(false);
        expect(chunks.join("")).toBe(text);
    });
});

describe(createCiOutputWriter, () => {
    it("writes through to a healthy stream synchronously, in order", () => {
        expect.assertions(4);

        const stdout = createFakeStream();
        const stderr = createFakeStream();
        const writer = createCiOutputWriter(stdout.stream, stderr.stream, fastThresholds);

        writer.write("first\n", "a");
        writer.write("second\n", "b");

        // Fast path: no await needed — the writes already landed.
        expect(stdout.writes.join("")).toBe("first\nsecond\n");
        expect(writer.status()).toStrictEqual({ channel: "stdout", pendingChunks: 0, pendingCodeUnits: 0 });
        expect(stderr.writes).toStrictEqual([]);
        expect(stdout.destroyCount).toBe(0);
    });

    it("waits for drain before committing the next chunk and keeps order", async () => {
        expect.assertions(3);

        const stdout = createFakeStream();
        const stderr = createFakeStream();
        const writer = createCiOutputWriter(stdout.stream, stderr.stream, fastThresholds);

        stdout.setAccepting(false);

        writer.write(`${"a".repeat(62)}\n${"b".repeat(62)}\n`, "task");

        // Chunk one is committed to the wedged stream; chunk two must wait.
        expect(stdout.writes).toHaveLength(1);

        const flushed = writer.flush();

        stdout.setAccepting(true);
        stdout.drain();

        await flushed;

        expect(stdout.writes.join("")).toBe(`${"a".repeat(62)}\n${"b".repeat(62)}\n`);
        expect(writer.status().channel).toBe("stdout");
    });

    it("reroutes to stderr when stdout stalls, losing at most one chunk — the observed CI hang", async () => {
        expect.assertions(6);

        const stdout = createFakeStream();
        const stderr = createFakeStream();
        const writer = createCiOutputWriter(stdout.stream, stderr.stream, fastThresholds);

        // The runner stopped draining our stdout: every write is backpressured.
        stdout.setAccepting(false);

        const dump = "line\n".repeat(40);

        writer.write(dump, "runtime:test:coverage");
        writer.write("✓ runtime:test:coverage (1 m 22 s)\n", "runtime:test:coverage");

        // Exactly one bounded chunk was handed to the wedged stdout.
        expect(stdout.writes).toHaveLength(1);
        expect(stdout.writes[0]?.length).toBeLessThanOrEqual(fastThresholds.chunkCodeUnits);

        // The reroute lands on the still-flowing stderr pipe.
        await waitForCondition(() => writer.status().channel === "stderr");

        const stderrText = stderr.writes.join("");

        // The stall was reported, naming what is stuck…
        expect(stderrText).toContain("stalled");
        expect(stderrText).toContain("runtime:test:coverage");
        // …and the remaining output survived, in order, ending with the status line.
        expect(stderrText.indexOf("rerouting")).toBeGreaterThan(-1);
        expect(stderrText.endsWith("✓ runtime:test:coverage (1 m 22 s)\n")).toBe(true);

        await writer.flush();
    });

    it("drops output entirely when both pipes stall, so the run can still finish", async () => {
        expect.assertions(4);

        const stdout = createFakeStream();
        const stderr = createFakeStream();
        const writer = createCiOutputWriter(stdout.stream, stderr.stream, fastThresholds);

        stdout.setAccepting(false);
        stderr.setAccepting(false);

        // Multi-chunk so the reroute leaves queued output poking stderr —
        // the stderr stall clock (and the drop rung) only runs with pending work.
        writer.write("line\n".repeat(40), "task");

        await waitForCondition(() => writer.status().channel === "dropped");

        // flush() must resolve on the dropped channel — no caller can hang on it.
        await writer.flush();

        writer.write("late output", "task");

        expect(writer.status()).toStrictEqual({ channel: "dropped", pendingChunks: 0, pendingCodeUnits: 0 });
        expect(stdout.destroyCount).toBe(1);
        expect(stderr.destroyCount).toBe(1);
        expect(stderr.writes.length).toBeGreaterThan(0);
    });

    it("reroutes immediately when stdout errors, without waiting for the stall window", async () => {
        expect.assertions(4);

        const stdout = createFakeStream();
        const stderr = createFakeStream();
        const writer = createCiOutputWriter(stdout.stream, stderr.stream, { ...fastThresholds, stallRerouteMs: 60_000, stallWarnMs: 60_000 });

        writer.write("before the error\n", "task");
        stdout.error("EPIPE");
        writer.write("after the error\n", "task");

        expect(writer.status().channel).toBe("stderr");
        expect(stderr.writes.join("")).toContain("EPIPE");
        expect(stderr.writes.join("")).toContain("after the error");
        expect(stdout.writes.join("")).toContain("before the error");

        await writer.flush();
    });

    it("does not escalate while the reader keeps making progress", async () => {
        expect.assertions(3);

        const stdout = createFakeStream();
        const stderr = createFakeStream();
        const writer = createCiOutputWriter(stdout.stream, stderr.stream, fastThresholds);

        // A slow-but-alive reader: every write is backpressured, but drain
        // arrives well inside the stall window. Recursive (not a loop) so
        // no `await` sits inside a loop body.
        const drainSoon = async (remaining: number): Promise<void> => {
            if (remaining === 0) {
                return;
            }

            await new Promise((resolve) => {
                setTimeout(resolve, 10);
            });

            stdout.drain();

            await drainSoon(remaining - 1);
        };

        // Backpressure from the first chunk on.
        stdout.setAccepting(false);

        writer.write("chunk\n".repeat(20), "task");

        const flushed = writer.flush();

        await drainSoon(4);

        stdout.setAccepting(true);
        stdout.drain();

        await flushed;

        // Slow, but everything landed on stdout and no escalation fired.
        expect(writer.status().channel).toBe("stdout");
        expect(stderr.writes).toStrictEqual([]);
        expect(stdout.writes.join("")).toContain("chunk");
    });
});

describe(writeCiOutput, () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });

    afterEach(() => {
        writeSpy.mockRestore();
    });

    it("routes through the process writer synchronously", async () => {
        expect.assertions(2);

        writeCiOutput("hello from the default writer\n", "default");

        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).toHaveBeenCalledWith("hello from the default writer\n");

        await flushCiOutput();
    });
});
