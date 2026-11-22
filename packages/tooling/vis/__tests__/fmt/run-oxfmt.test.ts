import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildOxfmtArgs, resolveOxfmtBin, runOxfmt, TRANSIENT_CONFIG_PATTERN, TRANSIENT_CONFIG_PREFIX } from "../../src/fmt/run-oxfmt";

/** Stands in for the oxfmt CLI: records how it was called and behaves as STUB_MODE says. */
const STUB_SOURCE = String.raw`
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const configIndex = args.indexOf("-c");
const configPath = configIndex === -1 ? undefined : args[configIndex + 1];

writeFileSync(
    process.env.STUB_OUT,
    JSON.stringify({
        args,
        configContent: configPath !== undefined && existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : undefined,
        configExisted: configPath !== undefined && existsSync(configPath),
        cwd: process.cwd(),
    }),
);

switch (process.env.STUB_MODE) {
    case "diff": {
        process.stdout.write("src/a.ts\nsrc/b.md\n");
        process.exit(1);
        break;
    }

    case "fail": {
        process.stderr.write("boom\n");
        process.exit(2);
        break;
    }

    case "hang": {
        setTimeout(() => {}, 30_000);
        break;
    }

    default: {
        process.exit(0);
    }
}
`;

let stub: string;

let root: string;
let out: string;
let scratch: string;

const recorded = (): { args: string[]; configContent?: Record<string, unknown>; configExisted: boolean; cwd: string } =>
    JSON.parse(readFileSync(out, "utf8")) as { args: string[]; configContent?: Record<string, unknown>; configExisted: boolean; cwd: string };

const leftovers = (): string[] => readdirSync(root).filter((name) => name.startsWith(TRANSIENT_CONFIG_PREFIX));

const oxfmtRuns = ((): boolean => {
    try {
        return spawnSync(process.execPath, [resolveOxfmtBin(), "--version"], { encoding: "utf8" }).status === 0;
    } catch {
        return false;
    }
})();

