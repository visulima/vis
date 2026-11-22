import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/**
 * The blocklists this test runs the TypeScript check against: a fixed pair that covers the shapes of the
 * real ones (unscoped, separated, scoped, overlapping and duplicated entries, generated and hand-curated).
 * The real lists (`data/typosquats*.json`) are refreshed by a workflow, so a fixture built from them would
 * go stale with every refresh; the matching is what must agree, and it agrees on any list.
 */
const { AUTO, MANUAL } = vi.hoisted(() => {
    return {
        AUTO: {
            "@tanstack/start": ["start-tanstack-app", "tanstack-kit"],
            express: ["expres", "exprss", "express-js"],
            "left-pad": ["leftpad", "left_pad", "lef-tpad"],
            lodash: ["lodahs", "l0dash", "lodash-js", "lodas"],
            react: ["reakt", "reactt", "raect"],
            "react-dom": ["reactdom"],
            typescript: ["typscript", "typescrip"],
            vue: ["vuee"],
            "zz-lib": ["zz-lib-x"],
        },
        MANUAL: { "@scope/pkg": ["pkgg", "scope-pkgs"], react: ["raect", "rect"] },
    };
});

vi.mock(import("../../data/typosquats.json"), () => {
    return { default: AUTO };
});
vi.mock(import("../../data/typosquats-manual.json"), () => {
    return { default: MANUAL };
});

const { checkTyposquat, generateVariants } = await import("../../src/security/typosquats");

/**
 * The typosquat name check exists twice: `src/security/typosquats.ts` (Node) and
 * `native/cli/src/typosquat.rs`, which `vis install` runs natively before it installs. A name the native
 * check misses would install where Node stops, so the two must agree on every name.
 *
 * This test writes what the TypeScript code answers, for the fixed blocklists above, into a fixture the Rust
 * unit tests check the port against: the blocklists themselves, the full set of flagged names (as a count and
 * a digest), the exact variant sets of a spread of names, and the answer for exact, variant, scoped, clean and
 * odd names. If the TypeScript matching changes, this test fails until the fixture is regenerated:
 *
 *     UPDATE_TYPOSQUAT_PARITY=1 pnpm exec vitest run __tests__/native/typosquat-parity.test.ts
 */

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "cli", "tests", "fixtures", "typosquat-parity.json");

type Blocklist = Record<string, string[]>;

const sources = [AUTO, MANUAL] as Blocklist[];

/** Names whose full variant set is part of the fixture: short, separated, scoped, repeated and edge shapes. */
const VARIANT_NAMES = [
    "react",
    "lodash",
    "left-pad",
    "a-b.c_d",
    "abc",
    "ab",
    "abcde",
    "abcdef",
    "express-session",
    "typescript",
    "a.b",
    "x_y-z",
    "aaa",
    "iiii",
    "@tanstack/start",
    "@types/node",
    "@a/b",
    "@ab/cde",
    "@abc/de",
    "@scope/",
    "@/x",
    "@scope/a/b",
];

/** Names that are on no list and match no variant; the native check must not flag them. */
const CLEAN_NAMES = [
    "react",
    "react-dom",
    "vue",
    "svelte",
    "left-pad",
    "typescript",
    "vitest",
    "eslint",
    "prettier",
    "@types/node",
    "@babel/core",
    "@visulima/vis",
    "zzz-not-a-package-name",
    "internal-tools",
    "my-company-ui",
    "lodash.merge",
    "express",
    "next",
];

const ODD_NAMES = ["", "@", "@a", "@a/", "@a/b", "a/b", "ab", "UPPER", "lodash ", "lödash", "@scope/lodas", "@scope/a/lodas", "npm:lodas"];

const buildFixture = () => {
    const flagged = new Set<string>();

    for (const source of sources) {
        for (const [legitimate, typosquats] of Object.entries(source)) {
            for (const typosquat of typosquats) {
                flagged.add(typosquat);
            }

            for (const variant of generateVariants(legitimate)) {
                flagged.add(variant);
            }
        }
    }

    const sorted = [...flagged].toSorted();
    const legitimateNames = [...new Set(sources.flatMap((source) => Object.keys(source)))];
    const typosquatNames = [...new Set(sources.flatMap((source) => Object.values(source).flat()))];
    const sampledVariants = legitimateNames.flatMap((name) => [...generateVariants(name)].toSorted().slice(0, 12));
    const lookups = [
        ...new Set([
            ...legitimateNames,
            ...legitimateNames.map((name) => `@scope/${name}`),
            ...typosquatNames,
            ...typosquatNames.map((name) => `@scope/${name}`),
            ...sampledVariants,
            ...CLEAN_NAMES,
            ...ODD_NAMES,
        ]),
    ].map((name) => [name, checkTyposquat(name) !== undefined] as const);

    return {
        blocklists: { auto: AUTO, manual: MANUAL },
        flagged: { count: sorted.length, sha256: createHash("sha256").update(sorted.join("\n")).digest("hex") },
        lookups,
        variants: Object.fromEntries(VARIANT_NAMES.map((name) => [name, [...generateVariants(name)].toSorted()])),
    };
};

describe("typosquat check: Node vs native (fixture for native/cli/src/typosquat.rs)", () => {
    const fixture = buildFixture();
    const text = `${JSON.stringify(fixture, undefined, 4)}\n`;

    if (process.env["UPDATE_TYPOSQUAT_PARITY"] === "1") {
        writeFileSync(fixturePath, text);
    }

    it("matches the committed fixture the Rust tests read", () => {
        expect.assertions(1);

        expect(readFileSync(fixturePath, "utf8")).toBe(text);
    });

    it("flags exactly the blocklisted names and the generated variants of the legitimate names", () => {
        expect.assertions(1);

        const wrong = fixture.lookups.filter(([name, hit]) => {
            const flagged = sources.some((source) => Object.values(source).some((typosquats) => typosquats.includes(name.startsWith("@") ? (name.split("/")[1] ?? name) : name)));
            const variant = sources.some((source) =>
                Object.keys(source).some((legitimate) => generateVariants(legitimate).has(name.startsWith("@") ? (name.split("/")[1] ?? name) : name)),
            );

            return hit !== (flagged || variant);
        });

        expect(wrong).toStrictEqual([]);
    });

    it("covers hits and misses of every kind", () => {
        expect.assertions(3);

        expect(fixture.lookups.filter(([, hit]) => hit).length).toBeGreaterThan(100);
        expect(fixture.lookups.filter(([, hit]) => !hit).length).toBeGreaterThan(15);
        expect(Object.keys(fixture.variants)).toHaveLength(VARIANT_NAMES.length);
    });
});
