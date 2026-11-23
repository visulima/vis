import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";

/**
 * `vis ignore` exists twice: the Node command (`src/commands/ignore/handler.ts`) and the native
 * port (`native/cli/src/ignore.rs`). Each fixture under `native/cli/tests/fixtures/ignore/` is
 * copied into a scratch directory for every invocation, so `--write` never changes the checked-in
 * files. The native and Node runs must print the same stdout, exit the same way, and leave the
 * same ignore files behind. Node needs the built CLI (`dist/bin.js`) and the NAPI addon, so the
 * comparison is skipped when `dist/bin.js` is missing.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const fixturesRoot = join(packageRoot, "native", "cli", "tests", "fixtures", "ignore");

/**
 * Fixtures the native path answers in CI, from a working directory that holds a marker and has no
 * marked ancestor (the scratch copy's own `package.json`). The
 * others carry a config or Deno file, or an ignore file the native path cannot read as UTF-8, so
 * they reach Node and only the parity of the output is checked.
 */
const NATIVE_FIXTURES = ["bare-directory", "bom-npmignore", "crlf-vercelignore", "empty-project", "existing-dockerignore", "whitespace-slugignore"];

const VARIANTS: string[][] = [
    [],
    ["--target", "npm"],
    ["--target=vercel", "--write"],
    ["--target=slug", "--json"],
    ["--json"],
    ["--write"],
    ["--target=npm"],
    ["--target=bogus"],
];

const IGNORE_FILES = [".dockerignore", ".npmignore", ".slugignore", ".vercelignore"];

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-ignore-parity-")));

let counter: number;

/** A fresh copy of `fixture` in the scratch directory. */
const copyFixture = (fixture: string): string => {
    counter += 1;

    const directory = join(scratch, `${counter}-${fixture}`);

    cpSync(join(fixturesRoot, fixture), directory, { recursive: true });

    return directory;
};

/** Runs one command in `cwd` with a clean environment, so the caller's CI and colour variables do not leak in. */
const run = (command: string, args: string[], cwd: string, extraEnv: Record<string, string>) =>
    spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env: { HOME: process.env["HOME"] ?? "", PATH: process.env["PATH"] ?? "", VIS_CLI_TEST: "1", VIS_NO_UPDATE_CHECK: "1", ...extraEnv },
    });

/** The ignore files in `directory`, by name, so both runs can be compared after `--write`. */
const ignoreFilesIn = (directory: string): Record<string, string | null> =>
    Object.fromEntries(IGNORE_FILES.map((name) => [name, existsSync(join(directory, name)) ? readFileSync(join(directory, name), "utf8") : null]));

/** Node's CLI with the same environment the native run gets, except the native path itself. */
const nodeRun = (args: string[], cwd: string, extraEnv: Record<string, string> = {}) =>
    run(process.execPath, [nodeEntry, "ignore", ...args], cwd, { CI: "1", VIS_MONOREPO_ROOT: cwd, ...extraEnv });

/**
 * The native binary, with its own delegation target set so a delegated run can still reach Node.
 * `VIS_MONOREPO_ROOT` is left unset: the gate computes the root itself.
 */
const nativeRun = (args: string[], cwd: string, extraEnv: Record<string, string> = {}) =>
    run(binary as string, ["ignore", ...args], cwd, {
        CI: "1",
        VIS_FALLBACK_ENTRY: nodeEntry,
        VIS_NODE: process.execPath,
        ...extraEnv,
    });

