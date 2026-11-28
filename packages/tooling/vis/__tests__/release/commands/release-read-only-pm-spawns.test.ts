/**
 * The read-only `vis release` commands print a plan and never publish, so they must not pay for
 * the package manager's `--version` gate (the minimum version only matters to a publish).
 *
 * A stand-in for the shell runner records every `pnpm` call (git and everything else still run for
 * real), which lets the tests assert that the manager was not spawned and that a command that does
 * need it still spawns it. A `pnpm` on PATH cannot do this: the subprocess library puts the
 * directory of the running Node first, so a global pnpm there wins over a stub.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import checkHandler from "../../../src/commands/release/check/handler";
import ciPlanHandler from "../../../src/commands/release/ci/plan/handler";
import nextVersionHandler from "../../../src/commands/release/next-version/handler";
import statusHandler from "../../../src/commands/release/status/handler";
import { releaseChangelog } from "../../../src/release/api";
import { buildContext } from "../../../src/release/core/orchestrator";
import { RELEASE_SUITE_TIMEOUT, removeTemporaryDirectoryWithRetry, restorePristineStdout } from "../../test-helpers";

const pnpm = vi.hoisted(() => {
    return {
        /** Every `pnpm` call, one line of arguments per call. */
        calls: [] as string[],
        /** What `pnpm -r ls --depth -1 --json` prints. */
        list: "[]",
        /** What `pnpm --version` prints. */
        version: "11.0.0",
    };
});

vi.mock(import("../../../src/release/core/shell-runner"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        createShellRunner: () => {
            const real = actual.createShellRunner();

            return {
                run: async (command: string, args: ReadonlyArray<string>, options: { cwd: string; env?: NodeJS.ProcessEnv; silent?: boolean }) => {
                    if (command !== "pnpm") {
                        return real.run(command, args, options);
                    }

                    pnpm.calls.push(args.join(" "));

                    return { exitCode: 0, stderr: "", stdout: args[0] === "--version" ? pnpm.version : pnpm.list };
                },
            };
        },
    };
});

vi.setConfig({ hookTimeout: RELEASE_SUITE_TIMEOUT, testTimeout: RELEASE_SUITE_TIMEOUT });

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
};

/** A two-package pnpm workspace with one pending change file, committed to a git repository. */
const setupFixture = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "vis-read-only-"));

    writeJson(join(cwd, "package.json"), { name: "fixture-root", packageManager: "pnpm@11.28.2", private: true, version: "0.0.0" });
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

    for (const [dir, name, version] of [
        ["a", "@scope/a", "1.0.0"],
        ["b", "@scope/b", "2.5.0"],
    ] as const) {
        mkdirSync(join(cwd, "packages", dir), { recursive: true });
        writeJson(join(cwd, "packages", dir, "package.json"), { name, version });
    }

    mkdirSync(join(cwd, ".vis", "release"), { recursive: true });
    writeFileSync(join(cwd, "vis.config.cjs"), `module.exports = ${JSON.stringify({ release: { acknowledgeUnstable: true, defaultManaged: true } })};\n`);
    writeFileSync(join(cwd, ".vis", "release", "auto.md"), "---\n\"@scope/a\": minor\n\"@scope/b\": patch\n---\n\nTwo bumps.\n");

    execFileSync("git", ["init", "-q", "--initial-branch", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd });

    return cwd;
};

const printed: string[] = [];
const logger = { error: () => {}, info: (message: string) => printed.push(message), warn: () => {} };

/** Everything a command prints to stdout or to its logger, plus the value it returns. */
const capture = async (run: () => Promise<unknown>): Promise<string> => {
    printed.length = 0;

    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        chunks.push(String(chunk));

        return true;
    });

    try {
        const returned = await run();

        return `${chunks.join("")}${typeof returned === "string" ? returned : ""}${printed.join("\n")}`;
    } finally {
        write.mockRestore();
    }
};

