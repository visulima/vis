import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CI_PACKAGE_MANAGER_COMMANDS } from "../../src/pm/ci-commands";
import { renderNativeCiTables } from "../../src/util/ci-workflow/native-tables";
import { GITHUB_ACTIONS } from "../../src/util/github-actions";

/**
 * The native `vis sync ci-workflow` reads its action pins and package-manager commands from
 * `native/cli/src/ci-tables.json`, which is generated from the TypeScript tables in `src/util/github-actions.ts`
 * and `src/pm/ci-commands.ts` (the sources the Node renderer, `vis release init` and `vis sync codeowners` use).
 * A pin bumped or a manager changed on the Node side fails here until the file is regenerated:
 * `VIS_UPDATE_CI_TABLES=1 pnpm exec vitest run __tests__/native/ci-tables.test.ts`.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tablesPath = join(packageRoot, "native", "cli", "src", "ci-tables.json");

describe("native ci workflow tables", () => {
    it.runIf(process.env["VIS_UPDATE_CI_TABLES"] === "1")("regenerates the file when asked to", () => {
        expect.assertions(1);

        writeFileSync(tablesPath, renderNativeCiTables());

        expect(readFileSync(tablesPath, "utf8")).toBe(renderNativeCiTables());
    });

    it("match the TypeScript tables byte for byte", () => {
        expect.assertions(1);

        expect(readFileSync(tablesPath, "utf8")).toBe(renderNativeCiTables());
    });

    it("covers every action and every package manager", () => {
        expect.assertions(2);

        const tables = JSON.parse(readFileSync(tablesPath, "utf8")) as { actions: Record<string, unknown>; packageManagers: Record<string, unknown> };

        expect(Object.keys(tables.actions)).toStrictEqual(Object.keys(GITHUB_ACTIONS));
        expect(Object.keys(tables.packageManagers)).toStrictEqual(Object.keys(CI_PACKAGE_MANAGER_COMMANDS));
    });
});
