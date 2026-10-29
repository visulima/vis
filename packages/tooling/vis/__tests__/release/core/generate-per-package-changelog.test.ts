/**
 * `vis release generate` must give each package a changelog of its own
 * commits. It used to write one change file listing every bumped package
 * over the whole range's subjects, so every package released in the run
 * got every line — `@lunora/wire` listed `@lunora/errors`'s breaking change.
 *
 * Each test runs the real pipeline: generate → read the change files back
 * from disk → assemble the plan → render each release's changelog.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatChangeFile } from "../../../src/release/core/change-file";
import { readChangeFiles } from "../../../src/release/core/change-file-reader";
import { defaultFormatter } from "../../../src/release/core/changelog/default";
import { DependencyGraph } from "../../../src/release/core/dep-graph";
import { runGenerate } from "../../../src/release/core/generate/run";
import { assembleReleasePlan } from "../../../src/release/core/release-plan";
import { createShellRunner } from "../../../src/release/core/shell-runner";
import type { WorkspacePackage } from "../../../src/release/types";

const testFs = { access, mkdir, readdir, readFile, rm, stat, writeFile } as never;

const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "pipe" });
};

/** `consumer` depends on `errors` with a `~` range, so a major `errors` cascades into it. */
const NAMES = ["errors", "wire", "do", "client", "values", "consumer"] as const;

let cwd: string | undefined;
let rootSha = "";
let packages: WorkspacePackage[] = [];

const setupFixture = (): void => {
    cwd = mkdtempSync(join(tmpdir(), "vis-generate-per-package-"));

    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "root", private: true, version: "0.0.0" }, null, 2)}\n`);
    writeFileSync(join(cwd, "README.md"), "root\n");

    packages = NAMES.map((name): WorkspacePackage => {
        const dir = join(cwd!, "packages", name);
        const manifest = {
            name: `@lunora/${name}`,
            version: "1.0.0",
            ...(name === "consumer" ? { dependencies: { "@lunora/errors": "~1.0.0" } } : {}),
        };

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

    rootSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
};

/** Commit a change to `files` (repo-relative) with the given message. */
const commit = (message: string, files: string[]): void => {
    for (const file of files) {
        writeFileSync(join(cwd!, file), `// ${message}\n`);
    }

    git(cwd!, "add", ".");
    git(cwd!, "commit", "-q", "-m", message);
};

const src = (name: string): string => `packages/${name}/src/index.ts`;

/** Run the full pipeline and return each released package's rendered changelog entry. */
const renderChangelogs = async (): Promise<Map<string, string>> => {
    const result = await runGenerate({ config: {}, cwd: cwd!, from: rootSha, fs: testFs, name: "wave", packages, runner: createShellRunner() });

    if (result.status !== "written") {
        throw new Error(`unexpected generate status ${result.status}`);
    }

    const { files } = await readChangeFiles({ cwd: cwd! });
    const plan = assembleReleasePlan(files, new DependencyGraph(packages), {});
    const rendered = new Map<string, string>();

    for (const release of plan.releases) {
        rendered.set(release.name, await defaultFormatter({ changeFiles: release.changeFiles, date: "2026-10-29", release, target: "github-release" }));
    }

    return rendered;
};

