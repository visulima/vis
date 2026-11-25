/* eslint-disable vitest/no-standalone-expect -- the helpers are called from the tests that import them */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { Files, Result } from "./workspace-parity-harness";
import { Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * The harness of the parity suites for commands that delete or rewrite files (`cache clean`, `cache prune`).
 *
 * Both sides run on identical, throwaway `HOME` directories and workspaces and are compared on stdout, stderr, the
 * exit status AND the whole state left on disk: every path of the home and the workspace with its type, mode and
 * content. A run the binary declines must hand the call to Node before it prints or changes anything: with no Node
 * entry it then exits 70, leaves both trees as they were, and the delegated run matches Node.
 */

export interface Side {
    home: string;
    /** The workspace root, where the case's `cwd` is a directory below it. */
    root: string;
    workspace: string;
}

/** The arguments of a case: fixed, or built from the paths of the side they run on. */
export type Args = string[] | ((side: Side) => string[]);

const argsFor = (args: Args, side: Side): string[] => (typeof args === "function" ? args(side) : args);

export interface Fixture {
    home?: Files;
    workspace?: Files;
}

/**
 * A name as text; one that is not valid UTF-8 shows its lossy text and its bytes, so two trees still compare byte for
 * byte. The bytes follow a NUL, which no file name can hold, so no valid name can produce the same key.
 */
const nameKey = (name: Buffer): string => {
    const text = name.toString("utf8");

    return Buffer.from(text, "utf8").equals(name) ? text : `${text}\u0000hex:${name.toString("hex")}`;
};

/** Every path under `root` with its type, mode and content, so a changed mode or a leftover directory shows. */
export const tree = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};

    // Names are walked as bytes: Node decodes one that is not UTF-8 to U+FFFD, a path that names no entry.
    const walk = (directory: Buffer, keys: string[]): void => {
        for (const name of readdirSync(directory, { encoding: "buffer" })) {
            const path = Buffer.concat([directory, Buffer.from("/"), name]);
            const entryKeys = [...keys, nameKey(name)];

            // Repository metadata holds clocks, hashes and absolute paths that differ between the two sides.
            if (entryKeys.includes(".git")) {
                continue;
            }

            const stats = lstatSync(path);
            // eslint-disable-next-line no-bitwise -- the permission bits of the mode
            const mode = (stats.mode & 0o7777).toString(8);
            const key = entryKeys.join("/");

            if (stats.isSymbolicLink()) {
                out[key] = `link ${readlinkSync(path)}`;
            } else if (stats.isDirectory()) {
                out[key] = `dir ${mode}`;
                walk(path, entryKeys);
            } else {
                out[key] = `file ${mode} ${readFileSync(path).toString("hex")}`;
            }
        }
    };

    walk(Buffer.from(root), []);

    return out;
};

export const snapshot = (side: Side): Record<string, Record<string, string>> => {
    return { home: tree(side.home), workspace: tree(side.root) };
};

/** The two sides differ only in a directory name of the same length; the Node runtime's warnings carry a pid. */
export const normalized = (result: Result, side: Side): Result => {
    const replace = (text: string): string => Harness.normalize(text, side.root).replaceAll(side.home, "<HOME>");

    return { status: result.status, stderr: replace(result.stderr), stdout: replace(result.stdout) };
};

const environmentOf = (side: Side, extra: Record<string, string>): Record<string, string> => {
    return { HOME: side.home, ...extra };
};

export class DestructiveSuite {
    public readonly harness: Harness;

    public constructor(command: string[]) {
        this.harness = new Harness(command);
    }

    public setup(prefix: string): void {
        this.harness.setup(prefix);
    }

    public teardown(): void {
        this.harness.teardown();
    }

    /** A pair of identical homes and workspaces, for the Node side and the native side. */
    public sides(fixture: Fixture, cwd = ""): { native: Side; node: Side } {
        const files = workspaceFiles({ "packages/app/package.json": '{"name":"app"}\n', ...fixture.workspace });
        const [nodeWorkspace, nativeWorkspace] = this.harness.pair(files);
        const [nodeHome, nativeHome] = this.harness.pair({ ".home": "", ...fixture.home });

        return {
            native: { home: nativeHome, root: nativeWorkspace, workspace: join(nativeWorkspace, cwd) },
            node: { home: nodeHome, root: nodeWorkspace, workspace: join(nodeWorkspace, cwd) },
        };
    }

    /** The native side must answer, and leave the same disk and output as Node. */
    public expectParity(fixture: Fixture, args: Args, extra: Record<string, string> = {}, options: { cwd?: string; prepare?: (side: Side) => void } = {}): Result {
        const { native, node } = this.sides(fixture, options.cwd);

        for (const side of [native, node]) {
            options.prepare?.(side);
        }

        const nodeResult = this.harness.runNode(argsFor(args, node), node.workspace, environmentOf(node, extra));
        const nativeResult = this.harness.runNative(argsFor(args, native), native.workspace, environmentOf(native, extra));

        expect(nativeResult.status, `native stderr: ${nativeResult.stderr}`).not.toBe(70);
        expect(normalized(nativeResult, native)).toStrictEqual(normalized(nodeResult, node));
        expect(snapshot(native)).toStrictEqual(snapshot(node));

        return nativeResult;
    }

    /** The native side must decline before it prints or changes anything, and the hand-off must match Node. */
    public expectDelegation(fixture: Fixture, args: Args, extra: Record<string, string> = {}, options: { ci?: boolean; prepare?: (side: Side) => void } = {}): Result {
        const ci = options.ci ?? true;
        const { native, node, probe } = this.triple(fixture, options.prepare);
        const before = snapshot(probe);
        const declined = this.harness.runNative(argsFor(args, probe), probe.workspace, environmentOf(probe, extra), ci);

        expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
        expect(declined.stdout, "a declined run prints nothing").toBe("");
        expect(snapshot(probe), "a declined run must not touch the disk").toStrictEqual(before);

        const nodeResult = this.harness.runNode(argsFor(args, node), node.workspace, environmentOf(node, extra), ci);
        const delegated = this.harness.runNative(
            argsFor(args, native),
            native.workspace,
            environmentOf(native, { ...extra, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }),
            ci,
        );

        expect(normalized(delegated, native)).toStrictEqual(normalized(nodeResult, node));
        expect(snapshot(native)).toStrictEqual(snapshot(node));

        return delegated;
    }

    /** The native side must decline, and leave the disk as it was. Node is not run: the call is one that must not run twice. */
    public expectDeclined(fixture: Fixture, args: Args, extra: Record<string, string> = {}): void {
        const { native } = this.sides(fixture);
        const before = snapshot(native);
        const declined = this.harness.runNative(argsFor(args, native), native.workspace, environmentOf(native, extra));

        expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
        expect(declined.stdout, "a declined run prints nothing").toBe("");
        expect(snapshot(native), "a declined run must not touch the disk").toStrictEqual(before);
    }

    /** A pair as in {@link sides} and a third, untouched copy of the native side for the declined run. */
    private triple(fixture: Fixture, prepare?: (side: Side) => void): { native: Side; node: Side; probe: Side } {
        const { native, node } = this.sides(fixture);
        const { native: probe } = this.sides(fixture);

        for (const side of [native, node, probe]) {
            prepare?.(side);
        }

        return { native, node, probe };
    }
}
