import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";

/**
 * `vis cache hash` exists twice: the Node handler (`src/commands/cache/hash.ts`) and the native
 * path (`native/cli/src/cache_hash.rs`). Both read a recorded run summary and print it. For every
 * invocation below the two must agree on stdout, stderr and the exit status, and the invocations
 * the native path declines must reach Node unchanged. Node needs the built CLI (`dist/bin.js`) and
 * the NAPI addons, the native side needs the `vis` binary, so the suite is skipped when either is
 * missing.
 *
 * The fixtures under `native/cli/tests/fixtures/cache-hash/` are workspaces holding hand-written
 * run summaries. Each case copies one into a fresh directory outside the repository, because the
 * binary reads its own location and Node's root search must stop at the copy.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const fixturesRoot = join(packageRoot, "native", "cli", "tests", "fixtures", "cache-hash");

let scratch: string;
// A copy outside the package: a binary inside it reads its own location and hands declined
// invocations to `dist/bin.js` itself, which would make the native path look like it answered.
let nativeBinary: string;
let counter: number;

/** The cache entries a fixture ships (`node_modules` is gitignored) go where `vis run` would have stored them. */
const placeCacheEntries = (root: string): void => {
    const entries = join(root, "cache-entries");

    if (existsSync(entries)) {
        cpSync(entries, join(root, "node_modules", ".cache", "vis"), { recursive: true });
    }
};

