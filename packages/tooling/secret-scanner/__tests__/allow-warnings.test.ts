import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { scanGitStaged } from "../src/git-scan";
import { scanDetailed, scanString } from "../src/index";

// Matches the bundled `github-pat` rule.
/* eslint-disable-next-line no-useless-concat -- split so GitHub push protection doesn't flag the fake token */
const TOKEN = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4zA5b";

beforeAll(async () => {
    await scanString("warmup", "warmup.txt");
}, 120_000);

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), "secret-scanner-allow-"));
});

afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
});

const scanSource = async (name: string, source: string, options = {}) => {
    await writeFile(resolve(dir, name), source);

    return scanDetailed([dir], options);
};

describe("allow marker warnings", () => {
    it("still suppresses a marker with a renamed rule id and reports the unknown id", async () => {
        expect.assertions(3);

        const result = await scanSource("a.ts", `const a = 1;\nconst t = "${TOKEN}"; // gitleaks:allow github-pat-v2\n`);

        expect(result.findings).toHaveLength(0);
        expect(result.allowWarnings).toStrictEqual([{ file: "a.ts", line: 2, unknownRuleIds: ["github-pat-v2"] }]);
        expect(result.skipped).toHaveLength(0);
    });

    it("reports nothing for a marker with a valid id, a bare marker or prose", async () => {
        expect.assertions(4);

        const result = await scanSource(
            "a.ts",
            [
                `const a = "${TOKEN}"; // gitleaks:allow github-pat`,
                `const b = "${TOKEN}"; // secret-scanner:allow`,
                `const c = "${TOKEN}"; // gitleaks:allow safe in tests`,
                `const d = 1; // the allow list`,
            ].join("\n"),
        );

        expect(result.allowWarnings).toStrictEqual([]);
        expect(result.findings).toHaveLength(0);
        expect(result.skipped).toHaveLength(0);

        const noInline = await scanSource("b.ts", `const e = 1; // gitleaks:allow renamed-rule\n`, { inlineAllow: false });

        expect(noInline.allowWarnings).toStrictEqual([]);
    });

    it("reports an unknown id once per line even when listed twice or across markers", async () => {
        expect.assertions(1);

        const result = await scanSource("a.ts", `x = 1 // gitleaks:allow gone-rule, github-pat, gone-rule // secret-scanner:allow gone-rule other-gone\n`);

        expect(result.allowWarnings).toStrictEqual([{ file: "a.ts", line: 1, unknownRuleIds: ["gone-rule", "other-gone"] }]);
    });

    it("reports unknown ids on region start markers and nextline pragmas", async () => {
        expect.assertions(2);

        const result = await scanSource(
            "a.py",
            [
                "# gitleaks:allow-start old-name",
                `t = "${TOKEN}"`,
                "# gitleaks:allow-end",
                "# pragma: allowlist nextline secret older-name",
                `u = "${TOKEN}"`,
            ].join("\n"),
        );

        expect(result.findings).toHaveLength(0);
        expect(result.allowWarnings).toStrictEqual([
            { file: "a.py", line: 1, unknownRuleIds: ["old-name"] },
            { file: "a.py", line: 4, unknownRuleIds: ["older-name"] },
        ]);
    });

    it("reports them for staged blobs under the reported path", async () => {
        expect.assertions(2);

        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
        const git = (...arguments_: string[]): void => {
            execFileSync("git", arguments_, { cwd: dir, env, stdio: "ignore" });
        };

        git("init", "-q");
        await writeFile(resolve(dir, "a.ts"), `const t = "${TOKEN}"; // gitleaks:allow renamed-rule\n`);
        git("add", "a.ts");

        const result = await scanGitStaged({ cwd: dir });

        expect(result.findings).toHaveLength(0);
        expect(result.allowWarnings.map(({ line, unknownRuleIds }) => { return { line, unknownRuleIds }; })).toStrictEqual([{ line: 1, unknownRuleIds: ["renamed-rule"] }]);
    });
});
