/**
 * Parity suite: the same scenarios against both concurrent runners.
 *
 * `runConcurrentFallback` (the JS spawner) and `runNativeConcurrent` (the native addon) are
 * called directly, with identical commands and options, so the suite says nothing about which one
 * `runConcurrently` picks. For each scenario the two runs are reduced to what a caller can observe
 * and compared:
 *
 * - the result: `success` and the close events sorted by `index`, each as
 *   (`index`, `exitCode`, `killed`, `name`, `command`); `pid` and `durationMs` are dropped;
 * - the event stream per command index: it starts with `started`, ends with exactly one `close`,
 *   and carries the same `stdout` lines, the same `stderr` lines and the same `error` events.
 *   Order across commands, and between a command's two streams, is not stable on either runner
 *   and is not compared. A pty command's merged output arrives as raw chunks, so it is compared
 *   as one string with CRLF turned into LF.
 *
 * ## Accepted differences
 *
 * Where the runners differ on purpose, the second block of the file asserts BOTH values, so a
 * change on either side fails loudly. Each row is a behaviour the native runner has deliberately
 * changed (a fix, or something the JS spawner never did); the JS value is the one being retired.
 *
 * | # | Scenario | JS spawner | Native runner |
 * | - | -------- | ---------- | ------------- |
 * | 1 | the command cannot be spawned (missing cwd or shell) | `started` without a pid, `error`, close code -2 | `error`, close code 1, no `started` |
 * | 2 | a UTF-8 character split across two reads | one U+FFFD per stray byte (each chunk decoded alone) | the character, once |
 * | 3 | `killTimeout` | never read: a command that ignores the kill signal runs on | SIGKILL after the timeout (137) |
 * | 4 | `killOthers` fires with commands still queued | the run never resolves | resolves; the queued commands have no close event |
 * | 5 | `successCondition: "command-MyApp"` for a command named `MyApp` | lowercases the condition, never matches | matches |
 * | 6 | an unknown `successCondition`, `killSignal` or `killOthers` value | silently the default | rejects, naming the value |
 * | 7 | a pty command killed by a signal | exit code 0, `killed` true (node-pty's `exitCode`) | `128 + signal`, `killed` true |
 * | 8 | a pty command that cannot start (missing cwd) | `started`, then close code 1, no `error` | `error`, close code 1, no `started` |
 * | 9 | a pty size with a zero dimension | accepted | rejects, naming the size |
 * | 10 | a run aborted by SIGINT | the `close` event keeps the raw exit code (143); only the result says 0 | the `close` event says 0, like the result |
 *
 * ## Needs the owner's classification
 *
 * | # | Scenario | JS spawner | Native runner |
 * | - | -------- | ---------- | ------------- |
 * | A | a pty command with `inheritEnv: false` | no `SHELL` | `SHELL` is set: `portable-pty` adds it to every command and gives no way to remove it |
 *
 * ## Same on both (asserted equal in the scenarios, not differences)
 *
 * `killed` is true for a command ended by `killOthers`, an abort or its own `kill`; the result of
 * a SIGINT abort is exit code 0 and `success` (the event is row 10); a signalled shell reports `128 + signal`; neither runner listens for SIGHUP; both remove the listeners they
 * add for SIGINT, SIGTERM and exit when the run settles.
 *
 * ## Not covered here
 *
 * Windows is unverified locally. The scenarios that need a POSIX shell, a pty or signals are
 * skipped there; the rest run through the probe script and `cmd.exe`.
 * A real SIGINT to a CLI process (rather than invoking the run's own listener) is step 3's Ctrl+C test.
 */

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runConcurrentFallback } from "../../src/concurrent-fallback";
import { runNativeConcurrent } from "../../src/concurrent-native";
import type { ConcurrentCommandConfig, ConcurrentRunnerOptions, ConcurrentRunResult, ProcessEvent } from "../../src/types";

type RunnerName = "js" | "native";

const runners: Record<RunnerName, typeof runConcurrentFallback> = { js: runConcurrentFallback, native: runNativeConcurrent };

const posix = process.platform !== "win32";
const probe = fileURLToPath(new URL("fixtures/probe.cjs", import.meta.url));
const scratch = realpathSync(tmpdir());

