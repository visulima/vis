import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRstestEntry } from "../../../src/commands/test/handler";

const readText = (path: string) => readFile(path, "utf8").catch(() => undefined);

describe(resolveRstestEntry, () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "vis-test-rstest-"));
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it("returns the rstest bin from an @rstest/core install found in an ancestor", async () => {
        expect.assertions(1);

        const coreDirectory = join(root, "node_modules", "@rstest", "core");
        const packageDirectory = join(root, "packages", "app");

        await mkdir(coreDirectory, { recursive: true });
        await mkdir(packageDirectory, { recursive: true });
        await writeFile(join(coreDirectory, "package.json"), JSON.stringify({ bin: { rstest: "./bin/rstest.js" } }));

        await expect(resolveRstestEntry(packageDirectory, readText)).resolves.toBe(join(coreDirectory, "bin", "rstest.js"));
    });

    it("returns undefined when no ancestor has @rstest/core", async () => {
        expect.assertions(1);

        const packageDirectory = join(root, "app");

        await mkdir(packageDirectory, { recursive: true });

        await expect(resolveRstestEntry(packageDirectory, readText)).resolves.toBeUndefined();
    });
});
