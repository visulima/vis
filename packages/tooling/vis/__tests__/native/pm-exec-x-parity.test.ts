import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { dispatchSubcommand } from "../../src/pm/pm-subcommand-dispatch";
import { resolveRuntime } from "../../src/runtime/resolve-runtime";

/**
 * Where the native `vis pm` and `vis x` follow Node's own code rather than a copy of it.
 *
 * - `vis pm &lt;sub>`: the native path answers only the subcommands that `dispatchSubcommand` passes through
 *   for every manager, and hands every other one to Node. The table is read from Node's function.
 * - `vis x`: the runtime comes from `resolveRuntime` (flag, `VIS_RUNTIME`, then the nearest lockfile), and an
 *   unknown runtime is reported with the message that function throws.
 *
 * The native run's environment is built from scratch: stub `bun` and `pnpm` on `PATH` that print a marker. The `pm`
 * cases point `VIS_NODE` at nothing, so a run the binary declines (hands to Node) ends with exit 70; the `x` cases
 * use a stub `node`, which is the runtime `vis x` starts.
 *
 * Needs the native `vis` binary (VIS_NATIVE_BIN or a local build); skipped otherwise.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);

const MANAGERS = [
    { name: "npm", version: "10.0.0" },
    { name: "pnpm", version: "9.0.0" },
    { name: "pnpm", version: "11.0.0" },
    { name: "yarn", version: "1.22.0" },
    { name: "yarn", version: "4.1.0" },
    { name: "bun", version: "1.1.0" },
];

// Every subcommand `vis pm` names in its usage line, plus others a user might pass.
const SUBCOMMANDS = [
    "cache",
    "publish",
    "audit",
    "list",
    "view",
    "config",
    "whoami",
    "login",
    "logout",
    "pack",
    "owner",
    "dist-tag",
    "search",
    "fund",
    "ping",
    "token",
    "deprecate",
    "rebuild",
    "prune",
    "plugin",
    "pkg",
    "ls",
    "info",
    "outdated",
];

let scratch: string;
let nativeBinary: string;
let counter: number;

const stub = (directory: string, name: string, body: string): void => {
    writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(directory, name), 0o755);
};

/** A project below `scratch` with `files`, and a `bin` of stubs: `node`/`bun` print a marker, `pnpm` prints its argv. */
const project = (files: Record<string, string>): { bindir: string; cwd: string } => {
    const root = join(scratch, String(counter++));
    const cwd = join(root, "project");
    const bindir = join(root, "bin");

    mkdirSync(cwd, { recursive: true });
    mkdirSync(bindir, { recursive: true });
    stub(bindir, "node", 'echo "NODE:$*"');
    stub(bindir, "bun", 'echo "BUN:$*"');
    stub(bindir, "pnpm", 'echo "PNPM:$*"');

    for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(cwd, name)), { recursive: true });
        writeFileSync(join(cwd, name), content);
    }

    return { bindir, cwd };
};

const runNative = (args: string[], cwd: string, bindir: string, env: Record<string, string> = {}) =>
    spawnSync(nativeBinary, args, {
        cwd,
        encoding: "utf8",
        env: {
            HOME: process.env["HOME"] ?? "",
            PATH: `${bindir}:/usr/bin:/bin`,
            VIS_CLI_TEST: "1",
            VIS_FALLBACK_ENTRY: join(scratch, "dist", "bin.js"),
            VIS_NODE: join(bindir, "node"),
            ...env,
        },
    });

describe.skipIf(!binary || process.platform === "win32")("vis pm / vis x: native follows Node's own resolution", () => {
    beforeAll(() => {
        scratch = mkdtempSync(join(tmpdir(), "vis-pm-exec-x-parity-"));
        nativeBinary = join(scratch, "vis");

        copyFileSync(binary as string, nativeBinary);
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it.each(SUBCOMMANDS)("vis pm %s: native answers it only where Node's dispatch passes it through for every manager", (subcommand) => {
        expect.assertions(1);

        const passesThroughEverywhere = MANAGERS.every((pm) => dispatchSubcommand(pm, subcommand, []).kind === "passthrough");
        const { bindir, cwd } = project({ "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: 9\n" });
        const native = runNative(["pm", subcommand], cwd, bindir, { VIS_NODE: join(scratch, "no-such-node") });

        // A declined run cannot start the missing Node and exits 70; a native run never gets that far.
        expect(native.status === 70).toBe(!passesThroughEverywhere);
    });

    const runtimeCases: [string, Record<string, string>, string[], Record<string, string>][] = [
        ["nearest lockfile beats a bun lockfile further up", { "app/package-lock.json": "{}", "bun.lock": "{}" }, [], {}],
        ["a bun lockfile at the working directory", { "app/bun.lockb": "", "bun.lock": "{}" }, [], {}],
        ["no lockfile", { "app/package.json": "{}" }, [], {}],
        ["bun next to a node lockfile", { "app/bun.lock": "{}", "app/yarn.lock": "" }, [], {}],
        ["an empty --runtime falls to VIS_RUNTIME", {}, ["--runtime="], { VIS_RUNTIME: "bun" }],
        ["an empty VIS_RUNTIME falls to the lockfile", { "app/bun.lock": "{}" }, [], { VIS_RUNTIME: "" }],
        ["--runtime node beats a bun lockfile", { "app/bun.lock": "{}" }, ["--runtime=node"], {}],
    ];

    it.each(runtimeCases)("vis x picks the runtime Node picks: %s", (_name, files, flags, env) => {
        expect.assertions(1);

        const { bindir, cwd } = project({ ...files, "app/app.ts": "" });
        const app = join(cwd, "app");
        const expected = resolveRuntime(app, { env, flag: flags[0]?.slice("--runtime=".length) }).runtime;
        const native = runNative(["x", ...flags, "app.ts"], app, bindir, env);

        expect(native.stdout.startsWith(expected === "bun" ? "BUN:run " : "NODE:--import ")).toBe(true);
    });

    it.each([
        ["--runtime=deno", {}],
        ["--runtime=", { VIS_RUNTIME: "deno" }],
        ["app.ts", { VIS_RUNTIME: "deno" }],
    ])("vis x reports an unknown runtime with the text Node throws (%s)", (argument, env) => {
        expect.assertions(3);

        const { bindir, cwd } = project({ "app.ts": "" });
        const flag = argument.startsWith("--runtime=") ? argument.slice("--runtime=".length) : undefined;
        let message = "";

        try {
            resolveRuntime(cwd, { env, flag });
        } catch (error) {
            message = (error as Error).message;
        }

        const native = runNative(argument.endsWith(".ts") ? ["x", argument] : ["x", argument, "app.ts"], cwd, bindir, env);

        expect(message).not.toBe("");
        expect(native.stderr).toBe(`${message}\n`);
        expect(native.status).toBe(1);
    });
});