describe("bundled oxfmt runner", () => {
    beforeEach(() => {
        scratch = mkdtempSync(join(tmpdir(), "vis-fmt-run-"));
        root = join(scratch, "root");
        mkdirSync(root);
        stub = join(scratch, "stub.mjs");
        writeFileSync(stub, STUB_SOURCE);
        out = join(scratch, "stub-out.json");
        process.env.STUB_OUT = out;
        process.env.STUB_MODE = "ok";
    });

    afterEach(() => {
        delete process.env.STUB_OUT;
        delete process.env.STUB_MODE;
        rmSync(scratch, { force: true, recursive: true });
    });

    describe(buildOxfmtArgs, () => {
        it("lists differing files in check mode and writes in fix mode, always tolerating unmatched patterns", () => {
            expect.assertions(2);

            expect(buildOxfmtArgs({ files: ["a.ts"], mode: "check" })).toStrictEqual(["--list-different", "--no-error-on-unmatched-pattern", "a.ts"]);
            expect(buildOxfmtArgs({ files: ["."], mode: "fix" })).toStrictEqual(["--write", "--no-error-on-unmatched-pattern", "."]);
        });

        it("passes a config with nested discovery off, and extra args before the files", () => {
            expect.assertions(1);

            expect(buildOxfmtArgs({ configPath: "/r/.vis-fmt-1.json", extraArgs: ["--threads=1"], files: ["."], mode: "check" })).toStrictEqual([
                "--list-different",
                "--no-error-on-unmatched-pattern",
                "-c",
                "/r/.vis-fmt-1.json",
                "--disable-nested-config",
                "--threads=1",
                ".",
            ]);
        });
    });

    describe("runOxfmt with a stub binary", () => {
        it("runs in the workspace root without a config argument when none is given", async () => {
            expect.assertions(4);

            const result = await runOxfmt({ binPath: stub, files: ["."], mode: "check", root });

            expect(result.exitCode).toBe(0);
            expect(recorded().args).not.toContain("-c");
            expect(realpathSync(recorded().cwd)).toBe(realpathSync(root));
            expect(leftovers()).toStrictEqual([]);
        });

        it("writes the config into the root with its own name in ignorePatterns, and removes it after a clean run", async () => {
            expect.assertions(6);

            await runOxfmt({ binPath: stub, config: { ignorePatterns: ["dist"], semi: false }, files: ["."], mode: "fix", root });

            const call = recorded();
            const configPath = call.args[call.args.indexOf("-c") + 1]!;

            expect(configPath.startsWith(TRANSIENT_CONFIG_PREFIX)).toBe(true);
            expect(configPath.endsWith(".json")).toBe(true);
            expect(call.args).toContain("--disable-nested-config");
            expect(call.configExisted).toBe(true);
            expect(call.configContent).toStrictEqual({ ignorePatterns: ["dist", TRANSIENT_CONFIG_PATTERN], semi: false });
            expect(leftovers()).toStrictEqual([]);
        });

        it("maps exit 1 and exit 2 through unchanged and still removes the config", async () => {
            expect.assertions(5);

            process.env.STUB_MODE = "diff";

            const diff = await runOxfmt({ binPath: stub, config: {}, files: ["."], mode: "check", root });

            expect(diff.exitCode).toBe(1);
            expect(diff.stdout).toBe("src/a.ts\nsrc/b.md\n");

            process.env.STUB_MODE = "fail";

            const failed = await runOxfmt({ binPath: stub, config: {}, files: ["."], mode: "check", root });

            expect(failed.exitCode).toBe(2);
            expect(failed.stderr).toBe("boom\n");
            expect(leftovers()).toStrictEqual([]);
        });

        it("surfaces a binary that fails to load as a non-zero exit and removes the config", async () => {
            expect.assertions(3);

            const result = await runOxfmt({ binPath: join(root, "does-not-exist.mjs"), config: {}, files: ["."], mode: "check", root });

            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).not.toBe("");
            expect(leftovers()).toStrictEqual([]);
        });

        it("removes the config and stops the child when SIGTERM or SIGINT arrives mid-run", async () => {
            expect.hasAssertions();

            const reRaise = vi.fn();

            for (const signal of ["SIGTERM", "SIGINT"] as const) {
                process.env.STUB_MODE = "hang";

                const running = runOxfmt({ binPath: stub, config: {}, files: ["."], mode: "fix", reRaiseSignal: reRaise, root });

                await vi.waitFor(() => {
                    expect(existsSync(out) && leftovers().length === 1).toBe(true);
                });

                process.emit(signal);

                const result = await running;

                expect(result.exitCode).toBeNull();
                expect(leftovers()).toStrictEqual([]);
                expect(reRaise).toHaveBeenCalledWith(signal);

                rmSync(out, { force: true });
            }
        });

        it("leaves other signal listeners to handle the signal instead of re-raising", async () => {
            expect.hasAssertions();

            process.env.STUB_MODE = "hang";

            const reRaise = vi.fn();
            const other = vi.fn();

            process.on("SIGTERM", other);

            try {
                const running = runOxfmt({ binPath: stub, config: {}, files: ["."], mode: "fix", reRaiseSignal: reRaise, root });

                await vi.waitFor(() => {
                    expect(existsSync(out)).toBe(true);
                });

                process.emit("SIGTERM");
                await running;

                expect(reRaise).not.toHaveBeenCalled();
            } finally {
                process.off("SIGTERM", other);
            }
        });
    });

    describe.skipIf(!oxfmtRuns)("runOxfmt with the bundled oxfmt", () => {
        const setup = (): void => {
            mkdirSync(join(root, "src"), { recursive: true });
            writeFileSync(join(root, "src", "a.ts"), 'const a = "x";\n');
            writeFileSync(join(root, "notes.md"), "# T\n\ntext\n");
        };

        it("applies a transient config: check finds the file, fix rewrites it, the config never stays", async () => {
            expect.assertions(6);

            setup();

            const config = { semi: false, singleQuote: true };
            const check = await runOxfmt({ config, files: ["."], mode: "check", root });

            expect(check.exitCode).toBe(1);
            expect(check.stdout).toContain("a.ts");
            expect(check.stdout).not.toContain(TRANSIENT_CONFIG_PREFIX);

            const fix = await runOxfmt({ config, files: ["."], mode: "fix", root });

            expect(fix.exitCode).toBe(0);
            expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("const a = 'x'\n");
            expect(leftovers()).toStrictEqual([]);
        });

        it("formats with oxfmt defaults and no config, and ignores a path it does not format", async () => {
            expect.assertions(3);

            setup();
            writeFileSync(join(root, "logo.png"), "PNG");

            const result = await runOxfmt({ files: ["src/a.ts", "logo.png", "gone.ts"], mode: "check", root });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).not.toContain("logo.png");
            expect(leftovers()).toStrictEqual([]);
        });

        it("leaves a discovered .oxfmtrc.json in charge when no config is passed", async () => {
            expect.assertions(1);

            setup();
            writeFileSync(join(root, ".oxfmtrc.json"), JSON.stringify({ semi: false }));

            const { exitCode } = await runOxfmt({ files: ["src/a.ts"], mode: "check", root });

            expect(exitCode).toBe(1);
        });
    });
});
