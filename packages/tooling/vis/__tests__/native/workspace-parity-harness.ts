/* eslint-disable vitest/no-standalone-expect -- the helpers are called from the tests that import them */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { withoutColour } from "./colour-environments";

/**
 * The harness of the native-vs-Node parity suites that run a command on generated pnpm workspaces
 * (`optimize-parity.test.ts`, `security-list-parity.test.ts`).
 *
 * Node needs the built CLI (`dist/bin.js`) and the NAPI addon, and the native side needs the `vis` binary, so the
 * suites are skipped when either is missing. "Native answered" is proved by running the binary without
 * `VIS_FALLBACK_ENTRY`: a declined invocation then exits 70 ("failed to launch Node CLI") instead of printing, so a
 * Node-vs-delegated-Node comparison cannot pass vacuously. The two sides run in workspaces whose paths have the same
 * length, because pail wraps its lines by the length of the paths it prints.
 */

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const binary = resolveNativeBinary(packageRoot);
export const nodeEntry = join(packageRoot, "dist", "bin.js");

/** A file's content, or `{ link }` for a symbolic link to that (relative) target. */
export type Files = Record<string, Buffer | string | { link: string }>;

export interface Result {
    status: number | null;
    stderr: string;
    stdout: string;
}

export interface Outcome {
    status: number | null;
    stderr: string;
    stdout: string;
    tree: Record<string, string>;
}

/** The files of a pnpm workspace whose projects are `packages/*`, with `files` on top. */
export const workspaceFiles = (files: Files, manifest: Record<string, unknown> = {}): Files => {
    return {
        "package.json": `${JSON.stringify({ name: "root", private: true, ...manifest }, null, 2)}\n`,
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
        "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
        ...files,
    };
};

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export class Harness {
    /** The environment of a run: the colour variables dropped, `CI` set unless `ci` is false. */
    public static environment(extra: Record<string, string> = {}, ci = true): Record<string, string> {
        return {
            ...withoutColour({ HOME: process.env["HOME"] ?? "", PATH: process.env["PATH"] ?? "" }),
            VIS_NO_UPDATE_CHECK: "1",
            ...(ci ? { CI: "1" } : {}),
            ...extra,
        };
    }

    /** Every file under `root`, relative path to hex, so a difference in any byte shows. */
    public static snapshot(root: string): Record<string, string> {
        const tree: Record<string, string> = {};

        for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
            const path = join(entry.parentPath, entry.name);

            if (lstatSync(path).isSymbolicLink()) {
                tree[relative(root, path)] = `link:${readlinkSync(path)}`;
            } else if (entry.isFile()) {
                tree[relative(root, path)] = readFileSync(path).toString("hex");
            }
        }

        return tree;
    }

    /**
     * Replaces the workspace root, the clock and the process id in the Node runtime's own warnings, and drops the random
     * `tip:` line a Node run outside CI may print (`showTip` picks one by chance, and the binary hands such a run to Node anyway).
     */
    public static normalize(text: string, root: string): string {
        return text
            .replaceAll(root, "<ROOT>")
            .replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS")
            .replaceAll(/\(node:\d+\)/g, "(node:PID)")
            .replaceAll(/\n[^\n]{0,6}tip: [^\n]*\n/g, "");
    }

    public static outcome(result: Result, root: string): Outcome {
        return { status: result.status, stderr: Harness.normalize(result.stderr, root), stdout: Harness.normalize(result.stdout, root), tree: Harness.snapshot(root) };
    }

    private scratch = "";

    private nativeBinary = "";

    private counter = 0;

    private readonly command: string[];

    public constructor(command: string[]) {
        this.command = command;
    }

    public setup(prefix: string): void {
        this.counter = 0;
        this.scratch = mkdtempSync(join(tmpdir(), prefix));
        this.nativeBinary = join(this.scratch, "bin", "vis");
        mkdirSync(join(this.scratch, "bin"));
        copyFileSync(binary as string, this.nativeBinary);
        chmodSync(this.nativeBinary, 0o755);
    }

    public teardown(): void {
        rmSync(this.scratch, { force: true, recursive: true });
    }

    /** A fresh directory holding `files`. `side` keeps the two sides' paths the same length. */
    public materialize(side: "native" | "node", files: Files): string {
        this.counter += 1;

        const root = join(this.scratch, side === "node" ? "a" : "b", String(this.counter).padStart(6, "0"));

        for (const [name, content] of Object.entries(files)) {
            mkdirSync(dirname(join(root, name)), { recursive: true });

            if (typeof content === "object" && !Buffer.isBuffer(content)) {
                symlinkSync(content.link, join(root, name));
            } else {
                writeFileSync(join(root, name), content);
            }
        }

        return realpathSync(root);
    }

    /** A pair of identical workspaces, for the Node side and the native side. */
    public pair(files: Files): [string, string] {
        const nodeRoot = this.materialize("node", files);

        this.counter -= 1;

        return [nodeRoot, this.materialize("native", files)];
    }

    public runNode(args: string[], cwd: string, extra: Record<string, string> = {}, ci = true): Result {
        return spawnSync(process.execPath, [nodeEntry, ...this.command, ...args], { cwd, encoding: "utf8", env: Harness.environment(extra, ci) });
    }

    public runNative(args: string[], cwd: string, extra: Record<string, string> = {}, ci = true, timeout?: number): Result {
        return spawnSync(this.nativeBinary, [...this.command, ...args], { cwd, encoding: "utf8", env: Harness.environment(extra, ci), timeout });
    }

    /**
     * Runs both sides on identical workspaces and expects identical outcomes; the native side must have answered.
     * `directory` is where each side runs, below the workspace root (the root itself by default).
     */
    public expectParity(files: Files, args: string[], extra: Record<string, string> = {}, directory = ""): Result {
        const [nodeRoot, nativeRoot] = this.pair(files);
        const node = this.runNode(args, join(nodeRoot, directory), extra);
        const native = this.runNative(args, join(nativeRoot, directory), extra);

        expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
        expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));

        return native;
    }

    /**
     * The native side declines (exit 70 without the Node entry, files untouched) and the delegated run matches Node; returns the
     * delegated run. `directory` is where each side runs, below the workspace root (the root itself by default).
     */
    public expectDelegation(files: Files, args: string[], extra: Record<string, string> = {}, ci = true, directory = ""): Result {
        const [nodeRoot, nativeRoot] = this.pair(files);
        const node = this.runNode(args, join(nodeRoot, directory), extra, ci);
        const probe = this.materialize("native", files);
        const before = Harness.snapshot(probe);
        const declined = this.runNative(args, join(probe, directory), extra, ci);

        expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
        expect(declined.stdout, "a declined run prints nothing").toBe("");
        expect(Harness.snapshot(probe), "a declined run must not touch the files").toStrictEqual(before);

        const native = this.runNative(args, join(nativeRoot, directory), { ...extra, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }, ci);

        expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));

        return native;
    }
}
