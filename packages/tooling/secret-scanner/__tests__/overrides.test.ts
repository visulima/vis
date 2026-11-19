import { describe, expect, it } from "vitest";

import { scanString } from "../src/index";

const GITHUB = 'github = "ghp_aB3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5b"';
const AWS = 'aws = "AKIAQYLPMN5HJ38DNCZG"';

// A small explicit ruleset keeps this file fast; the overrides pipeline is
// independent of how many rules the bundled config happens to carry.
const config = {
    extendBundled: false,
    inline: {
        rules: [
            { id: "gh-pat", keywords: ["ghp_"], regex: String.raw`ghp_[A-Za-z0-9]{20,}` },
            { id: "aws-key", keywords: ["AKIA"], regex: String.raw`AKIA[A-Z0-9]{16}` },
            { defaultEnabled: false, id: "opt-in-only", keywords: ["tok_"], regex: String.raw`tok_[a-z0-9]{12}` },
        ],
    },
};

const withOverrides = (overrides: { files: string | string[]; rules?: { enable?: string[]; exclude?: string[]; include?: string[] } }[]) => {
    return {
        config,
        overrides,
    };
};

describe("per-file overrides", () => {
    it("excludes rules only in matching files", async () => {
        expect.assertions(2);

        const options = withOverrides([{ files: "*.env", rules: { exclude: ["gh-pat"] } }]);
        const env = await scanString(`${GITHUB}\n${AWS}`, "app.env", options);
        const text = await scanString(`${GITHUB}\n${AWS}`, "app.txt", options);

        expect(env.some((finding) => finding.ruleId === "gh-pat")).toBe(false);
        expect(text.some((finding) => finding.ruleId === "gh-pat")).toBe(true);
    });

    it("restricts matching files to the listed rules", async () => {
        expect.assertions(2);

        const options = withOverrides([{ files: ["*.txt"], rules: { include: ["gh-pat"] } }]);
        const text = await scanString(`${GITHUB}\n${AWS}`, "app.txt", options);
        const env = await scanString(`${GITHUB}\n${AWS}`, "app.env", options);

        expect(text.map((finding) => finding.ruleId)).toStrictEqual(["gh-pat"]);
        expect(env.some((finding) => finding.ruleId === "gh-pat")).toBe(true);
    });

    it("enables opt-in rules only in matching files", async () => {
        expect.assertions(2);

        const options = withOverrides([{ files: "*.env", rules: { enable: ["opt-in-only"] } }]);
        const content = "token = tok_a1b2c3d4e5f6";
        const env = await scanString(content, ".env", options);
        const text = await scanString(content, "app.txt", options);

        expect(env.some((finding) => finding.ruleId === "opt-in-only")).toBe(true);
        expect(text.some((finding) => finding.ruleId === "opt-in-only")).toBe(false);
    });

    it("applies later matching overrides in order", async () => {
        expect.assertions(2);

        const options = withOverrides([
            { files: "**/*", rules: { exclude: ["gh-pat"] } },
            { files: "*.env", rules: { include: ["gh-pat"] } },
        ]);
        const env = await scanString(GITHUB, "app.env", options);
        const text = await scanString(GITHUB, "app.txt", options);

        expect(env.map((finding) => finding.ruleId)).toStrictEqual(["gh-pat"]);
        expect(text.some((finding) => finding.ruleId === "gh-pat")).toBe(false);
    });
});
