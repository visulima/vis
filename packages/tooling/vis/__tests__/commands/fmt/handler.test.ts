import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { Toolbox } from "@visulima/cerebro";
import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import execute from "../../../src/commands/fmt/handler";
import type { VisConfig } from "../../../src/config/types";
import { runOxfmt } from "../../../src/fmt/run-oxfmt";
import { runAdaptersParallel } from "../../../src/lint-fmt/runner";

vi.mock(import("../../../src/lint-fmt/runner"), () => {
    return {
        runAdaptersParallel: vi.fn(async (jobs: ReadonlyArray<unknown>) => jobs.map(() => { return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" }; })),
    };
});

vi.mock(import("../../../src/fmt/run-oxfmt"), async (importOriginal) => {
    return { ...(await importOriginal()), runOxfmt: vi.fn(async () => { return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" }; }) };
});

let root: string;
let messages: Record<"error" | "info" | "warn", string[]>;
let previousExitCode: typeof process.exitCode;

const run = async (options: Record<string, unknown> = {}, fmt?: NonNullable<VisConfig["fmt"]>): Promise<void> => {
    const sink = (level: "error" | "info" | "warn") => (...args: unknown[]) => {
        messages[level].push(args.join(" "));
    };

    await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
        logger: { debug: () => undefined, error: sink("error"), info: sink("info"), warn: sink("warn") } as unknown as Console,
        options,
        visConfig: fmt === undefined ? {} : { fmt },
        workspaceRoot: root,
    });
};

const writePackage = (devDependencies: Record<string, string>): void => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies, name: "x" }));
};

const oxfmtCall = (): Parameters<typeof runOxfmt>[0] => vi.mocked(runOxfmt).mock.calls[0]![0];

