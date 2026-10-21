import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAffectedProjects } from "../../src/affected";
import { collectExternalInputs, computeExternalInputHashes } from "../../src/external-inputs";
import type { ProjectConfiguration, ProjectGraph } from "../../src/types";

const git = (cwd: string, ...arguments_: string[]): void => {
    execFileSync("git", arguments_, { cwd, stdio: "pipe" });
};

describe("affected detection with external inputs", () => {
    let workspaceRoot: string;
    let externalRoot: string;
    let externalFile: string;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), "tr-affected-external-"));

        workspaceRoot = join(base, "workspace");
        externalRoot = join(base, "shared");

        await mkdir(join(workspaceRoot, "packages/lib-a"), { recursive: true });
        await mkdir(join(workspaceRoot, "packages/app"), { recursive: true });
        await mkdir(externalRoot, { recursive: true });

        await writeFile(join(workspaceRoot, "packages/lib-a/index.ts"), "export const a = 1;\n");
        await writeFile(join(workspaceRoot, "packages/app/index.ts"), "export const app = 1;\n");

        externalFile = join(externalRoot, "constants.ts");
        await writeFile(externalFile, "export const shared = 1;\n");

        git(workspaceRoot, "init", "--initial-branch=main");
        git(workspaceRoot, "config", "user.email", "test@example.com");
        git(workspaceRoot, "config", "user.name", "Test");
        git(workspaceRoot, "add", ".");
        git(workspaceRoot, "commit", "-m", "initial");
    });

    afterEach(async () => {
        await rm(join(workspaceRoot, ".."), { force: true, recursive: true });
    });

    it("hashes external glob inputs and detects a change between snapshots", async () => {
        expect.assertions(4);

        const globPattern = `${externalRoot}/**/*.ts`;
        const externalInputs = [{ pattern: globPattern, projects: ["lib-a"] }];
        const projects: Record<string, ProjectConfiguration> = { "lib-a": { root: "packages/lib-a" } };
        const projectGraph: ProjectGraph = {
            dependencies: { "lib-a": [] },
            nodes: { "lib-a": { data: { root: "packages/lib-a" }, name: "lib-a", type: "library" } },
        };

        const before = await computeExternalInputHashes(externalInputs);

        expect(before[globPattern]).toBeTypeOf("string");

        await writeFile(join(externalRoot, "extra.ts"), "export const extra = 1;\n");

        const after = await computeExternalInputHashes(externalInputs);

        expect(after[globPattern]).not.toBe(before[globPattern]);

        const firstRun = await getAffectedProjects({
            base: "HEAD",
            externalInputs,
            head: "HEAD",
            projectGraph,
            projects,
            workspaceRoot,
        });

        // No previous snapshot: the owning project must not be reported clean.
        expect(firstRun.changedExternalInputs).toStrictEqual([globPattern]);

        const secondRun = await getAffectedProjects({
            base: "HEAD",
            externalInputs,
            head: "HEAD",
            previousExternalInputHashes: firstRun.externalInputHashes,
            projectGraph,
            projects,
            workspaceRoot,
        });

        expect(secondRun.changedExternalInputs).toStrictEqual([]);
    });

    it("marks the owning project affected when an external input changes and its dependents downstream", async () => {
        expect.assertions(4);

        const externalInputs = collectExternalInputs(workspaceRoot, {
            "lib-a": { root: "packages/lib-a", targets: { build: { inputs: [`file://${externalFile}`] } } },
        });
        const graph: ProjectGraph = {
            dependencies: { app: [{ source: "app", target: "lib-a", type: "static" }], "lib-a": [] },
            nodes: {
                app: { data: { root: "packages/app" }, name: "app", type: "application" },
                "lib-a": { data: { root: "packages/lib-a" }, name: "lib-a", type: "library" },
            },
        };
        const projects: Record<string, ProjectConfiguration> = {
            app: { root: "packages/app" },
            "lib-a": { root: "packages/lib-a" },
        };

        const baseline = await getAffectedProjects({
            base: "HEAD",
            externalInputs,
            head: "HEAD",
            projectGraph: graph,
            projects,
            workspaceRoot,
        });

        expect(baseline.changedProjects).toStrictEqual(["lib-a"]);

        const unchanged = await getAffectedProjects({
            base: "HEAD",
            externalInputs,
            head: "HEAD",
            previousExternalInputHashes: baseline.externalInputHashes,
            projectGraph: graph,
            projects,
            workspaceRoot,
        });

        expect(unchanged.changedProjects).toStrictEqual([]);

        await writeFile(externalFile, "export const shared = 3;\n");

        const changed = await getAffectedProjects({
            base: "HEAD",
            externalInputs,
            head: "HEAD",
            previousExternalInputHashes: baseline.externalInputHashes,
            projectGraph: graph,
            projects,
            workspaceRoot,
        });

        expect(changed.changedProjects).toStrictEqual(["lib-a"]);
        expect(changed.affectedProjects).toStrictEqual(["lib-a", "app"]);
    });
});
