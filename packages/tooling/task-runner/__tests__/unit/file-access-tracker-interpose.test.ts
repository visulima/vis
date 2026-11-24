import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileAccessTracker } from "../../src/file-access-tracker";
import { FingerprintManager } from "../../src/fingerprint";

// Regression tests for the macOS DYLD-interpose tracker (`fspy_macos` +
// `native/src/macos.rs`). Each one runs a real tracked child, so they only run
// where the interpose dylib and addon are built (macOS), and they need `cc` to
// compile a small probe binary that issues exact libc calls (`open` with a mode,
// `openat`, `chdir`) that Node's `fs` cannot express.
const isSupported = new FileAccessTracker(tmpdir(), []).isInterposeSupported();

const PROBE_SOURCE = String.raw`
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const char *op = argv[1];

    if (!strcmp(op, "create")) {
        // probe create <path> <octal mode>
        int fd = open(argv[2], O_CREAT | O_WRONLY | O_TRUNC, (mode_t)strtol(argv[3], NULL, 8));
        if (fd < 0) { perror("open"); return 1; }
        close(fd);
    } else if (!strcmp(op, "openat-create")) {
        // probe openat-create <dir> <name> <octal mode>
        int dirfd = open(argv[2], O_RDONLY);
        int fd = openat(dirfd, argv[3], O_CREAT | O_WRONLY | O_TRUNC, (mode_t)strtol(argv[4], NULL, 8));
        if (fd < 0) { perror("openat"); return 1; }
        close(fd);
    } else if (!strcmp(op, "openat-read")) {
        // probe openat-read <dir> <name>
        int dirfd = open(argv[2], O_RDONLY);
        int fd = openat(dirfd, argv[3], O_RDONLY);
        if (fd < 0) { perror("openat"); return 1; }
        close(fd);
    } else if (!strcmp(op, "chdir-read")) {
        // probe chdir-read <dir> <relative name>
        if (chdir(argv[2]) != 0) { perror("chdir"); return 1; }
        int fd = open(argv[3], O_RDONLY);
        if (fd < 0) { perror("open"); return 1; }
        close(fd);
    } else if (!strcmp(op, "open-missing")) {
        int fd = open(argv[2], O_RDONLY);
        if (fd >= 0) { close(fd); return 1; }
    } else if (!strcmp(op, "stat-missing")) {
        struct stat st;
        if (stat(argv[2], &st) == 0) return 1;
    } else {
        return 2;
    }

    return 0;
}
`;

const findDylib = (): string | undefined => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "fspy_macos", "target");

    return [join(root, "debug", "libfspy_macos.dylib"), join(root, "release", "libfspy_macos.dylib")].find((candidate) => {
        try {
            accessSync(candidate, fsConstants.R_OK);

            return true;
        } catch {
            return false;
        }
    });
};

