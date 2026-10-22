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

describe("pack target inference", () => {
    let scratch: string;

    const targetsOf = (name: string): Record<string, { command?: string } | undefined> =>
        discoverWorkspace(scratch, {}).workspace.projects[`@fix/${name}`]?.targets ?? {};

    beforeEach(() => {
        scratch = mkdtempSync(join(realpathSync(tmpdir()), "vis-pack-infer-"));
        mkdirSync(join(scratch, "node_modules"), { recursive: true });
        writeFileSync(join(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "fixture-root", private: true }, undefined, 2));
    });

    afterEach(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("infers pack from rslib.config.ts, and keeps build", () => {
        expect.assertions(2);

        writeProject(scratch, "lib", "rslib.config.mts");

        expect(targetsOf("lib")["pack"]?.command).toBe("rslib build");
        expect(targetsOf("lib")["build"]?.command).toBe("rslib build");
    });

    it("infers pack from packem.config.ts, and keeps build", () => {
        expect.assertions(2);

        writeProject(scratch, "tool", "packem.config.ts");

        expect(targetsOf("tool")["pack"]?.command).toBe("packem build");
        expect(targetsOf("tool")["build"]?.command).toBe("packem build");
    });
});
