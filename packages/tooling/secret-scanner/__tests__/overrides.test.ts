/* eslint-disable no-useless-concat -- fake tokens are split so GitHub push protection does not flag the fixtures */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanGitStaged } from "../src/git-scan";
import { scan, scanString } from "../src/index";
import type { ScanOptions, ScanOverride } from "../src/types";

const GITHUB = 'github = "ghp_aB3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5b"';
const AWS = 'aws = "AKIAQYLPMN5HJ38DNCZG"';

// A small explicit ruleset keeps this file fast; the overrides pipeline is
// independent of how many rules the bundled config happens to carry.
const config = {
    extendBundled: false,
    inline: {
        rules: [
            { id: "gh-pat", keywords: ["ghp_"], regex: String.raw`ghp_[A-Za-z0-9]{20,}` },
            { id: "aws-key", keywords: ["AKIA"], regex: String.raw`AKIA[A-Z0-9]{16}` },
            { defaultEnabled: false, id: "opt-in-only", keywords: ["tok_"], regex: String.raw`tok_[a-z0-9]{12}` },
        ],
    },
};

const withOverrides = (overrides: ScanOverride[]): ScanOptions => {
    return {
        config,
        overrides,
    };
};

const ids = (findings: { ruleId: string }[]): string[] => findings.map((finding) => finding.ruleId);

describe("per-file overrides", () => {
    it("excludes rules only in matching files", async () => {
        expect.assertions(2);

        const options = withOverrides([{ files: "*.env", rules: { exclude: ["gh-pat"] } }]);
        const env = await scanString(`${GITHUB}\n${AWS}`, "app.env", options);
        const text = await scanString(`${GITHUB}\n${AWS}`, "app.txt", options);

        expect(env.some((finding) => finding.ruleId === "gh-pat")).toBe(false);
        expect(text.some((finding) => finding.ruleId === "gh-pat")).toBe(true);
    });

    it("restricts matching files to the listed rules", async () => {
        expect.assertions(2);

        const options = withOverrides([{ files: ["*.txt"], rules: { include: ["gh-pat"] } }]);
        const text = await scanString(`${GITHUB}\n${AWS}`, "app.txt", options);
        const env = await scanString(`${GITHUB}\n${AWS}`, "app.env", options);

        expect(text.map((finding) => finding.ruleId)).toStrictEqual(["gh-pat"]);
        expect(env.some((finding) => finding.ruleId === "gh-pat")).toBe(true);
    });

    it("enables opt-in rules only in matching files", async () => {
        expect.assertions(2);

        const options = withOverrides([{ files: "*.env", rules: { enable: ["opt-in-only"] } }]);
        const content = "token = tok_a1b2c3d4e5f6";
        const env = await scanString(content, ".env", options);
        const text = await scanString(content, "app.txt", options);

        expect(env.some((finding) => finding.ruleId === "opt-in-only")).toBe(true);
        expect(text.some((finding) => finding.ruleId === "opt-in-only")).toBe(false);
    });

    it("applies later matching overrides in order", async () => {
        expect.assertions(2);

        const options = withOverrides([
            { files: "**/*", rules: { exclude: ["gh-pat"] } },
            { files: "*.env", rules: { include: ["gh-pat"] } },
        ]);
        const env = await scanString(GITHUB, "app.env", options);
        const text = await scanString(GITHUB, "app.txt", options);

        expect(env.map((finding) => finding.ruleId)).toStrictEqual(["gh-pat"]);
        expect(text.some((finding) => finding.ruleId === "gh-pat")).toBe(false);
    });

    it("lets an override include re-enable a globally excluded rule", async () => {
        expect.assertions(2);

        const options = { ...withOverrides([{ files: "*.env", rules: { include: ["gh-pat"] } }]), rules: { exclude: ["gh-pat"] } };

        expect(ids(await scanString(GITHUB, "app.env", options))).toStrictEqual(["gh-pat"]);
        expect(ids(await scanString(GITHUB, "app.txt", options))).toStrictEqual([]);
    });

    it.each(["", "./app.env", "../app.env", "../../elsewhere/app.env", "/somewhere/else/app.env", String.raw`C:\somewhere\app.env`])(
        "never throws on the path %j and still evaluates the override",
        async (file) => {
            expect.assertions(1);

            const options = withOverrides([{ files: "*.env", rules: { exclude: ["gh-pat"] } }]);
            const findings = await scanString(GITHUB, file, options);

            // Outside the scan root a path is matched by its basename; `""` has none, so only the global filter applies.
            expect(ids(findings)).toStrictEqual(file === "" ? ["gh-pat"] : []);
        },
    );

    it("keeps an override-only opt-in rule confined to matching files for absolute and escaping paths", async () => {
        expect.assertions(3);

        const options = withOverrides([{ files: "*.env", rules: { enable: ["opt-in-only"] } }]);
        const content = "token = tok_a1b2c3d4e5f6";

        expect(ids(await scanString(content, "/abs/app.txt", options))).toStrictEqual([]);
        expect(ids(await scanString(content, "../app.txt", options))).toStrictEqual([]);
        expect(ids(await scanString(content, "/abs/app.env", options))).toStrictEqual(["opt-in-only"]);
    });

    it("matches globs against the path relative to overridesRoot", async () => {
        expect.assertions(3);

        const root = join(process.cwd(), "packages", "api");
        const options = { ...withOverrides([{ files: "packages/api/*.env", rules: { exclude: ["gh-pat"] } }]), overridesRoot: process.cwd() };

        expect(ids(await scanString(GITHUB, join(root, "app.env"), options))).toStrictEqual([]);
        expect(ids(await scanString(GITHUB, "packages/api/app.env", options))).toStrictEqual([]);
        expect(ids(await scanString(GITHUB, "packages/web/app.env", options))).toStrictEqual(["gh-pat"]);
    });
});

