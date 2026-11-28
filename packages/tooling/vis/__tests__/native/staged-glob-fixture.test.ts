import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import zeptomatch from "zeptomatch";

/**
 * The glob matcher of the native `vis staged` (`native/cli/src/staged/glob.rs`) matches a subset of what `zeptomatch`
 * matches, and Node's matcher is the authority. The fixture holds, for each pattern the binary reads, the paths
 * `zeptomatch` matches out of a fixed list, and the patterns the binary must leave to Node. The Rust tests read the
 * fixture, and this test rebuilds it from `zeptomatch` and fails when the file differs, so the two cannot drift.
 *
 * Regenerate with `UPDATE_STAGED_GLOB_FIXTURE=1 pnpm vitest run __tests__/native/staged-glob-fixture.test.ts`.
 */

const fixturePath = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "native", "cli", "tests", "fixtures", "staged-glob.json");

const SUPPORTED = [
    "*.txt",
    "*",
    "**",
    "**/*",
    "src/*.ts",
    "src/**/*.ts",
    "**/*.ts",
    "src/**",
    "**/src/*.ts",
    "*.{ts,tsx}",
    "{a,b}.ts",
    "a.txt",
    "src/a.ts",
    "*.t*",
    "*a*",
    "a*b",
    "**/a/**/b.ts",
    "a/**/b",
    "a/**",
    "*/a.ts",
    "*/**/a.ts",
    "src/*",
    "{src,lib}/**/*.ts",
    "*.{ts}",
    "{a}",
    "*.*",
    "*.*.*",
    ".eslintrc",
    ".*",
    "*.d.ts",
    "package.json",
    "a-b_c.txt",
    "{a,b}/{x,y}.ts",
    "**/{a,b}.ts",
    "**/*.{js,mjs,cjs}",
    "packages/*/src/**/*.ts",
    "docs/**/*.md",
    "**/README.md",
    "*.TXT",
];

const DECLINED = [
    "!*.test.ts",
    "a?.ts",
    "[ab].ts",
    "*.{ts,{js,mjs}}",
    "{}",
    "a.{b,}",
    "{a,b",
    "a,b}",
    "a//b",
    "./a.ts",
    "/a.ts",
    "../a.ts",
    "a/",
    "**/",
    "a**b",
    "**a",
    "a**",
    "@(a|b).ts",
    "+(a|b).ts",
    String.raw`a\*.ts`,
    "a b.txt",
    "é.txt",
    "{1..3}.ts",
    "*.{ts,tsx}/{a,b,c,d}/{a,b,c,d}/{a,b,c}",
    "",
];

const PATHS = [
    "a.txt",
    ".a.txt",
    ".txt",
    "x/a.txt",
    "a.txt.bak",
    "a",
    "a/b",
    "a/b/c",
    "src/a.ts",
    "src/x/a.ts",
    "src/x/y/a.ts",
    "src/.x/a.ts",
    "src/.a.ts",
    "a.ts",
    "x/a.ts",
    "lib/a.ts",
    "b.ts",
    "ab.ts",
    "a/b.ts",
    "a/x/b.ts",
    "a/x/y/b.ts",
    "a/a.ts",
    "x/a/a.ts",
    "a.tsx",
    "a.js",
    "a.mjs",
    "ab",
    "aXb",
    "a.b",
    "a.",
    "src",
    "src/a",
    "x.y.z",
    "a.b.c.d",
    "a b.txt",
    "a+b.txt",
    "A.txt",
    "A.TXT",
    "x.TXT",
    "src/A.ts",
    "README.md",
    "docs/README.md",
    "docs/a/b.md",
    "docs/x.md",
    "packages/a/src/index.ts",
    "packages/a/src/x/y.ts",
    "packages/a/index.ts",
    "packages/src/x.ts",
    ".eslintrc",
    ".eslintrc.json",
    ".env",
    "a/.env",
    "types.d.ts",
    "src/types.d.ts",
    "package.json",
    "packages/a/package.json",
    "a-b_c.txt",
    "x/y.ts",
    "a/y.ts",
    "b/x.ts",
    "a/x/y.ts",
    "a/b/x.ts",
];

const build = (): string => {
    const supported: Record<string, string[]> = {};

    for (const pattern of SUPPORTED) {
        supported[pattern] = PATHS.filter((path) => zeptomatch(pattern, path));
    }

    return `${JSON.stringify({ declined: DECLINED, paths: PATHS, supported }, null, 4)}\n`;
};

describe("staged glob fixture", () => {
    it("matches what zeptomatch matches", () => {
        expect.hasAssertions();

        const expected = build();

        if (process.env["UPDATE_STAGED_GLOB_FIXTURE"] === "1") {
            writeFileSync(fixturePath, expected);
        }

        expect(readFileSync(fixturePath, "utf8")).toBe(expected);
    });

    it("lists a pattern that matches something and one that matches nothing", () => {
        expect.hasAssertions();

        const fixture = JSON.parse(build()) as { supported: Record<string, string[]> };

        expect(fixture.supported["*.txt"]).toContain("a.txt");
        expect(fixture.supported["src/*.ts"]).not.toContain("src/x/a.ts");
        expect(fixture.supported["**/*.ts"]).toContain("a.ts");
    });
});
