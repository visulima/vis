import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listPnpmWorkspaceFromFiles } from "../../../src/release/core/package-managers/pnpm-workspace-files";
import { fixturePackageManager } from "../../test-helpers";

/** Files to create, keyed by path relative to the workspace root. An object value is written as JSON. */
type Files = Record<string, Record<string, unknown> | string>;

const write = (root: string, files: Files): void => {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
    }
};

const manifest = (name: string): Record<string, unknown> => {
    return { name, version: "1.0.0" };
};

/** The root manifest of a workspace pinned to a pnpm version. */
const rootManifest = (pin: string | null = "pnpm@11.28.2"): Record<string, unknown> => {
    return { ...manifest("root"), ...(pin === null ? {} : { packageManager: pin }) };
};

const workspaceYaml = (...patterns: string[]): string => `packages:\n${patterns.map((pattern) => `  - '${pattern}'`).join("\n")}\n`;

const pnpmAvailable = (): boolean => spawnSync("pnpm", ["--version"], { stdio: "ignore" }).status === 0;

const pnpmPaths = (cwd: string): string[] =>
    (JSON.parse(execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { path: string }[]).map(
        (entry) => entry.path,
    );

describe(listPnpmWorkspaceFromFiles, () => {
    let root: string;

    beforeEach(() => {
        // The real path: pnpm prints it, and the macOS temp directory is a symlink.
        root = realpathSync(mkdtempSync(join(tmpdir(), "vis-pnpm-files-")));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const names = async (): Promise<string[] | undefined> => {
        const entries = await listPnpmWorkspaceFromFiles(root);

        return entries?.map((entry) => entry.name);
    };

    const orderingFiles = (pin: string): Files => {
        return {
            "package.json": rootManifest(pin),
            "packages/a-b/package.json": manifest("a-b"),
            "packages/a/package.json": manifest("a"),
            "packages/a/x/package.json": manifest("a-x"),
            "packages/B/package.json": manifest("B"),
            "pnpm-workspace.yaml": workspaceYaml("packages/**"),
        };
    };

    it("lists the root first and then the selected packages, ordered like pnpm 9 to 11 (path strings)", async () => {
        expect.hasAssertions();

        write(root, orderingFiles("pnpm@11.28.2"));

        // "B" before "a" (code units), and "a-b" before "a/x" ("-" sorts before "/").
        await expect(names()).resolves.toStrictEqual(["root", "B", "a", "a-b", "a-x"]);
    });

    it("orders like pnpm 12, a directory right before what is inside it", async () => {
        expect.hasAssertions();

        write(root, orderingFiles("pnpm@12.15.0+sha512.abc"));

        await expect(names()).resolves.toStrictEqual(["root", "B", "a", "a-x", "a-b"]);
    });

    it("returns the real path of the workspace for a symlinked working directory", async () => {
        expect.hasAssertions();

        write(root, { "package.json": rootManifest(), "packages/a/package.json": manifest("a"), "pnpm-workspace.yaml": workspaceYaml("packages/*") });

        const link = `${root}-link`;

        symlinkSync(root, link);

        try {
            const entries = await listPnpmWorkspaceFromFiles(link);

            expect(entries?.map((entry) => entry.path)).toStrictEqual([root, join(root, "packages", "a")]);
        } finally {
            rmSync(link, { force: true });
        }
    });

    it("selects only what the patterns select and honours `!dir/**`", async () => {
        expect.hasAssertions();

        write(root, {
            "apps/web/package.json": manifest("web"),
            "package.json": rootManifest(),
            "packages/a/__tests__/package.json": manifest("a-tests"),
            "packages/a/package.json": manifest("a"),
            "packages/b/package.json": manifest("b"),
            "pnpm-workspace.yaml": workspaceYaml("packages/**", "!**/__tests__/**", "!packages/b/**"),
            "tools/t/package.json": manifest("t"),
        });

        await expect(names()).resolves.toStrictEqual(["root", "a"]);
    });

    it("does not enter node_modules, bower_components or dot directories, and ignores .gitignore", async () => {
        expect.hasAssertions();

        write(root, {
            ".gitignore": "packages/ignored\n",
            "package.json": rootManifest(),
            "packages/.hidden/package.json": manifest("hidden"),
            "packages/a/node_modules/dep/package.json": manifest("dep"),
            "packages/a/package.json": manifest("a"),
            "packages/bower_components/x/package.json": manifest("bower"),
            "packages/ignored/package.json": manifest("ignored"),
            "pnpm-workspace.yaml": workspaceYaml("packages/**"),
        });

        await expect(names()).resolves.toStrictEqual(["root", "a", "ignored"]);
    });

    it("drops a package without a name, as the manager list does", async () => {
        expect.hasAssertions();

        write(root, {
            "package.json": rootManifest(),
            "packages/a/package.json": manifest("a"),
            "packages/anonymous/package.json": { version: "1.0.0" },
            "pnpm-workspace.yaml": workspaceYaml("packages/*"),
        });

        await expect(names()).resolves.toStrictEqual(["root", "a"]);
    });

    describe("hands the question back to the package manager (undefined)", () => {
        const base: Files = { "package.json": rootManifest(), "packages/a/package.json": manifest("a") };

        it.each([
            ["no pnpm-workspace.yaml", { ...base }],
            ["no packageManager pin", { ...base, "package.json": rootManifest(null), "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["a pin to another manager", { ...base, "package.json": rootManifest("yarn@4.0.0"), "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["a pin below pnpm 9.5", { ...base, "package.json": rootManifest("pnpm@9.4.0"), "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["a pin to pnpm 12.1, which also lists dot directories", { ...base, "package.json": rootManifest("pnpm@12.1.0"), "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["a pin newer than the versions checked", { ...base, "package.json": rootManifest("pnpm@12.24.0"), "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["a pre-release pin", { ...base, "package.json": rootManifest("pnpm@11.0.0-rc.1"), "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["a pnpm-workspace.yaml without `packages`", { ...base, "pnpm-workspace.yaml": "catalog:\n  react: ^19.0.0\n" }],
            ["a `packages` entry that is not a string", { ...base, "pnpm-workspace.yaml": "packages:\n  - 1\n" }],
            ["a braces pattern", { ...base, "pnpm-workspace.yaml": workspaceYaml("packages/{a,b}") }],
            ["a partial wildcard", { ...base, "pnpm-workspace.yaml": workspaceYaml("packages/pkg-*") }],
            ["a leading ./", { ...base, "pnpm-workspace.yaml": workspaceYaml("./packages/*") }],
            ["a dot segment", { ...base, "pnpm-workspace.yaml": workspaceYaml(".github/*") }],
            ["a negation that is not `dir/**`", { ...base, "pnpm-workspace.yaml": workspaceYaml("packages/*", "!packages/a") }],
            ["a negation of every directory", { ...base, "pnpm-workspace.yaml": workspaceYaml("packages/*", "!**/**") }],
            ["a manifest that is not JSON", { ...base, "packages/bad/package.json": "{", "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["a package.yaml manifest", { ...base, "packages/y/package.yaml": "name: y\n", "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["a package.json5 manifest", { ...base, "packages/y/package.json5": "{ name: 'y' }", "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
            ["no root package.json", { "packages/a/package.json": manifest("a"), "pnpm-workspace.yaml": workspaceYaml("packages/*") }],
        ] as [string, Files][])("for %s", async (_label, files) => {
            expect.hasAssertions();

            write(root, files);

            await expect(listPnpmWorkspaceFromFiles(root)).resolves.toBeUndefined();
        });

        it("for a symlink to a directory in the tree", async () => {
            expect.hasAssertions();

            write(root, { ...base, "pnpm-workspace.yaml": workspaceYaml("packages/*") });
            symlinkSync(join(root, "packages", "a"), join(root, "packages", "linked"));

            await expect(listPnpmWorkspaceFromFiles(root)).resolves.toBeUndefined();
        });
    });

    // The point of the file read is to give the manager's answer. Compare it with the real manager's.
    describe.skipIf(!pnpmAvailable() || process.platform === "win32" || !/^pnpm@(?:9|10|11)\./.test(fixturePackageManager()))("against `pnpm -r ls`", () => {
        const fixtures: [string, Files][] = [
            [
                "nested patterns with negations and a name that sorts oddly",
                {
                    "apps/web/package.json": manifest("web"),
                    "package.json": rootManifest(),
                    "packages/a-b/package.json": manifest("a-b"),
                    "packages/a.b/package.json": manifest("a.b"),
                    "packages/a/__tests__/package.json": manifest("a-tests"),
                    "packages/a/package.json": manifest("a"),
                    "packages/a/sub/package.json": manifest("a-sub"),
                    "packages/ignored/package.json": manifest("ignored"),
                    "pnpm-workspace.yaml": workspaceYaml("packages/**", "apps/*", "!**/__tests__/**", "!packages/ignored/**"),
                },
            ],
            [
                "a single level, a literal directory and a scope",
                {
                    "@s/x/package.json": manifest("@s/x"),
                    "package.json": rootManifest(),
                    "packages/a/b/package.json": manifest("deep"),
                    "packages/a/package.json": manifest("a"),
                    "pnpm-workspace.yaml": workspaceYaml("packages/*", "tools/t", "@s/*"),
                    "tools/t/package.json": manifest("t"),
                },
            ],
            [
                "a .gitignore that pnpm does not read",
                {
                    ".gitignore": "packages/a/dist\npackages/ignored\n",
                    "package.json": rootManifest(),
                    "packages/a/dist/package.json": manifest("a-dist"),
                    "packages/a/package.json": manifest("a"),
                    "packages/ignored/inner/package.json": manifest("ignored-inner"),
                    "pnpm-workspace.yaml": workspaceYaml("packages/**"),
                },
            ],
        ];

        it.each(fixtures)("lists the same paths in the same order for %s", async (_label, files) => {
            expect.hasAssertions();

            // Pin to the pnpm that runs the suite: it is what `pnpm -r ls` below runs, and it avoids a download.
            write(root, { ...files, "package.json": rootManifest(fixturePackageManager()) });

            const entries = await listPnpmWorkspaceFromFiles(root);

            expect(entries?.map((entry) => entry.path)).toStrictEqual(pnpmPaths(root));
        });
    });
});