describe("overrides against the real scan targets", () => {
    const dirs: string[] = [];
    const tempDir = (): string => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "secret-scanner-overrides-")));

        dirs.push(dir);

        return dir;
    };

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    it("applies overrides to a single-file scan, whose findings carry an empty file", async () => {
        expect.assertions(2);

        const dir = tempDir();

        writeFileSync(join(dir, "app.env"), GITHUB);

        const excluded = await scan([join(dir, "app.env")], { ...withOverrides([{ files: "*.env", rules: { exclude: ["gh-pat"] } }]), overridesRoot: dir });
        const kept = await scan([join(dir, "app.env")], { ...withOverrides([{ files: "*.txt", rules: { exclude: ["gh-pat"] } }]), overridesRoot: dir });

        expect(ids(excluded)).toStrictEqual([]);
        expect(ids(kept)).toStrictEqual(["gh-pat"]);
    });

    it("matches root-relative globs for a scan rooted in a subdirectory", async () => {
        expect.assertions(2);

        const dir = tempDir();

        mkdirSync(join(dir, "packages", "api"), { recursive: true });
        writeFileSync(join(dir, "packages", "api", "app.env"), GITHUB);

        const options = { ...withOverrides([{ files: "packages/api/**", rules: { exclude: ["gh-pat"] } }]), overridesRoot: dir };

        expect(ids(await scan([join(dir, "packages", "api")], options))).toStrictEqual([]);
        expect(ids(await scan([dir], options))).toStrictEqual([]);
    });

    describe("staged scan", () => {
        const TOKEN = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";
        const generic = { id: "generic-api-key", keywords: ["token"], regex: String.raw`token\s*=\s*"([0-9a-zA-Z_]{20,})"` };
        const stagedConfig = { extendBundled: false, inline: { rules: [{ id: "github-pat", keywords: ["ghp_"], regex: "ghp_[0-9a-zA-Z]{36}" }, generic] } };
        const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

        const stage = (): string => {
            const root = tempDir();
            const git = (...arguments_: string[]): void => {
                execFileSync("git", arguments_, { cwd: root, env: gitEnvironment });
            };

            git("init", "-q", "-b", "main");
            writeFileSync(join(root, "app.env"), `const token = "${TOKEN}";\n`);
            git("add", "-A");

            return root;
        };

        it("reports the generic finding the excluded specific rule used to shadow, as a path scan does", async () => {
            expect.assertions(2);

            const root = stage();
            const options: ScanOptions = { config: stagedConfig, overrides: [{ files: "*.env", rules: { exclude: ["github-pat"] } }], overridesRoot: root };
            const previous = process.cwd();

            process.chdir(root);

            try {
                const staged = await scanGitStaged({ ...options, cwd: root });

                expect(ids(staged.findings)).toStrictEqual(["generic-api-key"]);
                expect(ids(await scan([root], options))).toStrictEqual(["generic-api-key"]);
            } finally {
                process.chdir(previous);
            }
        }, 30_000);
    });
});
