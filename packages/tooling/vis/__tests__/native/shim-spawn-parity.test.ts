import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { binary, nodeEntry } from "./workspace-parity-harness";

/**
 * `vis __pm-shim &lt;pm>` when the real manager cannot be started: the native and the Node dispatcher both end with
 * exit 1 and a `vis shim: could not start &lt;name>: &lt;reason>` line on stderr. The reason is the platform's own text
 * (Node's `error.message`, Rust's `io::Error`), so only the prefix is compared. A manager a signal killed ends with 1
 * on both sides, with nothing printed.
 */

let root = "";

const run = (command: string, arguments_: string[]): { status: number | null; stderr: string } => {
    const result = spawnSync(command, arguments_, {
        cwd: root,
        encoding: "utf8",
        env: { HOME: root, PATH: `${join(root, "bin")}:/usr/bin:/bin`, VIS_NO_UPDATE_CHECK: "1" },
    });

    return { status: result.status, stderr: result.stderr };
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis __pm-shim: a manager that cannot start", () => {
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "vis-shim-spawn-parity-"));
        mkdirSync(join(root, "bin"));
        // On PATH and a file, but not executable.
        writeFileSync(join(root, "bin", "npm"), "#!/bin/sh\n");
        chmodSync(join(root, "bin", "npm"), 0o644);
        writeFileSync(join(root, "bin", "pnpm"), "#!/bin/sh\nkill -9 $$\n");
        chmodSync(join(root, "bin", "pnpm"), 0o755);
    });

    afterAll(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("exits 1 with the same message prefix natively and in Node", () => {
        expect.hasAssertions();

        const native = run(binary as string, ["__pm-shim", "npm", "install"]);
        const node = run(process.execPath, [nodeEntry, "__pm-shim", "npm", "install"]);

        expect(native.status).toBe(1);
        expect(node.status).toBe(1);
        expect(native.stderr).toMatch(/^vis shim: could not start npm: .+/u);
        expect(node.stderr).toMatch(/^vis shim: could not start npm: .+/u);
    });

    it("ends with 1 and no message when a signal killed the manager", () => {
        expect.hasAssertions();

        const native = run(binary as string, ["__pm-shim", "pnpm", "install"]);
        const node = run(process.execPath, [nodeEntry, "__pm-shim", "pnpm", "install"]);

        expect(native).toStrictEqual({ status: 1, stderr: "" });
        expect(node).toStrictEqual({ status: 1, stderr: "" });
    });
});