describe("generate — per-package changelog attribution", () => {
    afterEach(async () => {
        if (cwd) {
            await rm(cwd, { force: true, recursive: true });
            cwd = undefined;
        }
    });

    it("gives each package of the lunora wave only its own commits", async () => {
        expect.hasAssertions();

        setupFixture();
        commit("feat(errors)!: drop the legacy error codes", [src("errors")]);
        commit("refactor(wire): split the frame codec\n\nBREAKING CHANGE: frames are encoded as v2", [src("wire")]);
        commit("fix(do,client): reconnect after a hibernation wake", [src("do"), src("client")]);
        commit("docs(values): document the validators", [src("values")]);

        const changelogs = await renderChangelogs();

        expect(changelogs.get("@lunora/errors")).toBe("- feat(errors)!: drop the legacy error codes");
        expect(changelogs.get("@lunora/wire")).toBe("- refactor(wire)!: split the frame codec");
        expect(changelogs.get("@lunora/do")).toBe("- fix(do,client): reconnect after a hibernation wake");
        expect(changelogs.get("@lunora/client")).toBe("- fix(do,client): reconnect after a hibernation wake");
        expect(changelogs.get("@lunora/values")).toBe("- docs(values): document the validators");
        // Released only because `errors` left its `~1.0.0` range: no commit of its own.
        expect(changelogs.get("@lunora/consumer")).toBe("- Updated dependency @lunora/errors@2.0.0");
    });

    it("lists a multi-package commit under each package it touches and no other", async () => {
        expect.hasAssertions();

        setupFixture();
        commit("feat(wire,client): negotiate the codec version", [src("wire"), src("client")]);
        commit("fix(values): reject NaN", [src("values")]);

        const changelogs = await renderChangelogs();

        expect(changelogs.get("@lunora/wire")).toBe("- feat(wire,client): negotiate the codec version");
        expect(changelogs.get("@lunora/client")).toBe("- feat(wire,client): negotiate the codec version");
        expect(changelogs.get("@lunora/values")).toBe("- fix(values): reject NaN");
    });

    it("attributes by scope when the commit touches no package files", async () => {
        expect.hasAssertions();

        setupFixture();
        commit("fix(client): honour the retry budget", ["README.md"]);
        commit("fix(wire): pad short frames", [src("wire")]);

        const changelogs = await renderChangelogs();

        expect(changelogs.get("@lunora/client")).toBe("- fix(client): honour the retry budget");
        expect(changelogs.get("@lunora/wire")).toBe("- fix(wire): pad short frames");
    });

    it("attributes an unscoped commit by the package directories it changes", async () => {
        expect.hasAssertions();

        setupFixture();
        commit("fix: tighten the frame bounds", [src("wire"), src("do")]);
        commit("feat(values): add a decimal validator", [src("values")]);

        const changelogs = await renderChangelogs();

        expect(changelogs.get("@lunora/wire")).toBe("- fix: tighten the frame bounds");
        expect(changelogs.get("@lunora/do")).toBe("- fix: tighten the frame bounds");
        expect(changelogs.get("@lunora/values")).toBe("- feat(values): add a decimal validator");
    });

    it("keeps bump levels max-merged per package across commits", async () => {
        expect.hasAssertions();

        setupFixture();
        commit("fix(wire): pad short frames", [src("wire")]);
        commit("feat(wire,client): negotiate the codec version", [src("wire"), src("client")]);

        const result = await runGenerate({ config: {}, cwd: cwd!, dryRun: true, from: rootSha, fs: testFs, packages, runner: createShellRunner() });

        expect(result.status).toBe("dry-run");
        expect(Object.fromEntries("bumps" in result ? result.bumps : [])).toStrictEqual({ "@lunora/client": "minor", "@lunora/wire": "minor" });
    });

    it("gives two packages whose names slugify alike separate files", async () => {
        expect.hasAssertions();

        setupFixture();

        const clash = [
            { dir: join(cwd!, "packages", "do"), name: "@a/b-c" },
            { dir: join(cwd!, "packages", "client"), name: "@a-b/c" },
        ].map(({ dir, name }): WorkspacePackage => {
            const manifest = { name, version: "1.0.0" };

            return { dir, manifest, manifestPath: join(dir, "package.json"), name, private: false, version: "1.0.0" };
        });

        commit("fix: shared fix", [src("do"), src("client")]);

        const result = await runGenerate({ config: {}, cwd: cwd!, from: rootSha, fs: testFs, name: "wave", packages: clash, runner: createShellRunner() });

        expect(result.status === "written" ? result.files.map((file) => file.package).toSorted() : []).toStrictEqual(["@a-b/c", "@a/b-c"]);
        expect(new Set(result.status === "written" ? result.files.map((file) => file.path) : []).size).toBe(2);
    });

    it("still renders an old single change file for every package it lists", async () => {
        expect.hasAssertions();

        setupFixture();
        mkdirSync(join(cwd!, ".vis", "release"), { recursive: true });
        writeFileSync(
            join(cwd!, ".vis", "release", "legacy.md"),
            formatChangeFile({ bumps: { "@lunora/values": "patch", "@lunora/wire": "minor" } }, "- feat(wire): one\n- fix(values): two"),
        );

        const { files } = await readChangeFiles({ cwd: cwd! });
        const plan = assembleReleasePlan(files, new DependencyGraph(packages), {});

        for (const name of ["@lunora/wire", "@lunora/values"]) {
            const release = plan.releases.find((entry) => entry.name === name)!;

            const rendered = await defaultFormatter({ changeFiles: release.changeFiles, date: "2026-10-29", release, target: "github-release" });

            expect(rendered).toBe("- feat(wire): one\n- fix(values): two");
        }
    });
});
