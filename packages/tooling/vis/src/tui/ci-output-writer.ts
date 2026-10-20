/**
 * The minimal stream surface {@link createCiOutputWriter} needs. `process.stdout`
 * and `process.stderr` satisfy it structurally, and tests build small fakes
 * without touching the real process streams.
 */
export interface CiOutputStream {
    /**
     * Tear the stream down. Only ever called on a stream that has already
     * stalled or errored — destroying it frees a wedged in-flight write so
     * the writer (and the run behind it) can keep moving.
     */
    destroy?: () => unknown;
    /** Remove a listener registered with {@link CiOutputStream.once}. */
    off: (event: "close" | "drain" | "error", listener: () => void) => unknown;
    /** Stream teardown notification. A closed stream is rerouted past, never crashed on. */
    on: ((event: "close", listener: () => void) => unknown) & ((event: "error", listener: (error: Error) => void) => unknown);
    /** One-shot wait helpers for `drain` / `error` / `close` while backpressured. */
    once: (event: "close" | "drain" | "error", listener: () => void) => unknown;
    /** Hand a chunk to the stream; `false` means the internal buffer is full (backpressure). */
    write: (chunk: string) => boolean;
}

/**
 * Which channel the writer currently hands output to.
 *
 * - `stdout` — the normal path.
 * - `stderr` — taken over after stdout stalled or errored. stderr is a
 *   separate pipe: when a CI runner wedges the stdout pipe, stderr usually
 *   still flows, so the run keeps a visible log.
 * - `dropped` — both pipes are unusable; output is discarded so the run can
 *   still finish (and exit) instead of buffering into a void.
 */
export type CiOutputChannel = "stdout" | "stderr" | "dropped";

export interface CiOutputWriterOptions {
    /**
     * Upper bound on a single `write()` call, in UTF-16 code units. Staying
     * under the common 64 KiB pipe buffer means a healthy reader accepts
     * every chunk synchronously, and a wedged reader can only ever swallow
     * one bounded chunk.
     */
    chunkCodeUnits: number;

    /** Clock injection for tests. Defaults to `Date.now`. */
    now: () => number;

    /**
     * How long a stalled stderr write waits (measured on the stderr channel)
     * before the writer drops output entirely. Only reachable when BOTH
     * pipes are wedged; keeps the run completable instead of infinitely
     * buffered.
     */
    stallDropMs: number;

    /**
     * How long a stalled stdout write waits before the writer gives up on
     * stdout, destroys it to free the wedged write, and reroutes the
     * remaining output to stderr. At most one chunk (≤
     * {@link CiOutputWriterOptions.chunkCodeUnits}) is lost.
     */
    stallRerouteMs: number;

    /**
     * How long a stalled stdout write waits before a warning lands on
     * stderr naming the pending output. The first sign of the failure mode
     * this writer exists for: a CI runner that stopped draining our stdout.
     */
    stallWarnMs: number;
}

const DEFAULT_CI_OUTPUT_WRITER_OPTIONS: CiOutputWriterOptions = {
    chunkCodeUnits: 32 * 1024,
    now: Date.now,
    stallDropMs: 30_000,
    stallRerouteMs: 30_000,
    stallWarnMs: 10_000,
};

/** One queued slice of output, with the label it arrived under (a task id). */
interface PendingChunk {
    label: string | undefined;
    text: string;
}

type FlushSignal = "abandoned" | "close" | "drain" | "error";

/**
 * Split `text` into slices of at most `limit` UTF-16 code units.
 *
 * - Splits on a line boundary inside the window when one exists, so a reader
 *   (and a log UI) always sees whole lines.
 * - Never splits a surrogate pair: a boundary landing between a high and a
 *   low surrogate is stepped back one unit, or the two halves would encode
 *   as replacement characters and corrupt CJK/emoji output.
 */
export const splitCiOutputChunks = (text: string, limit: number): string[] => {
    if (text.length <= limit) {
        return [text];
    }

    const chunks: string[] = [];

    let start = 0;

    while (start < text.length) {
        let end = Math.min(start + limit, text.length);

        if (end < text.length) {
            const lastNewline = text.lastIndexOf("\n", end - 1);

            if (lastNewline >= start) {
                end = lastNewline + 1;
            }

            // Step back off a surrogate pair: `end` must not sit between the
            // high surrogate at `end - 1` and the low surrogate at `end`. A
            // code point above the BMP range at `end - 1` means a complete
            // pair starts there and spans the boundary.
            if (end > start && (text.codePointAt(end - 1) ?? 0) > 0xff_ff) {
                end -= 1;
            }
        }

        chunks.push(text.slice(start, end));
        start = end;
    }

    return chunks;
};

