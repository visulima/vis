/**
 * Throughput of the two concurrent runners, side by side.
 *
 * Not a vitest benchmark (`*.bench.ts`): the CodSpeed job runs those, and spawning hundreds of
 * processes is not what it measures. Run it by hand, on a RELEASE addon:
 *
 *     pnpm build:native &amp;& pnpm bench:concurrent
 *
 * It calls `runConcurrentFallback` (the JS spawner) and `runNativeConcurrent` directly with the
 * same commands, a pinned shell and no flow controllers, so the numbers are the spawners' own:
 * no `npm config` shell lookup, no restart or teardown wrapper.
 *
 * Each warm case is warmed up first, then measured `BENCH_RUNS` times (default 15) with the two
 * runners taking turns, so drift in the machine hits both alike. The "cold process" case starts a
 * fresh `node` per run (`BENCH_COLD_RUNS`, default 20), because that is what one `vis run` costs:
 * loading the addon and starting its runtime are part of the first task. The report is the median, the spread,
 * and the ratio native / JS, next to the bar plan 015 sets for making the native runner the
 * default: within 1.25x of the JS spawner on 200 tasks, and within +10 ms on one task.
 *
 * The event-path cases (output-heavy tasks and pty tasks, all with a no-op `onEvent`, which is what
 * every `vis run` passes) are the second bar: native within 1.25x of the JS spawner. They run fewer
 * rounds (`BENCH_HEAVY_RUNS`, default 9, after `BENCH_HEAVY_WARMUP`, default 2), and `BENCH_ONLY`
 * (a substring of a case name) runs just the matching cases while profiling.
 *
 * Environment: `BENCH_RUNS` (measured runs per case), `BENCH_WARMUP` (default 3),
 * `BENCH_TASKS` (the large case, default 200), `BENCH_PROCESSES` (its `maxProcesses`, default 8),
 * `BENCH_HEAVY_RUNS`, `BENCH_HEAVY_WARMUP`, `BENCH_LINE_BYTES` (bytes per output line, default 100),
 * `BENCH_PTY_TASKS` (default 20), `BENCH_ONLY`,
 * `BENCH_COLD_RUNS` (cold-process runs, default 20), `BENCH_OUT` (a path: also write the numbers there
 * as JSON), `BENCH_SUMMARY` (a path: also write the markdown report there; CI points it at the job summary).
 */
/* eslint-disable no-console -- the report is the output of this script */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { expect, it } from "vitest";

import { runConcurrentFallback } from "../src/concurrent-fallback";
import { runNativeConcurrent } from "../src/concurrent-native";
import type { ConcurrentCommandConfig, ConcurrentRunnerOptions } from "../src/types";

type Runner = (commands: ConcurrentCommandConfig[], options: ConcurrentRunnerOptions) => Promise<{ success: boolean }>;

const runners: Record<"js" | "native", Runner> = { js: runConcurrentFallback, native: runNativeConcurrent };

const intFromEnv = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);

    return Number.isInteger(value) && value > 0 ? value : fallback;
};

const measuredRuns = intFromEnv("BENCH_RUNS", 15);
const coldRuns = intFromEnv("BENCH_COLD_RUNS", 20);
const warmupRuns = intFromEnv("BENCH_WARMUP", 3);
const largeCount = intFromEnv("BENCH_TASKS", 200);
const largeProcesses = intFromEnv("BENCH_PROCESSES", 8);

const heavyRuns = intFromEnv("BENCH_HEAVY_RUNS", 9);
const heavyWarmupRuns = intFromEnv("BENCH_HEAVY_WARMUP", 2);
const lineBytes = intFromEnv("BENCH_LINE_BYTES", 100);
const ptyTasks = intFromEnv("BENCH_PTY_TASKS", 20);

