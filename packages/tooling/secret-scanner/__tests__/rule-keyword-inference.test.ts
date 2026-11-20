import { beforeAll, describe, expect, it, vi } from "vitest";

import { createRuleTester, defineRule, inferKeywords, scanString } from "../src/index";

beforeAll(async () => {
    await scanString("warmup", "warmup.txt");
}, 120_000);

vi.setConfig({ testTimeout: 30_000 });

interface KeywordCase {
    keywords: string[];
    name: string;
    pattern: string;
    /** A string the regex matches. When set, `auto` must find exactly what `keywords: false` finds. */
    sample?: string;
}

const keywordCases: KeywordCase[] = [
    // Bounded quantifiers: `{n}`, `{n,}` and `{n,m}` are quantifiers, never literal text.
    { keywords: ["abcdx", "efgh"], name: "exact count {3}", pattern: "abcdx{3}efgh", sample: "abcdxxxefgh" },
    { keywords: ["tokenx", "_abcd"], name: "open range {2,}", pattern: "tokenx{2,}_abcd", sample: "tokenxx_abcd" },
    { keywords: ["_abcd", "keyx"], name: "range {1,3}", pattern: "keyx{1,3}_abcd", sample: "keyxx_abcd" },
    { keywords: ["_abcd", "token"], name: "{0,} drops the atom", pattern: "tokenx{0,}_abcd", sample: "token_abcd" },
    { keywords: ["_abcd", "token"], name: "{0,3} drops the atom", pattern: "tokenx{0,3}_abcd", sample: "token_abcd" },
    { keywords: ["secret", "_abcd"], name: "{0} drops the atom", pattern: "secretx{0}_abcd", sample: "secret_abcd" },
    { keywords: ["_abcd", "token"], name: "lazy {0,3}?", pattern: "tokenx{0,3}?_abcd", sample: "token_abcd" },
    { keywords: ["_suffix", "prefix"], name: "optional group {0,2}", pattern: "prefix(?:xyz){0,2}_suffix", sample: "prefix_suffix" },
    { keywords: ["_suffix", "prefix", "xyzw"], name: "required group {2}", pattern: "prefix(?:xyzw){2}_suffix", sample: "prefixxyzwxyzw_suffix" },
    { keywords: [], name: "brace without a minimum", pattern: "abcdef{,3}" },
    { keywords: [], name: "unterminated brace", pattern: "abcdef{" },
    { keywords: [], name: "non-numeric brace", pattern: "abcdef{x}" },
    { keywords: [], name: "stray closing brace", pattern: "abcdef}" },

    // Escapes: only escaped punctuation is literal text; unknown escapes give up.
    { keywords: ["abcdef.ghijk"], name: "escaped dot", pattern: String.raw`abcdef\.ghijk`, sample: "abcdef.ghijk" },
    { keywords: ["abcd-efgh"], name: "escaped dash", pattern: String.raw`abcd\-efgh`, sample: "abcd-efgh" },
    { keywords: ["abcd", "efgh"], name: String.raw`\a is the bell character`, pattern: String.raw`abcd\aefgh`, sample: "abcd\u0007efgh" },
    { keywords: ["prefix_", "abcdef"], name: String.raw`\pL without braces`, pattern: String.raw`prefix_\pLabcdef`, sample: "prefix_Zabcdef" },
    { keywords: ["prefix_", "abcdef"], name: String.raw`\p{L} with braces`, pattern: String.raw`prefix_\p{L}abcdef`, sample: "prefix_Zabcdef" },
    { keywords: ["bcdef"], name: String.raw`\U code point`, pattern: String.raw`\U00000041BCDEF`, sample: "ABCDEF" },
    { keywords: [], name: String.raw`word-start \<`, pattern: String.raw`\<abcdef\>`, sample: "abcdef" },
    { keywords: [], name: String.raw`\b{start}`, pattern: String.raw`\b{start}abcdef`, sample: "abcdef" },
    { keywords: [], name: String.raw`\h`, pattern: String.raw`\habcdef` },
    { keywords: [], name: String.raw`\H`, pattern: String.raw`abcdef\H` },
    { keywords: [], name: String.raw`\K`, pattern: String.raw`abcdef\Kghijk` },
    { keywords: [], name: String.raw`\G`, pattern: String.raw`\Gabcdef` },
    { keywords: [], name: String.raw`\e`, pattern: String.raw`abc\edef` },
    { keywords: [], name: String.raw`backreference \1`, pattern: String.raw`(abcd)_\1` },
    { keywords: [], name: String.raw`backreference \9`, pattern: String.raw`abcdef\9` },
    { keywords: [], name: "named backreference", pattern: String.raw`(?<n>abcd)\k<n>` },
    { keywords: [], name: "trailing backslash", pattern: "abcdef\\" },

    // Verbose mode makes whitespace and comments insignificant.
    { keywords: [], name: "(?x) prefix", pattern: "(?x) abcd efgh", sample: "abcdefgh" },
    { keywords: [], name: "(?x) in the middle", pattern: "abcdef(?x) ghij", sample: "abcdefghij" },
    { keywords: [], name: "(?x:…) group", pattern: "(?x:abcd efgh)", sample: "abcdefgh" },
    { keywords: [], name: "(?i-x) flags", pattern: "(?i-x)abcdefgh", sample: "ABCDEFGH" },
    { keywords: ["abcdefgh"], name: "(?i) is fine", pattern: "(?i)abcdefgh", sample: "ABCDEFGH" },

    // Character classes: POSIX items, nesting and a leading literal `]`.
    { keywords: ["abcdef"], name: "POSIX class", pattern: "[[:alpha:]]abcdef", sample: "xabcdef" },
    { keywords: ["abcdef"], name: "negated POSIX class", pattern: "[[:^digit:]]abcdef", sample: "xabcdef" },
    { keywords: ["abcdef"], name: "nested class", pattern: "[a-z[0-9]]abcdef", sample: "5abcdef" },
    { keywords: ["abcdef"], name: "leading literal ]", pattern: "[]x]abcdef", sample: "]abcdef" },
    { keywords: ["abcdef"], name: "negated leading literal ]", pattern: "[^]x]abcdef", sample: "zabcdef" },
    { keywords: ["abcdef"], name: "escaped ] in a class", pattern: String.raw`[\]x]abcdef`, sample: "]abcdef" },
    { keywords: ["abcdef"], name: "class inside a skipped group", pattern: "(?<n>[[:alpha:]()])abcdef", sample: "(abcdef" },
    { keywords: [], name: "unterminated class", pattern: "abcdef[abc" },
    { keywords: [], name: "unterminated group", pattern: "(abcdef" },
    { keywords: [], name: "unbalanced closing paren", pattern: "abcdef)" },
];