export interface CiOutputWriter {
    /**
     * Resolves once the queue is empty — immediately when nothing is
     * pending, after the drain when backpressured, and right away once the
     * channel is `dropped` (both pipes unusable) so no caller can hang on it.
     */
    flush: () => Promise<void>;
    /** Diagnostic snapshot for tests and stall warnings. */
    status: () => { channel: CiOutputChannel; pendingChunks: number; pendingCodeUnits: number };
    /** Queue `text` for the active channel and (re)start the pump. Never blocks. */
    write: (text: string, label?: string) => void;
}

/**
 * Create a CI output writer over an explicit pair of streams.
 *
 * All CI-path output in `vis` flows through one writer per process so that
 * a single wedged pipe cannot freeze (or silently swallow) the entire run
 * log:
 *
 * - Writes are chunked to ≤ {@link CiOutputWriterOptions.chunkCodeUnits} and
 *   honor backpressure: after a `write()` returns `false` the pump waits for
 *   `drain` before committing the next chunk, so at most one chunk ever sits
 *   inside the stream's internal buffer. The old single-giant-write path
 *   could queue megabytes invisibly behind a stalled pipe and lose all of it
 *   on `process.exit`.
 * - The fast path stays synchronous: chunks keep being written while the
 *   stream accepts them, so a healthy reader sees identical behavior to the
 *   direct `process.stdout.write` calls this replaces.
 * - A watchdog escalates a stuck channel: warn on stderr, then reroute to
 *   stderr (destroying the wedged stdout to free its in-flight write), then
 *   — only when stderr is wedged too — drop output so the run can finish.
 *
 * Observed incident (anolilab CI, 2026-10-20): a CI runner stopped draining
 * `vis` stdout mid-dump of a completed task's ~256 KiB buffered output. The
 * single unbounded write wedged, every later line queued invisibly behind
 * it, the log froze mid-stack-trace, and the job burned an hour until it
 * was cancelled — with every test that ran green.
 */
