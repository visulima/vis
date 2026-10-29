import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyContext, buildContext } from "../../../src/release/core/orchestrator";

// git hooks export these; a temp repo must not inherit the outer repository.
delete process.env.GIT_DIR;
delete process.env.GIT_INDEX_FILE;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_PREFIX;

describe.skipIf(process.platform === "win32")("orchestrator: internalDependencyRanges", () => {
    let cwd: string;

    const write = (rel: string, content: string): void => {
        mkdirSync(join(cwd, rel, ".."), { recursive: true });
        writeFileSync(join(cwd, rel), content);
    };

    const setup = (mode: string): void => {
        write("vis.config.cjs", `module.exports = { release: { acknowledgeUnstable: true, defaultManaged: true, internalDependencyRanges: "${mode}" } };\n`);
    };

    beforeEach(() => {
        cwd = realpathSync(mkdtempSync(join(tmpdir(), "vis-orch-ranges-")));

        write("package.json", "{\n    \"name\": \"root\",\n    \"private\": true,\n    \"version\": \"0.0.0\"\n}\n");
        write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
        write("packages/a/package.json", "{\n    \"name\": \"a\",\n    \"version\": \"1.0.0\"\n}\n");
        write(
            "packages/b/package.json",
            "{\n    \"name\": \"b\",\n    \"version\": \"1.0.0\",\n    \"dependencies\": {\n        \"a\": \"^1.0.0\"\n    },\n    \"peerDependencies\": {\n        \"a\": \">=1.0.0 <2.0.0\"\n    }\n}\n",
        );
        write(".vis/release/x.md", "---\n\"a\": minor\n\"b\": patch\n---\n### Change\n\nBody\n");
    });

    afterEach(() => {
        rmSync(cwd, { force: true, recursive: true });
    });

    it("keeps a satisfied range under preserve-satisfying", async () => {
        expect.hasAssertions();

        setup("preserve-satisfying");

        const ctx = await buildContext({ cwd });

        await applyContext(ctx, { dryRun: false });

        const manifest = JSON.parse(readFileSync(join(cwd, "packages/b/package.json"), "utf8"));

        expect(manifest.peerDependencies).toStrictEqual({ a: ">=1.0.0 <2.0.0" });
        expect(manifest.dependencies).toStrictEqual({ a: "^1.1.0" });
    });

    it("rewrites the range under rewrite", async () => {
        expect.hasAssertions();

        setup("rewrite");

        const ctx = await buildContext({ cwd });

        await applyContext(ctx, { dryRun: false });

        expect(JSON.parse(readFileSync(join(cwd, "packages/b/package.json"), "utf8")).peerDependencies).toStrictEqual({ a: ">=1.1.0" });
    });
});
