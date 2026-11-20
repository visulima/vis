import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scan, scanDetailed, scanFiles, scanFilesDetailed, scanString } from "../src/index";
import type { ScanOptions } from "../src/types";

const directories: string[] = [];

const tempDirectory = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "secret-scanner-redact-"));

    directories.push(directory);

    return directory;
};

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("redact masks composite dependencies", () => {
    const compositeOptions: ScanOptions = {
        config: {
            extendBundled: false,
            inline: {
                rules: [
                    { id: "ident", keywords: ["ident_"], regex: "ident_[A-Z]{12}" },
                    { id: "skey", keywords: ["skey_"], regex: "skey_[a-z]{14}", required: [{ id: "ident", withinLines: 3 }] },
                ],
            },
        },
        redact: true,
    };
    const content = "ID=ident_ABCDEFGHIJKL\nKEY=skey_abcdefghijklmn\n";

    it("masks requiredFindings when a secret-value .gitleaksignore entry is loaded", async () => {
        expect.assertions(3);

        const directory = tempDirectory();
        const ignorePath = join(directory, ".gitleaksignore");

        writeFileSync(ignorePath, "secret:unrelated-value-1234\n");

        const findings = await scanString(content, "c.env", { ...compositeOptions, gitleaksIgnore: ignorePath });
        const composite = findings.find((finding) => finding.ruleId === "skey");

        expect(composite?.secret).toBe("ske*************lmn");
        expect(composite?.requiredFindings?.map((required) => required.secret)).toStrictEqual(["ide************JKL"]);
        expect(JSON.stringify(findings)).not.toContain("ident_ABCDEFGHIJKL");
    });

    it("matches a baseline written from redacted output by its masked content hash", async () => {
        expect.assertions(2);

        const baseline = await scanString(content, "c.env", compositeOptions);
        // Moved two lines down, so only the content hash (not the line-based key) can match.
        const moved = `\n\n${content}`;

        await expect(scanString(moved, "c.env", compositeOptions)).resolves.toHaveLength(2);
        await expect(scanString(moved, "c.env", { ...compositeOptions, baseline })).resolves.toStrictEqual([]);
    });

    it("masks requiredFindings without an ignore file", async () => {
        expect.assertions(1);

        const findings = await scanString(content, "c.env", compositeOptions);

        expect(JSON.stringify(findings)).not.toContain("ident_ABCDEFGHIJKL");
    });
});

describe("masking is the default", () => {
    // eslint-disable-next-line no-useless-concat -- split so GitHub push protection doesn't flag the fake token
    const token = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";
    const masked = `ghp${"*".repeat(token.length - 6)}xY4`;
    const content = `const token = "${token}";\n`;
    const writeFixture = (): string => {
        const directory = tempDirectory();

        writeFileSync(join(directory, "a.ts"), content);

        return directory;
    };
    const secretsOf = (findings: { match: string; secret: string }[]): string[] => findings.flatMap((finding) => [finding.secret, finding.match]);

    it("masks match and secret in every scan API unless redact: false", async () => {
        expect.assertions(7);

        const directory = writeFixture();
        const file = join(directory, "a.ts");
        const detailed = await scanDetailed([directory]);
        const filesDetailed = await scanFilesDetailed([file]);

        const results = [await scanString(content, "a.ts"), await scan([directory]), await scanFiles([file]), detailed.findings, filesDetailed.findings];

        for (const findings of results) {
            expect(findings.map((finding) => finding.secret)).toStrictEqual([masked]);
        }

        expect(JSON.stringify(results)).not.toContain(token);
        expect(secretsOf(await scanString(content, "a.ts", { redact: true }))).not.toContain(token);
    });

    it("reveals the real values with redact: false", async () => {
        expect.assertions(3);

        const directory = writeFixture();
        const [fromString] = await scanString(content, "a.ts", { redact: false });
        const [fromScan] = await scan([directory], { redact: false });

        expect(fromString?.secret).toBe(token);
        expect(fromString?.match).toContain(token);
        expect(fromScan?.secret).toBe(token);
    });

    it("reports the same findings whether values are masked or revealed", async () => {
        expect.assertions(2);

        // Content-shape heuristics and the checksum filter judge the real value, so masking never changes the set.
        const noisy = `${content}b = "123e4567-e89b-12d3-a456-426614174000"\nc = "********"\n`;
        const ids = async (redact: boolean): Promise<string[]> => {
            const findings = await scanString(noisy, "a.ts", { redact });

            return findings.map((finding) => `${finding.ruleId}:${String(finding.startLine)}`);
        };
        const maskedIds = await ids(true);

        expect(maskedIds).toContain("github-pat:1");
        expect(maskedIds).toStrictEqual(await ids(false));
    });
});
