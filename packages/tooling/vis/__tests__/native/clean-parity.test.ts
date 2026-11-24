import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";

/**
 * `vis clean` exists twice: the Node handler (`src/commands/clean/handler.ts`) and the native
 * path (`native/cli/src/clean.rs`). For each fixture under `native/cli/tests/fixtures/clean/` the
 * native path must print the same bytes as Node and remove the same paths, and the fixtures the
 * native path declines must be handed to Node unchanged. Node needs the built CLI (`dist/bin.js`)
 * and the NAPI addon, and the native side needs the `vis` binary, so the suite is skipped when
 * either is missing.
 *
 * Each case copies its fixture into a fresh directory, because the default mode deletes. The
 * gitignored `node_modules` directories are created from the case's `case.json`.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const fixturesRoot = join(packageRoot, "native", "cli", "tests", "fixtures", "clean");

// Scratch space is created in `beforeAll`, which does not run when the suite is skipped, so a
// skipped run leaves nothing behind.
let scratch: string;

// A copy outside the package: a binary inside it reads its own location and hands declined
// invocations to `dist/bin.js` itself, which would make the native path look like it answered.
let nativeBinary: string;

interface CaseConfig {
    /** The native path must decline this case, so the binary has to hand it to Node. */
    delegates?: boolean;
    /** Directories, relative to the workspace, to create with a placeholder file. */
    materialize: string[];
    /** Directories, relative to the workspace, made read-only so removing their children fails. */
    readOnly?: string[];
}

const FLAG_SETS: [string, string[]][] = [
    ["--dry-run", ["--dry-run"]],
    ["--dry-run --lockfile", ["--dry-run", "-l"]],
    ["no flags", []],
    ["--lockfile", ["-l"]],
];

const cases = readdirSync(fixturesRoot)
    .filter((name) => statSync(join(fixturesRoot, name)).isDirectory())
    .sort();

let counter: number;

/** Read-only directories of the copies made so far, restored before the scratch space is removed. */
const lockedDirectories: string[] = [];

/** A fresh copy of a fixture, with its `node_modules` directories created. */
const workspaceFor = (name: string): string => {
    const root = join(scratch, `${name}-${String(counter++)}`);

    cpSync(join(fixturesRoot, name), root, { recursive: true });

    const config = JSON.parse(readFileSync(join(fixturesRoot, name, "case.json"), "utf8")) as CaseConfig;

    for (const directory of config.materialize) {
        mkdirSync(join(root, directory), { recursive: true });
        writeFileSync(join(root, directory, "index.js"), "");
    }

    for (const directory of config.readOnly ?? []) {
        lockedDirectories.push(join(root, directory));
        chmodSync(join(root, directory), 0o555);
    }

    return realpathSync(root);
};

const configOf = (name: string): CaseConfig => JSON.parse(readFileSync(join(fixturesRoot, name, "case.json"), "utf8")) as CaseConfig;

/** Environment that keeps Node's notices off, with CI either set or cleared. */
const environment = (ci: boolean, extra: Record<string, string> = {}): Record<string, string> => {
    return {
        HOME: process.env["HOME"] ?? "",
        PATH: process.env["PATH"] ?? "",
        VIS_NO_UPDATE_CHECK: "1",
        ...(ci ? { CI: "1" } : {}),
        ...extra,
    };
};

const runNode = (args: string[], cwd: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [nodeEntry, "clean", ...args], { cwd, encoding: "utf8", env: environment(true, extra) });

const runNative = (args: string[], cwd: string, extra: Record<string, string> = {}, ci = true) =>
    spawnSync(nativeBinary, ["clean", ...args], { cwd, encoding: "utf8", env: environment(ci, extra) });

/** Every path under `root`, relative and sorted. */
const listTree = (root: string): Set<string> => new Set(readdirSync(root, { recursive: true }).map(String));

/** The paths a run removed: present before, gone after. */
const removedBy = (root: string, before: Set<string>): string[] => [...before].filter((path) => !listTree(root).has(path)).sort();

/** Replaces the workspace root, the clock and the process id in the Node runtime's own warnings, which differ between runs. */
const normalize = (text: string, root: string): string => text.replaceAll(root, "<ROOT>").replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS").replaceAll(/\(node:\d+\)/g, "(node:PID)");

const delegation = (): Record<string, string> => { return { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }; };

