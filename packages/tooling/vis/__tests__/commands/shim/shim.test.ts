import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";

import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decideShim, shimExit } from "../../../src/commands/shim/dispatch";
import { shimInstallExecute, shimStatusExecute, shimUninstallExecute } from "../../../src/commands/shim/handler";
import { cleanupTemporaryDirectory, createTemporaryDirectory } from "../../test-helpers";

describe(decideShim, () => {
    it("dispatches on agreement, refuses a top-level mismatch", () => {
        expect.hasAssertions();

        expect(decideShim("pnpm", "pnpm", "install", false)).toBe("dispatch");
        expect(decideShim("npm", "pnpm", "install", false)).toBe("refuse");
    });

    it("falls through (dispatch) on a nested mismatch", () => {
        expect.hasAssertions();

        expect(decideShim("npm", "pnpm", "install", true)).toBe("dispatch");
    });

    it("lets transparent verbs and runner shims through despite a mismatch", () => {
        expect.hasAssertions();

        expect(decideShim("npm", "pnpm", "create", false)).toBe("dispatch");
        expect(decideShim("npx", "pnpm", "anything", false)).toBe("dispatch");
    });

    it("dispatches when there is no pin", () => {
        expect.hasAssertions();

        expect(decideShim("yarn", undefined, "install", false)).toBe("dispatch");
    });
});

describe(shimExit, () => {
    it("passes the manager's own status through", () => {
        expect.hasAssertions();

        expect(shimExit("npm", { signal: null, status: 3 })).toStrictEqual({ code: 3 });
        expect(shimExit("npm", { signal: null, status: 0 })).toStrictEqual({ code: 0 });
    });

    it("ends with 1 for a manager a signal killed", () => {
        expect.hasAssertions();

        expect(shimExit("npm", { signal: "SIGKILL", status: null })).toStrictEqual({ code: 1 });
    });

    it("ends with 1 and a message for a manager that could not be started", () => {
        expect.hasAssertions();

        const outcome = shimExit("npm", { error: new Error("spawnSync /bin/npm EACCES"), signal: null, status: null });

        expect(outcome).toStrictEqual({ code: 1, message: "vis shim: could not start npm: spawnSync /bin/npm EACCES" });
    });
});

describe("shimExit with a real spawn", () => {
    it.skipIf(process.platform === "win32")("reports a manager that is not executable", async () => {
        expect.assertions(2);

        const directory = createTemporaryDirectory();

        try {
            const manager = join(directory, "npm");

            await fs.writeFile(manager, "#!/bin/sh\n", { mode: 0o644 });

            const outcome = shimExit("npm", spawnSync(manager, ["install"]));

            expect(outcome.code).toBe(1);
            expect(outcome.message).toMatch(/^vis shim: could not start npm: .*EACCES/u);
        } finally {
            cleanupTemporaryDirectory(directory);
        }
    });
});

const SHIM_NAMES = ["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg"];

const makeToolbox = (cwd: string): { calls: string[]; exitCodes: number[]; toolbox: unknown } => {
    const calls: string[] = [];
    const exitCodes: number[] = [];

    return {
        calls,
        exitCodes,
        toolbox: {
            console: {
                error: (...a: unknown[]) => calls.push(`error ${a.join(" ")}`),
                log: (...a: unknown[]) => calls.push(a.join(" ")),
            },
            fs,
            process: {
                argv: [process.execPath, "/fake/dist/bin.js"],
                cwd,
                env: {},
                exit: (code: number) => {
                    exitCodes.push(code);
                },
                platform: process.platform,
            },
        },
    };
};

describe("vis shim", () => {
    let workspace: string;

    beforeEach(() => {
        workspace = createTemporaryDirectory("vis-shim-");
    });

    afterEach(() => {
        cleanupTemporaryDirectory(workspace);
    });

    it("install writes a wrapper per PM name that calls __pm-shim", async () => {
        expect.hasAssertions();

        await shimInstallExecute(makeToolbox(workspace).toolbox as never);

        const shimDirectory = join(workspace, ".vis", "shims");

        for (const name of SHIM_NAMES) {
            const file = join(shimDirectory, process.platform === "win32" ? `${name}.cmd` : name);

            expect(existsSync(file)).toBe(true);
            expect(readFileSync(file, "utf8")).toContain(`__pm-shim ${name}`);
        }
    });

    it("install prefers the native binary when VIS_NATIVE_BIN resolves", async () => {
        expect.hasAssertions();

        const fakeBinary = join(workspace, "vis-native-cli");

        await fs.writeFile(fakeBinary, "#!/bin/sh\n");

        process.env["VIS_NATIVE_BIN"] = fakeBinary;

        try {
            await shimInstallExecute(makeToolbox(workspace).toolbox as never);

            const file = join(workspace, ".vis", "shims", process.platform === "win32" ? "npm.cmd" : "npm");
            const content = readFileSync(file, "utf8");

            expect(content).toContain(fakeBinary);
            expect(content).toContain("__pm-shim npm");
        } finally {
            delete process.env["VIS_NATIVE_BIN"];
        }
    });

    it("status reports not-installed, then installed; uninstall removes the dir", async () => {
        expect.hasAssertions();

        const before = makeToolbox(workspace);

        await shimStatusExecute(before.toolbox as never);

        expect(before.calls.join("\n")).toContain("not installed");

        await shimInstallExecute(makeToolbox(workspace).toolbox as never);

        const after = makeToolbox(workspace);

        await shimStatusExecute(after.toolbox as never);

        expect(after.calls.join("\n")).toContain("installed in");

        await shimUninstallExecute(makeToolbox(workspace).toolbox as never);

        expect(existsSync(join(workspace, ".vis", "shims"))).toBe(false);
    });
});
