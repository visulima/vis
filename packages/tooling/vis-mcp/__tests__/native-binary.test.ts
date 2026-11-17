import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { execVis } from "../src/exec";
import { isNativeExecutable, visCommand } from "../src/native-binary";

const FAKE_VIS = fileURLToPath(new URL("__fixtures__/fake-vis.mjs", import.meta.url));

describe(isNativeExecutable, () => {
    let directory: string;

    const write = (name: string, bytes: Buffer | string): string => {
        const file = join(directory, name);

        writeFileSync(file, bytes);

        return file;
    };

    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), "vis-mcp-native-"));
    });

    afterAll(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it.each([
        ["ELF", [0x7f, 0x45, 0x4c, 0x46]],
        ["Mach-O 64-bit little endian", [0xcf, 0xfa, 0xed, 0xfe]],
        ["Mach-O 32-bit little endian", [0xce, 0xfa, 0xed, 0xfe]],
        ["Mach-O 32-bit big endian", [0xfe, 0xed, 0xfa, 0xce]],
        ["Mach-O 64-bit big endian", [0xfe, 0xed, 0xfa, 0xcf]],
        ["Mach-O universal", [0xca, 0xfe, 0xba, 0xbe]],
        ["PE", [0x4d, 0x5a, 0x90, 0x00]],
    ])("should detect %s binaries", (name, bytes) => {
        expect.assertions(1);

        expect(isNativeExecutable(write(`bin-${name}`, Buffer.from(bytes)))).toBe(true);
    });

    it("should not treat a node script as native", () => {
        expect.assertions(2);

        expect(isNativeExecutable(write("launcher", "#!/usr/bin/env node\nconsole.log(1);\n"))).toBe(false);
        expect(isNativeExecutable(FAKE_VIS)).toBe(false);
    });

    it("should not treat an empty or missing file as native", () => {
        expect.assertions(2);

        expect(isNativeExecutable(write("empty", ""))).toBe(false);
        expect(isNativeExecutable(join(directory, "missing"))).toBe(false);
    });

    it("should recognise the node executable itself", () => {
        expect.assertions(1);

        expect(isNativeExecutable(process.execPath)).toBe(true);
    });
});

describe(visCommand, () => {
    it("should run a native binary directly and a script through node", () => {
        expect.assertions(2);

        expect(visCommand(process.execPath, ["list"])).toStrictEqual({ args: ["list"], command: process.execPath, env: { VIS_NODE: process.execPath } });
        expect(visCommand(FAKE_VIS, ["list"])).toStrictEqual({ args: [FAKE_VIS, "list"], command: process.execPath, env: {} });
    });
});

describe("execVis with a native binary", () => {
    it("should spawn the native binary directly instead of passing it to node as a script", async () => {
        expect.assertions(2);

        // `process.execPath` is a native executable: spawned via `node <node> ...` it would
        // try to parse the binary as JavaScript and fail.
        const result = await execVis(process.execPath, ["-p", "40 + 2"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("42");
    });

    it("should default VIS_NODE to the running node for a native binary", async () => {
        expect.assertions(1);

        const previous = process.env.VIS_NODE;

        delete process.env.VIS_NODE;

        try {
            const result = await execVis(process.execPath, ["-p", "process.env.VIS_NODE"]);

            expect(result.stdout.trim()).toBe(process.execPath);
        } finally {
            if (previous !== undefined) {
                process.env.VIS_NODE = previous;
            }
        }
    });

    it("should let a caller-supplied VIS_NODE win over the default", async () => {
        expect.assertions(1);

        const result = await execVis(process.execPath, ["-p", "process.env.VIS_NODE"], { env: { VIS_NODE: "/custom/node" } });

        expect(result.stdout.trim()).toBe("/custom/node");
    });
});
