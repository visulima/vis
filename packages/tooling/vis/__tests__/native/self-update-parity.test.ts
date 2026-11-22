import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `vis self-update` exists twice: the Node handler (`src/commands/upgrade/handler.ts`) and the native
 * path (`native/cli/src/self_update.rs`). Both ask npm for the latest version and may install one, so
 * the test puts a stub `npm` first on PATH that records its arguments and prints a version, and never
 * reaches the registry. Every case runs through both with the same arguments and a CI context; stdout,
 * stderr, the exit code and the stub's recorded calls must match. A second stub stands in for Node on
 * the native side, so a run that quietly delegated is caught by its marker.
 *
 * Both runs get an environment built from scratch: nothing of the machine (colour, CI or terminal
 * variables, the home directory with its tip and sponsor state) reaches them.
 *
 * Needs the native `vis` binary, the built CLI (`dist/bin.js`) and the NAPI addon; skipped otherwise.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const hasAddon = readdirSync(packageRoot).some((name) => name.endsWith(".node"));
const marker = "NATIVE-DELEGATED";

interface Run {
    calls: string;
    status: number | null;
    stderr: string;
    stdout: string;
}

interface Stub {
    /** Exit status of `npm install`. */
    installStatus?: number;
    /** The stub's version answer for `npm view`. */
    latest?: string;
    /** Exit status of `npm view` (it prints an error to stderr when not 0). */
    viewStatus?: number;
    /** A line the stub writes to stderr on `npm view`, as npm does for a warning. */
    warn?: string;
}

interface Case {
    args: string[];
    current?: string;
    stub?: Stub;
}

let scratch = "";
let nativeBinary = "";
let counter = 0;

const STUB_NPM = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$1" in
  view)
    [ -n "$STUB_WARN" ] && echo "$STUB_WARN" >&2
    if [ "\${STUB_VIEW_STATUS:-0}" != "0" ]; then echo "npm error network" >&2; exit "$STUB_VIEW_STATUS"; fi
    echo "\${STUB_LATEST:-9.9.9}"
    ;;
  install)
    echo "installing $*"
    echo "install warning" >&2
    exit "\${STUB_INSTALL_STATUS:-0}"
    ;;
esac
`;

/** The environment both runs get; `extra` overrides or adds to it. */
const environmentFor = (bindir: string, log: string, home: string, stub: Stub, current: string | undefined, extra: Record<string, string | undefined>): Record<string, string> => {
    const env: Record<string, string | undefined> = {
        CI: "1",
        HOME: home,
        // The real Node and its npm are not on PATH: a call that missed the stub must fail, not reach the registry.
        PATH: `${bindir}:/usr/bin:/bin`,
        STUB_INSTALL_STATUS: String(stub.installStatus ?? 0),
        STUB_LATEST: stub.latest ?? "9.9.9",
        STUB_LOG: log,
        STUB_VIEW_STATUS: String(stub.viewStatus ?? 0),
        STUB_WARN: stub.warn,
        VIS_VERSION: current,
        ...extra,
    };

    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
};

/** A fresh working directory, with a bin directory holding the stub npm and a stub Node. */
const sandbox = (): { bindir: string; cwd: string; home: string; log: string } => {
    const root = join(scratch, String(counter++));
    const cwd = join(root, "project");
    const bindir = join(root, "bin");
    const home = join(root, "home");

    for (const directory of [cwd, bindir, home]) {
        mkdirSync(directory, { recursive: true });
    }

    writeFileSync(join(bindir, "npm"), STUB_NPM);
    chmodSync(join(bindir, "npm"), 0o755);
    writeFileSync(join(bindir, "node"), `#!/bin/sh\necho ${marker}\nexit 99\n`);
    chmodSync(join(bindir, "node"), 0o755);
    writeFileSync(join(root, "stub-entry.js"), "");

    return { bindir, cwd, home, log: join(root, "npm.log") };
};

const readCalls = (log: string): string => (existsSync(log) ? readFileSync(log, "utf8") : "");

const runNode = (test: Case, extra: Record<string, string | undefined> = {}): Run => {
    const { bindir, cwd, home, log } = sandbox();
    const result = spawnSync(process.execPath, [nodeEntry, "self-update", ...test.args], {
        cwd,
        encoding: "utf8",
        env: environmentFor(bindir, log, home, test.stub ?? {}, test.current ?? "1.0.0", extra),
    });

    return { calls: readCalls(log), status: result.status, stderr: result.stderr, stdout: result.stdout };
};

