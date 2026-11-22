import { describe, expect, expectTypeOf, it } from "vitest";

import { scan, scanDetailed, scanFilesDetailed, scanSync, scanTextSync } from "../index.js";
import { scanString } from "../src/index";

describe("native-binding", () => {
    // eslint-disable-next-line vitest/prefer-expect-assertions -- type-only assertions via expectTypeOf
    it("loads the native addon when compiled", () => {
        expectTypeOf(scan).toBeFunction();
        expectTypeOf(scanSync).toBeFunction();
        expectTypeOf(scanTextSync).toBeFunction();
    });

    it("detects a hard-coded GitHub token via scanString", { timeout: 30_000 }, async () => {
        expect.assertions(1);

        const content = ["# config", 'github_token = "ghp_aB3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5b"'].join("\n");
        const findings = await scanString(content, "fake.env");

        expect(findings.length).toBeGreaterThan(0);
    });

    it("returns an empty profile for an empty scan when one is requested", async () => {
        expect.assertions(4);

        const walked = await scanDetailed([], { profile: true });
        const listed = await scanFilesDetailed([], { profile: true });
        const plain = await scan([], {});

        expect(walked.profile?.files).toStrictEqual([]);
        expect(listed.profile?.rules).toStrictEqual([]);
        expect(listed.profile?.totalMs).toBe(0);
        expect(plain.profile).toBeUndefined();
    });

    it("exposes byte spans that point back into the scanned text", { timeout: 30_000 }, async () => {
        expect.assertions(3);

        // eslint-disable-next-line no-useless-concat -- split so automated push protection doesn't flag the fixture
        const token = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4zA5b";
        const content = `# config\r\ngithub_token = "${token}"\r\n`;
        const findings = await scanString(content, "fake.env", { redact: false });
        const finding = findings.find((entry) => entry.ruleId === "github-pat");

        expect(finding).toBeDefined();

        if (finding?.sourceSpan === undefined) {
            return;
        }

        const bytes = Buffer.from(content, "utf8");

        expect(bytes.subarray(finding.sourceSpan.secretStart, finding.sourceSpan.secretEnd).toString("utf8")).toBe(finding.secret);
        expect(bytes.subarray(finding.sourceSpan.matchStart, finding.sourceSpan.matchEnd).toString("utf8")).toBe(finding.match);
    });
});