// ── building commands ────────────────────────────────────────────────────

const quote = (value: string): string => (posix ? `'${value.replaceAll("'", String.raw`'\''`)}'` : `"${value}"`);

/** A shell command line that runs the probe script in `mode`. */
const probeCommand = (...arguments_: string[]): string => [process.execPath, probe, ...arguments_].map((value) => quote(value)).join(" ");

/** The same, for direct execution (no shell): it only works when no path has whitespace. */
const directCommand = (...arguments_: string[]): string => [process.execPath, probe, ...arguments_].join(" ");

const directExecSafe = ![process.execPath, probe].some((path) => /\s/.test(path));

const base64 = (value: string | Uint8Array): string => Buffer.from(value).toString("base64");

/** Variables a child needs on Windows even when it inherits nothing. */
const systemEnv = (): Record<string, string> =>
    posix ? {} : Object.fromEntries(["COMSPEC", "PATH", "PATHEXT", "SystemRoot"].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));

// ── observing a run ─────────────────────────────────────────────────────

interface Observation {
    elapsedMs: number;
    events: ProcessEvent[];
    result: ConcurrentRunResult;
}

type React = (event: ProcessEvent, started: Map<number, ProcessEvent>) => void;

/** Process listeners a run adds and does not remove are collected so a test can clean up after a run that never ends. */
const listenerNames = ["SIGINT", "SIGTERM", "exit"] as const;

type Listener = () => void;

const listenerSnapshot = (): Map<string, Listener[]> => new Map(listenerNames.map((name) => [name, process.listeners(name) as Listener[]]));

const observe = async (runner: RunnerName, commands: ConcurrentCommandConfig[], options: ConcurrentRunnerOptions = {}, react?: React): Promise<Observation> => {
    const events: ProcessEvent[] = [];
    const started = new Map<number, ProcessEvent>();
    const startedAt = Date.now();
    const result = await runners[runner](commands, {
        ...options,
        onEvent: (event) => {
            events.push(event);

            if (event.kind === "started") {
                started.set(event.index, event);
            }

            react?.(event, started);
        },
    });

    return { elapsedMs: Date.now() - startedAt, events, result };
};

interface CommandSummary {
    closed: { commandName?: string; exitCode?: number; killed?: boolean } | undefined;
    errors: string[];
    /** "ok", or what is wrong with the order of the command's events. */
    framing: string;
    stderr: string[];
    stdout: string[];
}

interface Summary {
    commands: Record<number, CommandSummary>;
    result: { closeEvents: { command: string; exitCode: number; index: number; killed: boolean; name?: string }[]; success: boolean };
}

const framingOf = (events: ProcessEvent[]): string => {
    if (events.length === 0) {
        return "no events";
    }

    const closes = events.filter((event) => event.kind === "close").length;

    if (events.at(-1)?.kind !== "close" || closes !== 1) {
        return `ends with ${events.at(-1)?.kind}, ${closes} close events`;
    }

    // A command that could not be spawned has no `started` on the native runner (accepted difference 1).
    return events[0]?.kind === "started" ? "ok" : `begins with ${events[0]?.kind}`;
};

const summarize = ({ events, result }: Observation, { merged = false }: { merged?: boolean } = {}): Summary => {
    const commands: Record<number, CommandSummary> = {};

    for (const index of new Set(events.map((event) => event.index))) {
        const own = events.filter((event) => event.index === index);
        const lines = (kind: "stderr" | "stdout"): string[] => own.filter((event) => event.kind === kind).map((event) => event.text ?? "");
        const close = own.find((event) => event.kind === "close");

        commands[index] = {
            closed: close && { commandName: close.commandName, exitCode: close.exitCode, killed: close.killed },
            errors: own.filter((event) => event.kind === "error").map((event) => event.message ?? ""),
            framing: framingOf(own),
            stderr: lines("stderr"),
            // A terminal's output is raw chunks, in whatever pieces the platform read them.
            stdout: merged ? [lines("stdout").join("").replaceAll("\r\n", "\n")] : lines("stdout"),
        };
    }

    return {
        commands,
        result: {
            closeEvents: [...result.closeEvents]
                .sort((a, b) => a.index - b.index)
                .map(({ command, exitCode, index, killed, name }) => { return { command, exitCode, index, killed, name }; }),
            success: result.success,
        },
    };
};

