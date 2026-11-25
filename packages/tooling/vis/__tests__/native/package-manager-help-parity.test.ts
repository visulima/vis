import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `--help` / `-h` before a `--` on the package-manager commands (`exec`, `pm`, `remove`, `dedupe`, `link`,
 * `unlink`, `outdated`, `why`) prints vis's own help for the command and exits 0, in the Node CLI and in the
 * native binary alike. The binary used to hand the flag to the package manager: `vis why --help` printed
 * `pnpm why --help`, and `vis dedupe --help` / `vis link --help` ran the manager. The stub managers below
 * leave a marker when they run, so a run of one fails the test.
 *
 * `vis exec -- --help` is the tool's: after a `--` the flag is not a help request, and both engines agree on that too.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

const commands = ["exec", "pm", "remove", "dedupe", "link", "unlink", "outdated", "why"];

// `dedupe` takes no positional argument, and Node rejects an unknown one even next to a help flag, so it has the two plain shapes only.
const shapes = (command: string): string[][] => [
    [command, "--help"],
    [command, "-h"],
    ...(command === "dedupe" ? [] : [[command, "tool", "--help"]]),
    ...(command === "why" || command === "outdated" ? [[command, "--json", "-h"]] : []),
];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis package-manager commands, --help: native vs Node", () => {
    const paths = { bin: "", marker: "", project: "", stub: "" };

    beforeAll(() => {
        paths.project = mkdtempSync(join(tmpdir(), "vis-pm-help-"));
        paths.bin = join(paths.project, "bin");
        paths.marker = join(paths.project, "manager-ran");
        paths.stub = join(paths.project, "stub.mjs");

        mkdirSync(paths.bin);
        writeFileSync(join(paths.project, "package.json"), '{"name":"t"}');
        writeFileSync(join(paths.project, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
        // The stub stands in for Node behind the binary: the binary must answer without delegating.
        writeFileSync(paths.stub, 'console.log("NATIVE-DELEGATED");\nprocess.exit(99);\n');

        for (const manager of ["pnpm", "npm", "yarn", "bun"]) {
            const path = join(paths.bin, manager);

            writeFileSync(path, `#!/bin/sh\necho MANAGER-RAN\ntouch '${paths.marker}'\n`);
            chmodSync(path, 0o755);
        }
    });

    afterAll(() => {
        rmSync(paths.project, { force: true, recursive: true });
    });

    const environment = (): Record<string, string> => {
        return {
            COLUMNS: "100",
            // The width lookup reads `COLUMNS` only together with `LINES`.
            LINES: "30",
            PATH: `${paths.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
            VIS_CLI_TEST: "1",
            VIS_NO_MCP_PROMOTE: "1",
            VIS_NO_SPONSOR: "1",
            VIS_NO_UPDATE_CHECK: "1",
            VIS_VERSION: version,
        };
    };

    const runNode = (args: string[]) => spawnSync(process.execPath, [nodeEntry, ...args], { cwd: paths.project, encoding: "utf8", env: environment() });

    const runNative = (args: string[]) =>
        spawnSync(binary as string, args, {
            cwd: paths.project,
            encoding: "utf8",
            env: { ...environment(), VIS_FALLBACK_ENTRY: paths.stub, VIS_FALLBACK_ENTRY_OVERRIDE: paths.stub, VIS_NODE: process.execPath },
        });

    it.each(commands.flatMap((command) => shapes(command)))("`vis %j` prints the vis help of the command, in both engines, without running the manager", (...args: string[]) => {
        expect.assertions(9);

        const node = runNode(args);
        const native = runNative(args);

        expect(node.status).toBe(0);
        // `outdated` is an alias of `check`, which the help names.
        expect(node.stdout).toContain(`vis ${args[0] === "outdated" ? "check" : args[0]} [`);
        expect(native.status).toBe(0);
        expect(native.stdout).not.toContain("MANAGER-RAN");
        expect(native.stdout).not.toContain("NATIVE-DELEGATED");
        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe(node.stderr);
        expect(node.stdout).not.toContain("MANAGER-RAN");
        expect(existsSync(paths.marker)).toBe(false);
    });
});