describe("read-only vis release commands and the package manager", () => {
    let cwd: string;
    let faithfulList: string;

    beforeEach(() => {
        cwd = setupFixture();
        pnpm.calls = [];
        // What `pnpm -r ls` prints for the fixture: the root and both packages.
        faithfulList = JSON.stringify(
            ["", "packages/a", "packages/b"].map((dir) => {
                return { name: dir === "" ? "fixture-root" : `@scope/${dir.slice(-1)}`, path: join(realpathSync(cwd), dir) };
            }),
        );
        pnpm.list = faithfulList;
        // Below pnpm's minimum (9.5.0): the version gate rejects it when it runs.
        pnpm.version = "8.0.0";
    });

    afterEach(async () => {
        restorePristineStdout();
        process.exitCode = undefined;
        await removeTemporaryDirectoryWithRetry(cwd);
    });

    it("buildContext without readOnly asks the manager for its version and rejects one below the minimum", async () => {
        expect.hasAssertions();

        await expect(buildContext({ cwd, skipRegistryLookup: true })).rejects.toMatchObject({ code: "PM_VERSION_TOO_LOW" });
        expect(pnpm.calls).toContain("--version");
    });

    it("buildContext with readOnly skips the version gate and plans anyway", async () => {
        expect.hasAssertions();

        const context = await buildContext({ cwd, readOnly: true, skipRegistryLookup: true });

        expect(context.plan.releases.map((release) => release.name)).toStrictEqual(["@scope/a", "@scope/b"]);
        expect(pnpm.calls).not.toContain("--version");
    });

    describe.each([
        ["next-version", () => nextVersionHandler({ logger, options: {}, workspaceRoot: cwd }), "@scope/b 2.5.0 -> 2.5.1"],
        ["status --json", () => statusHandler({ logger, options: { json: true }, workspaceRoot: cwd }), "\"@scope/b\""],
        ["ci plan", () => ciPlanHandler({ logger, options: {}, workspaceRoot: cwd }), "\"@scope/b\""],
        ["check", () => checkHandler({ logger, options: {}, workspaceRoot: cwd }), "1 change file(s) present"],
        ["changelog", async () => JSON.stringify(await releaseChangelog({ cwd })), "@scope/b"],
    ] as [string, () => Promise<unknown>, string][])("%s", (_name, run, expectedOutput) => {
        it("does not spawn the package manager and still finds the packages", async () => {
            expect.hasAssertions();

            // A list that names nothing the fixture has: had the manager been asked, there would be no plan to print.
            pnpm.list = "[]";

            const output = await capture(run);

            expect(process.exitCode).not.toBe(1);
            expect(pnpm.calls).toStrictEqual([]);
            expect(output).toContain(expectedOutput);
        });
    });

    it("prints the same lines from the files as it does with the manager's list", async () => {
        expect.hasAssertions();

        const run = (): Promise<string> => capture(() => nextVersionHandler({ logger, options: {}, workspaceRoot: cwd }));

        // The list `beforeEach` wrote by hand is what pnpm prints for this fixture: this is the reference run.
        pnpm.version = "11.0.0";

        const reference = await capture(async () => {
            const context = await buildContext({ cwd, skipRegistryLookup: true });

            process.stdout.write(context.plan.releases.map((release) => `${release.name} ${release.oldVersion} -> ${release.newVersion}\n`).join(""));
        });

        expect(pnpm.calls).toContain("-r ls --depth -1 --json");

        pnpm.calls = [];
        pnpm.list = "[]";

        await expect(run()).resolves.toBe(reference);
        expect(reference).toBe("@scope/a 1.0.0 -> 1.1.0\n@scope/b 2.5.0 -> 2.5.1\n");
        expect(pnpm.calls).toStrictEqual([]);
    });

    describe("listing the workspace", () => {
        // A list that names nothing the fixture has: if the manager were asked, the plan would be empty.
        beforeEach(() => {
            pnpm.list = "[]";
        });

        it("reads the packages from pnpm-workspace.yaml and does not run `pnpm -r ls`", async () => {
            expect.hasAssertions();

            const context = await buildContext({ cwd, readOnly: true, skipRegistryLookup: true });

            expect(context.plan.releases.map((release) => release.name)).toStrictEqual(["@scope/a", "@scope/b"]);
            expect(pnpm.calls).toStrictEqual([]);
        });

        it("gives the same packages and plan as the manager's own list", async () => {
            expect.hasAssertions();

            const fromFiles = await buildContext({ cwd, readOnly: true, skipRegistryLookup: true });

            // The hand-written list `beforeEach` made, not one derived from the answer under test.
            pnpm.list = faithfulList;
            pnpm.version = "11.0.0";

            const fromManager = await buildContext({ cwd, skipRegistryLookup: true });

            expect(pnpm.calls).toContain("-r ls --depth -1 --json");
            expect(fromFiles.packages.map((pkg) => pkg.dir)).toStrictEqual(fromManager.packages.map((pkg) => pkg.dir));
            expect(fromFiles.plan).toStrictEqual(fromManager.plan);
        });

        it("asks the manager when a command that writes builds the context", async () => {
            expect.hasAssertions();

            pnpm.version = "11.0.0";

            const context = await buildContext({ cwd, skipRegistryLookup: true });

            expect(context.packages).toHaveLength(0);
            expect(pnpm.calls).toStrictEqual(["--version", "-r ls --depth -1 --json"]);
        });

        it("asks the manager when the patterns are beyond what the files can answer", async () => {
            expect.hasAssertions();

            writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/{a,b}'\n");
            pnpm.list = JSON.stringify(
                ["a", "b"].map((dir) => {
                    return { name: `@scope/${dir}`, path: join(realpathSync(cwd), "packages", dir) };
                }),
            );

            const context = await buildContext({ cwd, readOnly: true, skipRegistryLookup: true });

            expect(pnpm.calls).toStrictEqual(["-r ls --depth -1 --json"]);
            expect(context.plan.releases.map((release) => release.name)).toStrictEqual(["@scope/a", "@scope/b"]);
        });

        it("asks the manager when the workspace does not pin its pnpm version", async () => {
            expect.hasAssertions();

            writeJson(join(cwd, "package.json"), { name: "fixture-root", private: true, version: "0.0.0" });
            pnpm.list = faithfulList;

            const context = await buildContext({ cwd, readOnly: true, skipRegistryLookup: true });

            expect(pnpm.calls).toStrictEqual(["-r ls --depth -1 --json"]);
            expect(context.plan.releases.map((release) => release.name)).toStrictEqual(["@scope/a", "@scope/b"]);
        });

        it("asks the manager from a directory that is not the workspace root", async () => {
            expect.hasAssertions();

            // pnpm finds the workspace root above its working directory; the files are only read at the directory itself.
            writeJson(join(cwd, "packages", "a", "package.json"), { name: "@scope/a", packageManager: "pnpm@11.0.0", version: "1.0.0" });

            await buildContext({ cwd: join(cwd, "packages", "a"), readOnly: true, skipRegistryLookup: true });

            expect(pnpm.calls).toStrictEqual(["-r ls --depth -1 --json"]);
        });
    });

    it("check --strict still asks the manager for its version", async () => {
        expect.hasAssertions();

        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

        try {
            await expect(checkHandler({ logger, options: { strict: true }, workspaceRoot: cwd })).rejects.toMatchObject({ code: "PM_VERSION_TOO_LOW" });
        } finally {
            write.mockRestore();
        }

        expect(pnpm.calls).toContain("--version");
    });
});