// ── scenarios that must be identical ────────────────────────────────────

interface Scenario {
    /** Extra check on one run, for what a plain comparison cannot see. */
    check?: (observation: Observation, runner: RunnerName) => void;
    commands: () => ConcurrentCommandConfig[];
    /** The commands' output is a terminal's: compare it as one string. */
    merged?: boolean;
    name: string;
    options?: ConcurrentRunnerOptions;
    /** Needs a POSIX shell, signals or a pty. */
    posixOnly?: boolean;
    /** Builds the reaction anew for each runner, so state in it cannot leak from one run to the next. */
    react?: () => React;
}

const callKill = (afterText: string, signal?: string) => (): React => {
    let done = false;

    return (event, started) => {
        if (!done && event.kind === "stdout" && event.text?.includes(afterText)) {
            done = true;
            started.get(event.index)?.kill?.(signal);
        }
    };
};

/** Run the run's own SIGINT or SIGTERM listener, the last one added, as the signal would. */
const callSignalListener = (afterText: string, signal: "SIGINT" | "SIGTERM") => (): React => {
    let done = false;

    return (event) => {
        if (!done && event.kind === "stdout" && event.text?.includes(afterText)) {
            done = true;
            (process.listeners(signal).at(-1) as () => void)();
        }
    };
};