const workspaceFor = (name: string): string => {
    const root = join(scratch, `${name}-${String(counter++)}`);

    cpSync(join(fixturesRoot, name), root, { recursive: true });
    placeCacheEntries(root);

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

/** Replaces the workspace root, the clock and the process id in the Node runtime's own warnings, which differ between runs. */
const normalize = (text: string, root: string): string => text.replaceAll(root, "<ROOT>").replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS").replaceAll(/\(node:\d+\)/g, "(node:PID)");

interface Case {
    args: string[];
    /** The native path must decline the call, so the binary has to hand it to Node. */
    delegates?: boolean;
    /** Extra environment for both engines. */
    env?: Record<string, string>;
    workspace: string;
}

const RECORDED = "app:build";

const LONG_TASK = "@scope/pkg-with-a-very-long-name-for-wrapping:build:production";

const cases: Case[] = [
    // A task with every bucket, mixed-case and punctuated paths, layout and a long hash.
    { args: [RECORDED], workspace: "recorded" },
    { args: [RECORDED, "--format", "json"], workspace: "recorded" },
    { args: ["--format=json", RECORDED], workspace: "recorded" },
    { args: [RECORDED, "--format", "table"], workspace: "recorded" },
    { args: [RECORDED], env: { COLUMNS: "50" }, workspace: "recorded" },
    { args: [LONG_TASK], env: { COLUMNS: "60" }, workspace: "recorded" },
    { args: [LONG_TASK, "--format", "json"], workspace: "recorded" },
    { args: ["app:declared"], workspace: "recorded" },
    { args: ["app:declared", "--format", "json"], workspace: "recorded" },
    { args: ["app:cached"], workspace: "recorded" },
    { args: ["app:cached", "--format", "json"], workspace: "recorded" },
    { args: ["app:nohash"], workspace: "recorded" },
    { args: ["app:nohash", "--format", "json"], workspace: "recorded" },
    // `--run` reads `.vis/runs/<id>.json`.
    { args: [RECORDED, "--run", "older-run"], workspace: "recorded" },
    { args: [RECORDED, "--run=older-run", "--format", "json"], workspace: "recorded" },
    // An empty key is an ordinary key in JavaScript: it is sorted and printed with the others.
    { args: [RECORDED, "--run", "empty-key"], workspace: "recorded" },
    { args: [RECORDED, "--run", "empty-key", "--format", "json"], workspace: "recorded" },
    // Error paths: the task is not in the run, the run does not exist, there is no summary at all.
    { args: ["app:missing"], workspace: "recorded" },
    { args: ["app:missing", "--format", "json"], workspace: "recorded" },
    { args: [RECORDED, "--run", "no-such-run"], workspace: "recorded" },
    { args: [RECORDED, "--run", "no-such-run", "--format", "json"], workspace: "recorded" },
    { args: ["app:missing", "--run", "older-run"], workspace: "recorded" },
    { args: [RECORDED], workspace: "empty" },
    { args: [RECORDED, "--format", "json"], workspace: "empty" },
    { args: [RECORDED], env: { COLUMNS: "45" }, workspace: "empty" },
    { args: [RECORDED, "--run", "older-run"], workspace: "empty" },
    // `--format` other than the exact word `json` prints the table in Node, so it is not guessed here.
    { args: [RECORDED, "--format=JSON"], delegates: true, workspace: "recorded" },
    { args: [RECORDED, "--format", "yaml"], delegates: true, workspace: "recorded" },
    { args: [RECORDED, "--json"], delegates: true, workspace: "recorded" },
    { args: [], delegates: true, workspace: "recorded" },
    { args: [RECORDED, "--run", "../recorded/.vis/last-summary"], delegates: true, workspace: "recorded" },
    // The tracked inputs of a trace-mode task live in the cache entry its hash names: found, absent,
    // and an entry without a fingerprint.
    { args: ["app:trace"], workspace: "recorded" },
    { args: ["app:trace", "--format", "json"], workspace: "recorded" },
    { args: ["app:trace-missing"], workspace: "recorded" },
    { args: ["app:trace-missing", "--format", "json"], workspace: "recorded" },
    { args: ["app:trace-empty"], workspace: "recorded" },
    { args: ["app:trace-empty", "--format", "json"], workspace: "recorded" },
    // A fingerprint with a key this port does not know, and a cache directory the environment moves.
    { args: ["app:trace-odd"], delegates: true, workspace: "recorded" },
    { args: ["app:trace-odd", "--format", "json"], delegates: true, workspace: "recorded" },
    { args: ["app:trace"], delegates: true, env: { VIS_CACHE_DIRECTORY: "elsewhere" }, workspace: "recorded" },
    { args: ["app:build"], env: { VIS_CACHE_DIRECTORY: "elsewhere" }, workspace: "recorded" },
    // Non-ASCII paths print with UTF-16 widths in Node; JSON mode is exact, the table is Node's.
    { args: ["app:unicode"], delegates: true, workspace: "recorded" },
    { args: ["app:unicode", "--format", "json"], workspace: "recorded" },
    // Integer-like keys are ordered first by JavaScript.
    { args: ["app:numeric"], delegates: true, workspace: "recorded" },
    { args: ["app:numeric", "--format", "json"], delegates: true, workspace: "recorded" },
    // A summary that does not parse is "no summary" in Node, but serde and `JSON.parse` differ in what they accept.
    { args: [RECORDED], delegates: true, workspace: "unreadable" },
    { args: [RECORDED, "--format", "json"], delegates: true, workspace: "unreadable" },
    // pail colours the header of its log lines where its colour detection says so, and the binary prints the same
    // codes (`piped_colour_level` in `term.rs`). One block of cases per colour environment, over the table, the error
    // block that goes to stderr, and the "no summary" message. (Outside CI Node also prints a random tip on
    // stderr, so that context is covered by the routing fixture instead.)
    ...COLOUR_ENVIRONMENTS.flatMap((env): Case[] => [
        { args: [RECORDED], env, workspace: "recorded" },
        { args: ["app:missing"], env, workspace: "recorded" },
        { args: [RECORDED], env, workspace: "empty" },
        { args: [RECORDED, "--format", "json"], env, workspace: "recorded" },
        // The JSON forms print no pail block, whatever the colour environment: not on the error paths either.
        { args: ["app:missing", "--format", "json"], env, workspace: "recorded" },
        { args: [RECORDED, "--run", "no-such-run", "--format", "json"], env, workspace: "recorded" },
        { args: [RECORDED, "--format", "json"], env, workspace: "empty" },
    ]),
    // The Node runtime warns on stderr, with its process id, when both are set; a colour flag is Node's too.
    ...DELEGATED_COLOUR_ENVIRONMENTS.map((env): Case => { return { args: [RECORDED], delegates: true, env, workspace: "recorded" }; }),
    { args: [RECORDED, "--no-color"], delegates: true, workspace: "recorded" },
    { args: [RECORDED, "--color"], delegates: true, env: { GITHUB_ACTIONS: "true" }, workspace: "recorded" },
];

/**
 * Whether the Node side can run at all: the handler resolves the shared cache directory first, which
 * needs the task-runner addon, and without it every case would fail instead of being skipped.
 */
const nodeAddonLoads = (): boolean => {
    if (!binary || !existsSync(nodeEntry)) {
        return false;
    }

    const probe = mkdtempSync(join(tmpdir(), "vis-cache-hash-probe-"));

    writeFileSync(join(probe, "package.json"), '{"name":"probe"}');

    try {
        const { stderr } = spawnSync(process.execPath, [nodeEntry, "cache", "hash", "probe:probe"], { cwd: probe, encoding: "utf8", env: environment() });

        return !stderr.includes("native addon could not be loaded");
    } finally {
        rmSync(probe, { force: true, recursive: true });
    }
};

describe.skipIf(process.platform === "win32" || !nodeAddonLoads())("vis cache hash: native vs Node", () => {
    beforeAll(() => {
        counter = 0;
        scratch = mkdtempSync(join(tmpdir(), "vis-cache-hash-parity-"));
        nativeBinary = join(scratch, "bin", "vis");

        mkdirSync(join(scratch, "bin"));
        copyFileSync(binary as string, nativeBinary);
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    const runNode = (argv: string[], root: string, extra: Record<string, string>) =>
        spawnSync(process.execPath, [nodeEntry, ...argv], { cwd: root, encoding: "utf8", env: environment(extra) });

    it.each(cases.filter((entry) => !entry.delegates))("prints what Node prints, without delegating: `cache hash $args` ($workspace, $env)", ({ args, env, workspace }: Case) => {
        expect.assertions(3);

        const root = workspaceFor(workspace);
        const extra = env ?? {};
        const argv = ["cache", "hash", ...args];
        const node = runNode(argv, root, extra);
        // No VIS_FALLBACK_ENTRY: a declined invocation would exit 70 here instead of passing.
        const native = spawnSync(nativeBinary, argv, { cwd: root, encoding: "utf8", env: environment(extra) });

        expect(native.status).toBe(node.status);
        expect(normalize(native.stdout, root)).toBe(normalize(node.stdout, root));
        expect(normalize(native.stderr, root)).toBe(normalize(node.stderr, root));
    });

    it.each(cases.filter((entry) => entry.delegates))("hands the call to Node, which prints it: `cache hash $args` ($workspace, $env)", ({ args, env, workspace }: Case) => {
        expect.assertions(4);

        const root = workspaceFor(workspace);
        const extra = env ?? {};
        const argv = ["cache", "hash", ...args];
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

    // The shared cache of a linked worktree lives in the main checkout, which the native path finds
    // with the task-runner core crate and Node with the addon built from it.
    it("reads a trace-mode entry from the main worktree's cache when run in a linked worktree", () => {
        expect.assertions(8);

        const git = (cwd: string, ...gitArgs: string[]) =>
            spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...gitArgs], { cwd, encoding: "utf8" });

        const main = workspaceFor("recorded");
        const linked = `${main}-linked`;

        expect(git(main, "init", "-q").status).toBe(0);
        expect(git(main, "commit", "-q", "--allow-empty", "-m", "init").status).toBe(0);
        expect(git(main, "worktree", "add", "-q", "-b", "feature/branch", linked).status).toBe(0);

        // The linked checkout holds the summary only: its cache entries are the main checkout's.
        cpSync(join(main, ".vis"), join(linked, ".vis"), { recursive: true });

        for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
            copyFileSync(join(main, name), join(linked, name));
        }

        const root = realpathSync(linked);
        const argv = ["cache", "hash", "app:trace", "--format", "json"];

        const node = spawnSync(process.execPath, [nodeEntry, ...argv], { cwd: root, encoding: "utf8", env: environment() });
        const native = spawnSync(nativeBinary, argv, { cwd: root, encoding: "utf8", env: environment() });

        expect(native.status).toBe(node.status);
        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe(node.stderr);
        // The entry was found, so the fingerprint is printed rather than `null`.
        expect(node.stdout).toContain('"fileHashes"');
        expect(native.stdout).not.toContain('"trackedFingerprint": null');
    });
});
