import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";

/**
 * `vis cache why` and `vis replay` exist twice: the Node handlers (`src/commands/cache/why.ts`,
 * `src/commands/replay/handler.ts`) and the native paths (`native/cli/src/cache_why.rs`,
 * `native/cli/src/replay.rs`). Both read recorded run summaries and print them. For every invocation
 * below the two must agree on stdout, stderr and the exit status, and the invocations the native
 * path declines must reach Node unchanged. Node needs the built CLI (`dist/bin.js`) and the NAPI
 * addons, the native side needs the `vis` binary, so the suite is skipped when either is missing.
 *
 * The fixtures under `native/cli/tests/fixtures/run-summaries/` are workspaces holding hand-written
 * run summaries. Each case copies one into a fresh directory outside the repository, because the
 * binary reads its own location and Node's root search must stop at the copy. Git does not keep file
 * times, which decide the order of `replay --list` and which run is "previous", so the copy sets them.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const fixturesRoot = join(packageRoot, "native", "cli", "tests", "fixtures", "run-summaries");

let scratch: string;
// A copy outside the package: a binary inside it reads its own location and hands declined
// invocations to `dist/bin.js` itself, which would make the native path look like it answered.
let nativeBinary: string;
let counter: number;

const RUN_1 = "2026-01-01T00-00-00-000Z_1111";
const RUN_2 = "2026-01-02T00-00-00-000Z_2222";
const RUN_3 = "2026-01-03T00-00-00-000Z_3333";
const LONG_TASK = "@scope/pkg-with-a-very-long-name-for-wrapping:build:production";

/**
 * File times of the `history` workspace, in seconds. `alias` has the time of run 2 (a tie, ordered by
 * name), and the two runs that are not part of the history share the oldest time.
 */
const HISTORY_TIMES: Record<string, number> = {
    [`${RUN_1}.json`]: Date.UTC(2026, 0, 3) / 1000,
    [`${RUN_2}.json`]: Date.UTC(2026, 0, 4) / 1000,
    [`${RUN_3}.json`]: Date.UTC(2026, 0, 5) / 1000,
    "alias.json": Date.UTC(2026, 0, 4) / 1000,
    "empty-run.json": Date.UTC(2026, 0, 1) / 1000,
    "failed-run.json": Date.UTC(2026, 0, 1) / 1000,
};

const workspaceFor = (name: string): string => {
    const root = join(scratch, `${name}-${String(counter++)}`);

    cpSync(join(fixturesRoot, name === "empty-runs-directory" ? "empty" : name), root, { recursive: true });

    if (name === "empty-runs-directory") {
        mkdirSync(join(root, ".vis", "runs"), { recursive: true });
    }

    const runs = join(root, ".vis", "runs");

    if (existsSync(runs)) {
        const base = Date.UTC(2026, 0, 10) / 1000;

        for (const [index, file] of readdirSync(runs).entries()) {
            const time = HISTORY_TIMES[file] ?? base + index;

            utimesSync(join(runs, file), time, time);
        }
    }

    return realpathSync(root);
};

/** Environment that keeps Node's notices off, in a CI context. */
const environment = (extra: Record<string, string> = {}): Record<string, string> => {
    return {
        CI: "1",
        HOME: process.env["HOME"] ?? "",
        PATH: process.env["PATH"] ?? "",
        VIS_NO_UPDATE_CHECK: "1",
        // Lets a checkout that keeps the task-runner addon elsewhere run the Node side.
        ...(process.env["NAPI_RS_NATIVE_LIBRARY_PATH"] ? { NAPI_RS_NATIVE_LIBRARY_PATH: process.env["NAPI_RS_NATIVE_LIBRARY_PATH"] } : {}),
        ...extra,
    };
};

/**
 * Replaces the workspace root, the clock at the start of a pail header line (its colour codes may
 * come first) and the process id in the Node runtime's own warnings, which differ between runs.
 * Timestamps inside the output are compared as they are.
 */