const scenarios: Scenario[] = [
    { commands: () => [{ command: probeCommand("exit", "0") }], name: "exit code 0" },
    { commands: () => [{ command: probeCommand("exit", "3") }], name: "a non-zero exit code" },
    { commands: () => [{ command: probeCommand("both") }], name: "stdout and stderr lines of one command" },
    { commands: () => [{ command: probeCommand("exit", "0") }], name: "empty output" },
    { commands: () => [{ command: probeCommand("chunks", "out", base64("one\r\ntwo\r\n")) }], name: "CRLF output" },
    { commands: () => [{ command: probeCommand("partial") }], name: "a partial line flushed after the idle time" },
    { commands: () => [{ command: probeCommand("chunks", "err", base64("no newline at the end")) }], name: "a last line without a newline on stderr" },
    { commands: () => [{ command: probeCommand("big-line", "200000") }], name: "a 200 KB single line" },
    { commands: () => [{ command: probeCommand("cwd"), cwd: scratch }], name: "the working directory" },
    {
        commands: () => [{ command: probeCommand("env", "PARITY_OVERLAY", "PARITY_UNSET"), env: { PARITY_OVERLAY: "from-overlay" } }],
        name: "the env overlay",
    },
    {
        commands: () => [
            { command: probeCommand("exit", "1"), name: "alpha" },
            { command: probeCommand("exit", "0"), name: "beta" },
            { command: probeCommand("exit-after", "60", "2"), name: "gamma" },
        ],
        name: "several commands, unlimited",
    },
    ...[1, 2].map((maxProcesses) => {
        return {
            check: ({ result }: Observation) => {
            // Completion order is stable only when the commands run one at a time.
                if (maxProcesses === 1) {
                    expect(result.closeEvents.map((event) => event.index)).toStrictEqual([0, 1, 2, 3]);
                }
            },
            commands: () => [0, 1, 2, 3].map((index) => { return { command: probeCommand("exit-after", String(20 * (4 - index)), String(index % 2)), name: `c${index}` }; }),
            name: `four commands, maxProcesses ${maxProcesses}`,
            options: { maxProcesses },
        };
    }),
    ...["all", "first", "last", "command-build", "command-1", "command-test", "!command-build", "!command-lint", "!command-2"].map((successCondition) => {
        return {
            commands: () => [
                { command: probeCommand("exit-after", "10", "0"), name: "build" },
                { command: probeCommand("exit-after", "120", "1"), name: "lint" },
                { command: probeCommand("exit-after", "240", "0"), name: "test" },
            ],
            name: `successCondition ${successCondition}`,
            options: { successCondition },
        };
    }),
    ...(["failure", "success"] as const).map((killOthers) => {
        return {
            check: ({ result }: Observation) => {
                expect(result.closeEvents.find((event) => event.index === 1)?.killed).toBe(true);
            },
            commands: () => [{ command: probeCommand("exit-after", "150", killOthers === "failure" ? "1" : "0") }, { command: probeCommand("hang") }],
            name: `killOthers ${killOthers}`,
            options: { killOthers: [killOthers] },
            posixOnly: true,
        };
    }),
    {
        commands: () => [{ command: probeCommand("read-line"), stdin: "pipe" }],
        name: "piped stdin: a write after started, and a child that reads it",
        react: () => (event) => {
            if (event.kind === "started") {
                event.write?.("hello\n");
            }
        },
    },
    {
        commands: () => [{ command: probeCommand("hang") }],
        name: "kill through the started event",
        posixOnly: true,
        react: callKill("hanging", "SIGTERM"),
    },
    {
        commands: () => [{ command: probeCommand("hang") }],
        name: "SIGTERM: a termination that keeps the exit code",
        posixOnly: true,
        react: callSignalListener("hanging", "SIGTERM"),
    },
    { commands: () => [{ command: "kill -TERM $$" }], name: "a child killed by SIGTERM reports 128 + 15", posixOnly: true },
    { commands: () => [{ command: "kill -KILL $$" }], name: "a child killed by SIGKILL reports 128 + 9", posixOnly: true },
    {
        // `sleep 4 &` keeps the inherited pipes open after the shell has exited.
        check: ({ elapsedMs }) => {
            expect(elapsedMs).toBeLessThan(3800);
        },
        commands: () => [{ command: "sleep 4 &" }],
        name: "a descendant holding the pipes does not hold the run",
        posixOnly: true,
    },
    ...(directExecSafe ? [{ commands: () => [{ command: directCommand("out", "direct"), shell: false }], name: "shell: false" }] : []),
    ...(posix && existsSync("/bin/bash")
        ? [{ commands: () => [{ command: "echo $0" }], name: "a custom shellPath", options: { shellPath: "/bin/bash" } }]
        : []),
    {
        commands: () => [{ command: probeCommand("tty"), stdin: "pty" }],
        merged: true,
        name: "pty: the child sees a terminal",
        posixOnly: true,
    },
    {
        commands: () => [{ command: probeCommand("read-line"), stdin: "pty" }],
        merged: true,
        name: "pty: a write after started",
        posixOnly: true,
        react: () => (event) => {
            if (event.kind === "started") {
                event.write?.("hello\n");
            }
        },
    },
    {
        commands: () => [{ command: probeCommand("resize"), ptySize: { cols: 80, rows: 24 }, stdin: "pty" }],
        merged: true,
        name: "pty: resize reaches the child",
        posixOnly: true,
        react: () => {
            let done = false;

            return (event, started) => {
                if (!done && event.kind === "stdout" && event.text?.includes("size:80x24")) {
                    done = true;
                    started.get(event.index)?.resize?.(100, 30);
                }
            };
        },
    },
    {
        commands: () => [{ command: "echo one && echo two", shell: false, stdin: "pty" }],
        merged: true,
        name: "pty: always through the shell, whatever `shell` says",
        posixOnly: true,
    },
    {
        // The pty command fails and takes the pipe command down with it. (A pty command that is
        // itself killed reports exit code 0 in the JS spawner: accepted difference 7.)
        commands: () => [{ command: probeCommand("exit-after", "20", "1"), stdin: "pty" }, { command: probeCommand("hang") }],
        merged: true,
        name: "pty and pipe commands under one killOthers",
        options: { killOthers: ["failure"] },
        posixOnly: true,
    },
];

const sideEffectsOf = (before: Map<string, Listener[]>): void => {
    for (const name of listenerNames) {
        expect(process.listeners(name)).toStrictEqual(before.get(name));
    }
};