export const createCiOutputWriter = (stdout: CiOutputStream, stderr: CiOutputStream, options: Partial<CiOutputWriterOptions> = {}): CiOutputWriter => {
    const config: CiOutputWriterOptions = { ...DEFAULT_CI_OUTPUT_WRITER_OPTIONS, ...options };
    const tickMs = Math.min(250, Math.max(10, Math.floor(config.stallWarnMs / 4)));

    const queue: PendingChunk[] = [];
    const flushWaiters: (() => void)[] = [];
    const errorListenersAttached = new Set<CiOutputStream>();

    let channel: CiOutputChannel = "stdout";
    let pumping = false;
    let waiting = false;
    let warned = false;
    let lastProgressAt = 0;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let abandonCurrentWait: (() => void) | undefined;

    const hasPendingWork = (): boolean => queue.length > 0 || waiting;

    /**
     * Stderr is the diagnostic channel — a wedged stdout must be reported
     * on the OTHER pipe, and writing the report must never throw even if
     * stderr itself is already gone.
     */
    const warnStderr = (message: string): void => {
        try {
            stderr.write(`${message}\n`);
        } catch {
            // stderr is gone too — nothing left to report on.
        }
    };

    const resolveFlushWaiters = (): void => {
        const waiters = flushWaiters.splice(0);

        for (const waiter of waiters) {
            waiter();
        }
    };

    const scheduleWatchdog = (): void => {
        if (channel === "dropped" || !hasPendingWork()) {
            if (watchdogTimer) {
                clearTimeout(watchdogTimer);
                watchdogTimer = undefined;
            }

            return;
        }

        if (!watchdogTimer) {
            watchdogTimer = setTimeout(tick, tickMs);
            watchdogTimer.unref?.();
        }
    };

    /** Escalation rung 2: stdout is wedged — free its write, move to stderr. */
    const rerouteFromStdout = (stalledForMs: number): void => {
        warned = true;

        warnStderr(
            `vis: stdout stalled for ${Math.round(stalledForMs / 1000)}s — dropping the wedged stdout write and rerouting the remaining output to stderr so the run can still finish; at most one ${config.chunkCodeUnits}-unit chunk of stdout output is lost.`,
        );

        // Destroying the stream frees the in-flight write that keeps the
        // stream (and anything joining it) wedged. Verified against
        // `process.stdout`: the pending write callback settles and the
        // stream stops holding the run's log hostage.
        try {
            stdout.destroy?.();
        } catch {
            // An already-broken stream must never throw back into the watchdog.
        }

        channel = "stderr";
        lastProgressAt = config.now();
        abandonCurrentWait?.();
    };

    /** Escalation rung 3: both pipes are wedged — drop output, let the run finish. */
    const dropFromStderr = (): void => {
        try {
            stderr.destroy?.();
        } catch {
            // An already-broken stream must never throw back into the watchdog.
        }

        channel = "dropped";
        queue.length = 0;
        lastProgressAt = config.now();
        abandonCurrentWait?.();
        resolveFlushWaiters();
        scheduleWatchdog();
    };

    /**
     * A stream errored (EPIPE and friends) or closed underneath us. The
     * run's log must survive a dead pipe: reroute past stdout, drop past
     * stderr. Never rethrow — an error listener that throws would take the
     * process down.
     */
    const handleStreamError = (stream: CiOutputStream, error?: Error): void => {
        if (stream === stdout && channel === "stdout") {
            warned = true;

            // `Error#code` exists on system errors (EPIPE, EDESTROYED …) but not
            // on the base type; fall back to the message, then to a generic tag.
            const code = (error as { code?: string } | undefined)?.code;

            warnStderr(`vis: stdout writes failed (${code ?? error?.message ?? "stream closed or errored"}) — rerouting the remaining output to stderr.`);

            channel = "stderr";
            lastProgressAt = config.now();
            abandonCurrentWait?.();

            return;
        }

        if (stream === stderr && channel === "stderr") {
            dropFromStderr();
        }
    };

    const attachErrorListeners = (): void => {
        if (!errorListenersAttached.has(stdout)) {
            stdout.on("error", (error: Error) => {
                handleStreamError(stdout, error);
            });
            stdout.on("close", () => {
                handleStreamError(stdout);
            });
            errorListenersAttached.add(stdout);
        }

        if (!errorListenersAttached.has(stderr)) {
            stderr.on("error", (error: Error) => {
                handleStreamError(stderr, error);
            });
            stderr.on("close", () => {
                handleStreamError(stderr);
            });
            errorListenersAttached.add(stderr);
        }
    };

    /**
     * Wait for the backpressured stream to make room (`drain`), die
     * (`error` / `close`), or be switched away from by the watchdog
     * (`abandoned`). Exactly one wait can be pending: the pump is single.
     */
    const waitForProgress = (stream: CiOutputStream): Promise<FlushSignal> =>
        new Promise<FlushSignal>((resolve) => {
            const settle = (signal: FlushSignal): void => {
                stream.off("drain", onDrain);
                stream.off("error", onError);
                stream.off("close", onClose);

                if (abandonCurrentWait === abandon) {
                    abandonCurrentWait = undefined;
                }

                waiting = false;
                resolve(signal);
            };

            const onDrain = (): void => {
                settle("drain");
            };
            const onError = (): void => {
                settle("error");
            };
            const onClose = (): void => {
                settle("close");
            };
            const abandon = (): void => {
                settle("abandoned");
            };

            waiting = true;
            abandonCurrentWait = abandon;

            stream.once("drain", onDrain);
            stream.once("error", onError);
            stream.once("close", onClose);
        });

    /**
     * Commit queued chunks to the active stream. Runs synchronously while
     * writes are accepted (identical behavior to direct `process.stdout.write`
     * calls on a healthy reader) and only awaits once a write is
     * backpressured — then at most one chunk is inside the stream's buffer.
     */
    const pump = async (): Promise<void> => {
        if (pumping) {
            return;
        }

        pumping = true;

        try {
            while (channel !== "dropped" && queue.length > 0) {
                const stream = channel === "stderr" ? stderr : stdout;
                const chunk = queue[0]!;

                // Commit the chunk before checking acceptance: `write()`
                // returning `false` still hands the chunk over — it already
                // sits in the stream's buffer and must never be re-sent.
                const accepted = stream.write(chunk.text);

                queue.shift();

                if (accepted) {
                    lastProgressAt = config.now();
                    warned = false;

                    continue;
                }

                const signal = await waitForProgress(stream);

                if (signal === "drain") {
                    lastProgressAt = config.now();
                    warned = false;
                }

                // "error" / "close": the error/close listeners attached in
                // `attachErrorListeners` own the channel transition — the
                // loop just re-reads `channel` and continues.
                // "abandoned": the watchdog switched channels the same way.
            }
        } catch (error) {
            // A `write()` that throws synchronously (a broken stream) is the
            // same failure as an `error` event: reroute or drop, never let
            // the fire-and-forget pump become an unhandled rejection.
            handleStreamError(channel === "stderr" ? stderr : stdout, error instanceof Error ? error : undefined);
        } finally {
            pumping = false;
            scheduleWatchdog();
            resolveFlushWaiters();
        }
    };

    const tick = (): void => {
        watchdogTimer = undefined;

        if (channel === "dropped" || !hasPendingWork()) {
            resolveFlushWaiters();

            return;
        }

        const stalledForMs = config.now() - lastProgressAt;

        if (channel === "stdout") {
            if (stalledForMs >= config.stallRerouteMs) {
                rerouteFromStdout(stalledForMs);
            } else if (stalledForMs >= config.stallWarnMs && !warned) {
                warned = true;

                const { pendingChunks, pendingCodeUnits } = writerStatus();
                const label = queue.at(0)?.label;

                warnStderr(
                    `vis: stdout writes stalled for ${Math.round(stalledForMs / 1000)}s (${pendingChunks} chunk(s), ~${Math.round(pendingCodeUnits / 1024)} KB pending${label ? ` for "${label}"` : ""}); waiting for the log reader to drain.`,
                );
            }
        } else if (stalledForMs >= config.stallDropMs) {
            dropFromStderr();
        }

        scheduleWatchdog();

        // `queue.length` alone is the guard: the drop path clears the queue,
        // and the reroute path leaves it (the pump then continues on stderr).
        if (queue.length > 0) {
            // eslint-disable-next-line no-void -- void marks the pump promise as intentionally fire-and-forget
            void pump();
        }
    };

    const writerStatus = (): { channel: CiOutputChannel; pendingChunks: number; pendingCodeUnits: number } => {
        return {
            channel,
            pendingChunks: queue.length,
            pendingCodeUnits: queue.reduce((total, chunk) => total + chunk.text.length, 0),
        };
    };

    const write = (text: string, label?: string): void => {
        if (channel === "dropped" || text.length === 0) {
            return;
        }

        // A fresh busy episode resets the stall clock so the reader gets a
        // full window; continuous new work must NOT reset it, or a chatty
        // wedged pipe would never cross the escalation threshold.
        if (!hasPendingWork()) {
            lastProgressAt = config.now();
        }

        for (const textChunk of splitCiOutputChunks(text, config.chunkCodeUnits)) {
            queue.push({ label, text: textChunk });
        }

        attachErrorListeners();

        // eslint-disable-next-line no-void -- void marks the pump promise as intentionally fire-and-forget
        void pump();
        scheduleWatchdog();
    };

    const flush = (): Promise<void> =>
        new Promise<void>((resolve) => {
            if (channel === "dropped" || !hasPendingWork()) {
                resolve();

                return;
            }

            flushWaiters.push(resolve);
            scheduleWatchdog();
        });

    return {
        flush,
        status: writerStatus,
        write,
    };
};

let defaultCiOutputWriter: CiOutputWriter | undefined;

/**
 * The process-wide writer over the real `process.stdout` / `process.stderr`.
 * Lazily created so tests that spy on `process.stdout.write` (the existing
 * tui suites) install their spy before any chunk is committed.
 */
const getDefaultCiOutputWriter = (): CiOutputWriter => {
    defaultCiOutputWriter ??= createCiOutputWriter(process.stdout, process.stderr);

    return defaultCiOutputWriter;
};

/**
 * Queue a line of CI-path output on the process writer. Drop-in for a direct
 * `process.stdout.write` call: synchronous on a healthy reader, never
 * blocking when the pipe stalls, and rerouted to stderr when it wedges.
 *
 * `label` names the logical unit the text belongs to (a task id, the run
 * summary) so a stall warning can say WHAT is stuck, not just how much.
 */
export const writeCiOutput = (text: string, label?: string): void => {
    getDefaultCiOutputWriter().write(text, label);
};

/**
 * Await the process writer's queue. Exported for tests and for any exit path
 * that wants to confirm the log landed before finishing.
 */
export const flushCiOutput = (): Promise<void> => getDefaultCiOutputWriter().flush();
