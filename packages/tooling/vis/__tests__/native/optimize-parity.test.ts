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
            // Names the e18e manifests know: Node reports none of them (see `optimize-tables.test.ts`), and so must the binary.
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

        it("a vis.config is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...rich(), "vis.config.ts": "export default {};\n" }, []);
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
            harness.expectDelegation({ ...rich(), ".gitignore": "*.log\n" }, []);
        });

        it("a workspace that is not rooted at the working directory is declined", () => {
            expect.hasAssertions();

            const [nodeRoot, nativeRoot] = harness.pair(rich());
            const directory = "packages/a";

            expect(harness.runNative([], join(nativeRoot, directory)).status).toBe(70);
            expect(harness.runNode([], join(nodeRoot, directory)).status).toBe(0);
        });
    });
});
