import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CerebroFs } from "@visulima/cerebro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TargetToolChoice } from "../../src/util/target-tool";
import { offerTargetTool } from "../../src/util/target-tool";

const CHOICES: ReadonlyArray<TargetToolChoice> = [
    { config: { contents: "export default {};\n", file: "vite.config.ts" }, label: "Vite", packages: ["vite"], script: "vite" },
    { label: "Rspack", packages: ["@rspack/cli", "@rspack/core"], script: "rspack serve" },
];

const fs = { access, readFile, writeFile } as unknown as CerebroFs;

describe(offerTargetTool, () => {
    let root: string;
    let app: string;

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
            cwd: app,
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

        await expect(offerTargetTool(params(), { definesTarget: async () => true, install })).resolves.toBe(true);
        expect(install).not.toHaveBeenCalled();
    });

    it("errors in a non-interactive run, listing each tool, and changes nothing", async () => {
        expect.assertions(3);

        const install = vi.fn(() => 0);

        await expect(offerTargetTool(params(), { definesTarget: async () => false, install, isInteractive: () => false })).rejects.toThrow("vis add -D vite");
        expect(install).not.toHaveBeenCalled();
        expect(manifest()).not.toContain("\"dev\"");
    });

    it("installs the picked tool into the package and adds its script", async () => {
        expect.assertions(4);

        const install = vi.fn(() => 0);

        await expect(offerTargetTool(params(), { definesTarget: async () => false, install, isInteractive: () => true, readline: async () => "1" })).resolves.toBe(true);
        expect(install).toHaveBeenCalledWith("vite", expect.stringMatching(/packages\/app$/));
        expect(JSON.parse(manifest())).toMatchObject({ scripts: { dev: "vite" } });
        expect(process.exitCode).toBeUndefined();
    });

    it("installs every package a tool needs", async () => {
        expect.assertions(1);

        const install = vi.fn(() => 0);

        await offerTargetTool(params(), { definesTarget: async () => false, install, isInteractive: () => true, readline: async () => "2" });

        expect(install.mock.calls.map(([name]) => name)).toStrictEqual(["@rspack/cli", "@rspack/core"]);
    });

    it("writes the tool's config file next to the script", async () => {
        expect.assertions(1);

        await offerTargetTool(params(), { definesTarget: async () => false, install: () => 0, isInteractive: () => true, readline: async () => "1" });

        expect(readFileSync(join(app, "vite.config.ts"), "utf8")).toBe("export default {};\n");
    });

    it("keeps an existing config file untouched", async () => {
        expect.assertions(1);

        writeFileSync(join(app, "vite.config.ts"), "export default { base: '/app/' };\n");

        await offerTargetTool(params(), { definesTarget: async () => false, install: () => 0, isInteractive: () => true, readline: async () => "1" });

        expect(readFileSync(join(app, "vite.config.ts"), "utf8")).toBe("export default { base: '/app/' };\n");
    });

    it("keeps the package's own indentation when it adds the script", async () => {
        expect.assertions(1);

        writeFileSync(join(app, "package.json"), "{\n\t\"name\": \"@fix/app\"\n}\n");

        await offerTargetTool(params(), { definesTarget: async () => false, install: () => 0, isInteractive: () => true, readline: async () => "1" });

        expect(manifest()).toBe("{\n\t\"name\": \"@fix/app\",\n\t\"scripts\": {\n\t\t\"dev\": \"vite\"\n\t}\n}\n");
    });

    it("stops without adding the script when an install fails", async () => {
        expect.assertions(3);

        const install = vi.fn(() => 2);

        await expect(offerTargetTool(params(), { definesTarget: async () => false, install, isInteractive: () => true, readline: async () => "1" })).resolves.toBe(false);
        expect(process.exitCode).toBe(2);
        expect(manifest()).not.toContain("\"dev\"");
    });

    it("cancels without installing when the user declines", async () => {
        expect.assertions(2);

        const install = vi.fn(() => 0);

        await expect(offerTargetTool(params(), { definesTarget: async () => false, install, isInteractive: () => true, readline: async () => "" })).rejects.toThrow("No dev tool selected");
        expect(install).not.toHaveBeenCalled();
    });

    it("refuses to add the script to the workspace root", async () => {
        expect.assertions(1);

        await expect(offerTargetTool(params({ cwd: root }), { definesTarget: async () => false, install: () => 0, isInteractive: () => true, readline: async () => "1" })).rejects.toThrow(
            "no package to add",
        );
    });
});
