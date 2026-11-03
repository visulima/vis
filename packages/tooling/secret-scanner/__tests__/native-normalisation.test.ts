import { beforeAll, describe, expect, it, vi } from "vitest";

import { fingerprint, scanString } from "../src/index";
import type { ScanOptions } from "../src/types";

// Warm the Rust regex JIT (full bundled ruleset) once so tests don't timeout.
beforeAll(async () => {
    await scanString("warmup", "warmup.txt");
}, 120_000);

vi.setConfig({ testTimeout: 30_000 });

const tokenRule: ScanOptions = {
    config: {
        extendBundled: false,
        inline: { rules: [{ description: "token", id: "tok", keywords: ["token="], regex: "token=(.+)", secretGroup: 1 }] },
    },
};

/** Deterministic pseudo-random base64 body wrapped at 64 columns. */
const base64Body = (length: number): string => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let state = 0x25_45_f4_91;
    let out = "";

    for (let index = 0; index < length; index += 1) {
        // eslint-disable-next-line no-bitwise -- xorshift32 PRNG
        state ^= state << 13;
        // eslint-disable-next-line no-bitwise -- xorshift32 PRNG
        state ^= state >>> 17;
        // eslint-disable-next-line no-bitwise -- xorshift32 PRNG
        state ^= state << 5;
        // eslint-disable-next-line no-bitwise -- xorshift32 PRNG
        out += alphabet.charAt((state >>> 0) % 64);

        if (index % 64 === 63) {
            out += "\n";
        }
    }

    return out;
};

describe("native normalisation", () => {
    it("redacts a multibyte secret without crashing", async () => {
        expect.assertions(2);

        const findings = await scanString("token=pässwörtgeheim\n", "a.env", { ...tokenRule, redact: true });

        expect(findings).toHaveLength(1);
        expect(findings[0]!.secret).toBe("päs********eim");
    });

    it("gives CRLF and LF files the same secret and fingerprint", async () => {
        expect.assertions(5);

        const lf = await scanString("a=1\ntoken=abcDEF123456\nb=2\n", "a.env", tokenRule);
        const crlf = await scanString("a=1\r\ntoken=abcDEF123456\r\nb=2\r\n", "a.env", tokenRule);

        expect(crlf).toHaveLength(1);
        expect(crlf[0]!.secret).toBe("abcDEF123456");
        expect(crlf[0]!.match).toBe(lf[0]!.match);
        expect(crlf[0]!.endColumn).toBe(lf[0]!.endColumn);
        expect(fingerprint(crlf[0]!)).toBe(fingerprint(lf[0]!));
    });

    it("matches a PGP private key block larger than the 4 KiB keyword window", async () => {
        expect.assertions(1);

        const content = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${base64Body(8192)}\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----\n`;
        const findings = await scanString(content, "key.asc");

        // `kingfisher.pem.1` covers the same span at a higher priority, so `private-key`
        // may surface as an alternate match rather than as its own finding.
        expect(findings.flatMap((finding) => [finding.ruleId, ...finding.alternateMatches])).toContain("private-key");
    });

    it("matches a PEM private key body larger than the 4 KiB keyword window", async () => {
        expect.assertions(1);

        const content = `-----BEGIN RSA PRIVATE KEY-----\n${base64Body(6500)}\n-----END RSA PRIVATE KEY-----\n`;
        const findings = await scanString(content, "server.pem");

        // `kingfisher.pem.1` covers the same span at a higher priority, so `private-key`
        // may surface as an alternate match rather than as its own finding.
        expect(findings.flatMap((finding) => [finding.ruleId, ...finding.alternateMatches])).toContain("private-key");
    });
});
