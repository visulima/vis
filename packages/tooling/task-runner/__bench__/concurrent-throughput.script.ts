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
 * Each case is warmed up first, then measured `BENCH_RUNS` times (default 15) with the two runners
 * taking turns, so drift in the machine hits both alike. The report is the median, the spread,
 * and the ratio native / JS, next to the bar plan 015 sets for making the native runner the
 * default: within 1.25x of the JS spawner on 200 tasks, and within +10 ms on one task.
 *
 * Environment: `BENCH_RUNS` (measured runs per case), `BENCH_WARMUP` (default 3),
 * `BENCH_TASKS` (the large case, default 200), `BENCH_PROCESSES` (its `maxProcesses`, default 8),
 * `BENCH_OUT` (a path: also write the numbers there as JSON).
 */
/* eslint-disable no-console -- the report is the output of this script */
import { statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const warmupRuns = intFromEnv("BENCH_WARMUP", 3);
const largeCount = intFromEnv("BENCH_TASKS", 200);
const largeProcesses = intFromEnv("BENCH_PROCESSES", 8);

interface BenchCase {
    /** What the caller passes: events streamed to a callback, or only the result. */
    events: boolean;
    maxProcesses: number;
    name: string;
    tasks: number;
}

const cases: BenchCase[] = [
    { events: false, maxProcesses: 1, name: "1 task", tasks: 1 },
    { events: true, maxProcesses: 1, name: "1 task, onEvent", tasks: 1 },
    { events: false, maxProcesses: largeProcesses, name: `${largeCount} tasks, maxProcesses ${largeProcesses}`, tasks: largeCount },
    { events: true, maxProcesses: largeProcesses, name: `${largeCount} tasks, maxProcesses ${largeProcesses}, onEvent`, tasks: largeCount },
];

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const once = async (runner: Runner, benchCase: BenchCase): Promise<number> => {
    const commands = Array.from({ length: benchCase.tasks }, (_, index): ConcurrentCommandConfig => {
        return { command: `echo task-${index}` };
    });
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

const addonSize = (): number | undefined => {
    try {
        const suffix = `${process.platform}-${process.arch}`;

        return statSync(fileURLToPath(new URL(`../task-runner-native.${suffix}.node`, import.meta.url))).size;
    } catch {
        return undefined;
    }
};

const format = (milliseconds: number): string => `${milliseconds.toFixed(1)} ms`;

it("measures both runners", async () => {
    expect.hasAssertions();

    const size = addonSize();

    // A debug addon is several times larger than a release one and spawns slower: the numbers would mislead.
    if (size !== undefined && size > 4 * 1024 * 1024) {
        console.warn(`WARNING: the addon is ${(size / 1024 / 1024).toFixed(1)} MB, which looks like a debug build. Build it with \`pnpm build:native\` before reading these numbers.`);
    }

    const rows: { case: string; jsMedian: number; jsRange: [number, number]; nativeMedian: number; nativeRange: [number, number] }[] = [];

    for (const benchCase of cases) {
        const samples: Record<"js" | "native", number[]> = { js: [], native: [] };

        for (let round = 0; round < warmupRuns + measuredRuns; round += 1) {
            // Take turns, and swap who goes first, so neither runner always follows the other.
            for (const name of round % 2 === 0 ? (["js", "native"] as const) : (["native", "js"] as const)) {
                // eslint-disable-next-line no-await-in-loop
                const elapsed = await once(runners[name], benchCase);

                if (round >= warmupRuns) {
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

    const lines = [
        "",
        `Concurrent runner throughput, ${process.platform}-${process.arch}, node ${process.version}, median of ${measuredRuns} after ${warmupRuns} warm-up runs`,
        "",
        "| case | JS spawner | native | native / JS | native - JS |",
        "| --- | --- | --- | --- | --- |",
        ...rows.map(
            (row) =>
                `| ${row.case} | ${format(row.jsMedian)} (${row.jsRange[0].toFixed(0)}-${row.jsRange[1].toFixed(0)}) | ${format(row.nativeMedian)} (${row.nativeRange[0].toFixed(0)}-${row.nativeRange[1].toFixed(0)}) | ${(row.nativeMedian / row.jsMedian).toFixed(2)}x | ${(row.nativeMedian - row.jsMedian).toFixed(1)} ms |`,
        ),
        "",
    ];

    const large = rows.find((row) => row.case === `${largeCount} tasks, maxProcesses ${largeProcesses}`)!;
    const single = rows.find((row) => row.case === "1 task")!;

    lines.push(
        `Gate (plan 015, step 3): ${largeCount} tasks within 1.25x: ${large.nativeMedian / large.jsMedian <= 1.25 ? "met" : "NOT met"} (${(large.nativeMedian / large.jsMedian).toFixed(2)}x); one task within +10 ms: ${single.nativeMedian - single.jsMedian <= 10 ? "met" : "NOT met"} (${(single.nativeMedian - single.jsMedian).toFixed(1)} ms)`,
        "",
    );

    console.log(lines.join("\n"));

    expect(rows).toHaveLength(cases.length);

    if (process.env["BENCH_OUT"]) {
        writeFileSync(process.env["BENCH_OUT"], `${JSON.stringify({ addonBytes: size, measuredRuns, rows, warmupRuns }, null, 2)}\n`);
    }
}, 30 * 60_000);
