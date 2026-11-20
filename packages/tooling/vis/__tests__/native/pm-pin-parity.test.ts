import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * A plain `install.backend` of npm, pnpm or bun is run by the native `remove`, `dedupe`, `link`,
 * `unlink` and `why` commands instead of being handed to Node. For each pinned backend the native
 * path must hand the same package manager the same arguments as Node's resolver does.
 *
 * The native side runs the real binary with a stub package manager on PATH that echoes its argv, and
 * a stub Node that prints a marker and must not run. The Node side cannot spawn a package manager from
 * the built CLI here, so the expected argv comes from the same NAPI resolvers Node's pm-runner calls,
 * with the options its handlers build for the same flags. The workspace is a lerna root, the only
 * shape Node loads `vis.config` from, and carries a lockfile of a different manager, so the pin
 * decides the outcome.
 *
 * Needs the native `vis` binary (VIS_NATIVE_BIN or a local build) and the NAPI addon; skipped otherwise.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const addonPath = join(packageRoot, "index.js");

const BACKENDS = ["npm", "pnpm", "bun"] as const;

type Backend = (typeof BACKENDS)[number];

// A lockfile of a manager other than the pin, so the lockfile cannot choose the stub that runs.
const OTHER_LOCKFILE: Record<Backend, string> = { bun: "package-lock.json", npm: "pnpm-lock.yaml", pnpm: "yarn.lock" };

interface Napi {
    resolveDedupe: (pm: string, version: string, check: boolean) => { args: string[]; bin: string };
    resolveLink: (pm: string, version: string, target?: string | null) => { args: string[]; bin: string };
    resolveRemove: (pm: string, version: string, options: Record<string, unknown>) => { args: string[]; bin: string };
    resolveUnlink: (pm: string, version: string, packages: string[], recursive: boolean) => { args: string[]; bin: string };
    resolveWhy: (pm: string, version: string, options: Record<string, unknown>) => { args: string[]; bin: string };
}

const remove = { filter: [], global: false, packages: ["lodash"], recursive: false, saveDev: false, workspaceRoot: false };

/** Each verb with the Node resolver call its handler makes for the same argv. */
const VERBS: [string[], (napi: Napi, pm: string) => { args: string[]; bin: string }][] = [
    [["remove", "lodash"], (napi, pm) => napi.resolveRemove(pm, "latest", remove)],
    [["remove", "-D", "lodash"], (napi, pm) => napi.resolveRemove(pm, "latest", { ...remove, saveDev: true })],
    [["remove", "-g", "lodash"], (napi, pm) => napi.resolveRemove(pm, "latest", { ...remove, global: true })],
    [["dedupe"], (napi, pm) => napi.resolveDedupe(pm, "latest", false)],
    [["dedupe", "--check"], (napi, pm) => napi.resolveDedupe(pm, "latest", true)],
    [["link", "../shared"], (napi, pm) => napi.resolveLink(pm, "latest", "../shared")],
    [["unlink", "lodash"], (napi, pm) => napi.resolveUnlink(pm, "latest", ["lodash"], false)],
    [
        ["why", "lodash"],
        (napi, pm) =>
            napi.resolveWhy(pm, "latest", {
                depth: undefined,
                dev: false,
                filter: [],
                global: false,
                json: false,
                long: false,
                noOptional: false,
                packages: ["lodash"],
                parseable: false,
                prod: false,
                recursive: false,
            }),
    ],
];

let scratch = "";
let nativeBinary = "";
let napi: Napi | undefined;
let counter = 0;

/** A lerna workspace pinned to `backend`, with a bin directory holding a stub for each manager and a stub Node. */
const workspaceFor = (backend: Backend): { bindir: string; cwd: string } => {
    const root = join(scratch, `${backend}-${String(counter++)}`);
    const cwd = join(root, "project");
    const bindir = join(root, "bin");

    mkdirSync(cwd, { recursive: true });
    mkdirSync(bindir, { recursive: true });
    writeFileSync(join(cwd, "lerna.json"), '{ "packages": [] }\n');
    writeFileSync(join(cwd, "vis.config.ts"), `export default { install: { backend: "${backend}" } };\n`);
    writeFileSync(join(cwd, OTHER_LOCKFILE[backend]), "lockfileVersion: 9\n");

    for (const name of [...BACKENDS, "node"]) {
        const stub = join(bindir, name);
        const body = name === "node" ? "echo NODE-MARKER\nexit 99" : `echo "${name.toUpperCase()}:$*"`;

        writeFileSync(stub, `#!/bin/sh\n${body}\n`);
        chmodSync(stub, 0o755);
    }

    return { bindir, cwd };
};

const runNative = (args: string[], cwd: string, bindir: string) =>
    spawnSync(nativeBinary, args, {
        cwd,
        encoding: "utf8",
        env: {
            HOME: process.env["HOME"] ?? "",
            PATH: `${bindir}:/usr/bin:/bin`,
            VIS_FALLBACK_ENTRY: join(scratch, "no-such-entry.js"),
            VIS_NO_UPDATE_CHECK: "1",
            VIS_NODE: join(bindir, "node"),
        },
    });

describe.skipIf(!binary || process.platform === "win32" || !existsSync(addonPath))("pinned package manager: native vs Node resolver", () => {
    beforeAll(async () => {
        scratch = mkdtempSync(join(tmpdir(), "vis-pm-pin-parity-"));
        nativeBinary = join(scratch, "vis");

        copyFileSync(binary as string, nativeBinary);

        napi = await import(pathToFileURL(addonPath).href);
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    for (const backend of BACKENDS) {
        for (const [argv, expected] of VERBS) {
            it(`${backend} pin: vis ${argv.join(" ")} runs the pinned manager with Node's arguments`, () => {
                const { bindir, cwd } = workspaceFor(backend);
                const native = runNative(argv, cwd, bindir);
                const want = expected(napi as Napi, backend);

                expect(native.status).toBe(0);
                expect(native.stdout).not.toContain("NODE-MARKER");
                // Node's resolver may name another binary for the verb (pnpm global remove runs npm).
                expect(native.stdout.trim()).toBe(`${want.bin.toUpperCase()}:${want.args.join(" ")}`);
            });
        }
    }
});
