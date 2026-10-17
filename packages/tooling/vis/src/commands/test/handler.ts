import { spawnSync } from "node:child_process";

import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import { dirname, join } from "@visulima/path";

import { VisUserError } from "../../errors/vis-user-error";
import type { TestOptions } from "./index";

/** Reads a file's text, or `undefined` when it does not exist. */
export type ReadText = (path: string) => Promise<string | undefined>;

/**
 * Locate the Vitest CLI entry by walking up from `start` through each parent's
 * `node_modules/vitest`, so a test run from a workspace package still finds the
 * hoisted install. Returns `undefined` when no ancestor has Vitest installed.
 */
export const resolveVitestEntry = async (start: string, readText: ReadText): Promise<string | undefined> => {
    let directory = start;

    for (;;) {
        const packageDirectory = join(directory, "node_modules", "vitest");
        const manifestText = await readText(join(packageDirectory, "package.json"));

        if (manifestText !== undefined) {
            const manifest = JSON.parse(manifestText) as { bin?: string | Record<string, string> };
            const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["vitest"];

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

const exitWithStatus = (status: number | null, error: Error | undefined): void => {
    if (error) {
        throw error;
    }

    if (status !== 0) {
        process.exitCode = status ?? 1;
    }
};

const execute = async ({ argument, fs, logger, options, rawUnknown }: Toolbox<Console, TestOptions>): Promise<void> => {
    const cwd = process.cwd();
    const readText: ReadText = (path) => fs.readFile(path, "utf8").catch(() => undefined);
    const forwarded = [...(argument ?? []), ...(rawUnknown ?? [])];
    const testScript = await readTestScript(cwd, readText);

    // A package that already has a `test` script keeps it: that script is what the
    // team runs, so it wins over the Vitest fallback. The warning says so up front.
    if (testScript !== undefined) {
        if (options.watch) {
            throw new VisUserError("--watch applies to Vitest, but this package runs its own `test` script. Run that script directly for watch mode.");
        }

        logger.warn(`vis test: running the package's "test" script (\`${testScript}\`) instead of Vitest. Remove the script to use Vitest.`);

        // Loaded here, not at module top: pm-runner pulls in the native binding, and the
        // Vitest path and the helpers above should stay usable without it.
        const { detectPm } = await import("../../pm/pm-runner");
        const result = spawnSync(detectPm(cwd).name, ["run", "test", ...(forwarded.length > 0 ? ["--", ...forwarded] : [])], {
            cwd,
            shell: process.platform === "win32",
            stdio: "inherit",
        });

        exitWithStatus(result.status, result.error);

        return;
    }

    const vitestEntry = await resolveVitestEntry(cwd, readText);

    if (vitestEntry === undefined) {
        throw new VisUserError("Vitest is not installed. Add it with `vis add -D vitest`, then run `vis test` again.");
    }

    // Vitest's `run` subcommand exits after one pass; without it Vitest watches,
    // which is what `--watch` asks for.
    const vitestArguments = [...(options.watch ? [] : ["run"]), ...forwarded];

    const result = spawnSync(process.execPath, [vitestEntry, ...vitestArguments], { cwd, stdio: "inherit" });

    exitWithStatus(result.status, result.error);
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
