import { describe, expect, it } from "vitest";

import { scanString, transformYamlBlockScalars } from "../src/index";

// End-to-end tests that exercise the Rust detector through the JS wrapper.
// Use a minimal inline config (one rule, `extendBundled: false`) so the
// ruleset compile stays fast — the full ~1,390-rule compile is multi-second
// on first call and would blow the default vitest 5s timeout.

const MINIMAL_CONFIG = {
    rules: [
        {
            description: "Fake token for tests",
            id: "test-token",
            keywords: ["TESTTOKEN"],
            regex: String.raw`TESTTOKEN_[A-Za-z0-9]{20}`,
            tags: ["test"],
        },
    ],
    title: "test",
};

const TWO_RULE_CONFIG = {
    rules: [
        ...MINIMAL_CONFIG.rules,
        {
            description: "Second fake token for rule-scoping tests",
            id: "other-token",
            keywords: ["OTHERTOKEN"],
            regex: String.raw`OTHERTOKEN_[A-Za-z0-9]{20}`,
            tags: ["test"],
        },
    ],
    title: "test",
};

const TEST_TOKEN_LINE = "let a = TESTTOKEN_abcdefghij0123456789";
const OTHER_TOKEN_LINE = "let b = OTHERTOKEN_abcdefghij0123456789";

const scanTwoRules = (content: string) =>
    scanString(content, "file.ts", {
        config: { extendBundled: false, inline: TWO_RULE_CONFIG },
    });

describe("pragma suppression (end-to-end)", () => {
    it("same-line `pragma: allowlist secret` suppresses the finding", async () => {
        expect.assertions(2);

        const unsuppressed = await scanString("let x = TESTTOKEN_abcdefghij0123456789\n", "file.ts", {
            config: { extendBundled: false, inline: MINIMAL_CONFIG },
        });

        expect(unsuppressed).toHaveLength(1);

        const suppressed = await scanString("let x = TESTTOKEN_abcdefghij0123456789 // pragma: allowlist secret\n", "file.ts", {
            config: { extendBundled: false, inline: MINIMAL_CONFIG },
        });

        expect(suppressed).toHaveLength(0);
    }, 30_000);

    it("previous-line `pragma: allowlist nextline secret` suppresses the finding", async () => {
        expect.assertions(1);

        const content = ["# pragma: allowlist nextline secret", "let x = TESTTOKEN_abcdefghij0123456789", ""].join("\n");

        const findings = await scanString(content, "file.ts", {
            config: { extendBundled: false, inline: MINIMAL_CONFIG },
        });

        expect(findings).toHaveLength(0);
    }, 30_000);

    it("nextline pragma two lines up does NOT suppress (only immediate previous line counts)", async () => {
        expect.assertions(1);

        const content = ["# pragma: allowlist nextline secret", "unrelated line", "let x = TESTTOKEN_abcdefghij0123456789"].join("\n");

        const findings = await scanString(content, "file.ts", {
            config: { extendBundled: false, inline: MINIMAL_CONFIG },
        });

        expect(findings).toHaveLength(1);
    }, 30_000);
});

