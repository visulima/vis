import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanString } from "../src/index";
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