describe("both runners, the same scenarios", () => {
    // A loop, not `it.each`: each scenario decides for itself whether the platform can run it.
    // eslint-disable-next-line vitest/prefer-each
    for (const scenario of scenarios) {
        it.skipIf(scenario.posixOnly && !posix)(
            scenario.name,
            async () => {
                expect.hasAssertions();

                const summaries: Partial<Record<RunnerName, Summary>> = {};

                for (const runner of ["js", "native"] as const) {
                    const before = listenerSnapshot();

                    // eslint-disable-next-line no-await-in-loop
                    const observation = await observe(runner, scenario.commands(), scenario.options, scenario.react?.());

                    summaries[runner] = summarize(observation, { merged: scenario.merged });
                    scenario.check?.(observation, runner);

                    // Every command's events are framed the same way, and the run left no listener behind.
                    for (const command of Object.values(summaries[runner].commands)) {
                        expect(command.framing, `${runner}: ${scenario.name}`).toBe("ok");
                    }

                    sideEffectsOf(before);
                }

                expect(summaries.native).toStrictEqual(summaries.js);
            },
            30_000,
        );
    }
});

// ── FORCE_COLOR and NO_COLOR ────────────────────────────────────────────

describe("the colour policy, with a mocked terminal", () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const saved: Record<string, string | undefined> = {};

    afterEach(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) {
                Reflect.deleteProperty(process.env, name);
            } else {
                process.env[name] = value;
            }
        }

        if (stdoutDescriptor) {
            Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        } else {
            delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
    });

    const setEnv = (name: string, value: string | undefined): void => {
        if (!(name in saved)) {
            saved[name] = process.env[name];
        }

        if (value === undefined) {
            Reflect.deleteProperty(process.env, name);
        } else {
            process.env[name] = value;
        }
    };

    const matrix = [true, false].flatMap((tty) =>
        [undefined, "1"].flatMap((noColor) =>
            [undefined, "2"].flatMap((parentForce) =>
                [undefined, "0"].flatMap((taskForce) => [true, false].map((inheritEnv) => { return { inheritEnv, noColor, parentForce, taskForce, tty }; })),
            ),
        ),
    );

    it.each(matrix)("tty $tty, NO_COLOR $noColor, parent FORCE_COLOR $parentForce, task FORCE_COLOR $taskForce, inheritEnv $inheritEnv", async (parameters) => {
        expect.assertions(1);

        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: parameters.tty });
        setEnv("NO_COLOR", parameters.noColor);
        setEnv("FORCE_COLOR", parameters.parentForce);

        const commands = (): ConcurrentCommandConfig[] => [
            {
                command: probeCommand("env", "FORCE_COLOR", "NO_COLOR"),
                env: { ...systemEnv(), ...(parameters.taskForce === undefined ? {} : { FORCE_COLOR: parameters.taskForce }) },
                inheritEnv: parameters.inheritEnv,
            },
        ];
        const seen = async (runner: RunnerName): Promise<string[]> => summarize(await observe(runner, commands())).commands[0]!.stdout;

        await expect(seen("native")).resolves.toStrictEqual(await seen("js"));
    });

    it.skipIf(!posix).each([
        { noColor: undefined, tty: true },
        { noColor: "1", tty: true },
        { noColor: undefined, tty: false },
    ])("a pty command: tty $tty, NO_COLOR $noColor", async (parameters) => {
        expect.assertions(1);

        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: parameters.tty });
        setEnv("NO_COLOR", parameters.noColor);
        setEnv("FORCE_COLOR", undefined);

        const commands = (): ConcurrentCommandConfig[] => [{ command: probeCommand("env", "FORCE_COLOR", "NO_COLOR", "TERM"), stdin: "pty" }];
        const seen = async (runner: RunnerName): Promise<string[]> => summarize(await observe(runner, commands()), { merged: true }).commands[0]!.stdout;

        await expect(seen("native")).resolves.toStrictEqual(await seen("js"));
    });
});

// ── the environment ────────────────────────────────────────────────────

