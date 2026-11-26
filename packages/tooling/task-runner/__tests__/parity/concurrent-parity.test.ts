/**
 * Behaviour suite of the native concurrent runner (`runNativeConcurrent`), called directly with
 * the same commands and options a caller passes to `runConcurrently`.
 *
 * Each scenario reduces its run to what a caller can observe and stores that in the snapshot file
 * beside this one:
 *
 * - the result: `success` and the close events sorted by `index`, each as
 *   (`index`, `exitCode`, `killed`, `name`, `command`); `pid` and `durationMs` are dropped;
 * - the event stream per command index: it starts with `started`, ends with exactly one `close`,
 *   and carries the `stdout` lines, the `stderr` lines and the `error` events. Order across
 *   commands, and between a command's two streams, is not stable and is not compared. A pty
 *   command's merged output arrives as raw chunks, so it is compared as one string with CRLF
 *   turned into LF.
 *
 * The snapshots were recorded while the TypeScript spawner this runner replaced was still in the
 * repository, from runs that matched it on every scenario except the accepted differences below.
 * Paths of the machine, the Node binary and the probe script are replaced by names; strings over
 * 200 characters are stored as their length. Update them with `vitest -u` only for a change in
 * behaviour you mean to make.
 *
 * ## Behaviour that differs from the retired spawner
 *
 * The last block of the file asserts each of these:
 *
 * | # | Scenario | Native runner |
 * | - | -------- | ------------- |
 * | 1 | the command cannot be spawned (missing cwd or shell) | `started`, `error`, close code 1 |
 * | 2 | a UTF-8 character split across two reads, within the 100 ms flush window | the character, once |
 * | 3 | `killTimeout` | SIGKILL after the timeout (137 when the command leads its process group; a wrapper shell that dies from the SIGTERM first, as dash does on Linux, reports 143) |
 * | 4 | `killOthers` fires with commands still queued | resolves; the queued commands have no close event |
 * | 5 | `successCondition: "command-MyApp"` for a command named `MyApp` | matches |
 * | 6 | an unknown `successCondition`, `killSignal` or `killOthers` value | rejects, naming the value |
 * | 7 | a pty command killed by a signal | `128 + signal`, `killed` true |
 * | 8 | a pty command that cannot start (missing cwd) | `started`, `error`, then close code 1 |
 *
 * ## Also asserted
 *
 * `killed` is true for a command ended by `killOthers`, an abort or its own `kill`; a signalled
 * shell reports `128 + signal`; the runner listens for no SIGHUP and removes the listeners it adds
 * for SIGINT, SIGTERM and exit when the run settles; a pty command with `inheritEnv: false` gets
 * only the caller's variables (no `SHELL` unless the caller passed one); a command that cannot be
 * spawned reports `started` (without a pid) before `error` and `close`; a run aborted by SIGINT
 * has its `close` event keep the raw exit code (143) while the result says 0 and `success`.
 *
 * ## Not covered here
 *
 * The scenarios that need a POSIX shell, a pty or signals are skipped on Windows; the rest run
 * through the probe script and `cmd.exe`. A real SIGINT to a CLI process (rather than invoking the
 * run's own listener) is `concurrent-ctrl-c.test.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runNativeConcurrent } from "../../src/concurrent-native";
import type { ConcurrentCommandConfig, ConcurrentRunnerOptions, ConcurrentRunResult, ProcessEvent } from "../../src/types";

const posix = process.platform !== "win32";
/** The session probe reads `getsid` through Python. */
const hasPython = posix && spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
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

const observe = async (commands: ConcurrentCommandConfig[], options: ConcurrentRunnerOptions = {}, react?: React): Promise<Observation> => {
    const events: ProcessEvent[] = [];
    const started = new Map<number, ProcessEvent>();
    const startedAt = Date.now();
    const result = await runNativeConcurrent(commands, {
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

/** Whether the process group led by `pid` is gone, allowing it a few seconds to be reaped. */
const groupGone = async (pid: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
            process.kill(-pid, 0);
        } catch {
            return true;
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
            setTimeout(resolve, 100);
        });
    }

    return false;
};