interface BenchCase {
    /** The commands of one run. */
    commands: () => ConcurrentCommandConfig[];
    /** What the caller passes: events streamed to a callback, or only the result. */
    events: boolean;
    /** An event-path case: held to the 1.25x bar, and run for fewer rounds because each is slow. */
    heavy?: boolean;
    maxProcesses: number;
    name: string;
}

const echoes = (count: number): (() => ConcurrentCommandConfig[]) => () =>
    Array.from({ length: count }, (_, index): ConcurrentCommandConfig => {
        return { command: `echo task-${index}` };
    });

const outputDirectory = fileURLToPath(new URL(".output/", import.meta.url));
const outputScript = `${outputDirectory}output.mjs`;

/**
 * A command that writes `megabytes` MB to stdout as lines of `lineBytes` bytes. POSIX hosts use
 * `yes | head`, so neither runner pays for starting node to produce it; Windows has no such tools
 * and writes it from a node script instead (start-up time is the same on both sides).
 */
const outputCommand = (megabytes: number): string => {
    const bytes = megabytes * 1024 * 1024;

    if (process.platform === "win32") {
        return `"${process.execPath}" "${outputScript}" ${bytes} ${lineBytes}`;
    }

    return `yes ${"x".repeat(lineBytes - 1)} | head -c ${bytes}`;
};

const outputCase = (megabytes: number): BenchCase => {
    return { commands: () => [{ command: outputCommand(megabytes) }], events: true, heavy: true, maxProcesses: 1, name: `1 task, ${megabytes} MB of output, onEvent` };
};

const cases: BenchCase[] = [
    { commands: echoes(1), events: false, maxProcesses: 1, name: "1 task" },
    { commands: echoes(1), events: true, maxProcesses: 1, name: "1 task, onEvent" },
    { commands: echoes(largeCount), events: false, maxProcesses: largeProcesses, name: `${largeCount} tasks, maxProcesses ${largeProcesses}` },
    { commands: echoes(largeCount), events: true, maxProcesses: largeProcesses, name: `${largeCount} tasks, maxProcesses ${largeProcesses}, onEvent` },
    outputCase(10),
    outputCase(100),
    {
        commands: () => Array.from({ length: ptyTasks }, (_, index): ConcurrentCommandConfig => { return { command: `echo pty-${index}`, stdin: "pty" }; }),
        events: true,
        heavy: true,
        maxProcesses: ptyTasks,
        name: `${ptyTasks} pty tasks, onEvent`,
    },
].filter((benchCase) => !process.env["BENCH_ONLY"] || benchCase.name.includes(process.env["BENCH_ONLY"]));

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const once = async (runner: Runner, benchCase: BenchCase): Promise<number> => {
    const commands = benchCase.commands();
    const options: ConcurrentRunnerOptions = {
        maxProcesses: benchCase.maxProcesses,
        // Pinned, so neither runner pays for (or varies with) a shell lookup.
        shellPath: process.platform === "win32" ? undefined : "/bin/sh",
        ...(benchCase.events ? { onEvent: () => undefined } : {}),
    };
    const start = performance.now();
    const result = await runner(commands, options);
    const elapsed = performance.now() - start;

    if (!result.success) {
        throw new Error(`a benchmark run failed: ${benchCase.name}`);
    }

    return elapsed;
};

const coldCaseName = "1 task, cold process";
const coldDirectory = fileURLToPath(new URL(".cold/", import.meta.url));
const coldEntry = `${coldDirectory}entry.mjs`;

/**
 * Bundles the two runners behind a tiny entry point that runs one `echo` task and exits, so each
 * measured run can be a fresh process. It is built inside `__bench__/` because the addon loader
 * walks up from the bundle to the package root to find `index.js`; the bundle is deleted afterwards.
 */