// Privileged processes remove files whatever their mode bits say, so a read-only directory does not
// make the removal fail there.
const privileged = process.getuid?.() === 0;

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis clean: native vs Node", () => {
    beforeAll(() => {
        counter = 0;
        scratch = mkdtempSync(join(tmpdir(), "vis-clean-parity-"));
        nativeBinary = join(scratch, "bin", "vis");

        mkdirSync(join(scratch, "bin"));
        copyFileSync(binary as string, nativeBinary);
    });

    afterAll(() => {
        for (const directory of lockedDirectories) {
            chmodSync(directory, 0o755);
        }

        rmSync(scratch, { force: true, recursive: true });
    });

    const nativeCases = cases.filter((name) => !configOf(name).delegates);
    const delegatedCases = cases.filter((name) => configOf(name).delegates);

    describe.each(nativeCases)("case %s", (name) => {
        it.each(FLAG_SETS)("`clean %s` prints and removes what Node does, without delegating", (_label: string, flags: string[]) => {
            expect.assertions(5);

            const nodeRoot = workspaceFor(name);
            const nativeRoot = workspaceFor(name);
            const nodeBefore = listTree(nodeRoot);
            const nativeBefore = listTree(nativeRoot);

            const node = runNode(flags, nodeRoot);
            // No VIS_FALLBACK_ENTRY: a declined invocation would exit 70 here instead of passing.
            const native = runNative(flags, nativeRoot);

            // A removal error exits 1 on both paths, so the status is compared with Node's.
            expect(native.status).toBe(node.status);
            expect(normalize(native.stdout, nativeRoot)).toBe(normalize(node.stdout, nodeRoot));
            // Error blocks are written to stderr by pail, so the two streams are compared apart.
            expect(normalize(native.stderr, nativeRoot)).toBe(normalize(node.stderr, nodeRoot));
            expect(removedBy(nativeRoot, nativeBefore)).toStrictEqual(removedBy(nodeRoot, nodeBefore));
            expect(node.status).toBe(native.status);
        });
    });

    describe.each(delegatedCases)("case %s (declined by the native path)", (name) => {
        it("exits 70 without the Node entry, so the native path did not answer", () => {
            expect.assertions(1);

            const native = runNative(["--dry-run"], workspaceFor(name));

            expect(native.status).toBe(70);
        });

        it.each(FLAG_SETS)("`clean %s` matches Node through delegation", (_label: string, flags: string[]) => {
            expect.assertions(3);

            const nodeRoot = workspaceFor(name);
            const nativeRoot = workspaceFor(name);
            const nodeBefore = listTree(nodeRoot);
            const nativeBefore = listTree(nativeRoot);

            const node = runNode(flags, nodeRoot);
            const native = runNative(flags, nativeRoot, delegation());

            expect(native.status).toBe(node.status);
            expect(normalize(native.stdout, nativeRoot)).toBe(normalize(node.stdout, nodeRoot));
            expect(removedBy(nativeRoot, nativeBefore)).toStrictEqual(removedBy(nodeRoot, nodeBefore));
        });
    });

    // A link to a directory outside the workspace, and one back to the workspace root: neither walk follows them, so the
    // dry run lists what the real run removes, nothing outside is deleted and the cycle ends.
    it.each([["--dry-run"], [""]])("never follows a symbolic link (flags: %j)", (flag: string) => {
        expect.assertions(6);

        const flags = flag === "" ? [] : [flag];
        const roots = [workspaceFor("workspace"), workspaceFor("workspace")] as const;
        const outsides = roots.map((root) => `${root}-outside`);

        for (const [index, root] of roots.entries()) {
            const outside = outsides[index] as string;

            mkdirSync(join(outside, "node_modules"), { recursive: true });
            writeFileSync(join(outside, "node_modules", "keep.js"), "");
            mkdirSync(join(root, "vendor"), { recursive: true });
            symlinkSync(outside, join(root, "vendor", "lib"));
            symlinkSync(root, join(root, "packages", "a", "loop"));
        }

        const [nodeRoot, nativeRoot] = roots;
        const node = runNode(flags, nodeRoot);
        const native = runNative(flags, nativeRoot);

        expect(native.status).toBe(node.status);
        expect(normalize(native.stdout, nativeRoot)).toBe(normalize(node.stdout, nodeRoot));
        expect(normalize(native.stderr, nativeRoot)).toBe(normalize(node.stderr, nodeRoot));
        expect(native.stdout).not.toContain("vendor");
        expect(existsSync(join(outsides[0] as string, "node_modules", "keep.js"))).toBe(true);
        expect(existsSync(join(outsides[1] as string, "node_modules", "keep.js"))).toBe(true);
    });

    it.skipIf(privileged)("writes a removal error to stderr and the successful removals to stdout", () => {
        expect.assertions(3);

        const root = workspaceFor("read-only-package");
        const native = runNative([], root);

        expect(native.status).toBe(1);
        expect(native.stderr).toMatch(/ERROR \.+\n\n.*packages\/locked\/node_modules/);
        expect(native.stdout).not.toContain("ERROR");
    });

    // Success lines (stdout), the cleaned count and the removal errors (stderr) in every colour environment, with the
    // removal itself compared too. The read-only package makes the error block, and a workspace without any
    // `node_modules` the "none found" line.
    describe.each(COLOUR_ENVIRONMENTS)("colour environment %j", (colour) => {
        it.each([
            ["workspace", ["--dry-run", "-l"]],
            ["workspace", []],
            ["no-node-modules", []],
            ["read-only-package", []],
        ] as [string, string[]][])("`clean` in %s with %j prints what Node prints, colour codes included", (name: string, flags: string[]) => {
            expect.assertions(5);

            const nodeRoot = workspaceFor(name);
            const nativeRoot = workspaceFor(name);
            const nodeBefore = listTree(nodeRoot);
            const nativeBefore = listTree(nativeRoot);

            const node = runNode(flags, nodeRoot, colour);
            const native = runNative(flags, nativeRoot, colour);

            expect(native.status).toBe(node.status);
            expect(normalize(native.stdout, nativeRoot)).toBe(normalize(node.stdout, nodeRoot));
            expect(normalize(native.stderr, nativeRoot)).toBe(normalize(node.stderr, nodeRoot));
            expect(removedBy(nativeRoot, nativeBefore)).toEqual(removedBy(nodeRoot, nodeBefore));
            // Colour is on exactly where the detection says so; the header of the first line shows it.
            expect(native.stdout.includes("\u001B[")).toBe(node.stdout.includes("\u001B["));
        });
    });

    it("writes the colour of the error block to stderr and keeps the success lines coloured on stdout", () => {
        expect.assertions(3);

        const root = workspaceFor("read-only-package");
        const native = runNative([], root, { GITHUB_ACTIONS: "true" });

        const esc = String.fromCodePoint(27);

        expect(native.stderr).toMatch(new RegExp(String.raw`${esc}\[31mERROR${esc}\[39m ${esc}\[90m\.{4}${esc}\[39m${esc}\[90m\.+${esc}\[39m\n\n.*packages/locked/node_modules`, "u"));
        expect(native.stdout).toContain(`${esc}[32mSUCCESS${esc}[39m`);
        expect(native.stdout).not.toContain("ERROR");
    });

    // The Node runtime warns on stderr, with its process id, when both variables are set, and a colour flag is read
    // from the arguments by Node's detection: both stay Node's.
    it.each([
        ...DELEGATED_COLOUR_ENVIRONMENTS.map((colour) => [["--dry-run"], colour]),
        [["--dry-run", "--no-color"], {}],
        [["--dry-run", "--color"], { GITHUB_ACTIONS: "true" }],
    ] as [string[], Record<string, string>][])("hands `clean %j` with %j to Node", (flags: string[], colour: Record<string, string>) => {
        expect.assertions(4);

        const name = nativeCases[0] as string;
        const nodeRoot = workspaceFor(name);
        const nativeRoot = workspaceFor(name);

        const node = runNode(flags, nodeRoot, colour);

        expect(runNative(flags, nativeRoot, colour).status).toBe(70);

        const native = runNative(flags, nativeRoot, { ...colour, ...delegation() });

        expect(native.status).toBe(node.status);
        expect(normalize(native.stdout, nativeRoot)).toBe(normalize(node.stdout, nodeRoot));
        expect(normalize(native.stderr, nativeRoot)).toBe(normalize(node.stderr, nodeRoot));
    });

    it("hands a run outside CI to Node, with Node's output", () => {
        expect.assertions(2);

        const name = nativeCases[0] as string;
        const nodeRoot = workspaceFor(name);
        const nativeRoot = workspaceFor(name);

        const node = spawnSync(process.execPath, [nodeEntry, "clean", "--dry-run"], { cwd: nodeRoot, encoding: "utf8", env: environment(false) });
        const native = runNative(["--dry-run"], nativeRoot, delegation(), false);

        expect(native.status).toBe(node.status);
        expect(normalize(native.stdout, nativeRoot)).toBe(normalize(node.stdout, nodeRoot));
    });
});