describe("vis fmt handler", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-fmt-handler-"));
        messages = { error: [], info: [], warn: [] };
        previousExitCode = process.exitCode;
        vi.mocked(runOxfmt).mockClear();
        vi.mocked(runAdaptersParallel).mockClear();
    });

    afterEach(() => {
        process.exitCode = previousExitCode;
        rmSync(root, { force: true, recursive: true });
    });

    describe("vis fmt engine selection", () => {
        it("formats a workspace with no formatter using the bundled oxfmt and its defaults", async () => {
            expect.assertions(5);

            await run();

            expect(runOxfmt).toHaveBeenCalledTimes(1);
            expect(oxfmtCall()).toMatchObject({ config: undefined, files: ["."], mode: "fix", root });
            expect(runAdaptersParallel).not.toHaveBeenCalled();
            expect(messages.info.join("\n")).toContain("no config found, using oxfmt defaults");
            expect(messages.warn).toStrictEqual([]);
        });

        it("replaces Prettier with the bundled oxfmt, mapping the Prettier config, and warns once how to opt out", async () => {
            expect.assertions(6);

            writePackage({ prettier: "^3.0.0" });
            writeFileSync(join(root, ".prettierrc.json"), JSON.stringify({ printWidth: 90, semi: false }));

            await run({ check: true });

            expect(oxfmtCall()).toMatchObject({ config: { printWidth: 90, semi: false, sortPackageJson: false }, mode: "check" });
            expect(runAdaptersParallel).not.toHaveBeenCalled();
            expect(messages.info.join("\n")).toContain(".prettierrc.json (mapped to oxfmt options)");
            expect(messages.warn.filter((line) => line.includes("instead of Prettier"))).toHaveLength(1);
            expect(messages.warn.join("\n")).toContain('fmt.engine: "prettier"');
            expect(messages.warn).toHaveLength(1);
        });

        it("keeps running Prettier through the adapters when fmt.engine is prettier", async () => {
            expect.assertions(4);

            writePackage({ prettier: "^3.0.0" });

            await run({}, { engine: "prettier" });

            expect(runOxfmt).not.toHaveBeenCalled();
            expect(runAdaptersParallel).toHaveBeenCalledTimes(1);
            expect(vi.mocked(runAdaptersParallel).mock.calls[0]![0].map((job) => job.adapter.id)).toStrictEqual(["prettier"]);
            expect(messages.warn).toStrictEqual([]);
        });

        it("keeps the adapter orchestration when biome is detected, and never runs the bundled oxfmt next to it", async () => {
            expect.assertions(3);

            writePackage({ "@biomejs/biome": "^2.0.0", prettier: "^3.0.0" });
            writeFileSync(join(root, "biome.json"), "{}");

            await run();

            expect(runOxfmt).not.toHaveBeenCalled();
            expect(runAdaptersParallel).toHaveBeenCalledTimes(1);
            expect(messages.warn).toStrictEqual([]);
        });

        it("runs a project-declared oxfmt through the bundled runner with its own config discovered, and nothing else", async () => {
            expect.assertions(5);

            writePackage({ oxfmt: "^0.1.0", prettier: "^3.0.0" });
            writeFileSync(join(root, ".oxfmtrc.json"), "{}");

            await run();

            expect(runOxfmt).toHaveBeenCalledTimes(1);
            expect(oxfmtCall().config).toBeUndefined();
            expect(runAdaptersParallel).not.toHaveBeenCalled();
            expect(messages.info.join("\n")).toContain("formatting with .oxfmtrc.json");
            expect(messages.warn.filter((line) => line.includes("instead of Prettier"))).toHaveLength(1);
        });

        it("uses fmt.options over an .oxfmtrc and passes them to the runner", async () => {
            expect.assertions(3);

            writeFileSync(join(root, ".oxfmtrc.json"), "{}");

            await run({}, { ignorePatterns: ["dist"], options: { semi: false } });

            expect(oxfmtCall().config).toStrictEqual({ ignorePatterns: ["dist"], semi: false });
            expect(messages.info.join("\n")).toContain("vis.config fmt.options");
            expect(messages.warn.join("\n")).toContain(".oxfmtrc.json");
        });

        it("keeps the project's own oxfmt on the adapters when adapters.oxfmt.builtin is false", async () => {
            expect.assertions(2);

            writePackage({ oxfmt: "^0.1.0" });

            await run({}, { adapters: { oxfmt: { builtin: false } } });

            expect(runOxfmt).not.toHaveBeenCalled();
            expect(vi.mocked(runAdaptersParallel).mock.calls[0]![0].map((job) => job.adapter.id)).toStrictEqual(["oxfmt"]);
        });

        it("runs the bundled oxfmt for fmt.engine oxfmt even when biome is detected", async () => {
            expect.assertions(2);

            writeFileSync(join(root, "biome.json"), "{}");

            await run({}, { engine: "oxfmt" });

            expect(runOxfmt).toHaveBeenCalledTimes(1);
            expect(runAdaptersParallel).not.toHaveBeenCalled();
        });

        it("does not run the bundled oxfmt when adapters.oxfmt.enabled is false, and says no formatter is detected", async () => {
            expect.assertions(3);

            await run({}, { adapters: { oxfmt: { enabled: false } } });

            expect(runOxfmt).not.toHaveBeenCalled();
            expect(runAdaptersParallel).not.toHaveBeenCalled();
            expect(messages.warn.join("\n")).toContain("no formatter detected");
        });

        it("forwards adapters.oxfmt.extraArgs to the bundled run", async () => {
            expect.assertions(1);

            await run({}, { adapters: { oxfmt: { extraArgs: ["--threads=1"] } } });

            expect(oxfmtCall().extraArgs).toStrictEqual(["--threads=1"]);
        });
    });

    describe("vis fmt bundled run", () => {
        it("passes explicit paths through unfiltered, whatever their extension", async () => {
            expect.assertions(1);

            await run({ _: ["logo.png", "docs/a.md", "src/b.ts"] });

            expect(oxfmtCall().files).toStrictEqual(["logo.png", "docs/a.md", "src/b.ts"]);
        });

        it("does not claim nothing changed after a write run, which oxfmt does not itemise", async () => {
            expect.assertions(2);

            await run();

            expect(messages.info.join("\n")).toContain("formatted with oxfmt");
            expect(messages.info.join("\n")).not.toContain("nothing to change");
        });

        it("warns that Prettier is replaced when the only sign of it is a package.json key or a TOML config", async () => {
            expect.assertions(2);

            writeFileSync(join(root, ".prettierrc.toml"), "tabWidth = 3\n");

            await run();

            expect(messages.warn.filter((line) => line.includes("instead of Prettier"))).toHaveLength(1);
            expect(oxfmtCall().config).toMatchObject({ tabWidth: 3 });
        });

        it("fails a --check run when oxfmt lists files that would change", async () => {
            expect.assertions(2);

            vi.mocked(runOxfmt).mockResolvedValueOnce({ durationMs: 1, exitCode: 1, stderr: "", stdout: "src/a.ts\n" });

            await run({ check: true });

            expect(process.exitCode).toBe(1);
            expect(messages.error).toStrictEqual([]);
        });

        it("reports oxfmt's own error output and fails when oxfmt errors, in fix mode too", async () => {
            expect.assertions(2);

            vi.mocked(runOxfmt).mockResolvedValueOnce({ durationMs: 1, exitCode: 2, stderr: "x Unexpected token\n", stdout: "" });

            await run();

            expect(process.exitCode).toBe(1);
            expect(messages.error).toStrictEqual(["x Unexpected token"]);
        });

        it("fails when oxfmt cannot start", async () => {
            expect.assertions(2);

            vi.mocked(runOxfmt).mockResolvedValueOnce({ durationMs: 1, exitCode: null, stderr: "spawn ENOENT", stdout: "" });

            await run();

            expect(process.exitCode).toBe(1);
            expect(messages.error).toStrictEqual(["spawn ENOENT"]);
        });

        it("keeps its notices out of a machine-readable format", async () => {
            expect.assertions(1);

            await run({ format: "json", output: join(root, "report.json") });

            expect(messages.info).toStrictEqual([]);
        });
    });
});
