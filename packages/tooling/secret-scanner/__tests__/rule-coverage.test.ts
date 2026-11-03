import { beforeAll, describe, expect, it } from "vitest";

import { scanString } from "../src";

// Rule-level regression tests: one true positive and one false positive per
// rule we touch at build time (converter fixes, gitleaks patches, Visulima
// rules). Every sample secret below is fake.

beforeAll(async () => {
    await scanString("warmup", "warmup.txt");
}, 120_000);

const ruleIdsFor = async (content: string, file = "sample.txt"): Promise<string[]> => {
    const findings = await scanString(content, file);

    return findings.map((finding) => finding.ruleId);
};

describe("kingfisher rules revived by the named-group keyword fix", () => {
    it("kingfisher.modal.1 finds a Modal token pair without the word `token_id` nearby", async () => {
        expect.assertions(1);

        const content = `modal_token = "ak-Xq9mB2vT7` + `kLp4RzW8nYc3d"\nmodal_secret = "as-Hj5kN8pQ2wE6rT9yU3iO1a"\n`;

        await expect(ruleIdsFor(content)).resolves.toContain("kingfisher.modal.1");
    });

    it("kingfisher.generic.9 finds `user+tag:SECRET` credentials without `user`/`pass` nearby", async () => {
        expect.assertions(1);

        const content = `url = alice.smith+deploy:A9F3K2L8Q7W1E5R6T4Y0U2I8O3P6S1D7\n`;

        await expect(ruleIdsFor(content)).resolves.toContain("kingfisher.generic.9");
    });

    it("kingfisher.ftp.1 finds plain `ftp://` URLs (keyword no longer `ftps`)", async () => {
        expect.assertions(1);

        const content = `mirror = ftp://admin:S3cr3tPassw0rd@files.example.org/pub\n`;

        await expect(ruleIdsFor(content)).resolves.toContain("kingfisher.ftp.1");
    });

    it("kingfisher.modal.1 ignores a lone `ak-` identifier", async () => {
        expect.assertions(1);

        await expect(ruleIdsFor("const id = 'ak-short';\n")).resolves.not.toContain("kingfisher.modal.1");
    });
});
