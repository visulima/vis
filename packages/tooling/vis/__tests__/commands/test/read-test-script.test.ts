import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTestScript } from "../../../src/commands/test/handler";

const readText = (path: string) => readFile(path, "utf8").catch(() => undefined);

describe(readTestScript, () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "vis-test-script-"));
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it("returns the package's test script", async () => {
        expect.assertions(1);

        await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));

        await expect(readTestScript(root, readText)).resolves.toBe("vitest run");
    });

    it("ignores npm's init placeholder", async () => {
        expect.assertions(1);

        await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));

        await expect(readTestScript(root, readText)).resolves.toBeUndefined();
    });

    it("returns undefined when there is no package.json or no test script", async () => {
        expect.assertions(2);

        await expect(readTestScript(root, readText)).resolves.toBeUndefined();

        await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "packem build" } }));

        await expect(readTestScript(root, readText)).resolves.toBeUndefined();
    });
});
