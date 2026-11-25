import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `--help` / `-h` before a `--` on the package-manager commands (`exec`, `pm`, `remove`, `dedupe`, `link`,
 * `unlink`, `outdated`, `why`) prints vis's own help for the command and exits 0, in the Node CLI and in the
 * native binary alike. The binary used to hand the flag to the package manager: `vis why --help` printed
 * `pnpm why --help`, and `vis dedupe --help` / `vis link --help` ran the manager. The stub managers below
 * leave a marker when they run, so a run of one fails the test.
 *
 * After a `--` the flag is not a help request: `vis exec -- --help` runs the tool in both engines, and both print the same.
 * A leading global flag (`vis -v exec -h`) changes nothing. Every shape runs at 80 and 120 columns, with and without colour.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

const commands = ["exec", "pm", "remove", "dedupe", "link", "unlink", "outdated", "why"];

// `dedupe` takes no positional argument, and Node rejects an unknown one even next to a help flag, so it has the two plain shapes only.
const shapes = (command: string): string[][] => [
    [command, "--help"],
    ["-v", command, "-h"],
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

    const environment = (columns: string, color: boolean): Record<string, string> => {
        return {
            ...(color ? { FORCE_COLOR: "1" } : {}),
            COLUMNS: columns,
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

    const runNode = (args: string[], columns: string, color: boolean) => spawnSync(process.execPath, [nodeEntry, ...args], { cwd: paths.project, encoding: "utf8", env: environment(columns, color) });

    const runNative = (args: string[], columns: string, color: boolean) =>
        spawnSync(binary as string, args, {
            cwd: paths.project,
            encoding: "utf8",
            env: { ...environment(columns, color), VIS_FALLBACK_ENTRY: paths.stub, VIS_FALLBACK_ENTRY_OVERRIDE: paths.stub, VIS_NODE: process.execPath },
        });

    const variants = ["80", "120"].flatMap((columns) => [true, false].map((color) => [columns, color] as const));
    const matrix = commands.flatMap((command) => shapes(command)).flatMap((args) => variants.map(([columns, color]) => [args, columns, color] as const));

    it.each(matrix)("`vis %j` prints the vis help of the command at %s columns (colour: %s), in both engines, without running the manager", (args, columns, color) => {
        expect.assertions(9);

        const command = args.find((word) => commands.includes(word)) as string;
        const node = runNode(args, columns, color);
        const native = runNative(args, columns, color);

        expect(node.status).toBe(0);
        // `outdated` is an alias of `check`, which the help names.
        expect(stripVTControlCharacters(node.stdout)).toContain(`vis ${command === "outdated" ? "check" : command} [`);
        expect(native.status).toBe(0);
        expect(native.stdout).not.toContain("MANAGER-RAN");
        expect(native.stdout).not.toContain("NATIVE-DELEGATED");
        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe(node.stderr);
        expect(node.stdout).not.toContain("MANAGER-RAN");
        expect(existsSync(paths.marker)).toBe(false);
    });

    it("leaves a flag after `--` to the tool, in both engines", () => {
        expect.assertions(3);

        const node = runNode(["exec", "--", "--help"], "100", false);
        const native = runNative(["exec", "--", "--help"], "100", false);

        expect(native.status).toBe(node.status);
        expect(native.stdout).toBe(node.stdout);
        // The stub manager ran in both, so this was not the vis help.
        expect(native.stdout).toContain("MANAGER-RAN");
    });
});
