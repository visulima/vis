import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverWorkspace } from "../../src/config/workspace";

const writeProject = (root: string, name: string, files: string[], packageJson: Record<string, unknown> = {}): void => {
    const directory = join(root, "packages", name);

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@fix/${name}`, scripts: {}, ...packageJson }, undefined, 2));

    for (const file of files) {
        writeFileSync(join(directory, file), "export default {}");
    }
};

describe("rstack target inference", () => {
    let scratch: string;

    const targetsOf = (name: string): Record<string, { command?: string } | undefined> =>
        discoverWorkspace(scratch, {}).workspace.projects[`@fix/${name}`]?.targets ?? {};

    beforeEach(() => {
        scratch = mkdtempSync(join(realpathSync(tmpdir()), "vis-rstack-"));
        mkdirSync(join(scratch, "node_modules"), { recursive: true });
        writeFileSync(join(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "fixture-root", private: true }, undefined, 2));
    });

    afterEach(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("infers build, dev, and preview from rsbuild.config.ts", () => {
        expect.assertions(3);

        writeProject(scratch, "app", ["rsbuild.config.ts"]);

        const targets = targetsOf("app");

        expect(targets["build"]?.command).toBe("rsbuild build");
        expect(targets["dev"]?.command).toBe("rsbuild dev");
        expect(targets["preview"]?.command).toBe("rsbuild preview");
    });

    it("prefers rsbuild over rspack when both configs exist", () => {
        expect.assertions(1);

        writeProject(scratch, "app", ["rsbuild.config.ts", "rspack.config.ts"]);

        expect(targetsOf("app")["build"]?.command).toBe("rsbuild build");
    });

    it("infers a library build and watch from rslib.config.ts", () => {
        expect.assertions(2);

        writeProject(scratch, "lib", ["rslib.config.ts"]);

        const targets = targetsOf("lib");

        expect(targets["build"]?.command).toBe("rslib build");
        expect(targets["dev"]?.command).toBe("rslib build --watch");
    });

    it("infers rstest run from the dependency, without a watcher", () => {
        expect.assertions(2);

        writeProject(scratch, "unit", [], { devDependencies: { "@rstest/core": "^0.12.0" } });

        const targets = targetsOf("unit");

        expect(targets["test"]?.command).toBe("rstest run");
        expect(targets["test:watch"]).toBeUndefined();
    });

    it("adds rstest watch when a config file exists", () => {
        expect.assertions(1);

        writeProject(scratch, "unit", ["rstest.config.ts"], { devDependencies: { "@rstest/core": "^0.12.0" } });

        expect(targetsOf("unit")["test:watch"]?.command).toBe("rstest watch");
    });

    it("keeps vitest ahead of rstest when both are present", () => {
        expect.assertions(1);

        writeProject(scratch, "unit", ["rstest.config.ts", "vitest.config.ts"], { devDependencies: { "@rstest/core": "^0.12.0", vitest: "^4.0.0" } });

        expect(targetsOf("unit")["test"]?.command).toBe("vitest run");
    });

    it("infers rslint from rslint.config.ts", () => {
        expect.assertions(1);

        writeProject(scratch, "style", ["rslint.config.ts"]);

        expect(targetsOf("style")["lint"]?.command).toBe("rslint .");
    });
});