/** A value as it is stored in a snapshot: machine-specific paths named, long strings reduced to their length. */
const snapshotOf = (value: unknown): unknown =>
    JSON.parse(
        JSON.stringify(value, (_key, item: unknown) => {
            if (typeof item !== "string") {
                return item;
            }

            const named = item.replaceAll(process.execPath, "<node>").replaceAll(probe, "<probe>").replaceAll(scratch, "<tmp>").replaceAll('"', "'");

            return named.length > 200 ? `<${named.length} characters>` : named;
        }),
    );

// ── scenarios ──────────────────────────────────────────────────────────

interface Scenario {
    /** Extra check on one run, for what a plain comparison cannot see. */
    check?: (observation: Observation) => Promise<void> | void;
    commands: () => ConcurrentCommandConfig[];
    /** The commands' output is a terminal's: compare it as one string. */
    merged?: boolean;
    name: string;
    /** Needs `python3` on the machine (skipped without it). */
    needsPython?: boolean;
    options?: ConcurrentRunnerOptions;
    /** Needs a POSIX shell, signals or a pty. */
    posixOnly?: boolean;
    /** Builds the reaction anew for each run, so state in it cannot leak from one run to the next. */
    react?: () => React;
    /** Skips the snapshot of the summary, for output too large to store (its `check` asserts it). */
    unsnapshotted?: boolean;
}

/** One line of `probe.cjs numbered`, as a caller sees it: every 1000th is empty, every 10000th is 300 KB, every 777th had a CRLF. */
const numberedLine = (label: string, number: number): string => {
    if (number % 10_000 === 0) {
        return `${label}-${"y".repeat(300_000)}`;
    }

    if (number % 1000 === 0) {
        return "";
    }

    return number % 777 === 0 ? label : `${label} padding-padding-padding`;
};

