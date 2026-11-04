import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProjectGraph, discoverWorkspace } from "../../src/config/workspace";

const writePackage = (root: string, relativeDirectory: string, manifest: Record<string, unknown>, projectJson?: Record<string, unknown>): void => {
    const directory = join(root, relativeDirectory);

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.0.0", ...manifest }, undefined, 2));

    if (projectJson) {
        writeFileSync(join(directory, "project.json"), JSON.stringify(projectJson, undefined, 2));
    }
};

const writeWorkspaceYaml = (root: string, patterns: string[]): void => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n${patterns.map((pattern) => `  - "${pattern}"`).join("\n")}\n`);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root", private: true }, undefined, 2));
};

describe("workspace discovery of `dir/**` globs", () => {
    let scratch: string;

    beforeEach(() => {
        scratch = mkdtempSync(join(realpathSync(tmpdir()), "vis-glob-self-"));
    });

    afterEach(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("should discover the base directory of a `dir/**` glob when it is a package, as pnpm does", () => {
        expect.assertions(2);

        writeWorkspaceYaml(scratch, ["packages/*", "tools/**"]);
        writePackage(scratch, "packages/a", { name: "a" });
        writePackage(scratch, "tools", { name: "tools" });
        writePackage(scratch, "tools/sub", { name: "tools-sub" });

        const { workspace } = discoverWorkspace(scratch, {});

        expect(Object.keys(workspace.projects).toSorted()).toStrictEqual(["a", "tools", "tools-sub"]);
        expect(workspace.projects["tools"]?.root).toBe("tools");
    });

    it("should not list the same directory twice when two patterns overlap", () => {
        expect.assertions(1);

        writeWorkspaceYaml(scratch, ["tools", "tools/**"]);
        writePackage(scratch, "tools", { name: "tools" });

        const { workspace } = discoverWorkspace(scratch, {});

        expect(Object.keys(workspace.projects)).toStrictEqual(["tools"]);
    });
});

describe("project.json implicitDependencies", () => {
    let scratch: string;

    beforeEach(() => {
        scratch = mkdtempSync(join(realpathSync(tmpdir()), "vis-implicit-"));
        writeWorkspaceYaml(scratch, ["packages/*"]);
        writePackage(scratch, "packages/a", { name: "a", scripts: { build: "echo a" } });
    });

    afterEach(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    const graphFor = (config: Record<string, unknown> = {}) => {
        const { packageJsons, workspace } = discoverWorkspace(scratch, config);

        return buildProjectGraph(scratch, workspace, packageJsons);
    };

    it("should remove the package.json edge for a `!name` entry", () => {
        expect.assertions(1);

        writePackage(scratch, "packages/b", { devDependencies: { a: "workspace:*" }, name: "b" }, { implicitDependencies: ["!a"], name: "b" });

        expect(graphFor().dependencies["b"]).toStrictEqual([]);
    });

    it("should keep the package.json edge when there is no exclusion", () => {
        expect.assertions(1);

        writePackage(scratch, "packages/b", { devDependencies: { a: "workspace:*" }, name: "b" }, { name: "b" });

        expect(graphFor().dependencies["b"]).toStrictEqual([{ source: "b", target: "a", type: "devDependency" }]);
    });

    it("should add an implicit edge for a positive entry with no package.json dependency", () => {
        expect.assertions(1);

        writePackage(scratch, "packages/c", { name: "c" }, { implicitDependencies: ["a"], name: "c" });

        expect(graphFor().dependencies["c"]).toStrictEqual([{ source: "c", target: "a", type: "implicit" }]);
    });

    it("should resolve an exclusion by npm package name", () => {
        expect.assertions(1);

        writePackage(scratch, "packages/b", { dependencies: { "@scope/a": "workspace:*" }, name: "b" }, { implicitDependencies: ["!@scope/a"], name: "b" });
        writePackage(scratch, "packages/a", { name: "@scope/a", scripts: { build: "echo a" } }, { name: "a" });

        expect(graphFor().dependencies["b"]).toStrictEqual([]);
    });

    it("should treat a `*` entry as a glob over project names", () => {
        expect.assertions(1);

        writePackage(scratch, "packages/b", { devDependencies: { a: "workspace:*" }, name: "b" }, { implicitDependencies: ["!*"], name: "b" });
        writePackage(scratch, "packages/c", { name: "c" }, { implicitDependencies: ["a*"], name: "c" });

        const graph = graphFor();

        expect([graph.dependencies["b"], graph.dependencies["c"]]).toStrictEqual([[], [{ source: "c", target: "a", type: "implicit" }]]);
    });

    it("should drop an excluded edge even when a glob that selects it comes later in the list", () => {
        expect.assertions(1);

        writePackage(scratch, "packages/b", { devDependencies: { a: "workspace:*" }, name: "b" }, { implicitDependencies: ["!a", "*"], name: "b" });

        expect(graphFor().dependencies["b"]).toStrictEqual([]);
    });

    it("should accept a positive entry that names only the project itself, adding no edge", () => {
        expect.assertions(1);

        writePackage(scratch, "packages/c", { name: "c" }, { implicitDependencies: ["c"], name: "c" });

        expect(graphFor().dependencies["c"]).toStrictEqual([]);
    });

    it("should reject a positive entry that names nothing in the workspace", () => {
        expect.assertions(1);

        writePackage(scratch, "packages/c", { name: "c" }, { implicitDependencies: ["does-not-exist"], name: "c" });

        expect(() => graphFor()).toThrow("lists implicit dependency \"does-not-exist\"");
    });
});

describe("projectIgnore", () => {
    let scratch: string;

    beforeEach(() => {
        scratch = mkdtempSync(join(realpathSync(tmpdir()), "vis-project-ignore-"));
        writeWorkspaceYaml(scratch, ["packages/*", "packages/fixtures/**"]);
        writePackage(scratch, "packages/a", { name: "a" });
        writePackage(scratch, "packages/fixtures/one", { name: "fixture-one" });
        writePackage(scratch, "packages/fixtures/two", { name: "fixture-two" });
    });

    afterEach(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("should drop packages in a `__fixtures__` directory matched by `**/__fixtures__/**`", () => {
        expect.assertions(1);

        writeWorkspaceYaml(scratch, ["packages/**"]);
        writePackage(scratch, "packages/__fixtures__/one", { name: "underscore-fixture" });

        const { workspace } = discoverWorkspace(scratch, { projectIgnore: ["**/__fixtures__/**"] });

        expect(Object.keys(workspace.projects).toSorted()).toStrictEqual(["a", "fixture-one", "fixture-two"]);
    });

    it("should keep fixture packages in the graph when projectIgnore is not set", () => {
        expect.assertions(1);

        expect(Object.keys(discoverWorkspace(scratch, {}).workspace.projects).toSorted()).toStrictEqual(["a", "fixture-one", "fixture-two"]);
    });

    it("should drop packages matching projectIgnore while the workspace file still lists them", () => {
        expect.assertions(1);

        const { workspace } = discoverWorkspace(scratch, { projectIgnore: ["packages/fixtures/**"] });

        expect(Object.keys(workspace.projects)).toStrictEqual(["a"]);
    });
});

describe("workspace root project", () => {
    let scratch: string;

    beforeEach(() => {
        scratch = mkdtempSync(join(realpathSync(tmpdir()), "vis-root-project-"));
        writeWorkspaceYaml(scratch, ["packages/*"]);
        writePackage(scratch, "packages/a", { name: "a" });
    });

    afterEach(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("should not treat the root as a project without a root project.json", () => {
        expect.assertions(1);

        const { workspace } = discoverWorkspace(scratch, {});

        expect(Object.keys(workspace.projects)).toStrictEqual(["a"]);
    });

    it("should discover the root as a project when it has a project.json, with the root's scripts as targets", () => {
        expect.assertions(3);

        writePackage(scratch, ".", { name: "fixture-root", private: true, scripts: { "lint:oxlint": "oxlint" } }, { name: "workspace-root", tags: ["type:tooling"] });

        const { workspace } = discoverWorkspace(scratch, {});

        expect(Object.keys(workspace.projects).toSorted()).toStrictEqual(["a", "workspace-root"]);
        expect(workspace.projects["workspace-root"]?.root).toBe(".");
        expect(workspace.projects["workspace-root"]?.targets?.["lint:oxlint"]).toBeDefined();
    });

    it("should drop root scripts that run their own target through vis run, so the root does not re-run itself", () => {
        expect.assertions(4);

        writePackage(
            scratch,
            ".",
            {
                name: "fixture-root",
                private: true,
                scripts: { build: "vis run build", lint: "pnpm exec vis run --affected lint", "lint:oxlint": "oxlint", test: "vis run test:unit" },
            },
            { name: "workspace-root" },
        );

        const targets = discoverWorkspace(scratch, {}).workspace.projects["workspace-root"]?.targets ?? {};

        expect(targets["build"]).toBeUndefined();
        expect(targets["lint"]).toBeUndefined();
        expect(targets["lint:oxlint"]).toBeDefined();
        expect(targets["test"]).toBeDefined();
    });

    it("should drop a root script that only forwards its own name to a project that has that script", () => {
        expect.assertions(1);

        // `b` gets an inferred `build` target from vite, but no `build` script: pnpm would run the vite binary there.
        writePackage(scratch, "packages/b", { name: "b" });
        writeFileSync(join(scratch, "packages/b/vite.config.ts"), "export default {}");

        writePackage(scratch, "packages/a", { name: "a", scripts: { e2e: "playwright test", "e2e:examples": "playwright test examples", lint: "eslint ." } });
        writePackage(
            scratch,
            ".",
            {
                name: "fixture-root",
                private: true,
                scripts: {
                    build: "pnpm --filter b build",
                    e2e: "pnpm --filter a e2e",
                    // Kept: passes arguments on, a pnpm built-in, and a name no other project has.
                    "e2e:examples": "pnpm --filter \"a\" run e2e:examples -- --headed",
                    lint: "pnpm -r --if-present run lint",
                    outdated: "pnpm -r outdated",
                    typecheck: "pnpm --filter a typecheck",
                },
            },
            { name: "workspace-root" },
        );

        const targets = discoverWorkspace(scratch, {}).workspace.projects["workspace-root"]?.targets ?? {};

        expect(Object.keys(targets).toSorted()).toStrictEqual(["build", "e2e:examples", "outdated", "typecheck"]);
    });

    it("should remove a target set to null in project.json from every source that would add it", () => {
        expect.assertions(3);

        writePackage(
            scratch,
            ".",
            { name: "fixture-root", private: true, scripts: { e2e: "playwright test", "lint:oxlint": "oxlint" } },
            { name: "workspace-root", targets: { check: null, e2e: null } },
        );

        const targets = discoverWorkspace(scratch, { tasks: { check: { command: "echo check" } } }).workspace.projects["workspace-root"]?.targets ?? {};

        expect(targets["e2e"]).toBeUndefined();
        expect(targets["check"]).toBeUndefined();
        expect(targets["lint:oxlint"]).toBeDefined();
    });

    it("should keep a commandless alias that depends on another project's target", () => {
        expect.assertions(2);

        writePackage(
            scratch,
            ".",
            { name: "fixture-root", private: true, scripts: { e2e: "pnpm --filter a e2e" } },
            { name: "workspace-root", targets: { e2e: { command: "", dependsOn: [{ projects: "a", target: "e2e" }] } } },
        );

        const target = discoverWorkspace(scratch, {}).workspace.projects["workspace-root"]?.targets?.["e2e"];

        expect(target?.command).toBe("");
        expect(target?.dependsOn).toStrictEqual([{ projects: "a", target: "e2e" }]);
    });

    it("should list the root once when the workspace patterns already include it", () => {
        expect.assertions(1);

        writeWorkspaceYaml(scratch, [".", "packages/*"]);
        writePackage(scratch, ".", { name: "fixture-root", private: true }, { name: "workspace-root" });

        const { workspace } = discoverWorkspace(scratch, {});

        expect(Object.keys(workspace.projects).toSorted()).toStrictEqual(["a", "workspace-root"]);
    });
});
