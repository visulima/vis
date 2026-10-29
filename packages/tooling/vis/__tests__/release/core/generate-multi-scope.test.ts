/**
 * `vis release generate` with comma-separated scopes (`feat(a,b): …`):
 * the header must parse as conventional (so the type sets the bump), and
 * every listed scope that names a package must be targeted.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderGroupedEntries } from "../../../src/release/core/changelog/sections";
import { parseCommit } from "../../../src/release/core/generate/conventional-commits";
import { runGenerate } from "../../../src/release/core/generate/run";
import { createShellRunner } from "../../../src/release/core/shell-runner";
import type { BumpLevel, WorkspacePackage } from "../../../src/release/types";

const testFs = { access, mkdir, readdir, readFile, rm, stat, writeFile } as never;

const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "pipe" });
};

const NAMES = ["a", "b", "c"] as const;

const setupFixture = (): { cwd: string; packages: WorkspacePackage[]; rootSha: string } => {
    const cwd = mkdtempSync(join(tmpdir(), "vis-generate-multi-scope-"));

    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "root", private: true, version: "0.0.0" }, null, 2)}\n`);

    const packages = NAMES.map((name): WorkspacePackage => {
        const dir = join(cwd, "packages", name);
        const manifest = { name: `@scope/${name}`, version: "1.0.0" };

        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        writeFileSync(join(dir, "src", "index.ts"), "export {};\n");

        return { dir, manifest, manifestPath: join(dir, "package.json"), name: manifest.name, private: false, version: "1.0.0" };
    });

    git(cwd, "init", "-q", "--initial-branch", "main");
    git(cwd, "config", "user.email", "test@test");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "commit.gpgsign", "false");
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", "chore: initial");

    return { cwd, packages, rootSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim() };
};

/** Every commit touches only `packages/c`, so a scope match is the only way to reach `a` or `b`. */
const commitTouchingC = (cwd: string, subject: string): void => {
    writeFileSync(join(cwd, "packages", "c", "src", "index.ts"), `export const c = ${JSON.stringify(subject)};\n`);
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", subject);
};

const generate = async (subject: string): Promise<{ bumps: Record<string, BumpLevel>; content: string }> => {
    const fixture = setupFixture();

    cwd = fixture.cwd;
    commitTouchingC(fixture.cwd, subject);

    const result = await runGenerate({
        config: {},
        cwd: fixture.cwd,
        dryRun: true,
        from: fixture.rootSha,
        fs: testFs,
        packages: fixture.packages,
        runner: createShellRunner(),
    });

    if (result.status !== "dry-run") {
        throw new Error(`unexpected generate status ${result.status}`);
    }

    return { bumps: Object.fromEntries(result.bumps), content: result.content };
};

let cwd: string | undefined;

describe("generate — comma-separated scopes", () => {
    afterEach(async () => {
        if (cwd) {
            await rm(cwd, { force: true, recursive: true });
            cwd = undefined;
        }
    });

    it("parses a comma-separated scope as a conventional header", () => {
        expect.hasAssertions();

        expect(parseCommit("feat(do,client,runtime): add sharding", "")).toStrictEqual({ breaking: false, scope: "do,client,runtime", type: "feat" });
        expect(parseCommit("fix(do, client)!: drop v1 frames", "")).toStrictEqual({ breaking: true, scope: "do, client", type: "fix" });
    });

    it("bumps every package the scope lists, at the level the type sets", async () => {
        expect.hasAssertions();

        const { bumps, content } = await generate("feat(a,b): share the cache");

        expect(bumps).toStrictEqual({ "@scope/a": "minor", "@scope/b": "minor" });
        expect(content).toContain("- feat(a,b): share the cache");
    });

    it("tolerates spaces after the commas and carries the ! marker to every package", async () => {
        expect.hasAssertions();

        const { bumps } = await generate("feat(a, b)!: drop the v1 cache");

        expect(bumps).toStrictEqual({ "@scope/a": "major", "@scope/b": "major" });
    });

    it("targets the parts that name a package and ignores the rest", async () => {
        expect.hasAssertions();

        const { bumps } = await generate("fix(a,docs): correct the example");

        expect(bumps).toStrictEqual({ "@scope/a": "patch" });
    });

    it("matches a full package name as one part", async () => {
        expect.hasAssertions();

        const { bumps } = await generate("fix(@scope/a,b): correct the example");

        expect(bumps).toStrictEqual({ "@scope/a": "patch", "@scope/b": "patch" });
    });

    it("falls back to the changed files when no part names a package", async () => {
        expect.hasAssertions();

        const { bumps } = await generate("feat(docs,examples): add a guide");

        expect(bumps).toStrictEqual({ "@scope/c": "minor" });
    });

    it("files the generated line under Features in the changelog", async () => {
        expect.hasAssertions();

        const { content } = await generate("feat(a,b): share the cache");
        const lines = renderGroupedEntries([{ line: content.split("\n").find((line) => line.startsWith("- feat"))! }]);

        expect(lines).toStrictEqual(["### Features", "", "* **a,b:** share the cache", ""]);
    });
});