const sampled = keywordCases.filter((entry): entry is KeywordCase & { sample: string } => entry.sample !== undefined);
const withoutIds = (findings: { ruleId: string }[]) => findings.map(({ ruleId: _ruleId, ...position }) => position);

describe("keyword inference fails safe", () => {
    it.each(keywordCases)("infers the right keywords for $name", ({ keywords, pattern }) => {
        expect.assertions(1);

        expect(inferKeywords(pattern)).toStrictEqual(keywords);
    });

    it.each(sampled)("auto keywords find what keywords: false finds for $name", async ({ pattern, sample }) => {
        expect.assertions(3);

        const auto = defineRule({ defaultEnabled: true, description: "auto", id: "test.auto", regex: pattern });
        const always = defineRule({ defaultEnabled: true, description: "always", id: "test.always", keywords: false, regex: pattern });
        const [expected] = await createRuleTester(always).snapshot([sample]);
        const [actual] = await createRuleTester(auto).snapshot([sample]);

        // Every inferred keyword must occur in a real match, or the native prefilter would drop it.
        expect((auto.keywords ?? []).every((keyword) => sample.toLowerCase().includes(keyword))).toBe(true);
        expect(expected?.findings.length).toBeGreaterThan(0);
        expect(withoutIds(actual?.findings ?? [])).toStrictEqual(withoutIds(expected?.findings ?? []));
    });
});

describe("opt-in rules in the tester", () => {
    const optIn = () => defineRule({ defaultEnabled: false, description: "opt-in", id: "test.opt-in", regex: /OPTIN_[A-Z0-9]{8}/ });

    it("runs a defaultEnabled: false rule that a plain scan skips", async () => {
        expect.assertions(2);

        const code = "OPTIN_ABCD1234";

        await expect(scanString(code, "test.ts", { config: { extendBundled: false, inline: { rules: [optIn()] } } })).resolves.toHaveLength(0);
        await expect(createRuleTester(optIn()).run({ invalid: [code], valid: ["OPTIN_short"] })).resolves.toHaveLength(2);
    });
});
