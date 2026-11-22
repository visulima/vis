import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { Toolbox } from "@visulima/cerebro";
import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import execute from "../../../src/commands/fmt/handler";
import type { VisConfig } from "../../../src/config/types";
import { resolveOxfmtBin, runOxfmt } from "../../../src/fmt/run-oxfmt";
import { runAdaptersParallel } from "../../../src/lint-fmt/runner";

vi.mock(import("../../../src/lint-fmt/runner"), () => {
    return { runAdaptersParallel: vi.fn(async () => []) };
});

vi.mock(import("../../../src/fmt/run-oxfmt"), async (importOriginal) => {
    return { ...(await importOriginal()), runOxfmt: vi.fn(async () => { return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" }; }) };
});

const oxfmtRuns = ((): boolean => {
    try {
        return spawnSync(process.execPath, [resolveOxfmtBin(), "--version"], { encoding: "utf8" }).status === 0;
    } catch {
        return false;
    }
})();

let root: string;
let messages: Record<"error" | "info" | "warn", string[]>;
let previousExitCode: typeof process.exitCode;

const doctor = async (options: Record<string, unknown> = {}, fmt?: NonNullable<VisConfig["fmt"]>): Promise<string> => {
    const sink = (level: "error" | "info" | "warn") => (...args: unknown[]) => {
        messages[level].push(args.join(" "));
    };

    await (execute as unknown as (toolbox: Partial<Toolbox>) => Promise<void>)({
        logger: { debug: () => undefined, error: sink("error"), info: sink("info"), warn: sink("warn") } as unknown as Console,
        options: { doctor: true, ...options },
        visConfig: fmt === undefined ? {} : { fmt },
        workspaceRoot: root,
    });

    return messages.info.join("\n");
};

const write = (name: string, content: string): void => {
    writeFileSync(join(root, name), content);
};

describe("vis fmt --doctor", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-fmt-doctor-"));
        messages = { error: [], info: [], warn: [] };
        previousExitCode = process.exitCode;
        process.exitCode = undefined;
        vi.mocked(runOxfmt).mockClear();
        vi.mocked(runAdaptersParallel).mockClear();
    });

    afterEach(() => {
        process.exitCode = previousExitCode;
        rmSync(root, { force: true, recursive: true });
    });

    it("formats nothing and writes nothing, whichever source wins", async () => {
        expect.assertions(5);

        write("a.ts", 'const a = "x"\n');

        await doctor({}, { ignorePatterns: ["gen/**"], options: { semi: false } });
        await doctor({}, { options: { semi: false } });

        expect(runOxfmt).not.toHaveBeenCalled();
        expect(runAdaptersParallel).not.toHaveBeenCalled();
        expect(readFileSync(join(root, "a.ts"), "utf8")).toBe('const a = "x"\n');
        expect(readdirSync(root)).toStrictEqual(["a.ts"]);
        expect(process.exitCode).toBeUndefined();
    });

    it("reports a workspace with nothing set up: the bundled oxfmt on its defaults, no config file, no .editorconfig", async () => {
        expect.assertions(7);

        const text = await doctor();

        expect(text).toContain("Engine: bundled oxfmt");
        expect(text).toContain('why: fmt.engine is "auto" and no formatter other than oxfmt or Prettier is detected');
        expect(text).toContain("Config source: oxfmt defaults");
        expect(text).toContain("ignored lower sources: none");
        expect(text).toContain("Config file: none");
        expect(text).toContain(".editorconfig: none in the workspace root");
        expect(text).toContain("Ignore files: none in the workspace root");
    });

    it("names the winning .oxfmtrc and every lower source that is ignored, with the editorconfig and ignore files", async () => {
        expect.assertions(9);

        write(".oxfmtrc.json", "{}");
        write("vite.config.mjs", "export default { fmt: { semi: false } };\n");
        write(".prettierrc.json", "{}");
        write(".editorconfig", "root = true\n");
        write(".gitignore", "dist\n");
        write(".prettierignore", "gen\n");

        const text = await doctor();

        expect(text).toContain("Config source: .oxfmtrc.json");
        expect(text).toContain("- vite.config.mjs (fmt key of the Vite config)");
        expect(text).toContain("- .prettierrc.json (Prettier config)");
        expect(text).toContain("Config file: none");
        expect(text).toContain("oxfmt reads its own config file");
        expect(text).toContain(".editorconfig: .editorconfig (read by oxfmt)");
        expect(text).toContain("Ignore files: .gitignore, .prettierignore");
        expect(text).toContain("Warning: Formatting options come from .oxfmtrc.json");
        expect(messages.warn).toStrictEqual([]);
    });

    it("reads the fmt key of the Vite config as the source and shows the cache file the options would go to", async () => {
        expect.assertions(5);

        write("vite.config.mjs", "export default { fmt: { semi: false } };\n");
        write(".prettierrc.json", "{}");

        const text = await doctor();

        expect(text).toContain("Config source: the fmt key of vite.config.mjs\n");
        expect(text).toContain("- .prettierrc.json (Prettier config)");
        expect(text).toMatch(/Config file: cache, node_modules\/\.cache\/vis\/fmt\/[0-9a-f]{16}\.json/);
        expect(text).toContain("kept in the vis cache");
        expect(existsSync(join(root, "node_modules"))).toBe(false);
    });

    it("says the root file is used when vis.config carries globs, and why", async () => {
        expect.assertions(4);

        write(".oxfmtrc.json", "{}");

        const text = await doctor({}, { ignorePatterns: ["gen/**"], options: { semi: false } });

        expect(text).toContain("Config source: vis.config fmt.options");
        expect(text).toContain("- .oxfmtrc.json (oxfmt config file)");
        expect(text).toContain("Config file: workspace root, .vis-fmt-<pid>-<id>.json");
        expect(text).toContain("which oxfmt reads relative to the config file's directory");
    });

    it("shows the mapped Prettier config as the source, with its file", async () => {
        expect.assertions(2);

        write(".prettierrc.json", JSON.stringify({ printWidth: 80, semi: false }));

        const text = await doctor();

        expect(text).toContain("Config source: .prettierrc.json (mapped to oxfmt options)\n");
        expect(text).toContain("Config file: cache");
    });

    it("explains the adapter orchestration when biome is detected, and does not resolve a config", async () => {
        expect.assertions(4);

        write("package.json", JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.0.0" }, name: "x" }));
        write(".prettierrc.json", "{ nope");

        const text = await doctor();

        expect(text).toContain("Engine: adapter orchestration (biome");
        expect(text).toContain('why: fmt.engine is "auto" and biome is detected');
        expect(text).toContain("Config source: not applicable");
        expect(process.exitCode).toBeUndefined();
    });

    it.skipIf(!oxfmtRuns)("reports the bundled oxfmt version when it runs", async () => {
        expect.assertions(2);

        const text = await doctor();
        const { version } = JSON.parse(readFileSync(join(process.cwd(), "node_modules", "oxfmt", "package.json"), "utf8")) as { version: string };

        expect(text).toContain(`Bundled oxfmt: resolves, version ${version}`);
        expect(process.exitCode).toBeUndefined();
    });

    it.skipIf(oxfmtRuns)("says so when the bundled oxfmt does not start, and still exits 0", async () => {
        expect.assertions(2);

        const text = await doctor();

        expect(text).toContain("Bundled oxfmt: does not run");
        expect(process.exitCode).toBeUndefined();
    });

    it("exits 2 with the reason on stderr, and prints no report, when the chosen config cannot be read", async () => {
        expect.assertions(4);

        write(".prettierrc.json", "{ nope");

        const text = await doctor();

        expect(process.exitCode).toBe(2);
        expect(messages.error).toHaveLength(1);
        expect(messages.error[0]).toMatch(/^vis fmt --doctor: .*\.prettierrc\.json/);
        expect(text).toBe("");
    });

    it("exits 2 for a contradictory engine setting and for a Vite fmt key that is not an object", async () => {
        expect.assertions(4);

        await doctor({}, { adapters: { oxfmt: { builtin: false } }, engine: "oxfmt" });

        expect(process.exitCode).toBe(2);
        expect(messages.error[0]).toContain("contradict each other");

        process.exitCode = undefined;
        messages.error.length = 0;
        write("vite.config.mjs", "export default { fmt: 3 };\n");

        await doctor();

        expect(process.exitCode).toBe(2);
        expect(messages.error[0]).toContain('the "fmt" key must be an object');
    });

    it("emits the report as JSON with --format json, to --output when given", async () => {
        expect.assertions(8);

        write(".oxfmtrc.json", "{}");
        mkdirSync(join(root, "out"));

        await doctor({ format: "json", output: "out/doctor.json" });

        const report = JSON.parse(readFileSync(join(root, "out", "doctor.json"), "utf8")) as {
            config: { file: string; source: string };
            configFile: { kind: string };
            engine: { kind: string };
            ignoredSources: unknown[];
            oxfmt: { resolves: boolean };
        };

        expect(report.engine.kind).toBe("bundled");
        expect(report.config.source).toBe("oxfmtrc");
        expect(report.config.file).toBe(".oxfmtrc.json");
        expect(report.configFile.kind).toBe("none");
        expect(report.ignoredSources).toStrictEqual([]);
        expect(report.oxfmt.resolves).toBe(oxfmtRuns);
        expect(messages.info).toStrictEqual([]);
        expect(process.exitCode).toBeUndefined();
    });
});
