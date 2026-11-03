import { describe, expect, it } from "vitest";

import { diffRulesets, formatMarkdown } from "../diff-rulesets.mjs";

const rules = (...list: Record<string, unknown>[]): Map<string, Record<string, unknown>> => new Map(list.map((rule) => [rule.id as string, rule]));

describe(diffRulesets, () => {
    it("separates added, removed, renamed and changed ids", () => {
        expect.assertions(4);

        const before = rules(
            { id: "kingfisher.a.1", regex: "(?x) a+ ", source: "kingfisher" },
            { id: "kingfisher.b.1", regex: "b+", source: "kingfisher" },
            { id: "kingfisher.c.1", regex: "c+", source: "kingfisher" },
        );
        const after = rules(
            // Same matcher modulo free-spacing whitespace under a new id: a rename.
            { id: "kingfisher.a.2", regex: "(?x)a+", source: "kingfisher" },
            { id: "kingfisher.c.1", regex: "c{2,}", source: "kingfisher" },
            { id: "kingfisher.d.1", regex: "d+", source: "kingfisher" },
        );

        const diff = diffRulesets(before, after);

        expect(diff.renamed).toStrictEqual([{ from: "kingfisher.a.1", to: "kingfisher.a.2" }]);
        expect(diff.removed).toStrictEqual(["kingfisher.b.1"]);
        expect(diff.added).toStrictEqual(["kingfisher.d.1"]);
        expect(diff.changed).toStrictEqual(["kingfisher.c.1"]);
    });

    it("does not pair rules from different sources as a rename", () => {
        expect.assertions(2);

        const diff = diffRulesets(rules({ id: "a", regex: "x+", source: "gitleaks" }), rules({ id: "b", regex: "x+", source: "kingfisher" }));

        expect(diff.renamed).toStrictEqual([]);
        expect(diff.removed).toStrictEqual(["a"]);
    });

    it("formats a markdown summary with the counts", () => {
        expect.assertions(2);

        const markdown = formatMarkdown(diffRulesets(rules({ id: "a", regex: "x" }), rules({ id: "b", regex: "y" })));

        expect(markdown).toContain("Rules: 1 -> 1. Added 1, removed 1, renamed 0, detection changed 0.");
        expect(markdown).toContain("- `a`");
    });
});
