import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { join } from "@visulima/path";
import { maskFinding } from "@visulima/secret-scanner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diffBaseline, toRelativeFinding, writeBaseline } from "../../src/secrets/baseline";
import { cleanupTemporaryDirectory, createTemporaryDirectory } from "../test-helpers";

describe("secrets-baseline", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = createTemporaryDirectory("vis-secrets-baseline-");
    });

    afterEach(() => {
        cleanupTemporaryDirectory(tmpDir);
    });

    const makeFinding = (overrides: Partial<ReturnType<typeof baseFinding>> = {}): ReturnType<typeof baseFinding> => {
        return {
            ...baseFinding(),
            ...overrides,
        };
    };

    const baseFinding = (): {
        description: string;
        endColumn: number;
        endLine: number;
        entropy: number;
        file: string;
        match: string;
        ruleId: string;
        secret: string;
        startColumn: number;
        startLine: number;
        tags: string[];
    } => {
        return {
            description: "",
            endColumn: 10,
            endLine: 1,
            entropy: 0,
            file: "",
            match: "",
            ruleId: "",
            secret: "",
            startColumn: 1,
            startLine: 1,
            tags: [],
        };
    };

    describe(toRelativeFinding, () => {
        it("converts absolute paths to root-relative", () => {
            expect.assertions(1);

            const finding = makeFinding({ file: join(tmpDir, "src/a.env"), ruleId: "aws" });
            const result = toRelativeFinding(finding, tmpDir);

            expect(result.file).toBe("src/a.env");
        });

        it("keeps already-relative paths unchanged", () => {
            expect.assertions(1);

            const finding = makeFinding({ file: "src/a.env", ruleId: "aws" });
            const result = toRelativeFinding(finding, tmpDir);

            expect(result.file).toBe("src/a.env");
        });
    });

    describe(writeBaseline, () => {
        it("creates a new baseline when none exists", () => {
            expect.assertions(3);

            const baselinePath = join(tmpDir, "baseline.json");
            const findings = [makeFinding({ file: join(tmpDir, "a.env"), ruleId: "aws", startLine: 1 })];

            const count = writeBaseline(findings, baselinePath, tmpDir);

            expect(count).toBe(1);
            expect(existsSync(baselinePath)).toBe(true);

            const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as { file: string }[];

            expect(parsed[0]!.file).toBe("a.env");
        });

        it("merges with an existing baseline by default", () => {
            expect.assertions(2);

            const baselinePath = join(tmpDir, "baseline.json");
            const existing = [makeFinding({ file: "a.env", ruleId: "old-rule", startLine: 10 })];

            writeFileSync(baselinePath, JSON.stringify(existing));

            const incoming = [makeFinding({ file: join(tmpDir, "b.env"), ruleId: "new-rule", startLine: 20 })];
            const count = writeBaseline(incoming, baselinePath, tmpDir);

            expect(count).toBe(2);

            const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as { ruleId: string }[];
            const ids = parsed.map((f) => f.ruleId);

            expect(ids).toStrictEqual(expect.arrayContaining(["old-rule", "new-rule"]));
        });

        it("replaces rather than merges when replace: true", () => {
            expect.assertions(2);

            const baselinePath = join(tmpDir, "baseline.json");

            writeFileSync(baselinePath, JSON.stringify([makeFinding({ file: "x", ruleId: "stale" })]));

            const count = writeBaseline([makeFinding({ file: "y", ruleId: "fresh" })], baselinePath, tmpDir, { replace: true });

            expect(count).toBe(1);

            const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as { ruleId: string }[];

            expect(parsed[0]!.ruleId).toBe("fresh");
        });
    });

    describe("baselines holding real values (written before masking was the default)", () => {
        const real = (): ReturnType<typeof baseFinding> =>
            makeFinding({ file: "a.env", match: "TOKEN=TESTTOKEN_abcdefghij0123456789", ruleId: "tok", secret: "TESTTOKEN_abcdefghij0123456789" });

        it("keeps one existing entry when a masked rescan of the same finding is merged in", () => {
            expect.assertions(3);

            const baselinePath = join(tmpDir, "baseline.json");

            writeFileSync(baselinePath, JSON.stringify([real()]));

            const count = writeBaseline([maskFinding(real())], baselinePath, tmpDir);
            const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as { secret: string }[];

            expect(count).toBe(1);
            expect(parsed).toHaveLength(1);
            expect(parsed[0]!.secret).toBe(real().secret);
        });

        it.skipIf(process.platform === "win32")("stays owner-only while an entry holds a real value", () => {
            expect.assertions(2);

            const baselinePath = join(tmpDir, "baseline.json");

            writeFileSync(baselinePath, JSON.stringify([real()]));
            chmodSync(baselinePath, 0o644);
            writeBaseline([maskFinding(real())], baselinePath, tmpDir);

            expect(statSync(baselinePath).mode % 0o1000).toBe(0o600);

            writeBaseline([maskFinding(real())], baselinePath, tmpDir, { replace: true });
            chmodSync(baselinePath, 0o644);
            writeBaseline([maskFinding(real())], baselinePath, tmpDir);

            expect(statSync(baselinePath).mode % 0o1000).not.toBe(0o600);
        });

        it("diffs a moved masked finding against a real-value entry as unchanged", () => {
            expect.assertions(3);

            const baselinePath = join(tmpDir, "baseline.json");

            writeFileSync(baselinePath, JSON.stringify([real()]));

            const diff = diffBaseline([maskFinding({ ...real(), endLine: 9, startLine: 9 })], baselinePath, tmpDir);

            expect(diff.fresh).toStrictEqual([]);
            expect(diff.resolved).toStrictEqual([]);
            expect(diff.surviving).toHaveLength(1);
        });
    });

    describe(diffBaseline, () => {
        it("matches entries that recorded the whole match as the secret", () => {
            expect.assertions(3);

            const baselinePath = join(tmpDir, "baseline.json");
            const old = makeFinding({ file: "a", match: `token = "abc123"`, ruleId: "tok", secret: `token = "abc123"` });

            writeFileSync(baselinePath, JSON.stringify([old]));

            const diff = diffBaseline([{ ...old, secret: "abc123" }], baselinePath, tmpDir);

            expect(diff.fresh).toStrictEqual([]);
            expect(diff.surviving).toHaveLength(1);
            expect(diff.resolved).toStrictEqual([]);
        });

        it("matches entries by file, rule and line, as the scanner's legacy fingerprint does", () => {
            expect.assertions(3);

            const baselinePath = join(tmpDir, "baseline.json");
            const old = makeFinding({ file: "a", ruleId: "tok", secret: "rotated-away", startLine: 4 });

            writeFileSync(baselinePath, JSON.stringify([old]));

            const diff = diffBaseline([{ ...old, match: "new-value", secret: "new-value" }], baselinePath, tmpDir);

            expect(diff.fresh).toStrictEqual([]);
            expect(diff.surviving).toHaveLength(1);
            expect(diff.resolved).toStrictEqual([]);
        });

        it("replaces whole-match entries when merging", () => {
            expect.assertions(1);

            const baselinePath = join(tmpDir, "baseline.json");
            const old = makeFinding({ file: "a", match: `token = "abc123"`, ruleId: "tok", secret: `token = "abc123"` });

            writeFileSync(baselinePath, JSON.stringify([old]));
            writeBaseline([{ ...old, secret: "abc123" }], baselinePath, tmpDir);

            expect((JSON.parse(readFileSync(baselinePath, "utf8")) as { secret: string }[]).map((f) => f.secret)).toStrictEqual(["abc123"]);
        });

        it("splits findings into fresh / surviving / resolved", () => {
            expect.assertions(3);

            const baselinePath = join(tmpDir, "baseline.json");

            writeFileSync(
                baselinePath,
                JSON.stringify([makeFinding({ file: "a", ruleId: "known", startLine: 1 }), makeFinding({ file: "b", ruleId: "gone", startLine: 5 })]),
            );

            const current = [
                makeFinding({ file: "a", ruleId: "known", startLine: 1 }), // surviving
                makeFinding({ file: "c", ruleId: "new", startLine: 9 }), // fresh
            ];

            const diff = diffBaseline(current, baselinePath, tmpDir);

            expect(diff.fresh).toHaveLength(1);
            expect(diff.surviving).toHaveLength(1);
            expect(diff.resolved).toHaveLength(1);
        });
    });
});
