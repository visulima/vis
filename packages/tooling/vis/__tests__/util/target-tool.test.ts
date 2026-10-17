import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CerebroFs } from "@visulima/cerebro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TargetToolChoice } from "../../src/util/target-tool";
import { offerTargetTool } from "../../src/util/target-tool";

const CHOICES: ReadonlyArray<TargetToolChoice> = [
    { config: { contents: "export default {};\n", file: "vite.config.mts" }, label: "Vite", packages: ["vite"], script: "vite" },
    { label: "Rspack", packages: ["@rspack/cli", "@rspack/core"], script: "rspack serve" },
];

const fs = { access, readFile, writeFile } as unknown as CerebroFs;

describe(offerTargetTool, () => {
    let root: string;
    let app: string;

    /** One project, the app, with no targets yet. */
    const oneProject = async () => [{ name: "@fix/app", root: app, targets: undefined }];
    /** One project that already has a dev target. */
    const withDev = async () => [{ name: "@fix/app", root: app, targets: { dev: {} } }];
    /** Two projects, neither with a dev target. */
    const twoProjects = async () => [
        { name: "@fix/app", root: app, targets: undefined },
        { name: "@fix/lib", root: join(root, "packages", "lib"), targets: undefined },
    ];

    const manifest = (): string => readFileSync(join(app, "package.json"), "utf8");

    beforeEach(() => {
        root = mkdtempSync(join(realpathSync(tmpdir()), "vis-target-tool-"));
        app = join(root, "packages", "app");

        mkdirSync(join(root, "node_modules"), { recursive: true });
        mkdirSync(app, { recursive: true });
        writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
        writeFileSync(join(app, "package.json"), JSON.stringify({ name: "@fix/app", scripts: {} }, undefined, 2));
        process.exitCode = undefined;
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
        process.exitCode = undefined;
    });

    const params = (overrides: Partial<Parameters<typeof offerTargetTool>[0]> = {}) => {
        return {
            choices: CHOICES,
            fs,
            logger: { info: vi.fn() },
            target: "dev" as const,
            visConfig: undefined,
            workspaceRoot: root,
            ...overrides,
        };
    };

    it("does nothing when a project already defines the target", async () => {
        expect.assertions(2);

        writeFileSync(join(app, "package.json"), JSON.stringify({ name: "@fix/app", scripts: { dev: "node server.js" } }));
        const install = vi.fn(() => 0);

        await expect(offerTargetTool(params(), { install, projects: withDev })).resolves.toBe(true);
        expect(install).not.toHaveBeenCalled();
    });

    it("errors in a non-interactive run, listing each tool, and changes nothing", async () => {
        expect.assertions(3);

        const install = vi.fn(() => 0);

        await expect(offerTargetTool(params(), { install, isInteractive: () => false, projects: oneProject })).rejects.toThrow("vis add -D vite");
        expect(install).not.toHaveBeenCalled();
        expect(manifest()).not.toContain("\"dev\"");
    });

    it("installs the picked tool into the package and adds its script", async () => {
        expect.assertions(4);

        const install = vi.fn(() => 0);

        await expect(offerTargetTool(params(), { install, isInteractive: () => true, projects: oneProject, readline: async () => "1" })).resolves.toBe(true);
        expect(install).toHaveBeenCalledWith("vite", expect.stringMatching(/packages\/app$/));
        expect(JSON.parse(manifest())).toMatchObject({ scripts: { dev: "vite" } });
        expect(process.exitCode).toBeUndefined();
    });

    it("installs every package a tool needs", async () => {
        expect.assertions(1);

        const install = vi.fn(() => 0);

        await offerTargetTool(params(), { install, isInteractive: () => true, projects: oneProject, readline: async () => "2" });

        expect(install.mock.calls.map(([name]) => name)).toStrictEqual(["@rspack/cli", "@rspack/core"]);
    });

    it("writes the tool's config file next to the script", async () => {
        expect.assertions(1);

        await offerTargetTool(params(), { install: () => 0, isInteractive: () => true, projects: oneProject, readline: async () => "1" });

        expect(readFileSync(join(app, "vite.config.mts"), "utf8")).toBe("export default {};\n");
    });

    it("keeps an existing config file untouched", async () => {
        expect.assertions(1);

        writeFileSync(join(app, "vite.config.mts"), "export default { base: '/app/' };\n");

        await offerTargetTool(params(), { install: () => 0, isInteractive: () => true, projects: oneProject, readline: async () => "1" });

        expect(readFileSync(join(app, "vite.config.mts"), "utf8")).toBe("export default { base: '/app/' };\n");
    });

    it("keeps the package's own indentation when it adds the script", async () => {
        expect.assertions(1);

        writeFileSync(join(app, "package.json"), "{\n\t\"name\": \"@fix/app\"\n}\n");

        await offerTargetTool(params(), { install: () => 0, isInteractive: () => true, projects: oneProject, readline: async () => "1" });

        expect(manifest()).toBe("{\n\t\"name\": \"@fix/app\",\n\t\"scripts\": {\n\t\t\"dev\": \"vite\"\n\t}\n}\n");
    });

    it("stops without adding the script when an install fails", async () => {
        expect.assertions(3);

        const install = vi.fn(() => 2);

        await expect(offerTargetTool(params(), { install, isInteractive: () => true, projects: oneProject, readline: async () => "1" })).resolves.toBe(false);
        expect(process.exitCode).toBe(2);
        expect(manifest()).not.toContain("\"dev\"");
    });

    it("cancels without installing when the user declines", async () => {
        expect.assertions(2);

        const install = vi.fn(() => 0);

        await expect(offerTargetTool(params(), { install, isInteractive: () => true, projects: oneProject, readline: async () => "" })).rejects.toThrow("No dev tool selected");
        expect(install).not.toHaveBeenCalled();
    });

    it("errors when the workspace has several projects and none is picked", async () => {
        expect.assertions(1);

        const install = vi.fn(() => 0);

        await expect(offerTargetTool(params(), { install, isInteractive: () => true, projects: twoProjects, readline: async () => "1" })).rejects.toThrow("--filter");
    });

    it("uses the project named by --filter when the workspace has several", async () => {
        expect.assertions(1);

        const install = vi.fn(() => 0);

        await offerTargetTool(params({ filter: ["@fix/app"] }), { install, isInteractive: () => true, projects: twoProjects, readline: async () => "1" });

        expect(install).toHaveBeenCalledWith("vite", app);
    });
});
