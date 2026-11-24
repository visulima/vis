import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * The help surface decides its colour and its width itself, so both decisions have to be the Node CLI's:
 * colour from `@visulima/is-ansi-color-supported` (environment, then the flags, then the terminal hints; there is
 * no "stdout is not a terminal, so no colour" step), width from cerebro's lookup (`CEREBRO_TERMINAL_WIDTH`, the size of
 * stdout or stderr, `COLUMNS` together with `LINES`, then `/dev/tty` and `tput`).
 *
 * Every row runs both engines from a from-scratch environment with stdout and stderr piped (the common CI
 * case) and compares the bytes and the exit status. A row marked `native: true` is one the binary must answer
 * itself: its fallback is a stub that prints a marker, so a hand-off fails the row. A row marked `native: false` is one
 * the binary cannot decide without asking the terminal or Node's runtime; it hands the run to the real Node CLI before
 * printing, and the bytes must still agree.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

interface Row {
    args?: string[];
    /** Run without the `COLUMNS` / `LINES` pair every other row gets. */
    bare?: true;
    env: Record<string, string>;
    /** The binary answers without Node. */
    native: boolean;
}

/** `COLUMNS` and `LINES` together are the width of the case unless the row says otherwise. */
const SIZE = { COLUMNS: "100", LINES: "30" };