describe("inheritEnv: false", () => {
    const saved = process.env["PARITY_PARENT_ONLY"];

    afterEach(() => {
        if (saved === undefined) {
            Reflect.deleteProperty(process.env, "PARITY_PARENT_ONLY");
        } else {
            process.env["PARITY_PARENT_ONLY"] = saved;
        }
    });

    it.each([false, true])("a parent variable does not reach the child (inheritEnv %s)", async (inheritEnv) => {
        expect.assertions(3);

        process.env["PARITY_PARENT_ONLY"] = "from-parent";

        const commands = (): ConcurrentCommandConfig[] => [
            { command: probeCommand("env", "PARITY_PARENT_ONLY", "PARITY_OVERLAY"), env: { ...systemEnv(), PARITY_OVERLAY: "from-overlay" }, inheritEnv },
        ];
        const seen = async (runner: RunnerName): Promise<unknown> => JSON.parse(summarize(await observe(runner, commands())).commands[0]!.stdout[0]!);
        const native = await seen("native");

        expect(native).toStrictEqual(await seen("js"));
        expect(native).toMatchObject({ PARITY_OVERLAY: "from-overlay" });
        expect(native).toMatchObject({ PARITY_PARENT_ONLY: inheritEnv ? "from-parent" : null });
    });

    it.skipIf(!posix).each(["pipe", "pty"] as const)("a parent variable does not reach a %s child either", async (stdin) => {
        expect.assertions(2);

        process.env["PARITY_PARENT_ONLY"] = "from-parent";

        const commands = (): ConcurrentCommandConfig[] => [
            { command: probeCommand("env", "PARITY_PARENT_ONLY", "PARITY_OVERLAY"), env: { PARITY_OVERLAY: "from-overlay" }, inheritEnv: false, stdin },
        ];
        const seen = async (runner: RunnerName): Promise<unknown> =>
            JSON.parse(summarize(await observe(runner, commands()), { merged: true }).commands[0]!.stdout[0]!.trim());

        await expect(seen("native")).resolves.toStrictEqual({ PARITY_OVERLAY: "from-overlay", PARITY_PARENT_ONLY: null });
        await expect(seen("js")).resolves.toStrictEqual({ PARITY_OVERLAY: "from-overlay", PARITY_PARENT_ONLY: null });
    });
});

describe("what every caller relies on", () => {
    it.each(["js", "native"] as const)("%s: no commands resolve at once as a success", async (runner) => {
        expect.assertions(1);

        await expect(runners[runner]([], {})).resolves.toStrictEqual({ closeEvents: [], success: true });
    });

    it.each(["js", "native"] as const)("%s: a close event carries the time the command ran, in the event and in the result", async (runner) => {
        expect.assertions(3);

        const { events, result } = await observe(runner, [{ command: probeCommand("exit-after", "150", "0") }]);
        const closeEvent = events.find((event) => event.kind === "close")!;

        expect(closeEvent.durationMs).toBeGreaterThanOrEqual(100);
        expect(result.closeEvents[0]!.durationMs).toBeGreaterThanOrEqual(100);
        expect(closeEvent.commandName).toBeUndefined();
    });
});

describe("neither runner handles SIGHUP", () => {
    it.skipIf(!posix).each(["js", "native"] as const)("%s adds no SIGHUP listener while it runs", async (runner) => {
        expect.assertions(1);

        const before = process.listenerCount("SIGHUP");
        let during = -1;

        await observe(runner, [{ command: probeCommand("exit", "0") }], {}, (event) => {
            if (event.kind === "started") {
                during = process.listenerCount("SIGHUP");
            }
        });

        expect(during).toBe(before);
    });
});

// ── accepted differences ───────────────────────────────────────────────

/** Run both runners and give back what each did, a rejection included. */
const both = async (
    commands: () => ConcurrentCommandConfig[],
    options: ConcurrentRunnerOptions = {},
    react?: () => React,
    settleWithin = 20_000,
): Promise<Record<RunnerName, { error?: string; observation?: Observation; pending?: true }>> => {
    const out: Record<string, { error?: string; observation?: Observation; pending?: true }> = {};

    for (const runner of ["js", "native"] as const) {
        const before = listenerSnapshot();
        const attempt = observe(runner, commands(), options, react?.()).then(
            (observation) => { return { observation }; },
            (error: unknown) => {
                return { error: (error as Error).message };
            },
        );
        // eslint-disable-next-line no-await-in-loop
        const outcome = await Promise.race([
            attempt,
            new Promise<{ pending: true }>((resolve) => {
                setTimeout(resolve, settleWithin, { pending: true }).unref();
            }),
        ]);

        out[runner] = outcome;

        // A run that never settles keeps its listeners; take them off so they cannot catch a later signal.
        for (const name of listenerNames) {
            for (const listener of process.listeners(name) as Listener[]) {
                if (!before.get(name)!.includes(listener)) {
                    process.removeListener(name, listener);
                }
            }
        }
    }

    return out;
};

