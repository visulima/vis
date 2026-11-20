import { beforeAll, describe, expect, it, vi } from "vitest";

import { createRuleTester, defineRule, defineRuleset, inferKeywords, RuleTesterError, scanString } from "../src/index";
import { maskSecret } from "../src/mask";

const SECRET = "TOKEN_ABCDEF1234";
const masked = maskSecret(SECRET);

beforeAll(async () => {
    await scanString("warmup", "warmup.txt");
}, 120_000);

vi.setConfig({ testTimeout: 30_000 });

const tokenRule = () =>
    defineRule({
        defaultEnabled: true,
        description: "test token",
        id: "test.token",
        regex: /TOKEN_[A-Z0-9]{10}/,
        secretGroup: 0,
        source: "test",
    });

describe("rule authoring", () => {
    it("infers only mandatory, unescaped literal fragments", () => {
        expect.assertions(7);

        expect(inferKeywords(String.raw`abc\.def[0-9]+`)).toStrictEqual(["abc.def"]);
        expect(inferKeywords("prefix(?:foo|bar)_XYZ")).toStrictEqual(["prefix", "_xyz"]);
        expect(inferKeywords("(?:foo|bar)_[0-9]{6}")).toStrictEqual([]);
        expect(inferKeywords("optional_(token)?_suffix")).toContain("_suffix");
        expect(inferKeywords(String.raw`abc\/def`)).toStrictEqual(["abc/def"]);
        expect(inferKeywords("(?i)foo|bar:bazqux")).toStrictEqual([]);
        expect(inferKeywords("(?i)ÄBCDEF123")).toStrictEqual([]);
    });

    it("does not treat unicode and hex escapes as literal text", () => {
        expect.assertions(2);

        expect(inferKeywords(String.raw`\u0041BCDEF`)).toStrictEqual(["bcdef"]);
        expect(inferKeywords(String.raw`\x41BCDEF`)).toStrictEqual(["bcdef"]);
    });

    it("compiles a typed rule into a native-compatible object", () => {
        expect.assertions(2);

        expect(tokenRule()).toStrictEqual({
            defaultEnabled: true,
            description: "test token",
            id: "test.token",
            keywords: ["token_"],
            regex: "TOKEN_[A-Z0-9]{10}",
            secretGroup: 0,
            source: "test",
        });
        expect(defineRuleset([tokenRule()], "test rules")).toStrictEqual({ rules: [tokenRule()], title: "test rules" });
    });

    it("converts RegExp flags to Rust inline flags and honours explicit keyword hints", () => {
        expect.assertions(5);

        expect(defineRule({ description: "case", id: "test.case", keywords: ["TOKEN_"], regex: /token_[a-z]+/i })).toStrictEqual({
            description: "case",
            id: "test.case",
            keywords: ["token_"],
            regex: "(?i)token_[a-z]+",
        });
        expect(defineRule({ description: "always", id: "test.always", keywords: false, regex: "abc" })).toStrictEqual({
            description: "always",
            id: "test.always",
            regex: "abc",
        });
        expect(() => defineRule({ description: "bad", id: "test.bad", regex: /abc/g })).toThrow(/can't be represented/);
        expect(defineRule({ description: "slash", id: "test.slash", regex: String.raw`a\\/b` }).regex).toBe(String.raw`a\\/b`);
        expect(() => defineRule({ description: "unicode", id: "test.unicode", keywords: ["ÄBCDEF"], regex: "abc" })).toThrow(/isn't ASCII/);
    });
});

describe(createRuleTester, () => {
    it("runs valid and invalid cases through the real scanner", async () => {
        expect.assertions(2);

        const tester = createRuleTester(tokenRule());
        const results = await tester.run({
            invalid: [{ code: `const token = ${SECRET};`, line: 1 }],
            valid: ["const token = 'not-a-secret';"],
        });

        expect(results.map((result) => result.kind)).toStrictEqual(["valid", "invalid"]);
        expect(results.map((result) => result.findings.length)).toStrictEqual([0, 1]);
    });

    it("produces masked, serializable snapshots without leaking the secret", async () => {
        expect.assertions(3);

        const tester = createRuleTester(tokenRule());
        const snapshots = await tester.snapshot([`const token = ${SECRET};`]);
        const serialized = JSON.stringify(snapshots);

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.findings).toStrictEqual([{ column: 15, line: 1, maskedMatch: masked, ruleId: "test.token" }]);
        expect(serialized).not.toContain(SECRET);
    });

    it("reports failures with positions only", async () => {
        expect.assertions(2);

        const tester = createRuleTester(tokenRule());

        try {
            await tester.run({ valid: [`const token = ${SECRET};`] });

            expect.unreachable("expected the tester to reject a leaked secret");
        } catch (error) {
            expect(error).toBeInstanceOf(RuleTesterError);
            expect((error as Error).message).not.toContain(SECRET);
        }
    });

    it("rejects rules that the native engine skipped", async () => {
        expect.assertions(2);

        const broken = defineRule({ description: "broken", id: "test.broken", regex: "([a-z" });
        const tester = createRuleTester(broken);

        try {
            await tester.run({ invalid: ["abc"] });

            expect.unreachable("expected the tester to reject a rule that failed to compile");
        } catch (error) {
            expect(error).toBeInstanceOf(RuleTesterError);
            expect((error as Error).message).toContain("test.broken");
        }
    });

    it("filters findings by rule id in multi-rule testers", async () => {
        expect.assertions(1);

        const other = defineRule({
            description: "other token",
            id: "test.other",
            regex: "OTHER_[A-Z0-9]{8}",
        });
        const tester = createRuleTester([tokenRule(), other]);
        const results = await tester.run({
            invalid: [{ code: `OTHER_ABC12345 ${SECRET}`, findings: 1, ruleId: "test.token" }],
        });

        expect(results[0]?.findings).toStrictEqual([{ column: 16, line: 1, maskedMatch: masked, ruleId: "test.token" }]);
    });
});
