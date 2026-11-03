import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseRefFile, updateRefFile } from "../ref-file.mjs";

const REF_FILE = [
    "# Pinned upstream.",
    "# Upstream: https://example.com/a=b",
    "major=8",
    "ref=v8.30.1",
    "sha=83d9cd684c87d95d656c1458ef04895a7f1cbd8e",
    "",
].join("\n");

describe(parseRefFile, () => {
    it("reads ref, sha and major, skipping comments", () => {
        expect.assertions(1);

        expect(parseRefFile(REF_FILE)).toStrictEqual({ major: 8, ref: "v8.30.1", sha: "83d9cd684c87d95d656c1458ef04895a7f1cbd8e" });
    });

    it("leaves major undefined when absent and accepts CRLF and padding", () => {
        expect.assertions(1);

        expect(parseRefFile("ref = v1.0.0\r\n  sha=abc  \r\n")).toStrictEqual({ major: undefined, ref: "v1.0.0", sha: "abc" });
    });

    it("rejects a file without ref or sha", () => {
        expect.assertions(2);

        expect(() => parseRefFile("ref=v1.0.0\n", "x.ref")).toThrow("invalid ref file (x.ref): expected ref=... and sha=... lines");
        expect(() => parseRefFile("# ref=v1\nsha=abc\n")).toThrow("expected ref=... and sha=...");
    });

    it("rejects a non-integer major", () => {
        expect.assertions(1);

        expect(() => parseRefFile("major=1.x\nref=v1.0.0\nsha=abc\n")).toThrow("major=1.x is not a non-negative integer");
    });

    it.each(["gitleaks.ref", "kingfisher.ref"])("parses the checked-in %s", (file) => {
        expect.assertions(3);

        const pin = parseRefFile(readFileSync(resolve(import.meta.dirname, "..", file), "utf8"), file);

        expect(pin.ref).toMatch(/^v\d+\.\d+\.\d+$/);
        expect(pin.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(pin.major).toBeTypeOf("number");
    });
});

describe(updateRefFile, () => {
    it("rewrites ref and sha and keeps everything else", () => {
        expect.assertions(2);

        const updated = updateRefFile(REF_FILE, { ref: "v8.31.0", sha: "0123456789abcdef0123456789abcdef01234567" });

        expect(updated).toBe(
            REF_FILE.replace("ref=v8.30.1", "ref=v8.31.0").replace(
                "sha=83d9cd684c87d95d656c1458ef04895a7f1cbd8e",
                "sha=0123456789abcdef0123456789abcdef01234567",
            ),
        );
        expect(parseRefFile(updated)).toStrictEqual({ major: 8, ref: "v8.31.0", sha: "0123456789abcdef0123456789abcdef01234567" });
    });

    it("refuses to update a malformed file", () => {
        expect.assertions(1);

        expect(() => updateRefFile("major=1\n", { ref: "v1.0.0", sha: "abc" })).toThrow("invalid ref file");
    });
});
