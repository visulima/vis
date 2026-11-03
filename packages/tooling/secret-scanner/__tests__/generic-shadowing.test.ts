/* eslint-disable no-useless-concat -- fake tokens are split so GitHub push protection does not flag the fixtures */
import { describe, expect, it } from "vitest";

import type { GitleaksConfig } from "../src/config-loader";
import { scanString } from "../src/index";
import type { ScanOptions } from "../src/types";

const TOKEN = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";

// A specific rule plus a catch-all `generic-api-key` whose match also covers the variable name.
const rules: GitleaksConfig["rules"] = [
    { id: "github-pat", keywords: ["ghp_"], regex: "ghp_[0-9a-zA-Z]{36}" },
    { id: "generic-api-key", keywords: ["token"], regex: String.raw`token\s*=\s*"([0-9a-zA-Z_]{20,})"` },
];
const options: ScanOptions = { config: { extendBundled: false, inline: { rules } } };

describe("generic-api-key shadowing", () => {
    it("drops the generic finding a reported specific finding overlaps", async () => {
        expect.assertions(1);

        const findings = await scanString(`const token = "${TOKEN}";\n`, "a.ts", options);

        expect(findings.map((finding) => finding.ruleId)).toStrictEqual(["github-pat"]);
    });

    it("reports the generic finding when the specific rule is excluded", async () => {
        expect.assertions(1);

        const findings = await scanString(`const token = "${TOKEN}";\n`, "a.ts", { ...options, rules: { exclude: ["github-pat"] } });

        expect(findings.map((finding) => finding.ruleId)).toStrictEqual(["generic-api-key"]);
    });

    it("reports the generic finding when a heuristic drops the specific one", async () => {
        expect.assertions(1);

        // The specific rule reports only the token body, a placeholder the heuristics drop.
        const bodyRule = { id: "github-pat", keywords: ["ghp_"], regex: "ghp_([0-9a-zA-Z]{36})" };
        const findings = await scanString(`const token = "ghp_${"A".repeat(36)}";\n`, "a.ts", {
            config: { extendBundled: false, inline: { rules: [bodyRule, ...rules.slice(1)] } },
        });

        expect(findings.map((finding) => finding.ruleId)).toStrictEqual(["generic-api-key"]);
    });
});