const colourRows: Row[] = [
    { env: {}, native: true },
    { env: { CI: "1", GITHUB_ACTIONS: "true" }, native: true },
    { env: { CI: "1", GITLAB_CI: "true" }, native: true },
    { env: { CI: "1" }, native: true },
    { env: { GITHUB_ACTIONS: "true" }, native: true },
    { env: { COLORTERM: "truecolor" }, native: true },
    { env: { COLORTERM: "yes" }, native: true },
    { env: { TERM: "xterm-256color" }, native: true },
    { env: { TERM: "xterm" }, native: true },
    { env: { CI: "1", GITHUB_ACTIONS: "true", TERM: "dumb" }, native: true },
    { env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.4.1" }, native: true },
    { env: { TERM_PROGRAM: "Apple_Terminal" }, native: true },
    { env: { TERM_PROGRAM: "vscode" }, native: true },
    { env: { TEAMCITY_VERSION: "10.0.1" }, native: true },
    { env: { AGENT_NAME: "agent", TF_BUILD: "True" }, native: true },
    { env: { TERMINAL_EMULATOR: "JetBrains-JediTerm" }, native: true },
    { env: { CLICOLOR_FORCE: "1" }, native: true },
    { env: { FORCE_COLOR: "1" }, native: true },
    { env: { FORCE_COLOR: "3" }, native: true },
    { env: { FORCE_COLOR: "0" }, native: true },
    { args: ["--help", "--color"], env: { FORCE_COLOR: "0" }, native: true },
    { env: { FORCE_COLOR: "-1" }, native: true },
    { args: ["--help", "--color"], env: { FORCE_COLOR: "-1" }, native: true },
    { env: { FORCE_COLOR: "abc" }, native: true },
    { env: { COLORTERM: "truecolor", FORCE_COLOR: "abc" }, native: true },
    { env: { FORCE_COLOR: "" }, native: true },
    { env: { FORCE_COLOR: "true" }, native: true },
    { env: { FORCE_COLOR: "false" }, native: true },
    { env: { CI: "1", FORCE_COLOR: "false", GITHUB_ACTIONS: "true" }, native: true },
    { env: { NO_COLOR: "1" }, native: true },
    { env: { NO_COLOR: "" }, native: true },
    { args: ["--help", "--color"], env: { NO_COLOR: "" }, native: true },
    { args: ["--help", "--color"], env: { NO_COLOR: "1" }, native: true },
    { env: { CI: "1", GITHUB_ACTIONS: "true", NO_COLOR: "" }, native: true },
    { args: ["--help", "--no-color"], env: { FORCE_COLOR: "1" }, native: true },
    { args: ["--help", "--no-color"], env: { CI: "1", GITHUB_ACTIONS: "true" }, native: true },
    { args: ["--no-color", "--help"], env: {}, native: true },
    { args: ["--help", "--color", "--no-color"], env: {}, native: true },
    { args: ["--color", "--help"], env: {}, native: true },
    { args: ["--help", "--color"], env: { TERM: "dumb" }, native: true },
    { args: ["help"], env: { CI: "1", GITHUB_ACTIONS: "true" }, native: true },
    { args: ["help", "cache"], env: { COLORTERM: "truecolor" }, native: true },
    { args: ["cache", "--help"], env: { TERM: "xterm-256color" }, native: true },
    { args: ["run", "--help"], env: { CI: "1", GITLAB_CI: "true" }, native: true },
    // The colour flags the binary does not know about are Node's.
    { args: ["--help", "--colors"], env: {}, native: false },
    { args: ["--help", "--color=256"], env: {}, native: false },
    { args: ["--help", "-color"], env: {}, native: false },
    // The Node runtime warns on stderr, with its process id, about these two variables together.
    { env: { FORCE_COLOR: "1", NO_COLOR: "1" }, native: false },
    { env: { FORCE_COLOR: "1", NODE_DISABLE_COLORS: "1" }, native: false },
    // Node counts a PM2 process as a terminal.
    { env: { PM2_HOME: "/tmp/pm2", pm_id: "0" }, native: false },
];

const widthRows: Row[] = [
    { env: { COLUMNS: "60", LINES: "30" }, native: true },
    { env: { COLUMNS: "120", LINES: "30" }, native: true },
    { env: { CEREBRO_TERMINAL_WIDTH: "70", COLUMNS: "120", LINES: "30" }, native: true },
    { env: { CEREBRO_TERMINAL_WIDTH: "100px" }, native: true },
    { env: { CEREBRO_TERMINAL_WIDTH: " 90" }, native: true },
    { env: { CEREBRO_TERMINAL_WIDTH: "+66" }, native: true },
    { env: { CEREBRO_TERMINAL_WIDTH: "abc", COLUMNS: "110", LINES: "30" }, native: true },
    { env: { CEREBRO_TERMINAL_WIDTH: "0", COLUMNS: "110", LINES: "30" }, native: true },
    { env: { CEREBRO_TERMINAL_WIDTH: "-5", COLUMNS: "110", LINES: "30" }, native: true },
    { args: ["cache", "--help"], env: { CEREBRO_TERMINAL_WIDTH: "64" }, native: true },
    { args: ["run", "--help"], env: { CEREBRO_TERMINAL_WIDTH: "64" }, native: true },
    // `COLUMNS` without `LINES` is the lookup's `tput` step, which the binary leaves to Node.
    { env: { COLUMNS: "120" }, native: false },
    { env: { COLUMNS: "120", LINES: "" }, native: false },
    // Numbers `parseInt` reads from text that is no clean number, which `COLUMNS` and `LINES` carry unchecked.
    { env: { COLUMNS: "abc", LINES: "30" }, native: false },
    { env: { COLUMNS: "", LINES: "30" }, native: false },
    { env: { COLUMNS: "0", LINES: "30" }, native: false },
    // No size at all: the answer is a terminal's (`/dev/tty`, `tput`), so the run may be either engine's.
    { bare: true, env: {}, native: false },
    { bare: true, env: { TERM: "xterm-256color" }, native: false },
];

/** The shapes of `--version` next to a help flag: help wins, as in cerebro. */
const versionRows: Row[] = [
    { args: ["--version", "--help"], env: SIZE, native: true },
    { args: ["-V", "-h"], env: SIZE, native: true },
    { args: ["--version", "--no-color", "--help"], env: { ...SIZE, FORCE_COLOR: "1" }, native: true },
    { args: ["--version", "cache", "--help"], env: SIZE, native: true },
    { args: ["--version"], env: SIZE, native: true },
    { args: ["-V"], env: SIZE, native: true },
    { args: ["--version", "--", "--help"], env: SIZE, native: true },
    // Not answered natively, but Node's answer has to be the one printed.
    { args: ["--help", "--version"], env: SIZE, native: false },
    { args: ["-h", "-V"], env: SIZE, native: false },
];

/** The bare group lists on stderr; its colour is the one stdout's state gives, as `vis help cache` gets it. */
const groupRows: Row[] = [
    { args: ["cache"], env: {}, native: true },
    { args: ["cache"], env: { CI: "1", GITHUB_ACTIONS: "true" }, native: true },
    { args: ["cache"], env: { COLORTERM: "truecolor" }, native: true },
    { args: ["cache"], env: { FORCE_COLOR: "1" }, native: true },
    { args: ["cache"], env: { FORCE_COLOR: "0" }, native: true },
    { args: ["cache", "--color"], env: {}, native: true },
    { args: ["cache"], env: { NO_COLOR: "" }, native: true },
    { args: ["cache", "--no-color"], env: { FORCE_COLOR: "1" }, native: true },
];

const describeRow = ({ args = ["--help"], bare, env, native }: Row): string =>
    `\`vis ${args.join(" ")}\` with ${JSON.stringify(env)}${bare ? " and no size" : ""} ${native ? "answers natively" : "agrees through Node"}`;

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis help colour, width and version: native vs Node", () => {
    const paths = { project: "", stub: "" };

    beforeAll(() => {
        paths.project = mkdtempSync(join(tmpdir(), "vis-help-env-"));
        paths.stub = join(paths.project, "stub.mjs");

        writeFileSync(join(paths.project, "package.json"), '{"name":"t"}');
        // The stub stands in for Node behind the binary: a row that must be native fails when it is reached.
        writeFileSync(paths.stub, 'console.log("NATIVE-DELEGATED");\nprocess.exit(99);\n');
    });

    afterAll(() => {
        rmSync(paths.project, { force: true, recursive: true });
    });

    const environment = (row: Row): Record<string, string> => {
        return {
            PATH: process.env["PATH"] ?? "",
            VIS_CLI_TEST: "1",
            VIS_NO_MCP_PROMOTE: "1",
            VIS_NO_SPONSOR: "1",
            VIS_NO_UPDATE_CHECK: "1",
            VIS_VERSION: version,
            ...(row.bare ? {} : SIZE),
            ...row.env,
        };
    };

    const run = (row: Row) => {
        const args = row.args ?? ["--help"];
        const env = environment(row);
        const node = spawnSync(process.execPath, [nodeEntry, ...args], { cwd: paths.project, encoding: "utf8", env });
        const entry = row.native ? paths.stub : nodeEntry;
        const native = spawnSync(binary as string, args, {
            cwd: paths.project,
            encoding: "utf8",
            env: { ...env, VIS_FALLBACK_ENTRY: entry, VIS_FALLBACK_ENTRY_OVERRIDE: entry, VIS_NODE: process.execPath },
        });

        return { native, node };
    };

    const check = (row: Row) => {
        const { native, node } = run(row);

        expect(native.stdout).not.toContain("NATIVE-DELEGATED");
        expect(native.stdout).toBe(node.stdout);
        // Node's colour-variable warning carries its process id, which differs between two processes.
        expect(native.stderr.replaceAll(/\(node:\d+\)/g, "(node:PID)")).toBe(node.stderr.replaceAll(/\(node:\d+\)/g, "(node:PID)"));
        expect(native.status).toBe(node.status);
    };

    it.each([...colourRows, ...widthRows, ...versionRows, ...groupRows].map((row) => [describeRow(row), row] as const))("%s", (_name, row) => {
        expect.assertions(4);

        check(row);
    });

    it("reads the colour of the environment, not of a terminal: a CI provider colours the piped help", () => {
        expect.assertions(2);

        const { native } = run({ env: { ...SIZE, CI: "1", GITHUB_ACTIONS: "true" }, native: true });

        expect(native.stdout).toContain("\u001B[");
        expect(native.stdout).not.toContain("NATIVE-DELEGATED");
    });

    it("prints the root help for `--version --help`, not the version", () => {
        expect.assertions(2);

        const { native } = run({ args: ["--version", "--help"], env: SIZE, native: true });

        expect(native.stdout).toContain("Usage");
        expect(native.stdout).not.toBe(`${version}\n`);
    });

    it("holds at least twenty-five distinct colour environments", () => {
        expect.assertions(1);

        expect(new Set(colourRows.map((row) => JSON.stringify([row.env, row.args]))).size).toBeGreaterThanOrEqual(25);
    });
});
