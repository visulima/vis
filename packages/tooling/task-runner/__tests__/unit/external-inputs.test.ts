import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectExternalInputs, isExternalPattern } from "../../src/external-inputs";
import { InProcessTaskHasher } from "../../src/task-hasher";
import type { ProjectConfiguration, Task } from "../../src/types";

const task: Task = {
    cache: true,
    id: "lib-a:build",
    outputs: [],
    overrides: {},
    target: { project: "lib-a", target: "build" },
};

const git = (cwd: string, ...arguments_: string[]): void => {
    execFileSync("git", arguments_, { cwd, stdio: "pipe" });
};

describe("external file-set inputs", () => {
    let workspaceRoot: string;
    let externalRoot: string;
    let externalFile: string;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), "tr-external-"));

        workspaceRoot = join(base, "workspace");
        externalRoot = join(base, "shared");

        await mkdir(join(workspaceRoot, "packages/lib-a"), { recursive: true });
        await mkdir(externalRoot, { recursive: true });
        await writeFile(join(workspaceRoot, "packages/lib-a/index.ts"), "export const a = 1;\n");

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

    it("collects patterns that resolve outside the workspace and attributes them to their project", async () => {
        expect.assertions(3);

        const projects: Record<string, ProjectConfiguration> = {
            "lib-a": {
                root: "packages/lib-a",
                targets: { build: { inputs: [`file://${externalFile}`, "glob://{workspaceRoot}/../shared/**/*.ts", "{projectRoot}/**/*"] } },
            },
        };

        const externalInputs = collectExternalInputs(workspaceRoot, projects);

        expect(externalInputs).toHaveLength(2);
        expect(externalInputs.map((input) => input.pattern).toSorted()).toStrictEqual([externalFile, join(externalRoot, "**/*.ts")].toSorted());
        expect(externalInputs.every((input) => input.projects.join(",") === "lib-a")).toBe(true);
    });

    it("treats an absolute path outside the workspace as external and one inside as local", () => {
        expect.assertions(2);

        expect(isExternalPattern(workspaceRoot, externalFile)).toBe(true);
        expect(isExternalPattern(workspaceRoot, join(workspaceRoot, "packages/lib-a/index.ts"))).toBe(false);
    });

    it("folds an external file into the task hash with a workspace-relative key", async () => {
        expect.assertions(3);

        const hasher = new InProcessTaskHasher({
            projects: {
                "lib-a": {
                    root: "packages/lib-a",
                    targets: { build: { inputs: [`file://${externalFile}`] } },
                },
            },
            workspaceRoot,
        });

        const first = await hasher.hashTask(task);
        const key = relative(workspaceRoot, externalFile).replaceAll("\\", "/");

        expect(Object.keys(first.nodes)).toStrictEqual([key]);
        expect(key.startsWith("..")).toBe(true);

        await writeFile(externalFile, "export const shared = 2;\n");
        hasher.clearCache();

        const second = await hasher.hashTask(task);

        expect(second.nodes[key]).not.toBe(first.nodes[key]);
    });
});