const buildColdEntry = async (): Promise<void> => {
    mkdirSync(coldDirectory, { recursive: true });

    const entrySource = [
        "const name = process.argv[2];",
        'const load = name === "js" ? import("../../src/concurrent-fallback") : import("../../src/concurrent-native");',
        'const run = await load.then((module) => (name === "js" ? module.runConcurrentFallback : module.runNativeConcurrent));',
        'const result = await run([{ command: "echo task" }], { maxProcesses: 1, shellPath: process.platform === "win32" ? undefined : "/bin/sh" });',
        "process.exit(result.success ? 0 : 1);",
    ].join("\n");

    await build({
        bundle: true,
        external: ["@lydell/node-pty"],
        format: "esm",
        logLevel: "error",
        outfile: coldEntry,
        platform: "node",
        stdin: { contents: entrySource, resolveDir: coldDirectory, sourcefile: "entry.ts" },
        target: "node22",
    });
};

/** Wall time of one fresh `node` that runs the cold entry with `name`'s runner. */
const coldOnce = (name: "js" | "native"): Promise<number> =>
    new Promise((resolve, reject) => {
        const start = performance.now();
        const child = spawn(process.execPath, [coldEntry, name], { stdio: "ignore" });

        child.on("error", reject);
        child.on("close", (code) => {
            const elapsed = performance.now() - start;

            if (code === 0) {
                resolve(elapsed);
            } else {
                reject(new Error(`a cold-process run failed: ${name} exited with ${code}`));
            }
        });
    });

const addonSize = (): number | undefined => {
    try {
        const suffix = `${process.platform}-${process.arch}`;

        return statSync(fileURLToPath(new URL(`../task-runner-native.${suffix}.node`, import.meta.url))).size;
    } catch {
        return undefined;
    }
};

const format = (milliseconds: number): string => `${milliseconds.toFixed(1)} ms`;

