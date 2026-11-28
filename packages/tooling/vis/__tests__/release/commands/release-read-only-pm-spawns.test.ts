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

    writeJson(join(cwd, "package.json"), { name: "fixture-root", private: true, version: "0.0.0" });
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

const logger = { error: () => {}, info: () => {}, warn: () => {} };

describe("read-only vis release commands and the package manager", () => {
    let cwd: string;

    beforeEach(() => {
        cwd = setupFixture();
        pnpm.calls = [];
        // What `pnpm -r ls` prints for the fixture: the root and both packages.
        pnpm.list = JSON.stringify(
            ["", "packages/a", "packages/b"].map((dir) => {
                return { name: dir === "" ? "fixture-root" : `@scope/${dir.slice(-1)}`, path: join(realpathSync(cwd), dir) };
            }),
        );
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

    it.each([
        ["next-version", () => nextVersionHandler({ logger, options: {}, workspaceRoot: cwd })],
        ["status --json", () => statusHandler({ logger, options: { json: true }, workspaceRoot: cwd })],
        ["ci plan", () => ciPlanHandler({ logger, options: {}, workspaceRoot: cwd })],
        ["check", () => checkHandler({ logger, options: {}, workspaceRoot: cwd })],
        ["changelog", () => releaseChangelog({ cwd })],
    ] as [string, () => Promise<unknown>][])("%s does not ask the manager for its version", async (_name, run) => {
        expect.hasAssertions();

        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

        try {
            await run();
        } finally {
            write.mockRestore();
        }

        expect(process.exitCode).not.toBe(1);
        expect(pnpm.calls).not.toContain("--version");
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
