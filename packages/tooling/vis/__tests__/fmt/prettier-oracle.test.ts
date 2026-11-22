import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { dirname, join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModuleLoader } from "../../src/fmt/options";
import { mapPrettierConfig, readPrettierConfig, readPrettierIgnore } from "../../src/fmt/prettier-config";
import { resolveOxfmtBin } from "../../src/fmt/run-oxfmt";
import { PRETTIER_CASES } from "./prettier-cases";

/**
 * The mapper must stay equal to `oxfmt --migrate prettier`. Each case is written to a temp project,
 * migrated by the real CLI, and the options it writes are compared with the mapper's output.
 * Skipped when the platform binary of oxfmt is not installed.
 */
const oxfmtRuns = ((): boolean => {
    try {
        return spawnSync(process.execPath, [resolveOxfmtBin(), "--version"], { encoding: "utf8" }).status === 0;
    } catch {
        return false;
    }
})();

const loadModule: ModuleLoader = async (path) => (await import(pathToFileURL(path).href)) as Record<string, unknown>;

let root: string;

describe("prettier mapper oracle", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-fmt-oracle-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    describe.skipIf(!oxfmtRuns)("mapPrettierConfig against `oxfmt --migrate prettier`", () => {
        it.each(PRETTIER_CASES)("matches for $name", async ({ files }) => {
            expect.assertions(2);

            for (const [name, content] of Object.entries(files)) {
                mkdirSync(dirname(join(root, name)), { recursive: true });
                writeFileSync(join(root, name), content);
            }

            const migrated = spawnSync(process.execPath, [resolveOxfmtBin(), "--migrate", "prettier"], { cwd: root, encoding: "utf8" });

            expect(migrated.status).toBe(0);

            const oracle = JSON.parse(readFileSync(join(root, ".oxfmtrc.json"), "utf8")) as Record<string, unknown>;

            delete oracle.$schema;

            const found = await readPrettierConfig(root, loadModule);
            const { config } = mapPrettierConfig(found!.config, { ignorePatterns: readPrettierIgnore(root), sourceFile: found!.file });

            expect(structuredClone(config)).toStrictEqual(oracle);
        });
    });
});
