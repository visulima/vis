import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findWorkspaceRootSync } from "../../src/util/workspace-root";

describe(findWorkspaceRootSync, () => {
    let root: string;

    beforeEach(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), "vis-workspace-root-")));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("returns the workspace root, not a package with its own lockfile", () => {
        expect.assertions(1);

        const pkg = join(root, "packages", "app");

        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@x/app" }));
        writeFileSync(join(pkg, "package-lock.json"), "{}");

        expect(findWorkspaceRootSync(pkg)).toBe(root);
    });

    it("finds a declared workspace without a lockfile", () => {
        expect.assertions(1);

        const pkg = join(root, "packages", "app");

        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

        expect(findWorkspaceRootSync(pkg)).toBe(root);
    });

    it("accepts a package.json workspaces field", () => {
        expect.assertions(1);

        const pkg = join(root, "packages", "app");

        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));

        expect(findWorkspaceRootSync(pkg)).toBe(root);
    });
});
