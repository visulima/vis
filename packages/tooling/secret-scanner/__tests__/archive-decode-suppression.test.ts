import { Buffer } from "node:buffer";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { scanDetailed } from "../src/index";
import type { ScanOptions } from "../src/types";

vi.setConfig({ testTimeout: 30_000 });

const SECRET = "TESTTOKEN_abcdefghij0123456789";
const OTHER = "TESTTOKEN_zyxwvutsrq9876543210";

const config: ScanOptions["config"] = {
    extendBundled: false,
    inline: {
        allowlists: [{ regexes: ["zyxwvutsrq"] }],
        rules: [{ description: "Fake token", id: "test-token", keywords: ["TESTTOKEN"], regex: String.raw`TESTTOKEN_[A-Za-z0-9]{20}` }],
    },
};

const base64 = (value: string): string => Buffer.from(value).toString("base64");

const dirs: string[] = [];

const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "secret-scanner-interplay-")));

    dirs.push(dir);

    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { force: true, recursive: true });
    }
});

describe("archive entries go through suppression and skipped", () => {
    it("reports allowlisted and inline-allowed archive entries as suppressed", async () => {
        expect.assertions(2);

        const root = tempDir();

        writeFileSync(join(root, "app.env.gz"), gzipSync(`a = ${SECRET} # gitleaks:allow\nb = ${OTHER}\n`));

        const result = await scanDetailed([root], { config, maxArchiveDepth: 1, reportSuppressed: true });

        expect(result.findings).toStrictEqual([]);
        expect(result.suppressed.map((f) => [f.file, f.suppressedBy])).toStrictEqual([
            ["app.env.gz!app.env", "inline-allow"],
            ["app.env.gz!app.env", "allowlist"],
        ]);
    });

    it("honours inlineAllow: false inside archive entries", async () => {
        expect.assertions(1);

        const root = tempDir();

        writeFileSync(join(root, "app.env.gz"), gzipSync(`a = ${SECRET} # gitleaks:allow\n`));

        const result = await scanDetailed([root], { config, inlineAllow: false, maxArchiveDepth: 1 });

        expect(result.findings.map((f) => f.file)).toStrictEqual(["app.env.gz!app.env"]);
    });

    it("matches .gitleaksignore fingerprints against the virtual path", async () => {
        expect.assertions(3);

        const root = tempDir();

        writeFileSync(join(root, "app.env.gz"), gzipSync(`a = ${SECRET}\n`));
        writeFileSync(join(root, ".gitleaksignore"), "app.env.gz!app.env:test-token:1\n");

        const result = await scanDetailed([root], { config, gitleaksIgnore: join(root, ".gitleaksignore"), maxArchiveDepth: 1, reportSuppressed: true });

        expect(result.findings).toStrictEqual([]);
        expect(result.suppressed.map((f) => f.suppressedBy)).toStrictEqual(["gitleaksignore"]);
        expect(result.unusedIgnores).toStrictEqual([]);
    });

    it("lists archive entries skipped as decompression bombs", async () => {
        expect.assertions(2);

        const root = tempDir();

        writeFileSync(join(root, "big.txt.gz"), gzipSync(Buffer.alloc(4 * 1024 * 1024, "a")));
        writeFileSync(join(root, "app.env.gz"), gzipSync(`a = ${SECRET}\n`));

        const result = await scanDetailed([root], { config, maxArchiveDepth: 1 });

        expect(result.findings.map((f) => f.file)).toStrictEqual(["app.env.gz!app.env"]);
        expect(result.skipped).toStrictEqual([{ path: "big.txt.gz!big.txt", reason: "too-large" }]);
    });
});

describe("decoded findings go through suppression", () => {
    it("reports an inline-allowed decoded secret as suppressed, and as a finding with inlineAllow: false", async () => {
        expect.assertions(3);

        const root = tempDir();

        writeFileSync(join(root, "secret.yaml"), `token: ${base64(SECRET)} # gitleaks:allow\n`);

        const suppressed = await scanDetailed([root], { config, reportSuppressed: true });

        expect(suppressed.findings).toStrictEqual([]);
        expect(suppressed.suppressed.map((f) => [f.secret, f.decoded, f.suppressedBy])).toStrictEqual([[SECRET, ["base64"], "inline-allow"]]);

        const audited = await scanDetailed([root], { config, inlineAllow: false });

        expect(audited.findings.map((f) => [f.secret, f.decoded])).toStrictEqual([[SECRET, ["base64"]]]);
    });

    it("applies config allowlists and .gitleaksignore secret entries to decoded secrets", async () => {
        expect.assertions(2);

        const root = tempDir();

        writeFileSync(join(root, "secret.yaml"), `a: ${base64(OTHER)}\nb: ${base64(SECRET)}\n`);
        writeFileSync(join(root, ".gitleaksignore"), `secret:${SECRET}\n`);

        const result = await scanDetailed([root], { config, gitleaksIgnore: join(root, ".gitleaksignore"), reportSuppressed: true });

        expect(result.findings).toStrictEqual([]);
        expect(result.suppressed.map((f) => [f.secret, f.suppressedBy])).toStrictEqual([
            [SECRET, "gitleaksignore"],
            [OTHER, "allowlist"],
        ]);
    });
});
