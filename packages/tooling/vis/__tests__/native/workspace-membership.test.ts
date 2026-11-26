import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import { isProjectCandidate } from "../../src/config/cargo-projects";
import type { PackageJson } from "../../src/config/types";
import { readPnpmWorkspacePatterns, resolveWorkspacePatterns, validateWorkspacesField } from "../../src/config/workspace";

/**
 * Parity for the native workspace membership (`native/cli/src/workspace.rs`). Each fixture under
 * `native/cli/tests/fixtures/workspace/` has an `expected.json`: `{ "native": [...] }` for the
 * sorted project directories, or `{ "delegate": true }` for roots the native path must hand to Node.
 * The Rust unit test checks the same files, so both sides answer to one list.
 *
 * The TypeScript side composes the exported discovery steps: the pnpm/aube YAML patterns first,
 * then the `package.json` `workspaces` array, then `resolveWorkspacePatterns` with the candidate
 * rule, keeping the directories that have a `package.json`.
 */

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "cli", "tests", "fixtures", "workspace");

const discover = (root: string): string[] => {
    const yamlPatterns = readPnpmWorkspacePatterns(root);
    const packageJson = join(root, "package.json");
    let patterns = yamlPatterns;

    if (patterns === undefined) {
        const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as PackageJson;

        patterns = manifest.workspaces === undefined ? undefined : validateWorkspacesField(manifest.workspaces);
    }

    if (patterns === undefined) {
        throw new Error(`no workspace configuration under ${root}`);
    }

    return resolveWorkspacePatterns(root, patterns, isProjectCandidate)
        .filter((directory) => isPackageDirectory(root, directory))
        .toSorted();
};

const isPackageDirectory = (root: string, directory: string): boolean => {
    try {
        readFileSync(join(root, directory, "package.json"));

        return true;
    } catch {
        return false;
    }
};

const readExpected = (caseRoot: string): { delegate?: boolean; native?: string[] } =>
    JSON.parse(readFileSync(join(caseRoot, "expected.json"), "utf8")) as { delegate?: boolean; native?: string[] };

describe("native workspace membership parity", () => {
    const cases = readdirSync(fixtureRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();

    it.each(cases.filter((name) => readExpected(join(fixtureRoot, name)).native !== undefined))("%s matches the native list", (name) => {
        expect.assertions(1);

        const caseRoot = join(fixtureRoot, name);
        const expected = readExpected(caseRoot).native ?? [];

        expect(discover(caseRoot)).toStrictEqual([...expected].toSorted());
    });

    it("keeps the delegate fixtures out of the native comparison", () => {
        expect.assertions(1);

        const delegating = cases.filter((name) => readExpected(join(fixtureRoot, name)).delegate === true);

        expect(delegating.length).toBeGreaterThan(0);
    });

    it("matches the root .gitignore literal rules", () => {
        expect.assertions(1);

        const root = mkdtempSync(join(tmpdir(), "vis-workspace-gitignore-"));

        onTestFinished(() => {
            rmSync(root, { force: true, recursive: true });
        });

        const files: Record<string, string> = {
            ".gitignore": "skipped\n/root-skip\nnested/hidden\nUpper\n# comment\n",
            "nested/hidden/p/package.json": "{}",
            "nested/keep/package.json": "{}",
            "package.json": '{"name":"root","private":true}',
            "packages/a/package.json": "{}",
            "packages/skipped/package.json": "{}",
            "packages/x/skipped/package.json": "{}",
            "pnpm-workspace.yaml": 'packages:\n  - "packages/**"\n  - "root-skip"\n  - "nested/**"\n  - "upper/**"\n',
            "root-skip/package.json": "{}",
            "upper/x/package.json": "{}",
        };

        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        }

        expect(discover(root)).toStrictEqual(["nested/keep", "packages/a"]);
    });

    // The same files and the same list as `root_gitignore_drops_wildcard_matches` in `native/cli/src/workspace.rs`.
    it("matches the root .gitignore wildcard rules", () => {
        expect.assertions(1);

        const root = mkdtempSync(join(tmpdir(), "vis-workspace-gitignore-wildcard-"));

        onTestFinished(() => {
            rmSync(root, { force: true, recursive: true });
        });

        const files: Record<string, string> = {
            ".gitignore": "*-skip\ntmp?\n/build-*\nnested/*/gen\nMixed*\n   \n# café\n",
            "build-one/package.json": "{}",
            "nested/a/gen/package.json": "{}",
            "nested/a/keep/package.json": "{}",
            "nested/gen/package.json": "{}",
            "package.json": '{"name":"root","private":true}',
            "packages/a-skip/package.json": "{}",
            "packages/a/package.json": "{}",
            "packages/build-two/package.json": "{}",
            "packages/MixedCase/package.json": "{}",
            "packages/tmp1/package.json": "{}",
            "packages/tmp12/package.json": "{}",
            "packages/x/b-skip/package.json": "{}",
            "pnpm-workspace.yaml": 'packages:\n  - "packages/**"\n  - "nested/**"\n  - "build-*"\n',
        };

        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        }

        expect(discover(root)).toStrictEqual(["nested/a/keep", "nested/gen", "packages/a", "packages/build-two", "packages/tmp12"]);
    });
});
