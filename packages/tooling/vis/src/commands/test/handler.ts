import { spawnSync } from "node:child_process";

import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import { dirname, join } from "@visulima/path";

import { VisUserError } from "../../errors/vis-user-error";
import type { ChooseToolDeps, Installer } from "../../util/tool-choice";
import { chooseTool, installDevDependency } from "../../util/tool-choice";
import type { TestOptions } from "./index";

/** Reads a file's text, or `undefined` when it does not exist. */
export type ReadText = (path: string) => Promise<string | undefined>;

/**
 * Locate a package's bin entry by walking up from `start` through each parent's
 * `node_modules/&lt;packageName>`, so a test run from a workspace package still finds
 * a hoisted install. Returns `undefined` when no ancestor has the package.
 */
export const resolveBinEntry = async (start: string, readText: ReadText, packageName: string, binName: string): Promise<string | undefined> => {
    let directory = start;

    for (;;) {
        const packageDirectory = join(directory, "node_modules", packageName);
        const manifestText = await readText(join(packageDirectory, "package.json"));

        if (manifestText !== undefined) {
            const manifest = JSON.parse(manifestText) as { bin?: string | Record<string, string> };
            const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];

            if (bin) {
                return join(packageDirectory, bin);
            }
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return undefined;
        }

        directory = parent;
    }
};

/** Locate the Vitest CLI entry. */
export const resolveVitestEntry = (start: string, readText: ReadText): Promise<string | undefined> =>
    resolveBinEntry(start, readText, "vitest", "vitest");

/** Locate the Rstest CLI entry (shipped by `@rstest/core`). */
export const resolveRstestEntry = (start: string, readText: ReadText): Promise<string | undefined> =>
    resolveBinEntry(start, readText, "@rstest/core", "rstest");

/**
 * The package's own `test` script, or `undefined` when there is none. npm's
 * `init` placeholder ("no test specified") does not count as a script.
 */
export const readTestScript = async (directory: string, readText: ReadText): Promise<string | undefined> => {
    const manifestText = await readText(join(directory, "package.json"));

    if (manifestText === undefined) {
        return undefined;
    }

    const { scripts } = (JSON.parse(manifestText) as { scripts?: Record<string, unknown> });
    const script = scripts?.["test"];

    if (typeof script !== "string" || script.trim() === "" || script.includes("no test specified")) {
        return undefined;
    }

    return script;
};

const runNodeEntry = (entry: string, args: string[], cwd: string): [number | null, Error | undefined] => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, stdio: "inherit" });

    return [result.status, result.error];
};

const exitWithStatus = (status: number | null, error: Error | undefined): void => {
    if (error) {
        throw error;
    }

    if (status !== 0) {
        process.exitCode = status ?? 1;
    }
};

export interface TestRunDeps extends ChooseToolDeps {
    /** Installs the chosen runner. Defaults to `vis add -D`. */
    install?: Installer;
}

interface Runner {
    entry: string;
    kind: "rstest" | "vitest";
}

/** Vitest first, then Rstest: the same order the inference detectors use. */
const findRunner = async (cwd: string, readText: ReadText): Promise<Runner | undefined> => {
    const vitestEntry = await resolveVitestEntry(cwd, readText);

    if (vitestEntry !== undefined) {
        return { entry: vitestEntry, kind: "vitest" };
    }

    const rstestEntry = await resolveRstestEntry(cwd, readText);

    return rstestEntry === undefined ? undefined : { entry: rstestEntry, kind: "rstest" };
};

/**
 * Run the package's tests. Without a `test` script and without a runner, ask which
 * runner to install. The choice is the consent: the install is `vis add -D`, and the
 * run follows it. Cancelling, or a failed install, stops before anything runs.
 */
export const runTests = async (
    { argument, fs, logger, options, rawUnknown }: Pick<Toolbox<Console, TestOptions>, "argument" | "fs" | "logger" | "options" | "rawUnknown">,
    deps: TestRunDeps = {},
): Promise<void> => {
    const cwd = process.cwd();
    const readText: ReadText = (path) => fs.readFile(path, "utf8").catch(() => undefined);
    const forwarded = [...(argument ?? []), ...(rawUnknown ?? [])];
    const testScript = await readTestScript(cwd, readText);

    // A package that already has a `test` script keeps it: that script is what the
    // team runs, so it wins over the runner fallback. The warning says so up front.
    if (testScript !== undefined) {
        if (options.watch) {
            throw new VisUserError("--watch applies to Vitest, but this package runs its own `test` script. Run that script directly for watch mode.");
        }

        logger.warn(`vis test: running the package's "test" script (\`${testScript}\`) instead of Vitest. Remove the script to use Vitest.`);

        // Loaded here, not at module top: pm-runner pulls in the native binding, and the
        // runner path above should stay usable without it.
        const { detectPm } = await import("../../pm/pm-runner");
        const result = spawnSync(detectPm(cwd).name, ["run", "test", ...(forwarded.length > 0 ? ["--", ...forwarded] : [])], {
            cwd,
            shell: process.platform === "win32",
            stdio: "inherit",
        });

        exitWithStatus(result.status, result.error);

        return;
    }

    let runner = await findRunner(cwd, readText);

    if (runner === undefined) {
        const choice = await chooseTool(
            "No test runner is installed. Pick one to add as a devDependency:",
            [
                { hint: "vis add -D vitest", label: "Vitest", value: "vitest" },
                { hint: "vis add -D @rstest/core", label: "Rstest", value: "@rstest/core" },
            ],
            deps,
        );

        if (choice === undefined) {
            throw new VisUserError("No test runner selected. Install one with `vis add -D vitest` or `vis add -D @rstest/core`, then run `vis test` again.");
        }

        const code = installDevDependency(choice.value, cwd, logger, deps.install);

        if (code !== 0) {
            process.exitCode = code;

            return;
        }

        runner = await findRunner(cwd, readText);

        if (runner === undefined) {
            throw new VisUserError(`${choice.value} was installed, but no runner was found from ${cwd}. Check the install output above.`);
        }
    }

    // Vitest's `run` subcommand exits after one pass; without it Vitest watches,
    // which is what `--watch` asks for. Rstest takes `run` or `watch` as a subcommand.
    const runnerArguments = runner.kind === "vitest" ? [...(options.watch ? [] : ["run"]), ...forwarded] : [options.watch ? "watch" : "run", ...forwarded];

    exitWithStatus(...runNodeEntry(runner.entry, runnerArguments, cwd));
};

const execute = (toolbox: Toolbox<Console, TestOptions>): Promise<void> => runTests(toolbox);

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
