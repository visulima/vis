import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis deps` exists twice: the Node handler (`src/commands/deps/handler.ts`) and the native fast path
 * (`native/cli/src/deps/`). For every shape and workspace the native path accepts it must print the same text with the
 * same exit status as Node, and every shape it declines must be handed to Node before anything is printed (see
 * `workspace-parity-harness.ts` for how both are proved).
 */

const harness = new Harness(["deps"]);

const project = (name: string, manifest: Record<string, unknown> = {}): Files => {
    return { [`packages/${name}/package.json`]: json({ name, version: "1.0.0", ...manifest }) };
};

/** A workspace in which every lint finds nothing. */
const clean = (): Files =>
    workspaceFiles(
        {
            ...project("a", { dependencies: { b: "workspace:*", lodash: "^4.17.21" }, devDependencies: { vitest: "^1.0.0" } }),
            ...project("b", { dependencies: { lodash: "^4.17.21" }, engines: { node: ">=20" } }),
        },
        { devDependencies: { typescript: "^5.0.0" }, engines: { node: ">=20" }, packageManager: "pnpm@10.0.0" },
    );

/** A workspace in which every lint that can be answered natively finds something. */
const findings = (): Files => {
    const files = workspaceFiles(
        {
            ...project("app", {
                dependencies: { "@types/node": "^20.0.0", lib: "^1.0.0", react: "^18.0.0", typescript: "^5.0.0" },
                devDependencies: {},
                peerDependencies: {},
                private: true,
            }),
            ...project("lib", { dependencies: { "react-dom": "^17.0.0" }, optionalDependencies: {}, peerDependencies: { typescript: "^5.0.0" } }),
            "packages/nameless/package.json": json({ dependencies: { lib: "1.0.0" }, devDependencies: {} }),
            "packages/nodeps/readme.md": "x\n",
        },
        { dependencies: { typescript: "^5.0.0", zod: "^3.0.0" }, private: true },
    );

    return { ...files, "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n  - "tools/cli"\n' };
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis deps: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-deps-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    const FLAG_SETS: string[][] = [
        [],
        ["--quiet"],
        ["--format", "json"],
        ["--format=json"],
        ["--format", "minimal"],
        ["--format=human"],
        ["--format", "json", "--quiet"],
        ["--workspace-protocol"],
        ["--redefine-root"],
        ["--empty-deps"],
        ["--root-private"],
        ["--root-package-manager"],
        ["--root-deps"],
        ["--missing-package-json"],
        ["--dead-workspace-patterns"],
        ["--types-in-deps"],
        ["--similar-deps"],
        ["--workspace-versions"],
        ["--custom-types"],
        ["--banned-deps", "--quiet"],
        ["--root-private", "--root-deps", "--format", "json"],
        ["--similar-deps", "--types-in-deps", "--format", "minimal"],
        ["--empty-deps", "--redefine-root", "--workspace-protocol"],
        ["--quiet", "--similar-deps"],
    ];

    describe("accepted shapes", () => {
        it.each(FLAG_SETS)("a clean workspace with `deps %s` prints what Node does", (...flags: string[]) => {
            expect.hasAssertions();

            harness.expectParity(clean(), flags);
        });

        it.each(FLAG_SETS)("a workspace with findings with `deps %s` prints what Node does", (...flags: string[]) => {
            expect.hasAssertions();

            harness.expectParity(findings(), flags);
        });

        it("reports what is wrong with a workspace and exits 1", () => {
            expect.hasAssertions();

            const result = harness.expectParity(findings(), []);

            expect(result.status).toBe(1);
            expect(result.stdout).toContain("Found 1 family with version drift");
        });

        it("exits 0 for a clean workspace and prints every lint", () => {
            expect.hasAssertions();

            const result = harness.expectParity(clean(), []);

            expect(result.status).toBe(0);
            expect(result.stdout.split("\n").filter((line) => line.includes("✓"))).toHaveLength(13);
        });

        it("groups issues of packages with and without a name", () => {
            expect.hasAssertions();

            const files = workspaceFiles(
                {
                    "packages/a/package.json": json({ dependencies: { b: "^1.0.0" } }),
                    "packages/b/package.json": json({ dependencies: { a: "1.0.0", c: "^1" }, name: "b" }),
                    "packages/c/package.json": json({ dependencies: { b: "workspace:^" }, name: "c" }),
                },
                { dependencies: { c: "^1", d: "*" } },
            );

            harness.expectParity(files, ["--workspace-protocol"]);
            harness.expectParity(files, ["--redefine-root", "--format", "json"]);
            harness.expectParity(files, ["--redefine-root", "--format", "minimal"]);
        });

        it("covers every kind of dependency block", () => {
            expect.hasAssertions();

            const block = { dependencies: { b: "^1" }, devDependencies: { b: "2" }, optionalDependencies: { b: "3" }, overrides: { b: "4" }, peerDependencies: { b: "5" }, pnpm: { overrides: { b: "6" } }, resolutions: { b: "7" } };

            harness.expectParity(workspaceFiles({ ...project("a", block), ...project("b") }, block), ["--workspace-protocol"]);
            harness.expectParity(workspaceFiles({ ...project("a", block), ...project("b") }, block), ["--redefine-root", "--format", "json"]);
        });

        it("reads the packageManager of the root like the JavaScript pattern", () => {
            expect.hasAssertions();

            for (const value of ["pnpm@10.0.0", "pnpm@", "@10", "pnpm", "pnpm@1 0", "1pnpm@1", "p-n_p@x+y", "pnpm@10\t", " pnpm@10", "npm@@", 5, null, ["pnpm@1"], {}]) {
                harness.expectParity(workspaceFiles({ ...project("a") }, { packageManager: value }), ["--root-package-manager"]);
            }

            harness.expectParity(workspaceFiles({ ...project("a") }, {}), ["--root-package-manager", "--format", "minimal"]);
            harness.expectParity(workspaceFiles({ ...project("a") }, {}), ["--root-package-manager", "--format", "json"]);
        });

        it("reads the private field of the root like Node does", () => {
            expect.hasAssertions();

            for (const value of [true, false, null, "yes", 1, 0, [], {}, [true], { a: 1 }, "quo\"te\\"]) {
                const files = workspaceFiles({ ...project("a") }, { private: value });

                harness.expectParity(files, ["--root-private"]);
                harness.expectParity(files, ["--root-private", "--format", "json"]);
            }

            harness.expectParity({ ...workspaceFiles({ ...project("a") }), "package.json": json({ name: "root" }) }, ["--root-private", "--root-deps"]);
        });

        it("reads root dependencies of a private root", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ...project("a") }, { dependencies: { left: "1", right: "2" }, private: true });

            harness.expectParity(files, ["--root-deps"]);
            harness.expectParity(files, ["--root-deps", "--format", "json"]);
            harness.expectParity(files, ["--root-deps", "--format", "minimal"]);
            harness.expectParity(workspaceFiles({ ...project("a") }, { dependencies: {}, private: true }), ["--root-deps"]);
        });

        it("tells drift from agreement in the families", () => {
            expect.hasAssertions();

            const family = (specifiers: Record<string, string>): Files =>
                workspaceFiles({ ...project("a", { dependencies: specifiers }), ...project("b", { devDependencies: { "@babel/cli": "^7.1.0", "@babel/core": "^7.0.0" } }), ...project("c", { peerDependencies: { "@nrwl/tao": "2", "@nx/devkit": "1", react: "workspace:*" } }) });

            harness.expectParity(family({ react: "^18", "react-dom": "^18" }), ["--similar-deps"]);
            harness.expectParity(family({ react: "^18", "react-dom": "^17", "react-test-renderer": "^16" }), ["--similar-deps", "--format", "json"]);
            harness.expectParity(family({ "@vitest/ui": "2", react: "^18", vitest: "1" }), ["--similar-deps", "--format", "minimal"]);
            harness.expectParity(family({ "@storybook/react": "7", react: "^18", sb: "9", storybook: "8" }), ["--similar-deps"]);
        });

        it("finds the types in the dependencies of private packages", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ...project("a", { dependencies: { "@types/node": "^20", "@types/react": "^18" }, private: true }), ...project("b", { dependencies: { "@types/lodash": "4" } }) }, { dependencies: { "@types/x": "1" }, private: true });

            harness.expectParity(files, ["--types-in-deps"]);
            harness.expectParity(files, ["--types-in-deps", "--format", "json"]);
        });

        it("finds the dead patterns and the directories without a package.json", () => {
            expect.hasAssertions();

            const base = workspaceFiles({ ...project("a"), "packages/empty/readme.md": "x\n", "packages/nested/inner/package.json": json({ name: "inner" }), "tools/cli/package.json": json({ name: "cli" }), "tools/plain/readme.md": "x\n" });

            for (const patterns of [["packages/*"], ["packages/*", "nowhere/*", "docs"], ["packages/*", "tools/*", "tools/plain", "tools/cli"], ["packages/a", "packages/empty", "packages/missing"], ["tools/*", "packages/*", "tools/*"]]) {
                const files = { ...base, "pnpm-workspace.yaml": `packages:\n${patterns.map((pattern) => `  - "${pattern}"\n`).join("")}` };

                for (const flags of [["--dead-workspace-patterns"], ["--missing-package-json"], ["--dead-workspace-patterns", "--missing-package-json", "--format", "json"], ["--missing-package-json", "--format", "minimal"]]) {
                    harness.expectParity(files, flags);
                }
            }
        });

        it("reads an ignored workspace directory like Node does", () => {
            expect.hasAssertions();

            harness.expectParity({ ...clean(), ".gitignore": "packages/b\n" }, []);
            harness.expectParity({ ...clean(), ".gitignore": "packages/b\n" }, ["--dead-workspace-patterns", "--missing-package-json"]);
        });

        it("finds a dependency block that is empty", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ...project("a", { dependencies: {}, optionalDependencies: null, peerDependencies: { x: "1" } }) }, { dependencies: {}, devDependencies: {} });

            harness.expectParity(files, ["--empty-deps"]);
            harness.expectParity(files, ["--empty-deps", "--format", "json"]);
            harness.expectParity(files, ["--empty-deps", "--format", "minimal"]);
        });

        it("skips values that are not strings and blocks that are not objects", () => {
            expect.hasAssertions();

            harness.expectParity(workspaceFiles({ ...project("a", { dependencies: { b: 1, c: null, d: ["x"], e: "ok" }, devDependencies: "x", peerDependencies: 5 }), ...project("b") }, { dependencies: { a: true } }), []);
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("prints what Node does under %j", (...[environment]: Record<string, string>[]) => {
            expect.hasAssertions();

            harness.expectParity(findings(), [], environment);
            harness.expectParity(clean(), [], environment);
        });
    });

    describe("shapes handed to Node", () => {
        it.each([
            [["--fix"]],
            [["--workspace-protocol", "--fix"]],
            [["--ban", "left-pad"]],
            [["--pin", "react@18.2.0"]],
            [["--workspace-versions", "--resolve", "catalog"]],
            [["--workspace-versions", "--dep", "react"]],
            [["--fix-specifier", "workspace:^"]],
            [["--propose-min", "2"]],
            [["--format", "xml"]],
            [["--format"]],
            [["--format", "json", "--format", "human"]],
            [["--quiet", "--quiet"]],
            [["--root-private", "--root-private"]],
            [["--banned-deps"]],
            [["extra"]],
            [["--unknown"]],
            [["--no-quiet"]],
        ])("`deps %s` is declined", (args: string[]) => {
            expect.hasAssertions();

            harness.expectDelegation(clean(), args);
        });

        it("a drift in a version, an engine or a packageManager is declined", () => {
            expect.hasAssertions();

            const drift = (a: Record<string, unknown>, b: Record<string, unknown>): Files => workspaceFiles({ ...project("a", a), ...project("b", b) });

            harness.expectDelegation(drift({ dependencies: { lodash: "^4" } }, { devDependencies: { lodash: "^3" } }), []);
            harness.expectDelegation(drift({ dependencies: { lodash: "^4" } }, { devDependencies: { lodash: "^3" } }), ["--workspace-versions"]);
            harness.expectDelegation(drift({ engines: { node: ">=20" } }, { engines: { node: ">=18" } }), []);
            harness.expectDelegation(drift({ volta: { node: "20.0.0" } }, { volta: { node: "18.0.0" } }), ["--custom-types"]);
            harness.expectDelegation(drift({ packageManager: "pnpm@9.0.0" }, { packageManager: "pnpm@10.0.0+sha1.abc" }), []);
            harness.expectDelegation(drift({ devEngines: { runtime: { name: "node", version: "20" } } }, {}), []);
        });

        it("agreement in a version, an engine or a packageManager is answered", () => {
            expect.hasAssertions();

            const same = (a: Record<string, unknown>, b: Record<string, unknown>): Files => workspaceFiles({ ...project("a", a), ...project("b", b) });

            harness.expectParity(same({ dependencies: { lodash: "^4" } }, { devDependencies: { lodash: "^4" }, peerDependencies: { lodash: "workspace:*", other: "catalog:" } }), []);
            harness.expectParity(same({ engines: { node: ">=20" }, volta: { extends: "../x", node: "20.0.0" } }, { engines: { node: ">=20", npm: ">=9" }, volta: { extends: "../y", node: "20.0.0" } }), []);
            harness.expectParity(same({ packageManager: "pnpm@10.0.0" }, { packageManager: "pnpm@10.0.0+sha1.abc" }), []);
            harness.expectParity(same({ packageManager: "pnpm@10.0.0" }, { packageManager: "yarn@4.0.0" }), []);
        });

        it("a drift in a lint that is not selected does not matter", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ...project("a", { dependencies: { lodash: "^4" } }), ...project("b", { devDependencies: { lodash: "^3" } }) });

            harness.expectParity(files, ["--empty-deps"]);
            harness.expectParity(files, ["--root-private", "--format", "json"]);
        });

        it("a run outside CI is declined", () => {
            expect.hasAssertions();

            // Node prints a random, rate-limited tip outside CI; VIS_CLI_TEST keeps it out of the comparison.
            harness.expectDelegation(clean(), [], { VIS_CLI_TEST: "1" }, false);
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("%j is declined", (environment) => {
            expect.hasAssertions();

            harness.expectDelegation(clean(), [], environment);
        });

        it.each([{ NODE_ENV: "test" }, { NODE_ENV: "debug" }, { DEBUG: "vis" }, { PAIL_LOG_LEVEL: "debug" }, { CEREBRO_OUTPUT_LEVEL: "4" }])("the output setting %j is declined", (environment) => {
            expect.hasAssertions();

            harness.expectDelegation(clean(), [], environment);
        });

        it("a colour flag is declined for the human format", () => {
            expect.hasAssertions();

            harness.expectDelegation(clean(), ["--no-color"]);
        });

        it("a workspace Node reads differently is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...clean(), "package.json": json({ name: "root", private: true, workspaces: ["packages/*"] }) }, []);
            harness.expectDelegation({ ...clean(), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\noverrides:\n  lodash: ^4\n' }, []);
            harness.expectDelegation({ ...clean(), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "!packages/b"\n' }, []);
            harness.expectDelegation({ ...clean(), "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - x\n" }, []);
            harness.expectDelegation({ ...clean(), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n"overrides":\n  lodash: ^4\n' }, []);
            harness.expectDelegation({ ...clean(), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\noverrides : { lodash: ^4 }\n' }, []);
            harness.expectDelegation({ ...clean(), "aube-workspace.yaml": 'packages:\n  - "packages/*"\n' }, []);
            harness.expectDelegation({ ...clean(), "packages/a/package.json": "{ not json" }, []);
            harness.expectDelegation({ ...clean(), "packages/a/package.json": '{ "name": "a", // note\n "dependencies": {} }\n' }, []);
            harness.expectDelegation({ ...clean(), "packages/a/package.json": json({ dependencies: ["x"], name: "a" }) }, []);
            harness.expectDelegation({ ...clean(), "packages/a/package.json": json({ dependencies: { 1: "x" }, name: "a" }) }, []);
            harness.expectDelegation({ ...clean(), "packages/a/package.json": "[]" }, []);
            harness.expectDelegation({ ...clean(), "package.json": json({ dependencies: ["x"], name: "root", private: true }) }, ["--root-deps"]);
            harness.expectDelegation({ ...clean(), "packages/a/package.json": json({ devDependencies: [], name: "a" }) }, []);
            harness.expectDelegation({ ...clean(), "vis.config.ts": "export default {};\n" }, []);
        });

        it("a name or specifier with a control character is declined", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ...project("a", { dependencies: { b: "1\n2" } }), ...project("b") });

            harness.expectDelegation(files, [], { FORCE_COLOR: "1" });
            harness.expectDelegation(workspaceFiles({ ...project("a", { dependencies: { "x\ny": "1" } }) }), ["--format", "json"]);
        });

        it("a pattern the directory listing does not reproduce is declined for the lints that read it", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...clean(), "pnpm-workspace.yaml": 'packages:\n  - "packages/**"\n' }, ["--missing-package-json"]);
            harness.expectDelegation({ ...clean(), "pnpm-workspace.yaml": 'packages:\n  - "packages/{a,b}"\n' }, ["--dead-workspace-patterns"]);
            harness.expectDelegation({ ...clean(), "packages/c/Cargo.toml": "[package]\nname = \"c\"\n", "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n' }, ["--missing-package-json"]);
        });

        it("a workspace that is not rooted at the working directory is declined", () => {
            expect.hasAssertions();

            const [nodeRoot, nativeRoot] = harness.pair(clean());
            const directory = "packages/a";

            expect(harness.runNative([], join(nativeRoot, directory)).status).toBe(70);
            expect(harness.runNode([], join(nodeRoot, directory)).status).toBe(0);
        });
    });
});
