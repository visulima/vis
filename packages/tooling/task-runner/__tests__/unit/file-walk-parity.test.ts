/**
 * The directory walk exists twice: the native one (`collectFiles` of the addon, which feeds every fileset key) and
 * the JS one (`collectFiles` of `src/utils.ts`, which feeds the incremental hasher and the import checks). They must
 * list the same files for the same tree, links, cycles and an ignored-looking walk root included. The one difference
 * is a dangling link: the native walk lists it (it hashes to a marker), the JS walk has no hash to give it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadNativeBindings } from "../../src/native-binding";
import { collectFiles } from "../../src/utils";

const IGNORED = new Set([".cache", ".git", "coverage", "dist", "node_modules"]);
const roots: string[] = [];

// eslint-disable-next-line vitest/require-top-level-describe -- removes the trees created below
afterAll(() => {
    for (const root of roots) {
        rmSync(root, { force: true, recursive: true });
    }
});

const put = (root: string, relative: string, content: string): void => {
    const path = join(root, relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
};

const createTree = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "walk-parity-")));

    roots.push(root);

    put(root, "libs/shared/src/index.ts", "index");
    put(root, "libs/shared/src/deep/more.ts", "more");
    put(root, "libs/shared/src/node_modules/dep/x.js", "ignored");
    put(root, "libs/out/a.js", "a");
    put(root, "app/own.ts", "own");
    put(root, "app/real/r.ts", "r");
    put(root, "app/node_modules/dep/index.js", "ignored");
    put(root, "app/dist/out.js", "ignored");
    mkdirSync(join(root, "app/src"), { recursive: true });
    symlinkSync("../../libs/shared/src", join(root, "app/src/shared"));
    symlinkSync("../../libs/shared/src/index.ts", join(root, "app/src/index-link.ts"));
    symlinkSync("real", join(root, "app/alias"));
    symlinkSync("..", join(root, "app/real/up"));
    symlinkSync(".", join(root, "app/self"));
    symlinkSync("../libs/out", join(root, "app/linked-out"));
    mkdirSync(join(root, "app/sub"), { recursive: true });
    symlinkSync("../../libs/out", join(root, "app/sub/dist"));
    symlinkSync("../missing/target.ts", join(root, "app/broken.ts"));
    put(root, "dist/inside.js", "a base directory named like an ignored one");

    return root;
};

describe.skipIf(process.platform === "win32")("native and JS directory walks", () => {
    it("list the same files, a dangling link aside", async () => {
        expect.hasAssertions();

        const native = loadNativeBindings();
        const root = createTree();

        for (const directory of [join(root, "app"), join(root, "dist")]) {
            // eslint-disable-next-line no-await-in-loop -- one tree at a time
            const found = await collectFiles(directory, IGNORED);
            const javascript = found.toSorted();
            const nativeFiles = (native?.collectFiles(directory) ?? []).toSorted();

            expect(nativeFiles.filter((file) => !javascript.includes(file)), directory).toStrictEqual(directory.endsWith("app") ? [join(root, "app/broken.ts")] : []);
            expect(nativeFiles.filter((file) => file !== join(root, "app/broken.ts")), directory).toStrictEqual(javascript);
        }
    });

    it("list the files behind every link under the spelling of the link", () => {
        expect.hasAssertions();

        const root = createTree();

        expect(loadNativeBindings()?.collectFiles(join(root, "app")).map((file) => file.slice(root.length + 1)).toSorted()).toStrictEqual([
            "app/alias/r.ts",
            "app/broken.ts",
            "app/linked-out/a.js",
            "app/own.ts",
            "app/real/r.ts",
            "app/src/index-link.ts",
            "app/src/shared/deep/more.ts",
            "app/src/shared/index.ts",
        ]);
    });
});
