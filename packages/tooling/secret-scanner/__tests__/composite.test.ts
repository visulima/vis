import { beforeAll, describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../src/config-loader";
import type { GitleaksConfig } from "../src/index";
import { inspectRuleset, scanString } from "../src/index";

vi.setConfig({ testTimeout: 60_000 });

const KEY_ID = "AKIA" + "Z7QW3RT5YU2IOPLM";
const SECRET = "wJalrXUtnFEMI/K7MDEN" + "G/bPxRfiCYzq8Rk2vN3d";

// Shape of a gitleaks.toml after TOML parsing: `[[rules.required]]` becomes a
// `required` array, keys keep their gitleaks spelling.
const gitleaksShaped = (required: Record<string, unknown>[], skipReport = false): GitleaksConfig => {
    return {
        rules: [
            {
                id: "aws-key-id",
                keywords: ["akia"],
                regex: String.raw`\b((?:AKIA|ASIA)[A-Z0-9]{16})\b`,
                skipReport,
            },
            {
                id: "aws-secret",
                keywords: ["aws_secret_access_key"],
                regex: String.raw`(?i)aws_secret_access_key\s*=\s*([A-Za-z0-9/+]{40})`,
                required,
                secretGroup: 1,
            },
        ],
    };
};

const scanWith = async (content: string, config: GitleaksConfig, redact = false) =>
    scanString(content, "creds.env", { config: { extendBundled: false, inline: config }, redact });

const lines = (gap: number): string =>
    [`aws_access_key_id = ${KEY_ID}`, ...Array.from({ length: gap - 1 }).fill("# filler"), `aws_secret_access_key = ${SECRET}`, ""].join("\n");

describe("composite rules (rules.required)", () => {
    beforeAll(async () => {
        await scanString("warmup", "warmup.txt", { config: { extendBundled: false, inline: { rules: [] } } });
    });

    it("reports the secret when the key id is within withinLines and attaches it", async () => {
        expect.assertions(5);

        const findings = await scanWith(lines(5), gitleaksShaped([{ id: "aws-key-id", withinLines: 5 }]));
        const primary = findings.find((finding) => finding.ruleId === "aws-secret");

        expect(primary?.secret).toBe(SECRET);
        expect(primary?.requiredFindings).toHaveLength(1);
        expect(primary?.requiredFindings?.[0]).toMatchObject({ ruleId: "aws-key-id", secret: KEY_ID, startLine: 1 });
        // The dependency is a normal rule, so it's also reported on its own.
        expect(findings.some((finding) => finding.ruleId === "aws-key-id")).toBe(true);
        // Plain findings keep their exact shape.
        expect(findings.find((finding) => finding.ruleId === "aws-key-id")).not.toHaveProperty("requiredFindings");
    });

    it("drops the secret when the key id is further than withinLines", async () => {
        expect.assertions(2);

        const findings = await scanWith(lines(6), gitleaksShaped([{ id: "aws-key-id", withinLines: 5 }]));

        expect(findings.some((finding) => finding.ruleId === "aws-secret")).toBe(false);
        expect(findings.some((finding) => finding.ruleId === "aws-key-id")).toBe(true);
    });

    it("drops the secret when the required rule has no finding at all", async () => {
        expect.assertions(1);

        const findings = await scanWith(`aws_secret_access_key = ${SECRET}\n`, gitleaksShaped([{ id: "aws-key-id" }]));

        expect(findings).toHaveLength(0);
    });

    it("counts a required finding anywhere in the file without bounds", async () => {
        expect.assertions(1);

        const findings = await scanWith(lines(200), gitleaksShaped([{ id: "aws-key-id" }]));

        expect(findings.some((finding) => finding.ruleId === "aws-secret")).toBe(true);
    });

    it("compares withinColumns only on the same line", async () => {
        expect.assertions(3);

        const required = [{ id: "aws-key-id", withinColumns: 10, withinLines: 2 }];
        // Next line, very different column: withinLines alone decides (the upstream bug).
        const nextLine = `${" ".repeat(60)}${KEY_ID}\naws_secret_access_key = ${SECRET}\n`;
        // Same line, columns 60+ apart: rejected by withinColumns.
        const sameLineFar = `aws_secret_access_key = ${SECRET} ${" ".repeat(40)}${KEY_ID}\n`;
        // withinColumns alone means "same line".
        const columnsOnly = `${KEY_ID}\naws_secret_access_key = ${SECRET}\n`;

        const reported = async (content: string, required_: Record<string, unknown>[]): Promise<boolean> => {
            const findings = await scanWith(content, gitleaksShaped(required_));

            return findings.some((finding) => finding.ruleId === "aws-secret");
        };

        await expect(reported(nextLine, required)).resolves.toBe(true);
        await expect(reported(sameLineFar, required)).resolves.toBe(false);
        await expect(reported(columnsOnly, [{ id: "aws-key-id", withinColumns: 100 }])).resolves.toBe(false);
    });

    it("evaluates skipReport rules as dependencies but never emits them", async () => {
        expect.assertions(3);

        const findings = await scanWith(lines(1), gitleaksShaped([{ id: "aws-key-id", withinLines: 1 }], true));

        expect(findings.map((finding) => finding.ruleId)).toStrictEqual(["aws-secret"]);
        expect(findings[0]?.requiredFindings?.[0]?.ruleId).toBe("aws-key-id");
        expect(findings[0]?.requiredFindings?.[0]?.secret).toBe(KEY_ID);
    });

    it("redacts required findings with redact on", async () => {
        expect.assertions(2);

        const findings = await scanWith(lines(1), gitleaksShaped([{ id: "aws-key-id" }]), true);
        const required = findings.find((finding) => finding.ruleId === "aws-secret")?.requiredFindings?.[0];

        expect(required?.secret).toBe("AKI**************PLM");
        expect(required?.match).not.toContain(KEY_ID);
    });

    it("reports unknown required ids through inspectRuleset instead of failing", async () => {
        expect.assertions(3);

        const config = gitleaksShaped([{ id: "does-not-exist" }]);
        const skipped = await inspectRuleset({ config: { extendBundled: false, inline: config } });

        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.ruleId).toBe("aws-secret");
        expect(skipped[0]?.reason).toContain("required rule 'does-not-exist' is not defined");
    });

    it("keeps required/skipReport when a partial rule extends a bundled rule (gitleaks #2024)", async () => {
        expect.assertions(5);

        const config: GitleaksConfig = {
            rules: [
                // No regex/path: extends the bundled `aws-access-token` instead of replacing it.
                { id: "aws-access-token", required: [{ id: "my-aws-secret", withinLines: 3 }] },
                {
                    id: "my-aws-secret",
                    keywords: ["aws_secret_access_key"],
                    regex: String.raw`(?i)aws_secret_access_key\s*=\s*([A-Za-z0-9/+]{40})`,
                    secretGroup: 1,
                    skipReport: true,
                },
            ],
        };
        const merged = resolveConfig({ config });
        const extended = merged.rules?.find((rule) => rule.id === "aws-access-token");

        // The bundled regex/keywords survive and the user's `required` is layered on.
        expect(extended).toMatchObject({ keywords: expect.arrayContaining(["akia"]), required: [{ id: "my-aws-secret", withinLines: 3 }] });
        expect(extended?.regex).toBeTypeOf("string");

        // Scan with just the two merged rules: other bundled AWS rules would win the
        // same-span dedup and hide the composite finding.
        const pair = { rules: merged.rules?.filter((rule) => rule.id === "aws-access-token" || rule.id === "my-aws-secret") };
        const options = { config: { extendBundled: false, inline: pair } };
        const paired = await scanString(lines(2), "creds.env", options);
        const alone = await scanString(`aws_access_key_id = ${KEY_ID}\n`, "creds.env", options);

        expect(paired.map((finding) => finding.ruleId)).toStrictEqual(["aws-access-token"]);
        expect(paired[0]?.requiredFindings?.[0]?.secret).toBe(SECRET);
        expect(alone).toHaveLength(0);
    });
});

