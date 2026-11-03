import { afterEach, describe, expect, it } from "vitest";

import type { GitleaksConfig } from "../src/config-loader";
import { buildRuleMeta, prepareScan, resetPrepareScanCacheForTests } from "../src/prepare-scan";

afterEach(() => {
    resetPrepareScanCacheForTests();
});

describe("prepareScan — memoization", () => {
    it("reuses the resolved config for two calls with equivalent non-inline options", () => {
        expect.assertions(2);

        const first = prepareScan({ rules: { exclude: ["github-pat"] } });
        const second = prepareScan({ rules: { exclude: ["github-pat"] } });

        // Cache hit → identical config and rule meta (no re-resolve / re-buildRuleMeta).
        expect(second.config).toBe(first.config);
        expect(second.ruleMeta).toBe(first.ruleMeta);
    });

    it("builds native options per call, even on a cache hit", () => {
        expect.assertions(3);

        const low = prepareScan({ config: { minConfidence: "low" as const } });
        const high = prepareScan({ config: { minConfidence: "high" as const }, redact: true });

        expect(high.config).toBe(low.config);
        expect(high.nativeOptions.minConfidence).toBe("high");
        expect(high.nativeOptions.redact).toBe(true);
    });

    it("does not cache inline configs (rebuilds each call)", () => {
        expect.assertions(1);

        const inline: GitleaksConfig = { rules: [{ id: "custom.rule", regex: "x" }] };
        const first = prepareScan({ config: { extendBundled: false, inline } });
        const second = prepareScan({ config: { extendBundled: false, inline } });

        expect(second.ruleMeta).not.toBe(first.ruleMeta);
    });

    it("misses the cache when a config-shaping option differs", () => {
        expect.assertions(1);

        const a = prepareScan({ rules: { exclude: ["github-pat"] } });
        const b = prepareScan({ rules: { exclude: ["aws-access-token"] } });

        expect(b.config).not.toBe(a.config);
    });
});

describe(buildRuleMeta, () => {
    it("maps a well-formed rule's checksum, pattern, validation, and deps", () => {
        expect.assertions(4);

        const config = {
            rules: [
                {
                    dependsOnRule: [{ rule_id: "aws.1", variable: "AKID" }],
                    id: "aws.2",
                    patternRequirements: { checksum: { expected: "{{ x }}" } },
                    regex: String.raw`AKIA[0-9A-Z]{16}`,
                    validation: { type: "AWS" },
                },
            ],
        } as unknown as GitleaksConfig;

        const map = buildRuleMeta(config);
        const meta = map.get("aws.2");

        expect(meta?.pattern).toBe(String.raw`AKIA[0-9A-Z]{16}`);
        expect(meta?.checksum).toStrictEqual({ expected: "{{ x }}" });
        expect(meta?.validation).toStrictEqual({ type: "AWS" });
        expect(meta?.dependsOnRule).toStrictEqual([{ ruleId: "aws.1", variable: "AKID" }]);
    });

    it("accepts the camelCase `ruleId` spelling for dependsOnRule entries", () => {
        expect.assertions(1);

        const config = {
            rules: [{ dependsOnRule: [{ ruleId: "parent.rule", variable: "TOKEN" }], id: "child.rule" }],
        } as unknown as GitleaksConfig;

        expect(buildRuleMeta(config).get("child.rule")?.dependsOnRule).toStrictEqual([{ ruleId: "parent.rule", variable: "TOKEN" }]);
    });

    it("drops dependsOnRule entries without a string variable or rule id", () => {
        expect.assertions(1);

        const config = {
            rules: [
                {
                    dependsOnRule: [
                        // missing `variable`
                        { rule_id: "x" },
                        // `variable` not a string
                        { rule_id: "x", variable: 5 },
                        // missing both rule_id and ruleId
                        { variable: "OK" },
                        // non-object entry
                        "garbage",
                    ],
                    id: "noisy.rule",
                },
            ],
        } as unknown as GitleaksConfig;

        // Every entry is malformed → deps collapse to undefined.
        expect(buildRuleMeta(config).get("noisy.rule")?.dependsOnRule).toBeUndefined();
    });

    it("skips non-object and id-less rules", () => {
        expect.assertions(1);

        const config = {
            rules: [
                // eslint-disable-next-line unicorn/no-null -- exercising the runtime null guard for malformed config rules.
                null,
                "not-an-object",
                { description: "no id" },
                { id: "kept.rule" },
            ],
        } as unknown as GitleaksConfig;

        expect([...buildRuleMeta(config).keys()]).toStrictEqual(["kept.rule"]);
    });

    it("returns an empty map when the config has no rules", () => {
        expect.assertions(1);

        expect(buildRuleMeta({}).size).toBe(0);
    });

    it("leaves checksum/pattern/validation undefined when the rule omits them", () => {
        expect.assertions(3);

        const meta = buildRuleMeta({ rules: [{ id: "bare" }] }).get("bare");

        expect(meta?.checksum).toBeUndefined();
        expect(meta?.pattern).toBeUndefined();
        expect(meta?.validation).toBeUndefined();
    });
});
