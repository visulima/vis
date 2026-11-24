import { describe, expect, it } from "vitest";

import { buildE18eEntries } from "../../../src/commands/optimize/replacements";

describe(buildE18eEntries, () => {
    it("lists every mapping of the module-replacements manifests when no dependency filter is given", () => {
        expect.assertions(2);

        const entries = buildE18eEntries();

        expect(entries.length).toBeGreaterThan(900);
        expect(new Set(entries.map((entry) => entry.category))).toStrictEqual(new Set(["micro-utility", "native", "preferred"]));
    });

    it("reports a package with a native replacement together with the Node version that has it", () => {
        expect.assertions(1);

        expect(buildE18eEntries(new Set(["left-pad"]))).toStrictEqual([
            {
                category: "native",
                docUrl: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padStart",
                hasCodemod: false,
                overrideSpec: undefined,
                packageName: "left-pad",
                replacement: "String.prototype.padStart (Node 8.0.0+)",
            },
        ]);
    });

    it("reports every replacement of a mapping, and links the e18e guide the mapping names", () => {
        expect.assertions(3);

        const entry = buildE18eEntries(new Set(["@cypress/request"])).find((candidate) => candidate.category === "preferred");

        expect(entry?.replacement).toBe("fetch (Node 18.0.0+), ofetch, ky");
        expect(entry?.docUrl).toBe("https://github.com/es-tooling/module-replacements/blob/main/docs/modules/fetch.md");
        expect(entry?.packageName).toBe("@cypress/request");
    });

    it("reports a micro utility with the snippet text it points at", () => {
        expect.assertions(2);

        const entries = buildE18eEntries(new Set(["arr-diff"]));

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ category: "micro-utility", packageName: "arr-diff" });
    });

    it("skips packages that are not dependencies", () => {
        expect.assertions(1);

        expect(buildE18eEntries(new Set(["not-a-package-any-manifest-lists"]))).toStrictEqual([]);
    });
});
