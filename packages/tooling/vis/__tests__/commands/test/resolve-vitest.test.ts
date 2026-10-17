import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveVitestEntry } from "../../../src/commands/test/handler";

const readText = (path: string) => readFile(path, "utf8").catch(() => undefined);

describe(resolveVitestEntry, () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "vis-test-resolve-"));
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it("returns the bin entry from a hoisted vitest install found in an ancestor", async () => {
        expect.hasAssertions();

        const vitestDirectory = join(root, "node_modules", "vitest");
        const packageDirectory = join(root, "packages", "app", "src");

        await mkdir(vitestDirectory, { recursive: true });
        await mkdir(packageDirectory, { recursive: true });
        await writeFile(join(vitestDirectory, "package.json"), JSON.stringify({ bin: { vitest: "./vitest.mjs" } }));

        await expect(resolveVitestEntry(packageDirectory, readText)).resolves.toBe(join(vitestDirectory, "vitest.mjs"));
    });

    it("returns undefined when no ancestor has vitest installed", async () => {
        expect.hasAssertions();

        const packageDirectory = join(root, "app");

        await mkdir(packageDirectory, { recursive: true });

        // The temp directory lives under the OS tmpdir, which should not contain a
        // vitest install in any ancestor; this guards against a false positive from
        // the walk stopping early.
        await expect(resolveVitestEntry(packageDirectory, readText)).resolves.toBeUndefined();
    });
});