/** The native binary, with a stub Node entry (a delegation prints the marker) or the real one. */
const runNative = (test: Case, options: { extra?: Record<string, string | undefined>; prepare?: (cwd: string) => void; realEntry?: boolean } = {}): Run => {
    const { bindir, cwd, home, log } = sandbox();

    options.prepare?.(cwd);

    const entry = options.realEntry ? nodeEntry : join(dirname(bindir), "stub-entry.js");
    const result = spawnSync(nativeBinary, ["self-update", ...test.args], {
        cwd,
        encoding: "utf8",
        env: environmentFor(bindir, log, home, test.stub ?? {}, test.current ?? "1.0.0", {
            VIS_FALLBACK_ENTRY: entry,
            VIS_NODE: options.realEntry ? process.execPath : join(bindir, "node"),
            ...options.extra,
        }),
    });

    return { calls: readCalls(log), status: result.status, stderr: result.stderr, stdout: result.stdout };
};

/** Node's error block names bundle paths and lines; the first line is the message. */
const withoutStack = (text: string): string =>
    text
        .split("\n")
        .filter((line) => !line.startsWith("    at "))
        .join("\n");

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry) || !hasAddon)("vis self-update: native vs Node", () => {
    beforeAll(() => {
        scratch = mkdtempSync(join(tmpdir(), "vis-self-update-parity-"));
        mkdirSync(join(scratch, "no-npm"));
        nativeBinary = join(scratch, "vis");

        copyFileSync(binary as string, nativeBinary);
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    /** The invocations the native path answers: it must print what Node prints and call npm the same way. */
    const NATIVE: [label: string, test: Case][] = [
        ["up to date", { args: [], current: "9.9.9" }],
        ["up to date with --check", { args: ["--check"], current: "9.9.9" }],
        ["up to date with --force --check", { args: ["--force", "--check"], current: "9.9.9" }],
        ["update available with --check", { args: ["--check"], current: "1.0.0" }],
        ["update available, installed", { args: [], current: "1.0.0" }],
        ["update available, installed with --silent", { args: ["--silent"], current: "1.0.0" }],
        ["--force when up to date", { args: ["--force"], current: "9.9.9" }],
        ["explicit version", { args: ["2.0.0"], current: "1.0.0" }],
        ["explicit version with --check", { args: ["--check", "2.0.0-next.1"], current: "1.0.0" }],
        ["explicit version that is the running one", { args: ["2.0.0", "--check"], current: "2.0.0" }],
        ["explicit version that is the running one, forced", { args: ["--force", "2.0.0", "--check"], current: "2.0.0" }],
        ["a warning on the query's stderr", { args: ["--check"], current: "1.0.0", stub: { warn: "npm warn something" } }],
        ["a warning on the query's stderr, installed", { args: [], current: "1.0.0", stub: { warn: "npm warn something" } }],
        ["the registry answers with a newer version", { args: ["--check"], current: "9.9.9", stub: { latest: "10.0.0-next.3" } }],
    ];

    for (const [label, test] of NATIVE) {
        it(`${label}: vis self-update ${test.args.join(" ")}`, { timeout: 30_000 }, () => {
            const native = runNative(test);
            const node = runNode(test);

            expect(native.stdout).not.toContain(marker);
            expect(native.stdout).toBe(node.stdout);
            expect(native.stderr).toBe(node.stderr);
            expect(native.status).toBe(node.status);
            expect(native.calls).toBe(node.calls);
        });
    }

    it("shows what the stub does: Node's own output for an update", { timeout: 30_000 }, () => {
        const node = runNode({ args: [], current: "1.0.0" });

        expect(node.stdout).toBe("info: checking for updates...\ninfo: found @visulima/vis@9.9.9 (current: 1.0.0)\ninfo: installing...\ninstalling install -g @visulima/vis@9.9.9\n\n✓ Updated @visulima/vis from 1.0.0 → 9.9.9\n");
        expect(node.calls).toBe("view @visulima/vis version\ninstall -g @visulima/vis@9.9.9\n");
    });

    /** Shapes and contexts the native path hands to Node: before npm is run at all, and with the marker shown. */
    const DELEGATED: [label: string, test: Case, extra?: Record<string, string | undefined>, prepare?: (cwd: string) => void][] = [
        ["an unknown flag", { args: ["--bogus"] }],
        ["a repeated flag", { args: ["--check", "--check"] }],
        ["a dist-tag", { args: ["latest"] }],
        ["a version with a prefix", { args: ["v2.0.0"] }],
        ["two versions", { args: ["1.0.0", "2.0.0"] }],
        ["a flag with a value", { args: ["--check=true"] }],
        ["a global flag", { args: ["--cwd", "."] }],
        ["no CI", { args: ["--check"] }, { CI: undefined }],
        ["CI turned off", { args: ["--check"] }, { CI: "0" }],
        ["no running version", { args: ["--check"] }, { VIS_VERSION: "" }],
        ["DEBUG set", { args: ["--check"] }, { DEBUG: "1" }],
        ["a CEREBRO setting", { args: ["--check"] }, { CEREBRO_OUTPUT_LEVEL: "16" }],
        ["an inherited monorepo root", { args: ["--check"] }, { VIS_MONOREPO_ROOT: "/somewhere" }],
        ["a vis config", { args: ["--check"] }, {}, (cwd) => { writeFileSync(join(cwd, "vis.config.json"), "{}\n"); }],
        ["a Deno file", { args: ["--check"] }, {}, (cwd) => { writeFileSync(join(cwd, "deno.json"), "{}\n"); }],
    ];

    for (const [label, test, extra, prepare] of DELEGATED) {
        it(`delegates ${label} before npm is run`, { timeout: 30_000 }, () => {
            const native = runNative(test, { extra, prepare });

            expect(native.stdout).toContain(marker);
            expect(native.calls).toBe("");
        });
    }

    it("delegates a failing query, and Node then reports the same error", { timeout: 30_000 }, () => {
        const test: Case = { args: ["--check"], current: "1.0.0", stub: { viewStatus: 1 } };
        const native = runNative(test);
        const delegated = runNative(test, { realEntry: true });
        const node = runNode(test);

        expect(native.stdout).toContain(marker);
        // The native query ran once, then Node ran its own; nothing the native path did shows in the output.
        expect(delegated.calls).toBe("view @visulima/vis version\nview @visulima/vis version\n");
        expect(delegated.stdout).toBe(node.stdout);
        expect(withoutStack(delegated.stderr)).toBe(withoutStack(node.stderr));
        expect(delegated.status).toBe(1);
        expect(node.status).toBe(1);
        expect(node.stderr).toContain("Error: Failed to query npm registry. Check your network connection.");
    });

    it("delegates npm missing from PATH, and Node then reports the same error", { timeout: 30_000 }, () => {
        const test: Case = { args: ["--check"], current: "1.0.0" };
        const delegated = runNative(test, { extra: { PATH: join(scratch, "no-npm") }, realEntry: true });

        expect(delegated.stdout).toBe("info: checking for updates...\n");
        expect(delegated.stderr).toContain("Error: Failed to query npm registry. Check your network connection.");
        expect(delegated.status).toBe(1);
    });

    // Known difference: the install cannot be taken back, so the lines printed before it are printed again
    // by Node, which also runs the install a second time before it reports the error.
    it("hands a failed install to Node, which repeats the lines and the install and then fails", { timeout: 30_000 }, () => {
        const test: Case = { args: [], current: "1.0.0", stub: { installStatus: 1 } };
        const delegated = runNative(test, { realEntry: true });
        const node = runNode(test);
        const lines = "info: checking for updates...\ninfo: found @visulima/vis@9.9.9 (current: 1.0.0)\ninfo: installing...\ninstalling install -g @visulima/vis@9.9.9\n";

        expect(node.stdout).toBe(lines);
        expect(delegated.stdout).toBe(`${lines}${lines}`);
        expect(delegated.calls).toBe("view @visulima/vis version\ninstall -g @visulima/vis@9.9.9\nview @visulima/vis version\ninstall -g @visulima/vis@9.9.9\n");
        expect(delegated.status).toBe(1);
        expect(node.status).toBe(1);
        expect(withoutStack(delegated.stderr)).toBe(`install warning\n${withoutStack(node.stderr)}`);
        expect(node.stderr).toContain("Error: Failed to update. Try running with sudo or fix npm permissions.");
    });
});
