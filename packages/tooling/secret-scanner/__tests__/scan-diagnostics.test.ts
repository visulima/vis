import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanDetailed, scanFilesDetailed, scanString, toSarif, toSarifUri, writeBaseline } from "../src/index";
import type { Finding } from "../src/types";

const SECRET = "TESTTOKEN_abcdefghij0123456789";
const OTHER = "TESTTOKEN_zyxwvutsrq9876543210";
const THIRD = "TESTTOKEN_qqqqqwwwwweeeeerrrrr";

const CONFIG = {
    allowlists: [{ regexes: ["zyxwvutsrq"] }],
    rules: [{ description: "Fake token", id: "test-token", keywords: ["TESTTOKEN"], regex: String.raw`TESTTOKEN_[A-Za-z0-9]{20}` }],
    title: "test",
};
const config = { extendBundled: false, inline: CONFIG };

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const canTestPermissions = process.platform !== "win32" && !isRoot;

const dirs: string[] = [];

const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "secret-scanner-diag-")));

    dirs.push(dir);

    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        try {
            chmodSync(join(dir, "locked"), 0o755);
        } catch {
            // not every test creates it
        }

        rmSync(dir, { force: true, recursive: true });
    }
});

describe("reportSuppressed / inlineAllow", () => {
    const content = [`a = "${SECRET}" # gitleaks:allow`, `b = "${OTHER}"`, `c = "${THIRD}"`, ""].join("\n");

    it("keeps suppressed findings out of the result unless asked", async () => {
        expect.assertions(2);

        const root = tempDir();

        writeFileSync(join(root, "a.env"), content);

        const result = await scanDetailed([root], { config });

        expect(result.findings.map((f) => f.secret)).toStrictEqual([THIRD]);
        expect(result.suppressed).toStrictEqual([]);
    }, 30_000);

    it("returns allowlist, inline and baseline suppressions with their reason", async () => {
        expect.assertions(2);

        const root = tempDir();

        writeFileSync(join(root, "a.env"), content);

        const { findings: baseline } = await scanDetailed([root], { config });

        writeFileSync(join(root, "a.env"), content);

        const result = await scanDetailed([root], { baseline, config, reportSuppressed: true });
        const reasons = Object.fromEntries(result.suppressed.map((f) => [f.secret, f.suppressedBy]));

        expect(result.findings).toStrictEqual([]);
        expect(reasons).toStrictEqual({ [OTHER]: "allowlist", [SECRET]: "inline-allow", [THIRD]: "baseline" });
    }, 30_000);

    it("inlineAllow: false reports gitleaks:allow, nextline pragma and allow blocks", async () => {
        expect.assertions(2);

        const text = [
            `a = "${SECRET}" # gitleaks:allow`,
            "# pragma: allowlist nextline secret",
            `b = "${THIRD}"`,
            "# gitleaks:allow-start",
            `c = "TESTTOKEN_aaaaabbbbbcccccddddd"`,
            "# gitleaks:allow-end",
            "",
        ].join("\n");

        await expect(scanString(text, "x.env", { config })).resolves.toStrictEqual([]);
        await expect(scanString(text, "x.env", { config, inlineAllow: false })).resolves.toHaveLength(3);
    }, 30_000);

    it("does not leak suppressed findings through scanString", async () => {
        expect.assertions(1);

        const findings = await scanString(`b = "${OTHER}"\n`, "x.env", { config, reportSuppressed: true });

        expect(findings).toStrictEqual([]);
    }, 30_000);
});

