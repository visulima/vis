import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `cache` is a command group with no command of its own. `vis cache`, `vis cache --help` and
 * `vis cache -h` print the same listing as `vis help cache`, in the Node CLI and in the native
 * binary alike. The help flags print it on stdout and exit 0; the bare group is a usage error, as for
 * the other bare groups: the listing goes to stderr, stdout stays empty and the exit status is 1.
 * Both engines run every shape here and must agree on stdout, stderr and the exit status.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

const shapes: [string[], number][] = [
    [["cache", "--help"], 0],
    [["cache", "-h"], 0],
    [["cache"], 1],
    [["-v", "cache", "-h"], 0],
    [["cache", "--no-color"], 1],
];

const environment = (columns: string, color: boolean): Record<string, string> => {
    const env: Record<string, string> = {
        COLUMNS: columns,
        // The width lookup reads `COLUMNS` only together with `LINES`.
        LINES: "30",
        PATH: process.env["PATH"] ?? "",
        VIS_CLI_TEST: "1",
        VIS_NO_MCP_PROMOTE: "1",
        VIS_NO_SPONSOR: "1",
        VIS_NO_UPDATE_CHECK: "1",
        VIS_VERSION: version,
    };

    if (color) {
        env["FORCE_COLOR"] = "1";
    }

    return env;
};

describe.skipIf(!binary || !existsSync(nodeEntry))("vis cache group help: native vs Node", () => {
    const paths = { project: "", stub: "" };

    beforeAll(() => {
        paths.project = mkdtempSync(join(tmpdir(), "vis-cache-help-"));
        paths.stub = join(paths.project, "stub.mjs");

        writeFileSync(join(paths.project, "package.json"), '{"name":"t"}');
        // The stub stands in for Node behind the binary: the binary must answer without delegating.
        writeFileSync(paths.stub, 'console.log("NATIVE-DELEGATED");\nprocess.exit(99);\n');
    });

    afterAll(() => {
        rmSync(paths.project, { force: true, recursive: true });
    });

    const runNode = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, [nodeEntry, ...args], { cwd: paths.project, encoding: "utf8", env });

    const runNative = (args: string[], env: Record<string, string>, entry: string) =>
        spawnSync(binary as string, args, {
            cwd: paths.project,
            encoding: "utf8",
            env: { ...env, VIS_FALLBACK_ENTRY: entry, VIS_FALLBACK_ENTRY_OVERRIDE: entry, VIS_NODE: process.execPath },
        });

    it.each(shapes.flatMap(([args, code]) => ["80", "120"].map((columns) => [args, code, columns] as const)))(
        "`vis %j` exits %i and prints `vis help cache` at %s columns, in both engines",
        (args, code, columns) => {
            expect.assertions(8);

            const env = environment(columns, !args.includes("--no-color"));
            const expected = runNode(["help", "cache"], env);
            const node = runNode(args, env);
            const native = runNative(args, env, paths.stub);

            // The bare group (exit 1) lists on stderr, the help flags (exit 0) on stdout.
            const [listing, silent] = code === 0 ? (["stdout", "stderr"] as const) : (["stderr", "stdout"] as const);

            expect(expected.stdout).toContain("cache list");
            expect(node[listing]).toBe(expected.stdout);
            expect(node.status).toBe(code);
            expect(native[listing]).toBe(expected.stdout);
            expect(native[silent]).toBe(node[silent]);
            expect(native.status).toBe(code);
            expect(node[silent]).toBe("");
            expect(native[listing]).toBe(node[listing]);
        },
    );
});