const closeOf = (outcome: { observation?: Observation }, index = 0) => outcome.observation!.result.closeEvents.find((event) => event.index === index)!;
const kindsOf = (outcome: { observation?: Observation }, index = 0): string[] =>
    outcome.observation!.events.filter((event) => event.index === index).map((event) => event.kind);

describe("accepted differences", () => {
    it("1. a command that cannot be spawned: exit code and the missing `started`", async () => {
        expect.assertions(6);

        const { js, native } = await both(() => [{ command: "echo hi", cwd: "/nonexistent/parity/directory" }]);

        expect(kindsOf(js)).toStrictEqual(["started", "error", "close"]);
        expect(closeOf(js).exitCode).toBe(-2);
        expect(js.observation!.events.find((event) => event.kind === "started")?.pid).toBeUndefined();
        expect(kindsOf(native)).toStrictEqual(["error", "close"]);
        expect(closeOf(native).exitCode).toBe(1);
        expect(native.observation!.result.success).toBe(false);
    });

    it.skipIf(!posix)("1b. a missing shell is the same difference", async () => {
        expect.assertions(4);

        const { js, native } = await both(() => [{ command: "echo hi" }], { shellPath: "/nonexistent/parity/sh" });

        expect(closeOf(js).exitCode).toBe(-2);
        expect(closeOf(native).exitCode).toBe(1);
        expect(kindsOf(js)).toStrictEqual(["started", "error", "close"]);
        expect(kindsOf(native)).toStrictEqual(["error", "close"]);
    });

    it("2. a UTF-8 character split across two reads", async () => {
        expect.assertions(2);

        const euro = Buffer.from("€\n");
        const { js, native } = await both(() => [{ command: probeCommand("chunks", "out", base64(euro.subarray(0, 1)), base64(euro.subarray(1))) }]);
        const stdout = (outcome: { observation?: Observation }) =>
            outcome.observation!.events.filter((event) => event.kind === "stdout").map((event) => event.text);

        expect(stdout(js)).toStrictEqual(["\uFFFD\uFFFD\uFFFD"]);
        expect(stdout(native)).toStrictEqual(["€"]);
    });

    it.skipIf(!posix)("3. killTimeout: the native runner escalates to SIGKILL, the JS spawner never reads it", async () => {
        expect.assertions(6);

        // The second command ignores SIGTERM and leaves by itself after 1.6 s.
        const commands = () => [{ command: probeCommand("exit-after", "150", "1") }, { command: probeCommand("ignore-term", "1600") }];
        const { js, native } = await both(commands, { killOthers: ["failure"], killTimeout: 300 });

        expect(closeOf(native, 1)).toMatchObject({ exitCode: 137, killed: true });
        expect(native.observation!.elapsedMs).toBeLessThan(1400);
        expect(closeOf(js, 1)).toMatchObject({ exitCode: 0, killed: true });
        expect(js.observation!.elapsedMs).toBeGreaterThan(1500);
        expect(native.observation!.result.success).toBe(false);
        expect(js.observation!.result.success).toBe(false);
    });

    it("4. killOthers with a command still queued: the native runner resolves, the JS spawner hangs", async () => {
        expect.assertions(4);

        const commands = () => [{ command: probeCommand("exit", "1") }, { command: probeCommand("out", "never") }];
        const { js, native } = await both(commands, { killOthers: ["failure"], maxProcesses: 1 }, undefined, 2500);

        expect(js.pending).toBe(true);
        expect(native.observation!.result.closeEvents.map((event) => event.index)).toStrictEqual([0]);
        expect(native.observation!.events.some((event) => event.index === 1)).toBe(false);
        expect(native.observation!.result.success).toBe(false);
    });

    it("5. a mixed-case command name in successCondition", async () => {
        expect.assertions(2);

        const commands = () => [
            { command: probeCommand("exit", "0"), name: "MyApp" },
            { command: probeCommand("exit", "3"), name: "other" },
        ];
        const { js, native } = await both(commands, { successCondition: "command-MyApp" });

        expect(js.observation!.result.success).toBe(false);
        expect(native.observation!.result.success).toBe(true);
    });

    it.each([
        ["successCondition", { successCondition: "sometimes" }, "sometimes"],
        ["killSignal", { killSignal: "SIGBOGUS" }, "SIGBOGUS"],
        ["killOthers", { killOthers: ["maybe" as "failure"] }, "maybe"],
    ])("6. an unknown %s: the native runner rejects naming the value, the JS spawner uses the default", async (_name, options, value) => {
        expect.assertions(3);

        const { js, native } = await both(() => [{ command: probeCommand("exit", "0") }], options);

        expect(js.observation!.result.success).toBe(true);
        expect(native.error).toContain(value);
        expect(native.observation).toBeUndefined();
    });

    it.skipIf(!posix)("10. a run aborted by SIGINT: the close event says 0 natively, the raw 143 in the JS spawner", async () => {
        expect.assertions(6);

        const { js, native } = await both(() => [{ command: probeCommand("hang") }], {}, callSignalListener("hanging", "SIGINT"));
        const closeEvent = (outcome: { observation?: Observation }) => outcome.observation!.events.find((event) => event.kind === "close")!;

        // The result is the same on both: an interrupt is a cancellation, not a failure.
        for (const outcome of [js, native]) {
            expect(closeOf(outcome)).toMatchObject({ exitCode: 0, killed: true });
            expect(outcome.observation!.result.success).toBe(true);
        }

        expect(closeEvent(js)).toMatchObject({ exitCode: 143, killed: true });
        expect(closeEvent(native)).toMatchObject({ exitCode: 0, killed: true });
    });

    describe.skipIf(!posix)("pty", () => {
        it("7b. a pty command killed through the started event", async () => {
            expect.assertions(4);

            const { js, native } = await both(() => [{ command: probeCommand("hang"), stdin: "pty" }], {}, callKill("hanging", "SIGKILL"));

            expect(closeOf(js)).toMatchObject({ exitCode: 0, killed: true });
            expect(closeOf(native)).toMatchObject({ exitCode: 137, killed: true });
            expect(js.observation!.result.success).toBe(true);
            expect(native.observation!.result.success).toBe(false);
        });

        it.each([
            ["SIGTERM", "kill -TERM $$", 143],
            ["SIGKILL", "kill -KILL $$", 137],
        ])("7. a command killed by %s: 128 + signal natively, exit code 0 through node-pty", async (_name, command, native128) => {
            expect.assertions(4);

            const { js, native } = await both(() => [{ command, stdin: "pty" }]);

            expect(closeOf(js)).toMatchObject({ exitCode: 0, killed: true });
            expect(closeOf(native)).toMatchObject({ exitCode: native128, killed: true });
            expect(js.observation!.result.success).toBe(true);
            expect(native.observation!.result.success).toBe(false);
        });

        it("8. a command that cannot start: an error natively, nothing but a failed close in the JS spawner", async () => {
            expect.assertions(4);

            const { js, native } = await both(() => [{ command: "echo hi", cwd: "/nonexistent/parity/directory", stdin: "pty" }]);

            expect(kindsOf(js)).toStrictEqual(["started", "close"]);
            expect(closeOf(js).exitCode).toBe(1);
            expect(kindsOf(native)).toStrictEqual(["error", "close"]);
            expect(closeOf(native).exitCode).toBe(1);
        });

        it("9. a size with a zero dimension: the native runner rejects it naming the size", async () => {
            expect.assertions(3);

            const { js, native } = await both(() => [{ command: "echo hi", ptySize: { cols: 0, rows: 0 }, stdin: "pty" }]);

            expect(js.observation!.result.success).toBe(true);
            expect(native.error).toContain("0x0");
            expect(native.observation).toBeUndefined();
        });

        it("a. (needs classification) SHELL is set natively even with inheritEnv: false", async () => {
            expect.assertions(2);

            const commands = () => [
                { command: probeCommand("env", "SHELL"), env: { PATH: process.env["PATH"] ?? "" }, inheritEnv: false, stdin: "pty" as const },
            ];
            const { js, native } = await both(commands);
            const shell = (outcome: { observation?: Observation }): unknown =>
                JSON.parse(summarize(outcome.observation!, { merged: true }).commands[0]!.stdout[0]!.trim())["SHELL"];

            expect(shell(js)).toBeNull();
            expect(shell(native)).toBeTypeOf("string");
        });
    });
});
