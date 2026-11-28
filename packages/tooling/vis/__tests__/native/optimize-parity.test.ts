/* eslint-disable perfectionist/sort-objects -- the key order of the fixtures is what the tests are about */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, packageRoot, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis optimize` exists twice: the Node handler (`src/commands/optimize/handler.ts`) and the native report
 * (`native/cli/src/optimize/`). For every non-interactive shape the native path accepts it must print the same text
 * with the same exit status as Node, and every shape it declines must be handed to Node before anything is printed
 * (see `workspace-parity-harness.ts` for how both are proved).
 */

interface Tables {
    e18e: unknown[];
    socket: [string, string, string, string][];
}

const tables = JSON.parse(readFileSync(join(packageRoot, "native", "cli", "src", "optimize-tables.json"), "utf8")) as Tables;
const packages = tables.socket.map(([name]) => name);
const harness = new Harness(["optimize"]);

/** `count` dependency entries starting at `from` in the socket table. */
const deps = (from: number, count: number): Record<string, string> => Object.fromEntries(packages.slice(from, from + count).map((name) => [name, "1.0.0"]));

const project = (name: string, manifest: Record<string, unknown>): Files => {
    return { [`packages/${name}/package.json`]: json({ name, ...manifest }) };
};

/** An installed `@visulima/vis` that exports a `defineConfig`, so a config that imports it from the config module loads. */
const VIS_CONFIG_MODULE: Files = {
    "node_modules/@visulima/vis/dist/config.js": "export const defineConfig = (config) => config;\n",
    "node_modules/@visulima/vis/package.json": json({ exports: { "./config": { default: "./dist/config.js" } }, name: "@visulima/vis", type: "module", version: "1.0.0" }),
};

interface ConfigCase {
    files: Files;
    label: string;
}

const config = (label: string, source: string, name = "vis.config.ts"): ConfigCase => {
    return { files: { [name]: source }, label };
};

/** Configs Node loads without a word, whatever they hold: the report does not read them. */
const ACCEPTED_CONFIGS: ConfigCase[] = [
    config("an empty config", "export default {};\n"),
    config("a module config", "export default { cache: { enabled: true } };\n", "vis.config.mjs"),
    config("a plain script config", "export default { cache: { enabled: true } };\n", "vis.config.js"),
    config("a typed config", "export default { cache: {} };\n", "vis.config.mts"),
    config("keys that mean nothing", 'export default { nope: 1, update: 5, plugins: [{ name: "x" }], sponsor: { enabled: false } };\n'),
    config("an install backend the binary knows", 'export default { install: { backend: "npm" } };\n'),
    config("a security block, which only the package-manager commands read", 'export default { security: { allowBuilds: { esbuild: true }, policies: { installScripts: { strict: false } } } };\n'),
    config("a security value of another type", "export default { security: 5 };\n"),
    config("tasks with lists", 'export default { tasks: { build: { dependsOn: ["^build"], inputs: ["@inherit", "src/**"], outputs: "dist" }, test: null } };\n'),
    config("a JSON config, which Node does not load", '{ "runtime": "bun", "targetDefaults": {} }\n', "vis.config.json"),
    { files: { "vis.config.json": "{ not json", "vis.config.ts": "export default {};\n" }, label: "a JSON config beside a script config" },
    // Node loads the first script config in its own order (`.ts` before `.mjs`) and never reads the other.
    { files: { "vis.config.mjs": "export default makeConfig();\n", "vis.config.ts": "export default {};\n" }, label: "two script configs" },
];

/** Configs Node has to evaluate, fails on or prints about while it loads them: the binary leaves them to it. */
const DECLINED_CONFIGS: ConfigCase[] = [
    config("a call", "export default makeConfig();\n"),
    config("a `defineConfig` import that does not resolve", 'import { defineConfig } from "@visulima/vis/config";\nexport default defineConfig({});\n'),
    config("an import", 'import { x } from "./other";\nexport default { x };\n'),
    config("an unresolvable extends", 'export default { extends: "./nope.ts" };\n'),
    config("a version constraint it does not satisfy", 'export default { versionConstraint: "999.0.0" };\n'),
    config("a removed key", "export default { targetDefaults: {} };\n"),
    config("a task list that is a number", "export default { tasks: { build: { inputs: 5 } } };\n"),
    config("a task list that is null", "export default { tasks: { build: { dependsOn: null } } };\n"),
    config("an install block Node runs", "export default { install: { corepack: true } };\n"),
    config("ESM syntax in a CommonJS file", "export default {};\n", "vis.config.cjs"),
    config("an invalid JSON config", "{ not json", "vis.config.json"),
];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis optimize: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-optimize-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    const FLAG_SETS: string[][] = [
        [],
        ["--dry-run"],
        ["-d"],
        ["--format", "json"],
        ["--format=json"],
        ["--format", "table"],
        ["--format=table", "--dry-run"],
        ["--format", "json", "--dry-run"],
        ["--pin"],
        ["--pin", "--format", "json"],
        ["--prod"],
        ["--prod", "--pin", "--dry-run"],
        ["--no-install"],
        ["--no-install", "--format", "json", "--prod"],
    ];

    const rich = (): Files =>
        workspaceFiles({
            ...project("a", { dependencies: deps(0, 6), devDependencies: deps(6, 5) }),
            ...project("b", { peerDependencies: deps(11, 4), optionalDependencies: deps(15, 3) }),
            // Names the e18e manifests know, so the report has e18e entries as well as socket ones.
            ...project("c", { dependencies: { "a-sync-waterfall": "1", "@cypress/request": "1", "arr-diff": "1", left: "1", ...deps(0, 2) } }),
        }, { dependencies: deps(20, 3), devDependencies: deps(23, 2) });

    describe("accepted shapes", () => {
        it.each(FLAG_SETS)("`optimize %s` prints what Node does", (...flags: string[]) => {
            expect.hasAssertions();

            harness.expectParity(rich(), flags);
        });

        it("reports the packages of every workspace project, and says how many there are", () => {
            expect.hasAssertions();

            const result = harness.expectParity(rich(), []);

            expect(result.stdout).toContain("Scanned 3 workspace packages.");
            expect(result.stdout).toContain("Socket.dev overrides");
        });

        it("covers every entry of the socket table, in table order", () => {
            expect.hasAssertions();

            const everything = workspaceFiles({}, { dependencies: Object.fromEntries(packages.map((name) => [name, "1"])) });

            harness.expectParity(everything, []);
            harness.expectParity(everything, ["--format", "json"]);
            harness.expectParity(everything, ["--format", "json", "--pin"]);
            harness.expectParity(everything, ["--pin", "--dry-run"]);
        });

        it("says so when nothing can be optimized", () => {
            expect.hasAssertions();

            const quiet = workspaceFiles(project("a", { dependencies: { left: "1" } }), { dependencies: { right: "1" } });
            const text = harness.expectParity(quiet, []);

            expect(text.stdout).toContain("No optimizations found for your dependencies.");

            harness.expectParity(quiet, ["--format", "json"]);
        });

        it("treats a workspace with no projects like Node does", () => {
            expect.hasAssertions();

            harness.expectParity({ ...workspaceFiles({}, { dependencies: deps(0, 4) }), "pnpm-workspace.yaml": 'packages:\n  - "nothing/*"\n' }, []);
            harness.expectParity({ ...workspaceFiles({}, { dependencies: deps(0, 4) }), "pnpm-workspace.yaml": 'packages:\n  - "nothing"\n' }, []);
        });

        it("reads the version the root pins", () => {
            expect.hasAssertions();

            for (const pin of ["pnpm@9.1.0", "pnpm@9.1.0+sha512.abcdef", "pnpm@10.0.0-beta.1", "pnpm@"]) {
                const files = workspaceFiles(project("a", { dependencies: deps(0, 2) }), { packageManager: pin });

                expect(harness.expectParity(files, []).stdout).toContain(`Detected pnpm v${pin.split("@")[1]?.split("+")[0] || "latest"}.`);
            }
        });

        it("finds packages the lockfile names that no manifest does", () => {
            expect.hasAssertions();

            const [first, second, third, fourth, fifth, sixth] = packages as [string, string, string, string, string, string];
            const lockfile = [
                "lockfileVersion: 9",
                "importers:",
                "  .:",
                "    dependencies:",
                `      ${first}:`,
                "        specifier: 1.0.0",
                "packages:",
                `  /${second}@1.0.0:`,
                `  '${third}':`,
                `  "${fourth}":`,
                `  x${fifth}@1.0.0:`,
                `  ${sixth}-extra@1.0.0:`,
                `  other: ${packages[6]}@1.0.0`,
                `\u00A0${packages[7]}@2`,
                "",
            ].join("\n");

            const files = { ...workspaceFiles(project("a", { dependencies: { left: "1" } })), "pnpm-lock.yaml": lockfile };

            const result = harness.expectParity(files, []);

            expect(result.stdout).toContain(first);
            expect(result.stdout).not.toContain(`  ${fifth} →`);

            harness.expectParity(files, ["--prod", "--format", "json"]);
        });

        it("reads a lockfile that is not UTF-8 the way Node does", () => {
            expect.hasAssertions();

            const bytes = Buffer.concat([Buffer.from(`lockfileVersion: 9\npackages:\n  /${packages[0]}@1.0.0:\n  `), Buffer.from([0xff, 0xfe]), Buffer.from(`${packages[1]}@1:\n`)]);

            harness.expectParity({ ...workspaceFiles(project("a", {})), "pnpm-lock.yaml": bytes }, []);
        });

        it("resolves workspace patterns the way Node does", () => {
            expect.hasAssertions();

            const files: Files = {
                ...workspaceFiles({
                    ...project("a", { dependencies: deps(0, 2) }),
                    "packages/no-manifest/readme.md": "x",
                    "tools/one/package.json": json({ name: "one", dependencies: deps(2, 2) }),
                    "tools/two/deep/package.json": json({ name: "two", dependencies: deps(4, 2) }),
                    "apps/web/package.json": json({ name: "web", dependencies: deps(6, 2) }),
                    "ignored/x/package.json": json({ name: "x", dependencies: deps(8, 2) }),
                    "node_modules/hidden/package.json": json({ name: "hidden", dependencies: deps(10, 2) }),
                }),
                ".gitignore": "ignored\n# comment\n\n",
                "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - tools/**\n  - \'apps/*\'\n  - ignored/*\n  - packages/a\n',
            };

            harness.expectParity(files, []);
            harness.expectParity(files, ["--format", "json"]);
        });

        it("reads dependency maps like Node: nulls, empty values and every kind of map", () => {
            expect.hasAssertions();

            harness.expectParity(workspaceFiles({
                ...project("nulls", { dependencies: null, devDependencies: 0, peerDependencies: "", optionalDependencies: false }),
                ...project("empty", { dependencies: {}, devDependencies: {} }),
                ...project("ok", { dependencies: deps(0, 2) }),
                "packages/not-an-object/package.json": "[1, 2]\n",
                "packages/null-file/package.json": "null\n",
                "packages/missing-file-entry/readme.md": "x",
            }), []);
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("prints what Node does under %j", (...[environment]: Record<string, string>[]) => {
            expect.hasAssertions();

            harness.expectParity(rich(), [], environment);
            harness.expectParity(rich(), ["--format", "json", "--dry-run"], environment);
        });

        describe("from a directory below the root", () => {
            const below: Files = { ...rich(), "packages/a/src/deep/readme.md": "x", "packages/a/vis.config.ts": "export default { nope: 1 };\n" };

            it.each([["packages/a"], ["packages/a/src"], ["packages/a/src/deep"], ["packages/b"], ["packages/no-manifest"]])("`optimize` from %s prints what Node does", (directory: string) => {
                expect.hasAssertions();

                const files = { ...below, "packages/no-manifest/readme.md": "x" };

                expect(harness.expectParity(files, [], {}, directory).stdout).toContain("Scanned 3 workspace packages.");
                harness.expectParity(files, ["--format", "json", "--prod"], {}, directory);
                harness.expectParity(files, ["--pin", "--dry-run"], {}, directory);
            });

            it("reads the root's config, not the one of the project directory", () => {
                expect.hasAssertions();

                harness.expectParity({ ...below, "vis.config.ts": "export default { security: { allowBuilds: { esbuild: true } } };\n" }, [], {}, "packages/a/src");
            });

            it("reads the root a yaml names, with a pin and a lockfile of its own", () => {
                expect.hasAssertions();

                harness.expectParity({ ...below, "package.json": json({ name: "root", packageManager: "pnpm@9.1.0", dependencies: deps(0, 3) }) }, [], {}, "packages/a/src/deep");
            });

            it("accepts an inherited root that names the root", () => {
                expect.hasAssertions();

                const [nodeRoot, nativeRoot] = harness.pair(below);
                const directory = "packages/a/src";
                const node = harness.runNode([], join(nodeRoot, directory), { VIS_MONOREPO_ROOT: nodeRoot });
                const native = harness.runNative([], join(nativeRoot, directory), { VIS_MONOREPO_ROOT: nativeRoot });

                expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
                expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
            });
        });

        describe("with a literal vis.config", () => {
            it.each(ACCEPTED_CONFIGS)("$label is read like Node does", ({ files }) => {
                expect.hasAssertions();

                harness.expectParity({ ...rich(), ...files }, []);
                harness.expectParity({ ...rich(), ...files }, ["--format", "json", "--dry-run"]);
            });

            it("reads the config `vis init` writes: a `defineConfig` call from the vis config module", () => {
                expect.hasAssertions();

                const files: Files = {
                    ...VIS_CONFIG_MODULE,
                    "vis.config.ts": 'import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ security: { allowBuilds: { esbuild: true } } });\n',
                };

                expect(harness.expectParity({ ...rich(), ...files }, []).stdout).toContain("Scanned 3 workspace packages.");
            });
        });

        it("wraps long lines at the width pail uses", () => {
            expect.hasAssertions();

            for (const columns of ["40", "45", "60", "79", "80", "100"]) {
                harness.expectParity(rich(), [], { COLUMNS: columns });
            }
        });
    });

    describe("shapes handed to Node", () => {
        it.each([
            [["--json"]],
            [["--format", "xml"]],
            [["--format"]],
            [["--dry-run", "--dry-run"]],
            [["--dry-run", "-d"]],
            [["--pin=true"]],
            [["--unknown"]],
            [["somepackage"]],
            [["--format", "json", "--format", "table"]],
        ])("`optimize %s` is declined", (args: string[]) => {
            expect.hasAssertions();

            harness.expectDelegation(rich(), args);
        });

        it("a run outside CI is declined", () => {
            expect.hasAssertions();

            // Node prints a random, rate-limited tip outside CI; VIS_CLI_TEST keeps it out of the comparison.
            harness.expectDelegation(rich(), [], { VIS_CLI_TEST: "1" }, false);
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("%j is declined", (environment) => {
            expect.hasAssertions();

            harness.expectDelegation(rich(), [], environment);
        });

        it.each([{ NODE_ENV: "test" }, { NODE_ENV: "debug" }, { DEBUG: "vis" }, { PAIL_LOG_LEVEL: "debug" }, { CEREBRO_OUTPUT_LEVEL: "4" }, { COLUMNS: "20" }, { TERM: "xterm-ghostty-wide" }])(
            "the output setting %j is declined",
            (environment) => {
                expect.hasAssertions();

                harness.expectDelegation(rich(), [], environment);
            },
        );

        it("a colour flag is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation(rich(), ["--no-color"]);
        });

        it("another package manager is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation(workspaceFiles(project("a", { dependencies: deps(0, 2) }), { packageManager: "npm@10.0.0" }), []);
        });

        it("a workspace with exclusions is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "!packages/b"\n' }, []);
        });

        it("a workspace without a pattern list is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - x\n" }, []);
        });

        it.each(DECLINED_CONFIGS)("a vis.config with $label is declined", ({ files }) => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), ...files }, []);
        });

        it("a vis.config above the root is declined", () => {
            expect.hasAssertions();

            // Node loads the config of the workspace root only, so the config of the parent directory changes nothing for it.
            const inner = Object.fromEntries(Object.entries(rich()).map(([name, content]) => [`inner/${name}`, content]));
            const [nodeRoot, nativeRoot] = harness.pair({ ...inner, "vis.config.ts": "export default {};\n" });
            const native = harness.runNative([], join(nativeRoot, "inner"));

            expect(native.status).toBe(70);
            expect(native.stdout).toBe("");
            expect(harness.runNode([], join(nodeRoot, "inner")).status).toBe(0);
        });

        it("a manifest that is not strict JSON is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), "packages/a/package.json": `{ "name": "a", // note\n "dependencies": { "${packages[0]}": "1" } }\n` }, []);
            harness.expectDelegation({ ...rich(), "packages/a/package.json": "{ not json" }, []);
        });

        it("a dependency map JavaScript reads as something else is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), "packages/a/package.json": json({ name: "a", dependencies: "abc" }) }, []);
            harness.expectDelegation({ ...rich(), "packages/a/package.json": json({ name: "a", dependencies: [packages[0]] }) }, []);
            harness.expectDelegation({ ...rich(), "packages/a/package.json": json({ name: "a", dependencies: 5 }) }, []);
        });

        it("a pattern outside the supported shapes is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), "pnpm-workspace.yaml": 'packages:\n  - "packages/{a,b}"\n' }, []);
            harness.expectDelegation({ ...rich(), ".gitignore": "!kept\n" }, []);
            harness.expectDelegation({ ...rich(), ".gitignore": "**/dist\n" }, []);
        });

        it("a project directory that is itself a workspace root is declined", () => {
            expect.hasAssertions();

            // Node's search stops at the nearest lockfile or `packageManager` pin, which here is not a workspace root.
            for (const marker of [{ "packages/a/yarn.lock": "# yarn lockfile v1\n" }, { "packages/a/pnpm-lock.yaml": "lockfileVersion: 9\n" }, { "packages/a/package.json": json({ name: "a", packageManager: "pnpm@9.1.0" }) }]) {
                harness.expectDelegation({ ...rich(), ...marker }, [], {}, true, "packages/a");
            }
        });

        it("a directory below a lerna or turbo root is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), "turbo.json": "{}\n" }, [], {}, true, "packages/a");
            harness.expectDelegation({ ...rich(), "lerna.json": json({ packages: ["packages/*"] }) }, [], {}, true, "packages/a");
        });

        it("a run from a project directory is declined when the root config is", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), "vis.config.ts": 'export default { extends: "./nope.ts" };\n' }, [], {}, true, "packages/a");
        });

        it("an inherited root for another directory is declined", () => {
            expect.hasAssertions();

            // Node computes the root again and ignores it, so the delegated run prints what the root run does.
            harness.expectDelegation(rich(), [], { VIS_MONOREPO_ROOT: "/elsewhere" }, true, "packages/a");
            harness.expectDelegation(rich(), [], { VIS_MONOREPO_ROOT: "/elsewhere" });
        });
    });
});
