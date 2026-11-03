import { describe, expect, it } from "vitest";

import { splitNativeReport } from "../src/binding";
import type { Finding } from "../src/types";

const finding = (ruleId: string): Finding => {
    return {
        alternateMatches: [],
        confidence: "low",
        description: "",
        endColumn: 1,
        endLine: 1,
        entropy: 0,
        file: "a.env",
        match: "m",
        ruleId,
        secret: "s",
        startColumn: 1,
        startLine: 1,
        tags: [],
    };
};

const skipped = [{ path: "big.bin", reason: "too-large" }];

describe(splitNativeReport, () => {
    it("splits a bare findings array (older scanTextSync) on suppressedBy", () => {
        expect.assertions(1);

        expect(splitNativeReport([finding("a"), { ...finding("b"), suppressedBy: "inline-allow" }])).toStrictEqual({
            findings: [finding("a")],
            skipped: [],
            suppressed: [{ ...finding("b"), suppressedBy: "inline-allow" }],
        });
    });

    it("splits a report whose findings carry suppressedBy inline (older scanDetailed)", () => {
        expect.assertions(1);

        expect(splitNativeReport({ findings: [{ ...finding("a"), suppressedBy: "allowlist" }, finding("b")], skipped })).toStrictEqual({
            findings: [finding("b")],
            skipped,
            suppressed: [{ ...finding("a"), suppressedBy: "allowlist" }],
        });
    });

    it("passes a split report through", () => {
        expect.assertions(1);

        const report = { findings: [finding("a")], skipped, suppressed: [{ ...finding("b"), suppressedBy: "allowlist" }] };

        expect(splitNativeReport(report)).toStrictEqual(report);
    });
});
