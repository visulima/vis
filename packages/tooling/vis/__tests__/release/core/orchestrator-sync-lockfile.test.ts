import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { OrchestratorContext } from "../../../src/release/core/orchestrator";
import { applyContext, buildContext, syncLockfile } from "../../../src/release/core/orchestrator";
import { __resetLookupMemoForTests } from "../../../src/release/core/version-resolver";

const versionProbe = (installed: boolean) => {
    return {
        run: async () => {
            return { exitCode: installed ? 0 : -1, stderr: "", stdout: "" };
        },
    };
};

/** `pmInstalled` answers the `&lt;pm> --version` probe. */
const fakeContext = (pm: Partial<OrchestratorContext["pm"]>, verifyLockfile?: boolean, pmInstalled = true): OrchestratorContext =>
    ({ config: { verifyLockfile }, cwd: "/r", pm: { id: "npm", runner: versionProbe(pmInstalled), ...pm } }) as unknown as OrchestratorContext;

const rejectWith = (message: string) =>
    vi.fn(async () => {
        throw new Error(message);
    });

describe(syncLockfile, () => {
    it("soft-fails a regeneration when the package manager is not installed", async () => {
        expect.hasAssertions();

        const verifyLockfile = vi.fn(async () => undefined);

        await syncLockfile(fakeContext({ installLockfileOnly: rejectWith("spawn pnpm ENOENT"), verifyLockfile }, undefined, false));

        expect(verifyLockfile).not.toHaveBeenCalled();
    });

    it("fails a regeneration the package manager rejected when the lockfile is checked", async () => {
        expect.hasAssertions();

        const verifyLockfile = vi.fn(async () => undefined);

        await expect(syncLockfile(fakeContext({ installLockfileOnly: rejectWith("ERR_PNPM_OUTDATED"), verifyLockfile }))).rejects.toThrow("ERR_PNPM_OUTDATED");
        expect(verifyLockfile).not.toHaveBeenCalled();
    });

    it("soft-fails a regeneration when the lockfile is not checked", async () => {
        expect.hasAssertions();

        await expect(
            syncLockfile(fakeContext({ installLockfileOnly: rejectWith("ERR_PNPM_OUTDATED"), verifyLockfile: vi.fn() }, false)),
        ).resolves.toBeUndefined();
    });

    it("propagates a failed check", async () => {
        expect.hasAssertions();

        const context = fakeContext({
            installLockfileOnly: vi.fn(async () => undefined),
            verifyLockfile: vi.fn(async () => {
                throw new Error("stale");
            }),
        });

        await expect(syncLockfile(context)).rejects.toThrow("stale");
    });

    it("skips the check when verifyLockfile is false", async () => {
        expect.hasAssertions();

        const verifyLockfile = vi.fn(async () => undefined);

        await syncLockfile(fakeContext({ installLockfileOnly: vi.fn(async () => undefined), verifyLockfile }, false));

        expect(verifyLockfile).not.toHaveBeenCalled();
    });

    it("rejects verifyLockfile: true for a package manager without a check", async () => {
        expect.hasAssertions();

        await expect(syncLockfile(fakeContext({ installLockfileOnly: vi.fn(async () => undefined) }, true))).rejects.toThrow(/not supported for npm/);
    });
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

describe.skipIf(process.platform === "win32")("applyContext lockfile sync", () => {
    it("regenerates the lockfile after applyDraft plugins edit manifests, so the committed lockfile installs frozen", async () => {
        expect.hasAssertions();

        __resetLookupMemoForTests();

        const cwd = mkdtempSync(join(tmpdir(), "vis-apply-lockfile-"));

        try {
            writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root", private: true }));
            writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
            writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
            writeFileSync(
                join(cwd, "vis.config.cjs"),
                `module.exports = ${JSON.stringify({ release: { acknowledgeUnstable: true, defaultManaged: true } })};\n`,
            );

            for (const name of ["a", "b"]) {
                mkdirSync(join(cwd, "packages", name), { recursive: true });
                writeFileSync(join(cwd, "packages", name, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`);
            }

            mkdirSync(join(cwd, ".vis", "release"), { recursive: true });
            writeFileSync(join(cwd, ".vis", "release", "a.md"), `---\n"a": minor\n---\nadd a thing\n`);
            execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd, stdio: "pipe" });
            git(cwd, "init", "-q");
            git(cwd, "config", "user.email", "test@example.com");
            git(cwd, "config", "user.name", "Test");
            git(cwd, "config", "commit.gpgsign", "false");
            git(cwd, "add", "-A");
            git(cwd, "commit", "-qm", "chore: init");

            const ctx = await buildContext({ cwd });

            // A plugin that rewrites a dependency range, like a sibling-range fixer.
            ctx.config.plugins = [
                {
                    applyDraft: async () => {
                        const path = join(cwd, "packages", "a", "package.json");
                        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

                        writeFileSync(path, `${JSON.stringify({ ...manifest, dependencies: { b: "workspace:^" } })}\n`);
                    },
                    name: "range-fixer",
                },
            ];

            await applyContext(ctx, { commit: true });

            expect(git(cwd, "status", "--porcelain")).toBe("");
            expect(() => execFileSync("pnpm", ["install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"], { cwd, stdio: "pipe" })).not.toThrow();
        } finally {
            await rm(cwd, { force: true, recursive: true });
        }
    }, 60_000);
});
