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