const normalize = (text: string, root: string): string =>
    text
        .replaceAll(root, "<ROOT>")
        // eslint-disable-next-line no-control-regex
        .replaceAll(/^((?:\u001B\[\d+m)?)\d{2}:\d{2}:\d{2}/gm, "$1HH:MM:SS")
        .replaceAll(/\(node:\d+\)/g, "(node:PID)");

interface Case {
    args: string[];
    command: "cache why" | "replay";
    /** The native path must decline the call, so the binary has to hand it to Node. */
    delegates?: boolean;
    /** Extra environment for both engines. */
    env?: Record<string, string>;
    workspace: string;
}

const why = (args: string[], rest: Omit<Case, "args" | "command" | "workspace"> & { workspace?: string } = {}): Case => {
    return { args, command: "cache why", workspace: "history", ...rest };
};
const replay = (args: string[], rest: Omit<Case, "args" | "command" | "workspace"> & { workspace?: string } = {}): Case => {
    return { args, command: "replay", workspace: "history", ...rest };
};

const WHY_TASKS = [
    // Declared mode: changed, added and removed inputs, a command change, a layout change, nothing changed.
    "app:build",
    "app:same",
    "app:layout",
    "app:cmd",
    "app:deps",
    "app:fallback",
    // The task was not in the previous run.
    "app:first",
    // Trace mode: every kind of miss reason, none, an empty list, a hit.
    "app:trace",
    "app:trace-empty",
    "app:trace-hit",
    "app:nohash",
    LONG_TASK,
    // Not in the run at all.
    "app:missing",
];

const cases: Case[] = [
    ...WHY_TASKS.flatMap((task) => [why([task]), why([task, "--format", "json"])]),
    why(["--format=json", "app:build"]),
    why(["app:build", "--format", "table"]),
    why(["app:build"], { env: { COLUMNS: "45" } }),
    why(["app:trace"], { env: { COLUMNS: "45" } }),
    why(["app:missing"], { env: { COLUMNS: "45" } }),
    why([LONG_TASK], { env: { COLUMNS: "60" } }),
    // The "first time" message holds a dash that pail measures differently from the native wrap: native only where it fits one line.
    why(["app:first"], { env: { COLUMNS: "73" } }),
    why(["app:first"], { delegates: true, env: { COLUMNS: "72" } }),
    why(["app:first"], { delegates: true, env: { COLUMNS: "71" } }),
    why(["app:first"], { delegates: true, env: { COLUMNS: "70" } }),
    why(["app:first", "--format", "json"], { env: { COLUMNS: "45" } }),
    // `--run` loads another file; the previous run is the newest file other than the one named by the loaded run's `id`.
    why(["app:build", "--run", RUN_2]),
    why(["app:build", "--run", RUN_2, "--format", "json"]),
    why(["app:build", "--run", "alias"]),
    why(["app:build", "--run=alias", "--format", "json"]),
    why(["app:build", "--run", "failed-run"]),
    why(["app:build", "--run", "failed-run", "--format", "json"]),
    why(["app:test", "--run", "failed-run"]),
    why(["app:build", "--run", RUN_1]),
    why(["app:build", "--run", "no-such-run"]),
    why(["app:build", "--run", "no-such-run", "--format", "json"]),
    // Keys that are special to JavaScript, and keys UTF-16 and UTF-8 order differently: the table is Node's for non-ASCII keys.
    why(["app:unicode", "--format", "json"]),
    why(["app:unicode"], { delegates: true }),
    why(["app:proto"], { delegates: true }),
    why(["app:proto", "--format", "json"], { delegates: true }),
    why(["app:numeric"], { delegates: true }),
    why(["app:numeric", "--format", "json"], { delegates: true }),
    why(["app:bad-reason"], { delegates: true }),
    why(["app:bad-reason", "--format", "json"], { delegates: true }),
    why(["app:nullhash"], { delegates: true }),
    why(["app:nullhash", "--format", "json"], { delegates: true }),
    // No run directory, no state at all, a summary that does not parse, a newest run that does not parse.
    why(["app:build"], { workspace: "no-runs" }),
    why(["app:build", "--format", "json"], { workspace: "no-runs" }),
    why(["app:trace"], { workspace: "no-runs" }),
    why(["app:build"], { workspace: "empty" }),
    why(["app:build", "--format", "json"], { workspace: "empty" }),
    why(["app:build", "--run", RUN_2], { workspace: "empty" }),
    // A task without an id is listed as nothing, and an empty list reads "(none)".
    why(["app:build", "--run", "empty-id"], { workspace: "odd" }),
    why(["app:build", "--run", "empty-id", "--format", "json"], { workspace: "odd" }),
    why(["app:build"], { delegates: true, workspace: "unreadable" }),
    why(["app:build", "--format", "json"], { delegates: true, workspace: "unreadable" }),
    why(["app:build"], { delegates: true, workspace: "broken-previous" }),
    why(["app:build", "--format", "json"], { delegates: true, workspace: "broken-previous" }),
    // Argument shapes that are Node's.
    why(["app:build", "--json"], { delegates: true }),
    why(["app:build", "--format=JSON"], { delegates: true }),
    why(["app:build", "--format", "yaml"], { delegates: true }),
    why(["app:build", "app:same"], { delegates: true }),
    why(["app:build", "--run", "../x"], { delegates: true }),
    why(["app:build", "--run", ""], { delegates: true }),
    why([], { delegates: true }),

    // replay: the latest run, as a table and as JSON.
    replay([]),
    replay(["--format", "json"]),
    replay(["--format=json"]),
    replay(["--format", "table"]),
    replay([], { env: { COLUMNS: "50" } }),
    replay(["--failed"]),
    replay(["--failed", "--format", "json"]),
    // One task: the detail view, with and without dependencies, hash, times and exit code.
    ...["app:build", "app:deps", "app:nohash", "app:trace-hit", "app:trace-empty", "app:fallback", "app:missing", LONG_TASK].flatMap((task) => [
        replay(["--task", task]),
        replay(["--task", task, "--format", "json"]),
    ]),
    replay(["--task=app:deps"], { env: { COLUMNS: "45" } }),
    replay(["--task", LONG_TASK], { env: { COLUMNS: "60" } }),
    replay(["--task", "app:missing"], { env: { COLUMNS: "45" } }),
    replay(["--task", "app:build", "--failed"]),
    replay(["--task", "app:build", "--failed", "--format", "json"]),
    // A run with failed tasks exits 1 after it printed; `--failed` filters to them.
    replay(["--run", "failed-run"]),
    replay(["--run", "failed-run", "--format", "json"]),
    replay(["--run", "failed-run", "--failed"]),
    replay(["--run", "failed-run", "--failed", "--format", "json"]),
    replay(["--run", "failed-run", "--task", "app:build"]),
    replay(["--run", "failed-run", "--task", "app:crash"]),
    replay(["--run", "failed-run", "--task", "app:crash", "--format", "json"]),
    replay(["--run", "failed-run", "--task", "app:test", "--failed"]),
    replay(["--run", "failed-run", "--task", "app:test", "--failed", "--format", "json"]),
    replay(["--run", "failed-run", "--task", "app:lint"]),
    replay(["--run=failed-run", "--task=app:build", "--format=json"]),
    // No tasks, and no duration.
    replay(["--run", "empty-run"]),
    replay(["--run", "empty-run", "--format", "json"]),
    replay(["--run", "empty-run", "--failed"]),
    replay(["--run", RUN_2]),
    replay(["--run", RUN_1, "--format", "json"]),
    replay(["--run", "no-such-run"]),
    replay(["--run", "no-such-run", "--format", "json"]),
    replay(["--run", "no-such-run", "--task", "app:build"]),
    // `--list` wins over the other flags; times and ties are ordered as `fs.readdir` plus `stat` order them.
    replay(["--list"]),
    replay(["--list", "--format", "json"]),
    replay(["--list", "--failed", "--task", "app:build"]),
    replay(["--list"], { env: { COLUMNS: "45" } }),
    replay(["--list"], { workspace: "empty" }),
    replay(["--list", "--format", "json"], { workspace: "empty" }),
    replay(["--list"], { workspace: "empty-runs-directory" }),
    replay(["--list", "--format", "json"], { workspace: "empty-runs-directory" }),
    replay(["--list"], { workspace: "no-runs" }),
    replay([], { workspace: "empty" }),
    replay(["--format", "json"], { workspace: "empty" }),
    replay(["--task", "app:build"], { workspace: "empty" }),
    replay([], { env: { COLUMNS: "45" }, workspace: "empty" }),
    replay(["--run", RUN_1], { workspace: "empty" }),
    replay([], { delegates: true, workspace: "unreadable" }),
    replay(["--format", "json"], { delegates: true, workspace: "unreadable" }),
    // Summaries the native path reads strictly: `null` and floats are not the same as absent, and an unknown key is kept.
    replay(["--run", "extra-env"], { workspace: "odd" }),
    replay(["--run", "extra-env", "--format", "json"], { workspace: "odd" }),
    replay(["--run", "task-no-deps", "--format", "json"], { delegates: true, workspace: "odd" }),
    replay(["--run", "null-duration"], { delegates: true, workspace: "odd" }),
    replay(["--run", "null-duration", "--format", "json"], { delegates: true, workspace: "odd" }),
    replay(["--run", "float-duration"], { delegates: true, workspace: "odd" }),
    replay(["--run", "float-duration", "--format", "json"], { delegates: true, workspace: "odd" }),
    replay(["--run", "no-env", "--format", "json"], { delegates: true, workspace: "odd" }),
    replay(["--run", "task-null-exit"], { delegates: true, workspace: "odd" }),
    replay(["--run", "task-null-exit", "--format", "json"], { delegates: true, workspace: "odd" }),
    replay(["--run", "task-float-duration"], { delegates: true, workspace: "odd" }),
    replay(["--run", "task-float-duration", "--format", "json"], { delegates: true, workspace: "odd" }),
    replay(["--run", "task-string-exit"], { delegates: true, workspace: "odd" }),
    replay(["--run", "task-string-exit", "--format", "json"], { delegates: true, workspace: "odd" }),
    replay(["--run", "array-task", "--format", "json"], { delegates: true, workspace: "odd" }),
    replay(["--run", "bom"], { delegates: true, workspace: "odd" }),
    replay(["--run", "bom", "--format", "json"], { delegates: true, workspace: "odd" }),
    // Argument shapes that are Node's.
    replay(["--format=JSON"], { delegates: true }),
    replay(["--format", "yaml"], { delegates: true }),
    replay(["--json"], { delegates: true }),
    replay(["app:build"], { delegates: true }),
    replay(["--failed", "--failed"], { delegates: true }),
    replay(["--task", "a", "--task", "b"], { delegates: true }),
    replay(["--task", ""], { delegates: true }),
    replay(["--run", "../x"], { delegates: true }),
    replay(["--no-failed"], { delegates: true }),

    // pail colours the header of its log lines where its colour detection says so, and the binary prints the same
    // codes (`piped_colour_level` in `term.rs`): the blocks `cache why` and `replay` print, over stdout and stderr.
    ...COLOUR_ENVIRONMENTS.flatMap((env): Case[] => [
        why(["app:build"], { env }),
        why(["app:same"], { env }),
        why(["app:missing"], { env }),
        why(["app:build"], { env, workspace: "empty" }),
        why(["app:build", "--format", "json"], { env }),
        replay(["--task", "app:build"], { env }),
        replay(["--task", "app:missing"], { env }),
        replay([], { env }),
        replay([], { env, workspace: "empty" }),
        replay(["--list"], { env, workspace: "empty" }),
        replay(["--format", "json"], { env }),
    ]),
    // The Node runtime warns on stderr, with its process id, when both are set; a colour flag is Node's too.
    ...DELEGATED_COLOUR_ENVIRONMENTS.flatMap((env): Case[] => [why(["app:build"], { delegates: true, env }), replay(["--task", "app:build"], { delegates: true, env })]),
    why(["app:build", "--no-color"], { delegates: true }),
    replay(["--no-color"], { delegates: true }),
    replay(["--color"], { delegates: true, env: { GITHUB_ACTIONS: "true" } }),
];

/** The commands each case runs, as the words after `vis`. */
const argvOf = (entry: Case): string[] => [...entry.command.split(" "), ...entry.args];

/**
 * Whether the Node side can run at all: the CLI loads the task-runner addon at start, and without it
 * every case would fail instead of being skipped.
 */
const nodeAddonLoads = (): boolean => {
    if (!binary || !existsSync(nodeEntry)) {
        return false;
    }

    const probe = mkdtempSync(join(tmpdir(), "vis-summary-probe-"));

    writeFileSync(join(probe, "package.json"), '{"name":"probe"}');

    try {
        const { stderr } = spawnSync(process.execPath, [nodeEntry, "replay"], { cwd: probe, encoding: "utf8", env: environment() });

        return !stderr.includes("native addon could not be loaded");
    } finally {
        rmSync(probe, { force: true, recursive: true });
    }
};

const title = (entry: Case): string => `\`${entry.command} ${entry.args.join(" ")}\` (${entry.workspace}, ${JSON.stringify(entry.env ?? {})})`;

describe.skipIf(process.platform === "win32" || !nodeAddonLoads())("vis cache why and replay: native vs Node", () => {
    beforeAll(() => {
        counter = 0;
        scratch = mkdtempSync(join(tmpdir(), "vis-summary-parity-"));
        nativeBinary = join(scratch, "bin", "vis");

        mkdirSync(join(scratch, "bin"));
        copyFileSync(binary as string, nativeBinary);
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    const runNode = (argv: string[], root: string, extra: Record<string, string>) =>
        spawnSync(process.execPath, [nodeEntry, ...argv], { cwd: root, encoding: "utf8", env: environment(extra) });

    it.each(cases.filter((entry) => !entry.delegates).map((entry) => [title(entry), entry] as const))("prints what Node prints, without delegating: %s", (_title, entry: Case) => {
        expect.assertions(3);

        const root = workspaceFor(entry.workspace);
        const extra = entry.env ?? {};
        const argv = argvOf(entry);
        const node = runNode(argv, root, extra);
        // No VIS_FALLBACK_ENTRY: a declined invocation would exit 70 here instead of passing.
        const native = spawnSync(nativeBinary, argv, { cwd: root, encoding: "utf8", env: environment(extra) });

        expect(native.status).toBe(node.status);
        expect(normalize(native.stdout, root)).toBe(normalize(node.stdout, root));
        expect(normalize(native.stderr, root)).toBe(normalize(node.stderr, root));
    });

    it.each(cases.filter((entry) => entry.delegates).map((entry) => [title(entry), entry] as const))("hands the call to Node, which prints it: %s", (_title, entry: Case) => {
        expect.assertions(4);

        const root = workspaceFor(entry.workspace);
        const extra = entry.env ?? {};
        const argv = argvOf(entry);
        const node = runNode(argv, root, extra);
        // Without a fallback entry a declined call cannot reach Node and fails with exit 70.
        const bare = spawnSync(nativeBinary, argv, { cwd: root, encoding: "utf8", env: environment(extra) });
        const native = spawnSync(nativeBinary, argv, {
            cwd: root,
            encoding: "utf8",
            env: environment({ ...extra, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }),
        });

        expect(bare.status).toBe(70);
        expect(native.status).toBe(node.status);
        expect(normalize(native.stdout, root)).toBe(normalize(node.stdout, root));
        expect(normalize(native.stderr, root)).toBe(normalize(node.stderr, root));
    });
});