const fixtures = existsSync(fixturesRoot) ? readdirSync(fixturesRoot).sort() : [];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis ignore: native vs Node", () => {
    beforeAll(() => {
        counter = 0;
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it.each(fixtures)("prints the same output and writes the same files for %s", (fixture) => {
        expect.assertions(24);

        for (const variant of VARIANTS) {
            const nativeDirectory = copyFixture(fixture);
            const nodeDirectory = copyFixture(fixture);

            const native = nativeRun(variant, nativeDirectory);
            const node = nodeRun(variant, nodeDirectory);

            expect(native.status).toBe(node.status);
            expect(native.stdout).toBe(node.stdout);
            expect(ignoreFilesIn(nativeDirectory)).toStrictEqual(ignoreFilesIn(nodeDirectory));
        }
    }, 120_000);

    it.each(NATIVE_FIXTURES)("answers %s natively, without a Node fallback", (fixture) => {
        expect.assertions(4);

        const directory = copyFixture(fixture);
        const missingEntry = join(scratch, "missing-entry.js");

        // Node cannot run from a missing entry, so a delegated run would fail with a different status.
        const native = nativeRun([], directory, { VIS_FALLBACK_ENTRY_OVERRIDE: missingEntry });
        const node = nodeRun([], copyFixture(fixture));

        expect(native.status).toBe(0);
        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe("");

        const writeDirectory = copyFixture(fixture);
        const nativeWrite = nativeRun(["--write"], writeDirectory, { VIS_FALLBACK_ENTRY_OVERRIDE: missingEntry });

        expect(nativeWrite.status).toBe(0);
    }, 60_000);

    it("delegates when VIS_MONOREPO_ROOT names another directory", () => {
        expect.assertions(1);

        const directory = copyFixture("empty-project");
        const missingEntry = join(scratch, "missing-entry.js");

        // A delegated run cannot reach a missing entry, so a non-zero status shows the binary handed over.
        // Node's own output is not compared here: a delegated run would only compare Node with itself.
        const stale = nativeRun([], directory, {
            VIS_FALLBACK_ENTRY: missingEntry,
            VIS_FALLBACK_ENTRY_OVERRIDE: missingEntry,
            VIS_MONOREPO_ROOT: scratch,
        });

        expect(stale.status).not.toBe(0);
    }, 60_000);

    it("delegates when an ancestor holds a root marker, and matches Node", () => {
        expect.assertions(3);

        const ancestor = join(scratch, "ancestor-marker");
        const missingEntry = join(scratch, "missing-entry.js");

        mkdirSync(join(ancestor, "child"), { recursive: true });
        writeFileSync(join(ancestor, "package.json"), "{}");

        const directory = join(ancestor, "child");

        writeFileSync(join(directory, "package.json"), "{}");

        const delegated = nativeRun([], directory, { VIS_FALLBACK_ENTRY: missingEntry, VIS_FALLBACK_ENTRY_OVERRIDE: missingEntry });
        const native = nativeRun([], directory, { VIS_FALLBACK_ENTRY: nodeEntry });
        const node = nodeRun([], directory);

        expect(delegated.status).not.toBe(0);
        expect(native.status).toBe(node.status);
        expect(native.stdout).toBe(node.stdout);
    }, 60_000);

    it("keeps the write sequence identical across repeated runs", () => {
        expect.assertions(6);

        const nativeDirectory = copyFixture("existing-dockerignore");
        const nodeDirectory = copyFixture("existing-dockerignore");

        for (const step of [["--write"], [], ["--write"], ["--json"]]) {
            const native = nativeRun(step, nativeDirectory);
            const node = nodeRun(step, nodeDirectory);

            expect(native.stdout).toBe(node.stdout);
        }

        expect(ignoreFilesIn(nativeDirectory)).toStrictEqual(ignoreFilesIn(nodeDirectory));
        expect(ignoreFilesIn(nativeDirectory)[".dockerignore"]).toContain("# Added by vis ignore");
    }, 60_000);

    it("delegates outside CI and matches Node's stdout and exit status", () => {
        expect.assertions(2);

        const directory = copyFixture("empty-project");
        const native = run(binary as string, ["ignore"], directory, {
            VIS_FALLBACK_ENTRY: nodeEntry,
            VIS_MONOREPO_ROOT: directory,
            VIS_NODE: process.execPath,
        });
        const node = run(process.execPath, [nodeEntry, "ignore"], directory, { VIS_MONOREPO_ROOT: directory });

        expect(native.status).toBe(node.status);
        expect(native.stdout).toBe(node.stdout);
    }, 60_000);

    // The dimmed hint of the preview is the only coloured line. The native path prints it in escape codes exactly where
    // Node's colour detection (`piped_colour_level` in `term.rs`) turns colour on. A missing fallback entry makes a
    // delegated run fail, so every pass here was answered natively. The ambient environment is not passed on.
    describe.each(COLOUR_ENVIRONMENTS)("colour environment %j", (colour) => {
        it.each([[[]], [["--target", "npm"]], [["--json"]], [["--write"]]] as string[][][])("prints what Node prints for `ignore %j`", (variant: string[]) => {
            expect.assertions(5);

            const missingEntry = join(scratch, "missing-entry.js");
            const nativeDirectory = copyFixture("existing-dockerignore");
            const nodeDirectory = copyFixture("existing-dockerignore");
            const native = nativeRun(variant, nativeDirectory, { ...colour, VIS_FALLBACK_ENTRY: missingEntry, VIS_FALLBACK_ENTRY_OVERRIDE: missingEntry });
            const node = nodeRun(variant, nodeDirectory, colour);

            expect(native.status).toBe(node.status);
            expect(native.stdout).toBe(node.stdout);
            expect(native.stderr).toBe(node.stderr);
            expect(ignoreFilesIn(nativeDirectory)).toStrictEqual(ignoreFilesIn(nodeDirectory));
            // The preview's hint is dimmed in every colour environment that turns colour on, and only there.
            expect(native.stdout.includes("\u001B[2m")).toBe(node.stdout.includes("\u001B[2m"));
        });
    });

    // Node warns on stderr, with its process id, when `FORCE_COLOR` and `NO_COLOR` are both set, and its detection reads
    // a colour flag from the arguments: both stay Node's.
    it.each([
        ...DELEGATED_COLOUR_ENVIRONMENTS.map((colour) => [[], colour]),
        [["--no-color"], {}],
        [["--color"], { GITHUB_ACTIONS: "true" }],
    ] as [string[], Record<string, string>][])("delegates `ignore %j` with %j, and matches Node", (variant: string[], colour: Record<string, string>) => {
        expect.assertions(3);

        const normalize = (text: string): string => text.replaceAll(/\(node:\d+\)/g, "(node:PID)");
        const missingEntry = join(scratch, "missing-entry.js");
        const native = nativeRun(variant, copyFixture("empty-project"), { ...colour, VIS_FALLBACK_ENTRY: missingEntry, VIS_FALLBACK_ENTRY_OVERRIDE: missingEntry });
        const delegated = nativeRun(variant, copyFixture("empty-project"), colour);
        const node = nodeRun(variant, copyFixture("empty-project"), colour);

        // Without Node to hand over to, the declined run fails; with it, the output is Node's.
        expect(native.status).not.toBe(0);
        expect(normalize(delegated.stdout)).toBe(normalize(node.stdout));
        expect(normalize(delegated.stderr)).toBe(normalize(node.stderr));
    }, 60_000);
});
