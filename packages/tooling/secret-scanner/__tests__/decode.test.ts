/* eslint-disable no-useless-concat -- fake tokens are split so GitHub push protection does not flag the fixtures */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { scanString } from "../src/index";

// Warm the Rust regex JIT (full bundled ruleset) once so tests don't timeout.
beforeAll(async () => {
    await scanString("warmup", "warmup.txt");
}, 120_000);

vi.setConfig({ testTimeout: 30_000 });

const OPENROUTER_KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;
const GITHUB_PAT = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

describe("decode layer (maxDecodeDepth)", () => {
    it("finds a base64-wrapped OpenRouter key at the encoded span", async () => {
        expect.assertions(6);

        const encoded = b64(OPENROUTER_KEY);
        const content = `# settings\nOPENROUTER_BLOB=${encoded}\n`;
        const findings = await scanString(content, "settings.env");
        const hit = findings.find((finding) => finding.secret === OPENROUTER_KEY);

        expect(hit).toBeDefined();
        expect(hit!.ruleId).toBe("kingfisher.openrouter.1");
        expect(hit!.decoded).toStrictEqual(["base64"]);
        expect(hit!.startLine).toBe(2);
        expect(hit!.startColumn).toBe("OPENROUTER_BLOB=".length + 1);
        expect(hit!.endColumn).toBe("OPENROUTER_BLOB=".length + 1 + encoded.length);
    });

    it("finds a token in a Kubernetes Secret data value", async () => {
        expect.assertions(3);

        const content = [
            "apiVersion: v1",
            "kind: Secret",
            "metadata:",
            "  name: ci-credentials",
            "type: Opaque",
            "data:",
            `  GITHUB_TOKEN: ${b64(GITHUB_PAT)}`,
            "",
        ].join("\n");
        const findings = await scanString(content, "secret.yaml");
        const hit = findings.find((finding) => finding.secret === GITHUB_PAT);

        expect(hit).toBeDefined();
        expect(hit!.decoded).toStrictEqual(["base64"]);
        expect(hit!.startLine).toBe(7);
    });

    it("unwraps double encoding up to the default depth and stops at the limit", async () => {
        expect.assertions(4);

        const double = `blob: ${b64(b64(OPENROUTER_KEY))}\n`;
        const triple = `blob: ${b64(b64(b64(OPENROUTER_KEY)))}\n`;
        const hasKey = (findings: { secret: string }[]): boolean => findings.some((finding) => finding.secret === OPENROUTER_KEY);

        const doubleFindings = await scanString(double, "a.txt");

        expect(doubleFindings.find((finding) => finding.secret === OPENROUTER_KEY)?.decoded).toStrictEqual(["base64", "base64"]);
        expect(hasKey(await scanString(double, "a.txt", { maxDecodeDepth: 1 }))).toBe(false);
        expect(hasKey(await scanString(triple, "a.txt"))).toBe(false);
        expect(hasKey(await scanString(triple, "a.txt", { maxDecodeDepth: 3 }))).toBe(true);
    });

    it("decodes hex and percent-encoded values", async () => {
        expect.assertions(2);

        const hex = Buffer.from(OPENROUTER_KEY, "utf8").toString("hex");
        const percent = Array.from(Buffer.from(OPENROUTER_KEY, "utf8"), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
        const hexFindings = await scanString(`value=${hex}\n`, "a.txt");
        const percentFindings = await scanString(`url=https://example.test/?k=${percent}\n`, "a.txt");

        expect(hexFindings.find((finding) => finding.secret === OPENROUTER_KEY)?.decoded).toStrictEqual(["hex"]);
        expect(percentFindings.find((finding) => finding.secret === OPENROUTER_KEY)?.decoded).toStrictEqual(["percent"]);
    });

    it("maxDecodeDepth: 0 disables decoding", async () => {
        expect.assertions(1);

        const findings = await scanString(`blob=${b64(OPENROUTER_KEY)}\n`, "a.txt", { maxDecodeDepth: 0 });

        expect(findings.some((finding) => finding.decoded !== undefined)).toBe(false);
    });

    it("produces no decoded findings for binary base64 and hashes", async () => {
        expect.assertions(1);

        const randomBytes = createHash("sha512").update("seed").digest();
        const content = [
            `icon = "data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes]).toString("base64")}"`,
            `sha256 = "${createHash("sha256").update("x").digest("hex")}"`,
            `integrity = "sha512-${randomBytes.toString("base64")}"`,
            `blob = "${createHash("sha512").update("y").digest("base64url")}"`,
            `commit = "${createHash("sha256").update("z").digest("hex").slice(0, 40)}"`,
            "",
        ].join("\n");
        const findings = await scanString(content, "assets.toml");

        expect(findings.filter((finding) => finding.decoded !== undefined)).toStrictEqual([]);
    });

    it("leaves plain findings untouched", async () => {
        expect.assertions(1);

        const content = `token = "${GITHUB_PAT}"\n`;
        const withDecode = await scanString(content, "a.env");
        const without = await scanString(content, "a.env", { maxDecodeDepth: 0 });

        expect(withDecode).toStrictEqual(without);
    });
});