describe.skipIf(!isSupported)("macOS interpose tracker", () => {
    let toolsDirectory: string;
    let probe: string;
    let workspaceRoot: string;
    let tracker: FileAccessTracker;

    /* eslint-disable no-bitwise -- permission bits */

    // The mode a file created with `requested` ends up with under this process's umask
    // (the tracked child inherits it).
    const expectedMode = (requested: number): number => {
        // eslint-disable-next-line sonarjs/file-permissions -- briefly clears the umask to read it back
        const previous = process.umask(0);

        process.umask(previous);

        return requested & ~previous & 0o777;
    };

    const modeOf = async (path: string): Promise<number> => {
        const { mode } = await stat(path);

        return mode & 0o7777;
    };
    /* eslint-enable no-bitwise */

    beforeAll(async () => {
        toolsDirectory = await realpath(await mkdtemp(join(tmpdir(), "interpose-tools-")));
        probe = join(toolsDirectory, "probe");

        await writeFile(join(toolsDirectory, "probe.c"), PROBE_SOURCE);

        const compiled = spawnSync("cc", [join(toolsDirectory, "probe.c"), "-o", probe], { encoding: "utf8" });

        if (compiled.status !== 0) {
            throw new Error(`could not compile the probe helper: ${compiled.stderr}`);
        }

        // `os.tmpdir()` on macOS is a symlink (`/var` -> `/private/var`); the dylib
        // reports real paths for the cwd, so use the resolved form throughout.
        workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "interpose-ws-")));
        tracker = new FileAccessTracker(workspaceRoot, []);
    });

    afterAll(async () => {
        await rm(toolsDirectory, { force: true, recursive: true });
        await rm(workspaceRoot, { force: true, recursive: true });
    });

    const track = (argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) =>
        tracker.trackInterpose(argv, { cwd: workspaceRoot, ...options });

    describe("variadic open(2) mode (arm64 passes the variadic argument on the stack)", () => {
        it("creates a file with exactly the requested mode via open(O_CREAT)", async () => {
            expect.assertions(3);

            const target = join(workspaceRoot, "created-open.txt");
            const result = await track([probe, "create", target, "640"]);

            expect(result.code).toBe(0);
            await expect(modeOf(target)).resolves.toBe(expectedMode(0o640));
            expect(result.accesses.some((a) => a.path === target && a.type === "write")).toBe(true);
        });

        it("creates a file with exactly the requested mode via openat(O_CREAT)", async () => {
            expect.assertions(2);

            const directory = join(workspaceRoot, "at-create");
            const target = join(directory, "created-openat.txt");

            await mkdir(directory);

            const result = await track([probe, "openat-create", directory, "created-openat.txt", "754"]);

            expect(result.code).toBe(0);
            await expect(modeOf(target)).resolves.toBe(expectedMode(0o754));
        });

        it("creates a file with exactly the requested mode via Node fs.writeFileSync", async () => {
            expect.assertions(3);

            const target = join(workspaceRoot, "created-node.txt");
            const script = `require("node:fs").writeFileSync(${JSON.stringify(target)}, "x", { mode: 0o600 })`;
            const result = await track([process.execPath, "-e", script]);

            expect(result.code).toBe(0);
            await expect(modeOf(target)).resolves.toBe(expectedMode(0o600));
            expect(result.accesses.some((a) => a.path === target && a.type === "write")).toBe(true);
        });

        it("creates a file with exactly the requested mode via Node fs.openSync", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "created-node-open.txt");
            const script = `require("node:fs").closeSync(require("node:fs").openSync(${JSON.stringify(target)}, "w", 0o640))`;
            const result = await track([process.execPath, "-e", script]);

            expect(result.code).toBe(0);
            await expect(modeOf(target)).resolves.toBe(expectedMode(0o640));
        });
    });

    describe("child processes spawned by the tracked process", () => {
        it("keeps reporting accesses of children started with a close-all-by-default spawn", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "read-by-grandchild.txt");

            await writeFile(target, "data");

            // libuv launches children with POSIX_SPAWN_CLOEXEC_DEFAULT, which closes every
            // descriptor the spawn does not name — including the report socket.
            const grandchild = `require("node:fs").readFileSync(${JSON.stringify(target)})`;
            const script = `
                const { spawnSync } = require("node:child_process");
                const result = spawnSync(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
                process.exit(result.status);
            `;
            const result = await track([process.execPath, "-e", script]);

            expect(result.code).toBe(0);
            expect(result.accesses.some((a) => a.path === target && a.type === "read")).toBe(true);
        });
    });

    describe("tracked process that closed the report socket", () => {
        it("can still spawn children", async () => {
            expect.assertions(1);

            const script = `
                const { closeSync } = require("node:fs");
                const { spawnSync } = require("node:child_process");
                closeSync(Number(process.env.FSPY_MACOS_FD));
                process.exit(spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" }).status);
            `;
            const result = await track([process.execPath, "-e", script]);

            expect(result.code).toBe(0);
        });
    });

    describe("relative paths", () => {
        it("resolves an openat() path against its directory descriptor", async () => {
            expect.assertions(2);

            const directory = join(workspaceRoot, "at-read");
            const target = join(directory, "inside.txt");

            await mkdir(directory);
            await writeFile(target, "data");

            const result = await track([probe, "openat-read", directory, "inside.txt"]);

            expect(result.code).toBe(0);
            expect(result.accesses.some((a) => a.path === target && a.type === "read")).toBe(true);
        });

        it("resolves a relative path against the directory the process changed into", async () => {
            expect.assertions(3);

            const directory = join(workspaceRoot, "chdir-read");
            const target = join(directory, "inside.txt");

            await mkdir(directory);
            await writeFile(target, "data");

            const result = await track([probe, "chdir-read", directory, "inside.txt"]);

            expect(result.code).toBe(0);
            expect(result.accesses.some((a) => a.path === target && a.type === "read")).toBe(true);
            expect(result.accesses.some((a) => a.path === join(workspaceRoot, "inside.txt"))).toBe(false);
        });

        it("keeps the caller's spelling of a workspace reached through a symlink", async () => {
            expect.assertions(2);

            // `os.tmpdir()` is `/var/...` on macOS while the kernel reports `/private/var/...`.
            const linkedRoot = await mkdtemp(join(tmpdir(), "interpose-linked-"));
            const directory = join(linkedRoot, "sub");
            const target = join(directory, "inside.txt");

            try {
                await mkdir(directory);
                await writeFile(target, "data");

                const linkedTracker = new FileAccessTracker(linkedRoot, []);
                const result = await linkedTracker.trackInterpose([probe, "chdir-read", directory, "inside.txt"], { cwd: linkedRoot });

                expect(result.code).toBe(0);
                expect(result.accesses.some((a) => a.path === target && a.type === "read")).toBe(true);
            } finally {
                await rm(linkedRoot, { force: true, recursive: true });
            }
        });

        it("resolves a relative path read by Node after process.chdir()", async () => {
            expect.assertions(2);

            const directory = join(workspaceRoot, "node-chdir");
            const target = join(directory, "inside.txt");

            await mkdir(directory);
            await writeFile(target, "data");

            const script = `process.chdir(${JSON.stringify(directory)}); require("node:fs").readFileSync("inside.txt")`;
            const result = await track([process.execPath, "-e", script]);

            expect(result.code).toBe(0);
            expect(result.accesses.some((a) => a.path === target && a.type === "read")).toBe(true);
        });
    });

    describe("environment of the tracked child", () => {
        it("keeps its own report socket and dylib when the caller env carries stale values", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "read-with-stale-env.txt");

            await writeFile(target, "data");

            const script = `require("node:fs").readFileSync(${JSON.stringify(target)})`;
            const result = await track([process.execPath, "-e", script], {
                env: { DYLD_INSERT_LIBRARIES: "/nonexistent/stale.dylib", FSPY_MACOS_FD: "99" },
            });

            expect(result.code).toBe(0);
            expect(result.accesses.some((a) => a.path === target && a.type === "read")).toBe(true);
        });
    });

    describe("report socket validation", () => {
        const dylib = findDylib();

        it.skipIf(dylib === undefined)("does not write access records into an unrelated stream descriptor", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "read-with-reused-fd.txt");

            await writeFile(target, "data");

            // fd 3 is a stream socket (not the datagram report socket) that the parent can read.
            const child = spawn(process.execPath, ["-e", `require("node:fs").readFileSync(${JSON.stringify(target)})`], {
                env: { ...process.env, DYLD_INSERT_LIBRARIES: dylib as string, FSPY_MACOS_FD: "3" },
                stdio: ["ignore", "ignore", "ignore", "pipe"],
            });
            const chunks: Buffer[] = [];

            child.stdio[3]?.on("data", (chunk: Buffer) => chunks.push(chunk));

            const code = await new Promise<number | null>((resolve) => {
                child.on("close", resolve);
            });

            expect(code).toBe(0);
            expect(Buffer.concat(chunks).toString("utf8")).toBe("");
        });
    });

    describe("failed lookups", () => {
        it("reports a failed open() of a missing file as missing", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "no-such-open.txt");
            const result = await track([probe, "open-missing", target]);

            expect(result.code).toBe(0);
            expect(result.accesses).toContainEqual({ path: target, type: "missing" });
        });

        it("reports a failed stat() of a missing file as missing", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "no-such-stat.txt");
            const result = await track([probe, "stat-missing", target]);

            expect(result.code).toBe(0);
            expect(result.accesses).toContainEqual({ path: target, type: "missing" });
        });

        it("reports a Node existsSync() probe of a missing file as missing", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "no-such-exists.txt");
            const script = `require("node:fs").existsSync(${JSON.stringify(target)})`;
            const result = await track([process.execPath, "-e", script]);

            expect(result.code).toBe(0);
            expect(result.accesses).toContainEqual({ path: target, type: "missing" });
        });

        it("does not report a missing file for an open() that creates it", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "created-not-missing.txt");
            const result = await track([probe, "create", target, "644"]);

            expect(result.accesses.some((a) => a.path === target && a.type === "write")).toBe(true);
            expect(result.accesses.some((a) => a.path === target && a.type === "missing")).toBe(false);
        });

        it("does not leave a probed directory as a missing input once the task creates it", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "probed-then-mkdir");
            const script = `const fs = require("node:fs"); if (!fs.existsSync(${JSON.stringify(target)})) fs.mkdirSync(${JSON.stringify(target)})`;
            const result = await track([process.execPath, "-e", script]);
            const manager = new FingerprintManager(workspaceRoot);
            const fingerprint = await manager.createFingerprint(result.accesses, "probe", {}, {}, [], [], "interpose");

            expect(fingerprint.missingFiles).toStrictEqual([]);
            await expect(manager.validate(fingerprint)).resolves.toBeUndefined();
        });

        it("invalidates a fingerprint when a probed path is created afterwards", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "probed-then-created.txt");
            const script = `require("node:fs").existsSync(${JSON.stringify(target)})`;
            const result = await track([process.execPath, "-e", script]);
            const manager = new FingerprintManager(workspaceRoot);
            const fingerprint = await manager.createFingerprint(result.accesses, "probe", {}, {}, [], [], "interpose");

            expect(fingerprint.missingFiles).toContain("probed-then-created.txt");

            await writeFile(target, "now it exists");

            const reasons = await manager.validate(fingerprint);

            expect(reasons?.some((r) => r.type === "file-created")).toBe(true);
        });
    });
});