describe("skipped files", () => {
    it.skipIf(!canTestPermissions)(
        "reports unreadable files and directories instead of treating them as clean",
        async () => {
            expect.assertions(3);

            const root = tempDir();

            writeFileSync(join(root, "ok.env"), `a = "${THIRD}"\n`);
            writeFileSync(join(root, "secret.env"), `a = "${SECRET}"\n`);
            chmodSync(join(root, "secret.env"), 0o000);
            mkdirSync(join(root, "locked"));
            writeFileSync(join(root, "locked", "inner.env"), `a = "${SECRET}"\n`);
            chmodSync(join(root, "locked"), 0o000);

            try {
                const result = await scanDetailed([root], { config });

                expect(result.findings.map((f) => f.secret)).toStrictEqual([THIRD]);
                expect(result.skipped).toContainEqual({ path: "secret.env", reason: "permission-denied" });
                expect(result.skipped.some((s) => s.path.endsWith("locked") && s.reason === "permission-denied")).toBe(true);
            } finally {
                chmodSync(join(root, "secret.env"), 0o644);
            }
        },
        30_000,
    );

    it("reports a broken symlink or missing file passed to scanFiles", async () => {
        expect.assertions(1);

        const root = tempDir();

        symlinkSync(join(root, "nowhere"), join(root, "dangling.env"));

        const result = await scanFilesDetailed([join(root, "dangling.env"), join(root, "missing.env")], { config });

        expect(result.skipped.map((s) => s.reason)).toStrictEqual(["not-found", "not-found"]);
    }, 30_000);

    it("reports files over maxFileSize as too-large", async () => {
        expect.assertions(1);

        const root = tempDir();

        writeFileSync(join(root, "big.env"), `a = "${SECRET}"\n${"x".repeat(2048)}`);

        const result = await scanDetailed([root], { config, walk: { maxFileSize: 1024 } });

        expect(result.skipped).toStrictEqual([{ path: "big.env", reason: "too-large" }]);
    }, 30_000);

    it("does not report symlinks the walker deliberately skips", async () => {
        expect.assertions(1);

        const root = tempDir();

        writeFileSync(join(root, "real.env"), "nothing\n");
        symlinkSync(join(root, "real.env"), join(root, "link.env"));
        symlinkSync(join(root, "nowhere"), join(root, "dangling.env"));

        const result = await scanDetailed([root], { config });

        expect(result.skipped).toStrictEqual([]);
    }, 30_000);
});

describe(toSarifUri, () => {
    it.each([
        ["src/app.ts", "src/app.ts"],
        ["my dir/a b.ts", "my%20dir/a%20b.ts"],
        ["src/#1/100%.ts", "src/%231/100%25.ts"],
        ["src/what?.ts", "src/what%3F.ts"],
        ["src/ünï.ts", "src/%C3%BCn%C3%AF.ts"],
        [String.raw`win\path\a.ts`, "win/path/a.ts"],
    ])("encodes %s", (input, expected) => {
        expect.assertions(1);
        expect(toSarifUri(input)).toBe(expected);
    });

    it.skipIf(process.platform === "win32")("turns absolute paths into file URIs", () => {
        expect.assertions(1);
        expect(toSarifUri("/srv/my dir/a#b.ts")).toBe("file:///srv/my%20dir/a%23b.ts");
    });

    it("is used for artifactLocation.uri", () => {
        expect.assertions(1);

        const finding = { file: "a b/c.ts", ruleId: "r", secret: "s", startLine: 1 } as Finding;
        const log = toSarif([
            { ...finding, alternateMatches: [], confidence: "low", description: "", endColumn: 1, endLine: 1, entropy: 0, match: "", startColumn: 1, tags: [] },
        ]);

        expect(log.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe("a%20b/c.ts");
    });
});

describe("writeBaseline permissions", () => {
    it.skipIf(process.platform === "win32")("writes owner-only and tightens an existing file", async () => {
        expect.assertions(2);

        const root = tempDir();
        const path = join(root, "baseline.json");

        await writeBaseline(path, []);

        expect(statSync(path).mode % 0o1000).toBe(0o600);

        chmodSync(path, 0o644);
        await writeBaseline(path, []);

        expect(statSync(path).mode % 0o1000).toBe(0o600);
    });
});
