import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAffectedProjects } from "../../src/affected";
import type { ProjectConfiguration, ProjectGraph } from "../../src/types";

// A pre-commit hook exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE for the
// hook-running repo; the fixture's git calls must not inherit them.
for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
        Reflect.deleteProperty(process.env, key);
    }
}

const projects: Record<string, ProjectConfiguration> = {
    api: { root: "packages/api" },
    "workspace-root": { root: "." },
};

const projectGraph: ProjectGraph = {
    dependencies: { api: [], "workspace-root": [] },
    nodes: {
        api: { data: { root: "packages/api" }, name: "api", type: "library" },
        "workspace-root": { data: { root: "." }, name: "workspace-root", type: "library" },
    },
};

describe("getAffectedProjects with a workspace-root project", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "tr-affected-root-"));
        execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "pipe" });
        execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "initial"], { cwd: root, stdio: "pipe" });
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const affectedBy = async (file: string, ignoredFiles?: string[]) =>
        getAffectedProjects({ additionalChangedFiles: [file], base: "HEAD", head: "HEAD", ignoredFiles, projectGraph, projects, workspaceRoot: root });

    it("should treat a file outside every other project as a workspace-wide change", async () => {
        expect.assertions(1);

        const result = await affectedBy("tsconfig.base.json");

        expect(result.affectedProjects.toSorted()).toStrictEqual(["api", "workspace-root"]);
    });

    it("should keep a file inside a package scoped to that package", async () => {
        expect.assertions(1);

        const result = await affectedBy("packages/api/src/index.ts");

        expect(result.affectedProjects).toStrictEqual(["api"]);
    });

    it("should mark only the root project for a root file matching ignoredFiles", async () => {
        expect.assertions(2);

        const result = await affectedBy("README.md", ["*.md"]);

        expect(result.affectedProjects).toStrictEqual(["workspace-root"]);
        expect(result.ignoredFiles).toStrictEqual(["README.md"]);
    });
});
