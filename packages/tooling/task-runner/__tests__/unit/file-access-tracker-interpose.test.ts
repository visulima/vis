import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileAccessTracker } from "../../src/file-access-tracker";

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
    const root = join(import.meta.dirname, "..", "..", "native", "fspy_macos", "target");

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

    // The mode a file created with `requested` ends up with under this process's umask
    // (the tracked child inherits it).
    const expectedMode = (requested: number): number => {
        const previous = process.umask(0);

        process.umask(previous);

        return requested & ~previous & 0o777;
    };

    const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777;

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
            expect(await modeOf(target)).toBe(expectedMode(0o640));
            expect(result.accesses.some((a) => a.path === target && a.type === "write")).toBe(true);
        });

        it("creates a file with exactly the requested mode via openat(O_CREAT)", async () => {
            expect.assertions(2);

            const directory = join(workspaceRoot, "at-create");
            const target = join(directory, "created-openat.txt");

            await mkdir(directory);

            const result = await track([probe, "openat-create", directory, "created-openat.txt", "754"]);

            expect(result.code).toBe(0);
            expect(await modeOf(target)).toBe(expectedMode(0o754));
        });

        it("creates a file with exactly the requested mode via Node fs.writeFileSync", async () => {
            expect.assertions(3);

            const target = join(workspaceRoot, "created-node.txt");
            const script = `require("node:fs").writeFileSync(${JSON.stringify(target)}, "x", { mode: 0o600 })`;
            const result = await track([process.execPath, "-e", script]);

            expect(result.code).toBe(0);
            expect(await modeOf(target)).toBe(expectedMode(0o600));
            expect(result.accesses.some((a) => a.path === target && a.type === "write")).toBe(true);
        });

        it("creates a file with exactly the requested mode via Node fs.openSync", async () => {
            expect.assertions(2);

            const target = join(workspaceRoot, "created-node-open.txt");
            const script = `require("node:fs").closeSync(require("node:fs").openSync(${JSON.stringify(target)}, "w", 0o640))`;
            const result = await track([process.execPath, "-e", script]);

            expect(result.code).toBe(0);
            expect(await modeOf(target)).toBe(expectedMode(0o640));
        });
    });

});
