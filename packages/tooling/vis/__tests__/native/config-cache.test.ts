import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * A `vis.config.ts` that imports a helper cannot be read as a literal, so the native CLI asks
 * the Node CLI to evaluate it (`vis __emit-config`, `src/config/emit.ts`) and keeps the result
 * (`native/cli/src/config_cache.rs`). This runs the real binary against the real built CLI, with a
 * `node` wrapper that logs every start, and checks the three behaviours the cache promises:
 * a first run starts Node once, a repeat run starts no Node, and editing an imported module or
 * a variable the config read evaluates it again. The built CLI (`dist/bin.js`) and the native
 * binary are needed, so the suite is skipped when either is missing.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");

let scratch: string;
let nativeBinary: string;
let workspace: string;
let log: string;

const environment = (): Record<string, string> => {
    return {
        HOME: process.env["HOME"] ?? "",
        // The stubs come first so the pinned `npm` is ours.
        PATH: `${join(scratch, "stubs")}:/usr/bin:/bin`,
        VIS_FALLBACK_ENTRY: nodeEntry,
        VIS_NO_UPDATE_CHECK: "1",
        VIS_NODE: join(scratch, "stubs", "node"),
    };
};

const run = (extra: Record<string, string> = {}) =>
    spawnSync(nativeBinary, ["why", "lodash"], { cwd: workspace, encoding: "utf8", env: { ...environment(), ...extra } });

const nodeStarts = (): number => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

const writeHelper = (backend: string): void => {
    writeFileSync(join(workspace, "helper.ts"), `export const backend = process.env.VIS_CONFIG_CACHE_TEST_BACKEND ?? ${JSON.stringify(backend)};\n`);
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis.config evaluation cache", () => {
    beforeAll(() => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-config-cache-")));
        nativeBinary = join(scratch, "bin", "vis");
        workspace = join(scratch, "workspace");
        log = join(scratch, "node-starts.log");

        mkdirSync(join(scratch, "bin"));
        mkdirSync(join(scratch, "stubs"));
        mkdirSync(workspace);
        // A copy outside the package: a binary inside it replaces `VIS_FALLBACK_ENTRY` with the entry it finds.
        copyFileSync(binary as string, nativeBinary);
        chmodSync(nativeBinary, 0o755);

        writeFileSync(join(scratch, "stubs", "node"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${process.execPath}" "$@"\n`);
        writeFileSync(join(scratch, "stubs", "npm"), `#!/bin/sh\necho "PM:$*"\n`);
        chmodSync(join(scratch, "stubs", "node"), 0o755);
        chmodSync(join(scratch, "stubs", "npm"), 0o755);

        // Node reads `vis.config` only from a monorepo root, so the workspace is one.
        writeFileSync(join(workspace, "lerna.json"), '{"packages":[]}\n');
        writeFileSync(join(workspace, "yarn.lock"), "# yarn\n");
        writeFileSync(join(workspace, "package.json"), '{"name":"fixture","private":true}\n');
        writeFileSync(join(workspace, "base.ts"), 'export default { fileGroups: { src: ["src/**"] } };\n');
        writeFileSync(
            join(workspace, "vis.config.ts"),
            'import { backend } from "./helper";\nexport default { extends: "./base.ts", install: { backend } };\n',
        );
        writeHelper("npm");
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("evaluates the config once, serves repeat runs without Node, and notices edits", () => {
        expect.assertions(9);

        const first = run();

        expect(first.stdout).toBe("PM:explain lodash\n");
        expect(nodeStarts()).toBe(1);
        expect(readFileSync(log, "utf8")).toContain("__emit-config");

        const second = run();

        expect(second.stdout).toBe("PM:explain lodash\n");
        expect(nodeStarts()).toBe(1);

        // An edited import evaluates the config again, and the new value is used (pnpm is not installed here).
        writeHelper("pnpm");

        const third = run();

        expect(nodeStarts()).toBe(2);
        expect(third.stderr).toContain("pnpm");

        // The variable the helper reads is part of what the stored result depends on.
        writeHelper("npm");
        run();

        const fourth = run({ VIS_CONFIG_CACHE_TEST_BACKEND: "pnpm" });

        expect(nodeStarts()).toBe(4);
        expect(fourth.stderr).toContain("pnpm");
    });

    it("hands the command to Node when the cache is turned off", () => {
        expect.assertions(2);

        const before = nodeStarts();

        run({ VIS_NO_CONFIG_CACHE: "1" });

        // The unpinned Node CLI runs `why` itself, with no emitter start.
        expect(nodeStarts()).toBe(before + 1);
        expect(readFileSync(log, "utf8").trim().split("\n").at(-1)).not.toContain("__emit-config");
    });

    it("keeps its entries under node_modules/.cache/vis/config", () => {
        expect.assertions(1);

        expect(readdirSync(join(workspace, "node_modules", ".cache", "vis", "config")).length).toBeGreaterThan(0);
    });
});