/** The lines `probe.cjs numbered PREFIX COUNT` writes to one stream (`tag` "o" or "e"), as a caller sees them. */
const numberedLines = (tag: "e" | "o", prefix: string, count: number): string[] => [
    ...Array.from({ length: count }, (_, position) => numberedLine(`${tag}${prefix}-${position + 1}`, position + 1)),
    `${tag}${prefix}-tail`,
];

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
    {
        // About 15 MB across four streams: every line of every stream reaches `onEvent` exactly once
        // and in order, whatever the runner does to move events (the native one folds adjacent
        // lines of a stream into one object and splits them again in JavaScript).
        check: ({ events }) => {
            for (const [index, prefix] of [[0, "a"], [1, "b"]] as const) {
                for (const [kind, tag] of [["stdout", "o"], ["stderr", "e"]] as const) {
                    const seen = events.filter((event) => event.index === index && event.kind === kind).map((event) => event.text);

                    // The scenario's own test is running this check.
                    // eslint-disable-next-line vitest/no-standalone-expect
                    expect(seen).toStrictEqual(numberedLines(tag, prefix, 30_000));
                }
            }
        },
        commands: () => [{ command: probeCommand("numbered", "a", "30000") }, { command: probeCommand("numbered", "b", "30000") }],
        name: "multi-megabyte output: every line once, in order, per command and stream",
        options: { maxProcesses: 2 },
        unsnapshotted: true,
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
        // `process.stdout.columns` is 0 on some terminals and callers pass it on as the size.
        commands: () => [{ command: "stty size", ptySize: { cols: 0, rows: 0 }, stdin: "pty" }],
        merged: true,
        name: "pty: a size with a zero dimension gives the default terminal",
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
    ...[
        ["only the caller's variables", { PATH: process.env["PATH"] ?? "" }],
        ["a SHELL the caller passes", { PATH: process.env["PATH"] ?? "", SHELL: "/custom/shell" }],
    ].map(([name, env]) => {
        return {
            commands: () => [{ command: probeCommand("env", "SHELL", "PARITY_PARENT_ONLY"), env: env as Record<string, string>, inheritEnv: false, stdin: "pty" as const }],
            merged: true,
            name: `pty with inheritEnv: false gets ${name as string}`,
            posixOnly: true,
        };
    }),
    {
        // An interrupt is a cancellation: the result says 0 and success, the event keeps the raw code.
        check: async ({ events, result }) => {
            expect(result.closeEvents[0]).toMatchObject({ exitCode: 0, killed: true });
            expect(result.success).toBe(true);
            expect(events.find((event) => event.kind === "close")).toMatchObject({ exitCode: 143, killed: true });
            // The scenario's own test is running this check.
            // eslint-disable-next-line vitest/no-standalone-expect
            await expect(groupGone(events.find((event) => event.kind === "started")!.pid!)).resolves.toBe(true);
        },
        commands: () => [{ command: probeCommand("hang") }],
        name: "SIGINT: the result says 0, the close event keeps 143",
        posixOnly: true,
        react: callSignalListener("hanging", "SIGINT"),
    },
    {
        check: ({ events }) => {
            // The scenario's own test is running this check.

            expect(events.flatMap((event) => (event.kind === "stdout" ? [event.text] : []))).toStrictEqual(["session-leader"]);
        },
        // The child leads a session of its own, so it has no controlling terminal: a read from an
        // inherited terminal or an open of `/dev/tty` fails instead of stopping the command, and
        // `kill(-pid)` reaches its whole group. Both runners do this through `setsid`.
        commands: () => [{ command: `sid=$(python3 -c 'import os; print(os.getsid(0))'); [ "$sid" = "$$" ] && echo session-leader || echo "not a session leader ($sid, $$)"` }],
        name: "the command leads a session of its own",
        needsPython: true,
        posixOnly: true,
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
        // The pty command waits long enough for the pipe command to have started and printed before it is killed.
        commands: () => [
            { command: probeCommand("exit-after", "400", "1"), stdin: "pty" },
            { command: probeCommand("hang") },
        ],
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

describe("the native runner, scenario by scenario", () => {
    // A loop, not `it.each`: each scenario decides for itself whether the platform can run it.
    // eslint-disable-next-line vitest/prefer-each
    for (const scenario of scenarios) {
        it.skipIf((scenario.posixOnly && !posix) || (scenario.needsPython && !hasPython))(
            scenario.name,
            async () => {
                expect.hasAssertions();

                const before = listenerSnapshot();
                const observation = await observe(scenario.commands(), scenario.options, scenario.react?.());
                const summary = summarize(observation, { merged: scenario.merged });

                await scenario.check?.(observation);

                // Every command's events are framed the same way, and the run left no listener behind.
                for (const command of Object.values(summary.commands)) {
                    expect(command.framing, scenario.name).toBe("ok");
                }

                sideEffectsOf(before);

                if (!scenario.unsnapshotted) {
                    expect(snapshotOf(summary)).toMatchSnapshot();
                }
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

        expect(summarize(await observe(commands())).commands[0]!.stdout).toMatchSnapshot();
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

        expect(summarize(await observe(commands()), { merged: true }).commands[0]!.stdout).toMatchSnapshot();
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
        expect.assertions(2);

        process.env["PARITY_PARENT_ONLY"] = "from-parent";

        const commands = (): ConcurrentCommandConfig[] => [
            { command: probeCommand("env", "PARITY_PARENT_ONLY", "PARITY_OVERLAY"), env: { ...systemEnv(), PARITY_OVERLAY: "from-overlay" }, inheritEnv },
        ];
        const native: unknown = JSON.parse(summarize(await observe(commands())).commands[0]!.stdout[0]!);

        expect(native).toMatchObject({ PARITY_OVERLAY: "from-overlay" });
        expect(native).toMatchObject({ PARITY_PARENT_ONLY: inheritEnv ? "from-parent" : null });
    });

    it.skipIf(!posix).each(["pipe", "pty"] as const)("a parent variable does not reach a %s child either", async (stdin) => {
        expect.assertions(1);

        process.env["PARITY_PARENT_ONLY"] = "from-parent";

        const commands = (): ConcurrentCommandConfig[] => [
            { command: probeCommand("env", "PARITY_PARENT_ONLY", "PARITY_OVERLAY"), env: { PARITY_OVERLAY: "from-overlay" }, inheritEnv: false, stdin },
        ];
        const seen: unknown = JSON.parse(summarize(await observe(commands()), { merged: true }).commands[0]!.stdout[0]!.trim());

        expect(seen).toStrictEqual({ PARITY_OVERLAY: "from-overlay", PARITY_PARENT_ONLY: null });
    });
});

describe("what every caller relies on", () => {
    it("no commands resolve at once as a success", async () => {
        expect.assertions(1);

        await expect(runNativeConcurrent([], {})).resolves.toStrictEqual({ closeEvents: [], success: true });
    });

    it("a close event carries the time the command ran, in the event and in the result", async () => {
        expect.assertions(3);

        const { events, result } = await observe([{ command: probeCommand("exit-after", "150", "0") }]);
        const closeEvent = events.find((event) => event.kind === "close")!;

        expect(closeEvent.durationMs).toBeGreaterThanOrEqual(100);
        expect(result.closeEvents[0]!.durationMs).toBeGreaterThanOrEqual(100);
        expect(closeEvent.commandName).toBeUndefined();
    });
});

describe("sIGHUP", () => {
    it.skipIf(!posix)("the runner adds no SIGHUP listener while it runs", async () => {
        expect.assertions(1);

        const before = process.listenerCount("SIGHUP");
        let during = -1;

        await observe([{ command: probeCommand("exit", "0") }], {}, (event) => {
            if (event.kind === "started") {
                during = process.listenerCount("SIGHUP");
            }
        });

        expect(during).toBe(before);
    });
});

// ── behaviour that differs from the retired spawner ────────────────────

interface Outcome {
    error?: string;
    observation?: Observation;
    pending?: true;
}

/** Runs the native runner and gives back what it did, a rejection included, or `pending` when it has not settled in `settleWithin` ms. */
const run = async (commands: () => ConcurrentCommandConfig[], options: ConcurrentRunnerOptions = {}, react?: () => React, settleWithin = 20_000): Promise<Outcome> => {
    const before = listenerSnapshot();
    const attempt = observe(commands(), options, react?.()).then(
        (observation) => { return { observation }; },
        (error: unknown) => {
            return { error: (error as Error).message };
        },
    );
    const outcome = await Promise.race([
        attempt,
        new Promise<{ pending: true }>((resolve) => {
            setTimeout(resolve, settleWithin, { pending: true }).unref();
        }),
    ]);

    // A run that never settles keeps its listeners; take them off so they cannot catch a later signal.
    for (const name of listenerNames) {
        for (const listener of process.listeners(name) as Listener[]) {
            if (!before.get(name)!.includes(listener)) {
                process.removeListener(name, listener);
            }
        }
    }

    return outcome;
};

const closeOf = (outcome: Outcome, index = 0) => outcome.observation!.result.closeEvents.find((event) => event.index === index)!;
const kindsOf = (outcome: Outcome, index = 0): string[] => outcome.observation!.events.filter((event) => event.index === index).map((event) => event.kind);

describe("behaviour that differs from the retired spawner", () => {
    it("1. a command that cannot be spawned: `started` without a pid, `error`, then close code 1", async () => {
        expect.assertions(4);

        const native = await run(() => [{ command: "echo hi", cwd: "/nonexistent/parity/directory" }]);

        expect(kindsOf(native)).toStrictEqual(["started", "error", "close"]);
        expect(native.observation!.events.find((event) => event.kind === "started")?.pid).toBeUndefined();
        expect(closeOf(native).exitCode).toBe(1);
        expect(native.observation!.result.success).toBe(false);
    });

    it.skipIf(!posix)("1b. a missing shell is the same", async () => {
        expect.assertions(2);

        const native = await run(() => [{ command: "echo hi" }], { shellPath: "/nonexistent/parity/sh" });

        expect(closeOf(native).exitCode).toBe(1);
        expect(kindsOf(native)).toStrictEqual(["started", "error", "close"]);
    });

    it("2. a UTF-8 character split across two reads arrives once", async () => {
        expect.assertions(1);

        const euro = Buffer.from("€\n");
        const native = await run(() => [{ command: probeCommand("chunks-fast", "out", base64(euro.subarray(0, 1)), base64(euro.subarray(1))) }]);

        expect(native.observation!.events.filter((event) => event.kind === "stdout").map((event) => event.text)).toStrictEqual(["€"]);
    });

    it.skipIf(!posix)("3. killTimeout: the runner escalates to SIGKILL", async () => {
        expect.assertions(3);

        // The second command ignores SIGTERM and leaves by itself after 1.6 s. It is `exec`ed so the
        // probe is the process group's leader on every shell: dash (Linux) keeps a wrapper shell
        // alive, which dies from the SIGTERM first and would be what the exit code reports (143).
        const commands = () => [{ command: probeCommand("exit-after", "150", "1") }, { command: `exec ${probeCommand("ignore-term", "1600")}` }];
        const native = await run(commands, { killOthers: ["failure"], killTimeout: 300 });

        expect(closeOf(native, 1)).toMatchObject({ exitCode: 137, killed: true });
        expect(native.observation!.elapsedMs).toBeLessThan(1400);
        expect(native.observation!.result.success).toBe(false);
    });

    it("4. killOthers with a command still queued: the run resolves and the queued command has no close event", async () => {
        expect.assertions(3);

        const commands = () => [{ command: probeCommand("exit", "1") }, { command: probeCommand("out", "never") }];
        const native = await run(commands, { killOthers: ["failure"], maxProcesses: 1 }, undefined, 2500);

        expect(native.observation!.result.closeEvents.map((event) => event.index)).toStrictEqual([0]);
        expect(native.observation!.events.some((event) => event.index === 1)).toBe(false);
        expect(native.observation!.result.success).toBe(false);
    });

    it("5. a mixed-case command name matches in successCondition", async () => {
        expect.assertions(1);

        const commands = () => [
            { command: probeCommand("exit", "0"), name: "MyApp" },
            { command: probeCommand("exit", "3"), name: "other" },
        ];
        const native = await run(commands, { successCondition: "command-MyApp" });

        expect(native.observation!.result.success).toBe(true);
    });

    it.each([
        ["successCondition", { successCondition: "sometimes" }, "sometimes"],
        ["killSignal", { killSignal: "SIGBOGUS" }, "SIGBOGUS"],
        ["killOthers", { killOthers: ["maybe" as "failure"] }, "maybe"],
    ])("6. an unknown %s is rejected, naming the value", async (_name, options, value) => {
        expect.assertions(2);

        const native = await run(() => [{ command: probeCommand("exit", "0") }], options);

        expect(native.error).toContain(value);
        expect(native.observation).toBeUndefined();
    });

    describe.skipIf(!posix)("pty", () => {
        it("7b. a pty command killed through the started event", async () => {
            expect.assertions(2);

            const native = await run(() => [{ command: probeCommand("hang"), stdin: "pty" }], {}, callKill("hanging", "SIGKILL"));

            expect(closeOf(native)).toMatchObject({ exitCode: 137, killed: true });
            expect(native.observation!.result.success).toBe(false);
        });

        it.each([
            ["SIGTERM", "kill -TERM $$", 143],
            ["SIGKILL", "kill -KILL $$", 137],
        ])("7. a command killed by %s reports 128 + signal", async (_name, command, code) => {
            expect.assertions(2);

            const native = await run(() => [{ command, stdin: "pty" }]);

            expect(closeOf(native)).toMatchObject({ exitCode: code, killed: true });
            expect(native.observation!.result.success).toBe(false);
        });

        it("8. a command that cannot start gives an `error`, then close code 1", async () => {
            expect.assertions(2);

            const native = await run(() => [{ command: "echo hi", cwd: "/nonexistent/parity/directory", stdin: "pty" }]);

            expect(kindsOf(native)).toStrictEqual(["started", "error", "close"]);
            expect(closeOf(native).exitCode).toBe(1);
        });
    });
});