describe("rule-scoped allow markers (end-to-end)", () => {
    it("same-line marker suppresses only the named rule", async () => {
        expect.assertions(2);

        const findings = await scanTwoRules(`${TEST_TOKEN_LINE} // gitleaks:allow test-token\n${OTHER_TOKEN_LINE}\n`);

        expect(findings).toHaveLength(1);
        expect(findings[0]?.ruleId).toBe("other-token");
    }, 30_000);

    it("same-line marker naming another rule suppresses nothing", async () => {
        expect.assertions(2);

        const findings = await scanTwoRules(`${TEST_TOKEN_LINE} # secret-scanner:allow other-token\n${OTHER_TOKEN_LINE}\n`);

        expect(findings).toHaveLength(2);
        expect(findings.map((finding) => finding.ruleId)).toStrictEqual(expect.arrayContaining(["other-token", "test-token"]));
    }, 30_000);

    it("unknown rule id is read as prose and leaves the marker bare", async () => {
        expect.assertions(1);

        const findings = await scanTwoRules(`${TEST_TOKEN_LINE} // gitleaks:allow no-such-rule\n${OTHER_TOKEN_LINE}\n`);

        expect(findings.map((finding) => finding.ruleId)).toStrictEqual(["other-token"]);
    }, 30_000);

    it.each(["false-positive", "test-only", "@alice"])(
        "hyphenated or handle prose `%s` after a bare marker still suppresses",
        async (prose) => {
            expect.assertions(1);

            const findings = await scanTwoRules(`${TEST_TOKEN_LINE} // gitleaks:allow ${prose}\n`);

            expect(findings).toHaveLength(0);
        },
        30_000,
    );

    it("bare marker with prose still suppresses every rule on the line", async () => {
        expect.assertions(1);

        const findings = await scanTwoRules(`${TEST_TOKEN_LINE} // gitleaks:allow safe in tests\n`);

        expect(findings).toHaveLength(0);
    }, 30_000);

    it("scoped previous-line pragma suppresses only the named rule", async () => {
        expect.assertions(2);

        const findings = await scanTwoRules(["# pragma: allowlist nextline secret test-token", TEST_TOKEN_LINE, OTHER_TOKEN_LINE, ""].join("\n"));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.ruleId).toBe("other-token");
    }, 30_000);

    it("scoped block region suppresses only the named rule", async () => {
        expect.assertions(2);

        const findings = await scanTwoRules(["# gitleaks:allow-start test-token", TEST_TOKEN_LINE, "# gitleaks:allow-end", OTHER_TOKEN_LINE, ""].join("\n"));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.ruleId).toBe("other-token");
    }, 30_000);
});

describe("allow markers sharing a line or a boundary line", () => {
    it("lets a later bare marker suppress a rule an earlier scoped marker did not name", async () => {
        expect.assertions(1);

        const findings = await scanTwoRules(`${TEST_TOKEN_LINE} // gitleaks:allow other-token // gitleaks:allow`);

        expect(findings).toHaveLength(0);
    }, 30_000);

    it("treats a secret before an allow-start marker on the same line as allowed", async () => {
        expect.assertions(1);

        const findings = await scanTwoRules(`${TEST_TOKEN_LINE} // gitleaks:allow-start`);

        expect(findings).toHaveLength(0);
    }, 30_000);

    it("scopes a boundary line by the rule ids after the marker", async () => {
        expect.assertions(2);

        const findings = await scanTwoRules(`${TEST_TOKEN_LINE} ${OTHER_TOKEN_LINE} // gitleaks:allow-start test-token`);

        expect(findings).toHaveLength(1);
        expect(findings[0]?.ruleId).toBe("other-token");
    }, 30_000);
});

describe("yaml transformer × scanString integration", () => {
    it("detects a secret that was split across a block scalar after transform", async () => {
        expect.assertions(3);

        // Secret intentionally split across two block-scalar lines — without
        // the transformer, neither line contains the full match.
        const yamlSource = ["config:", "  token: |", "    TESTTOKEN_abcdefghij", "    0123456789extra", ""].join("\n");

        const raw = await scanString(yamlSource, "config.yaml", {
            config: { extendBundled: false, inline: MINIMAL_CONFIG },
        });

        expect(raw).toHaveLength(0);

        const transformed = transformYamlBlockScalars(yamlSource);
        const findings = await scanString(transformed, "config.yaml", {
            config: { extendBundled: false, inline: MINIMAL_CONFIG },
        });

        expect(findings).toHaveLength(1);
        // Line numbers preserved: the collapsed proxy sits on the original
        // `token: |` line (line 2).
        expect(findings[0]?.startLine).toBe(2);
    }, 30_000);
});