it(
    "measures both runners",
    async () => {
        expect.hasAssertions();

        const size = addonSize();

        // A debug addon is several times larger than a release one and spawns slower: the numbers would mislead.
        if (size !== undefined && size > 4 * 1024 * 1024) {
            console.warn(
                `WARNING: the addon is ${(size / 1024 / 1024).toFixed(1)} MB, which looks like a debug build. Build it with \`pnpm build:native\` before reading these numbers.`,
            );
        }

        const rows: { case: string; jsMedian: number; jsRange: [number, number]; nativeMedian: number; nativeRange: [number, number] }[] = [];

        if (process.platform === "win32") {
            mkdirSync(outputDirectory, { recursive: true });
            writeFileSync(
                outputScript,
                [
                    "const [bytes, width] = process.argv.slice(2).map(Number);",
                    String.raw`const line = "x".repeat(width - 1) + "\n";`,
                    "const block = line.repeat(Math.max(1, Math.floor(65_536 / width)));",
                    "let left = bytes;",
                    "while (left > 0) {",
                    "    const piece = block.length <= left ? block : block.slice(0, left);",
                    "    left -= piece.length;",
                    "    if (!process.stdout.write(piece)) await new Promise((resolve) => process.stdout.once('drain', resolve));",
                    "}",
                ].join("\n"),
            );
        }

        for (const benchCase of cases) {
            const samples: Record<"js" | "native", number[]> = { js: [], native: [] };
            const warmups = benchCase.heavy ? heavyWarmupRuns : warmupRuns;
            const measured = benchCase.heavy ? heavyRuns : measuredRuns;

            for (let round = 0; round < warmups + measured; round += 1) {
                // Take turns, and swap who goes first, so neither runner always follows the other.
                for (const name of round % 2 === 0 ? (["js", "native"] as const) : (["native", "js"] as const)) {
                    // eslint-disable-next-line no-await-in-loop
                    const elapsed = await once(runners[name], benchCase);

                    if (round >= warmups) {
                        samples[name].push(elapsed);
                    }
                }
            }

            rows.push({
                case: benchCase.name,
                jsMedian: median(samples.js),
                jsRange: [Math.min(...samples.js), Math.max(...samples.js)],
                nativeMedian: median(samples.native),
                nativeRange: [Math.min(...samples.native), Math.max(...samples.native)],
            });
        }

        if (!process.env["BENCH_ONLY"]) {
            const samples: Record<"js" | "native", number[]> = { js: [], native: [] };

            await buildColdEntry();

            try {
                for (let round = 0; round < 2 + coldRuns; round += 1) {
                    for (const name of round % 2 === 0 ? (["js", "native"] as const) : (["native", "js"] as const)) {
                        // eslint-disable-next-line no-await-in-loop
                        const elapsed = await coldOnce(name);

                        // Two throw-away rounds fill the page cache for the binary and the bundle.
                        if (round >= 2) {
                            samples[name].push(elapsed);
                        }
                    }
                }
            } finally {
                rmSync(coldDirectory, { force: true, recursive: true });
            }

            rows.push({
                case: coldCaseName,
                jsMedian: median(samples.js),
                jsRange: [Math.min(...samples.js), Math.max(...samples.js)],
                nativeMedian: median(samples.native),
                nativeRange: [Math.min(...samples.native), Math.max(...samples.native)],
            });
        }

        const image = process.env["ImageOS"] ? `, runner image ${process.env["ImageOS"]} ${process.env["ImageVersion"] ?? ""}`.trimEnd() : "";
        const lines = [
            "",
            `Concurrent runner throughput, ${process.platform}-${process.arch}, node ${process.version}${image}, median of ${measuredRuns} runs after ${warmupRuns} warm-up runs (cold process: ${coldRuns} runs)`,
            "",
            "| case | JS spawner | native | native / JS | native - JS |",
            "| --- | --- | --- | --- | --- |",
            ...rows.map(
                (row) =>
                    `| ${row.case} | ${format(row.jsMedian)} (${row.jsRange[0].toFixed(0)}-${row.jsRange[1].toFixed(0)}) | ${format(row.nativeMedian)} (${row.nativeRange[0].toFixed(0)}-${row.nativeRange[1].toFixed(0)}) | ${(row.nativeMedian / row.jsMedian).toFixed(2)}x | ${(row.nativeMedian - row.jsMedian).toFixed(1)} ms |`,
            ),
            "",
        ];

        const large = rows.find((row) => row.case === `${largeCount} tasks, maxProcesses ${largeProcesses}`);
        const single = rows.find((row) => row.case === coldCaseName);

        if (large && single) {
            lines.push(
                `Gate (plan 015, step 3): ${largeCount} tasks within 1.25x: ${large.nativeMedian / large.jsMedian <= 1.25 ? "met" : "NOT met"} (${(large.nativeMedian / large.jsMedian).toFixed(2)}x); one task (cold process) within +10 ms: ${single.nativeMedian - single.jsMedian <= 10 ? "met" : "NOT met"} (${(single.nativeMedian - single.jsMedian).toFixed(1)} ms)`,
                "",
            );
        }

        const heavyRows = rows.filter((row) => cases.some((benchCase) => benchCase.heavy && benchCase.name === row.case));

        if (heavyRows.length > 0) {
            lines.push(
                `Event path (onEvent set, native within 1.25x of the JS spawner): ${heavyRows.map((row) => `${row.case} ${(row.nativeMedian / row.jsMedian).toFixed(2)}x ${row.nativeMedian / row.jsMedian <= 1.25 ? "met" : "NOT met"}`).join("; ")}`,
                "",
            );
        }

        console.log(lines.join("\n"));

        if (process.env["BENCH_SUMMARY"]) {
            appendFileSync(process.env["BENCH_SUMMARY"], `${lines.join("\n")}\n`);
        }

        rmSync(outputDirectory, { force: true, recursive: true });

        expect(rows).toHaveLength(cases.length + (process.env["BENCH_ONLY"] ? 0 : 1));

        if (process.env["BENCH_OUT"]) {
            writeFileSync(process.env["BENCH_OUT"], `${JSON.stringify({ addonBytes: size, measuredRuns, rows, warmupRuns }, null, 2)}\n`);
        }
    },
    30 * 60_000,
);