describe("composite precedence", () => {
    it("keeps a satisfied composite over a higher-priority rule on the same span", async () => {
        expect.assertions(3);

        const config: GitleaksConfig = {
            rules: [
                ...(gitleaksShaped([{ id: "aws-key-id", withinLines: 5 }]).rules ?? []),
                {
                    id: "specific-aws-secret",
                    keywords: ["aws_secret_access_key"],
                    priority: 10,
                    regex: String.raw`(?i)aws_secret_access_key\s*=\s*([A-Za-z0-9/+]{40})`,
                    secretGroup: 1,
                },
            ],
        };

        const findings = await scanWith(lines(1), config);
        const atSecret = findings.filter((finding) => finding.startLine === 2);

        expect(atSecret.map((finding) => finding.ruleId)).toStrictEqual(["aws-secret"]);
        expect(atSecret[0]?.alternateMatches).toStrictEqual(["specific-aws-secret"]);
        expect(atSecret[0]?.requiredFindings?.[0]?.ruleId).toBe("aws-key-id");
    });

    it("keeps a composite generic-api-key whose dependency overlaps it", async () => {
        expect.assertions(2);

        const config: GitleaksConfig = {
            rules: [
                { id: "token-prefix", keywords: ["tok_"], regex: String.raw`tok_[a-z0-9]{8}` },
                {
                    id: "generic-api-key",
                    keywords: ["api_key"],
                    regex: String.raw`api_key\s*=\s*(tok_[a-z0-9]{8}[A-Z]{6})`,
                    required: [{ id: "token-prefix" }],
                    secretGroup: 1,
                },
            ],
        };

        const findings = await scanWith("api_key = tok_abcd1234QWERTY\n", config);

        expect(findings.map((finding) => finding.ruleId).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["generic-api-key", "token-prefix"]);
        expect(findings.find((finding) => finding.ruleId === "generic-api-key")?.requiredFindings).toHaveLength(1);
    });
});
