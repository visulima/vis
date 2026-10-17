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

const execute = async ({ argument, fs, options, rawUnknown }: Toolbox<Console, TestOptions>): Promise<void> => {
    const cwd = process.cwd();
    const vitestEntry = await resolveVitestEntry(cwd, (path) => fs.readFile(path, "utf8").catch(() => undefined));

    if (vitestEntry === undefined) {
        throw new VisUserError("Vitest is not installed. Add it with `vis add -D vitest`, then run `vis test` again.");
    }

    // Vitest's `run` subcommand exits after one pass; without it Vitest watches,
    // which is what `--watch` asks for.
    const vitestArguments = [...(options.watch ? [] : ["run"]), ...(argument ?? []), ...(rawUnknown ?? [])];

    const result = spawnSync(process.execPath, [vitestEntry, ...vitestArguments], { cwd, stdio: "inherit" });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
    }
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
