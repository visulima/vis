import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverWorkspace } from "../../src/config/workspace";

const writeProject = (root: string, name: string, configFile: string): void => {
    const directory = join(root, "packages", name);

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@fix/${name}`, scripts: {} }, undefined, 2));
    writeFileSync(join(directory, configFile), "export default {}");
};

describe("rspack target inference", () => {
    let scratch: string;

    beforeEach(() => {
        scratch = mkdtempSync(join(realpathSync(tmpdir()), "vis-rspack-"));
        mkdirSync(join(scratch, "node_modules"), { recursive: true });
        writeFileSync(join(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "fixture-root", private: true }, undefined, 2));
    });

    afterEach(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("infers build, dev, and preview from rspack.config.ts", () => {
        expect.assertions(3);

        writeProject(scratch, "alpha", "rspack.config.ts");

        const targets = discoverWorkspace(scratch, {}).workspace.projects["@fix/alpha"]?.targets ?? {};

        expect(targets["build"]?.command).toBe("rspack build");
        expect(targets["dev"]?.command).toBe("rspack serve");
        expect(targets["preview"]?.command).toBe("rspack preview");
    });

    it("prefers rspack over webpack when both configs exist", () => {
        expect.assertions(1);

        writeProject(scratch, "beta", "rspack.config.mjs");
        writeFileSync(join(scratch, "packages", "beta", "webpack.config.js"), "module.exports = {}");

        const targets = discoverWorkspace(scratch, {}).workspace.projects["@fix/beta"]?.targets ?? {};

        expect(targets["build"]?.command).toBe("rspack build");
    });

    it("keeps vite ahead of rspack when both configs exist", () => {
        expect.assertions(1);

        writeProject(scratch, "gamma", "rspack.config.ts");
        writeFileSync(join(scratch, "packages", "gamma", "vite.config.ts"), "export default {}");

        const targets = discoverWorkspace(scratch, {}).workspace.projects["@fix/gamma"]?.targets ?? {};

        expect(targets["build"]?.command).toBe("vite build");
    });
});
