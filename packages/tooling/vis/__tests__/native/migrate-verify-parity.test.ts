import { chmodSync, existsSync, mkdtempSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis migrate verify` exists twice: the Node handler (`src/commands/migrate/verify.ts`) and the native one
 * (`native/cli/src/migrate/verify.rs`). The handler reads files and writes none, and prints through the plain `console` of
 * the cerebro toolbox (not through pail), so the output has no colour, width or clock in it: a clean run is one line on
 * stdout, a dirty run is a block on stderr with exit status 1. Every shape the native side cannot reproduce exactly is handed
 * to Node before anything is printed (see `workspace-parity-harness.ts` for how both are proved), and every run compares
 * the output, the exit status and every file with its bytes, so a write would show.
 */

const harness = new Harness(["migrate", "verify"]);

const CLEAN = "\u2713 No unmigrated gitleaks/secretlint/sherif/syncpack references found.\n";

/** A workspace whose root `package.json` is `manifest` (a name and the private flag come first). */
const workspace = (extra: Files = {}, manifest: Record<string, unknown> = {}): Files => workspaceFiles(extra, manifest);

/** The same with a `package.json` written verbatim. */
const rawManifest = (text: string, extra: Files = {}): Files => workspaceFiles({ ...extra, "package.json": text });

/** `@visulima/vis/config` resolvable from the workspace, so a config that wraps itself in `defineConfig` loads in Node. */
const VIS_CONFIG_MODULE: Files = {
    "node_modules/@visulima/vis/config.mjs": "export const defineConfig = (config) => config;\n",
    "node_modules/@visulima/vis/package.json": json({ exports: { "./config": "./config.mjs" }, name: "@visulima/vis", type: "module", version: "0.0.0" }),
};

/** What `vis init` writes: the secure defaults, which the native side must not hand to Node for. */
const GENERATED_CONFIG = `import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ security: { policies: { installScripts: { allow: {} }, firstSeen: { minutes: 2880 } } } });\n`;

/** Mixed case, digits, a dot file, a non-ASCII name and two files no workflow rule takes; no two names differ only in case, since a case-insensitive file system would merge them. */
const WORKFLOW_NAMES = ["b.yml", "Ab.yml", "a.yml", "B.yaml", "10.yml", "2.yml", "1.yml", "Z.yml", "_x.yml", "\u00E9.yml", "ci.YML", "aa.yml", "zz.yml", "release.yaml", "Lint.yml", ".hidden.yml", "notes.txt"];

/** The names in the order `readdirSync` lists them: libuv sorts them with `strcmp`, so by byte. */
const byteOrder = (names: string[]): string[] => names.toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

/** The order the file system itself lists `names` in (`opendir` does not sort), created in reverse byte order. */
const rawOrder = (names: string[]): string[] => {
    const directory = mkdtempSync(join(tmpdir(), "vis-verify-order-"));

    for (const name of byteOrder(names).toReversed()) {
        writeFileSync(join(directory, name), "");
    }

    const handle = opendirSync(directory);
    const listed: string[] = [];

    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        listed.push(entry.name);
    }

    handle.closeSync();
    rmSync(directory, { force: true, recursive: true });

    return listed;
};

/** Whether this file system lists the workflow names in an order other than byte order, so the case cannot pass by accident. */
const rawOrderDiscriminates = JSON.stringify(rawOrder(WORKFLOW_NAMES)) !== JSON.stringify(byteOrder(WORKFLOW_NAMES));

/** The `[kind]` lines of a report, in order. */
const reportLines = (stderr: string): string[] => stderr.split("\n").filter((line) => line.startsWith("  ["));

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis migrate verify: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-migrate-verify-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe("a clean workspace", () => {
        it("prints one line on stdout and exits 0", () => {
            expect.hasAssertions();

            const result = harness.expectParity(workspace(), []);

            expect(result.stdout).toBe(CLEAN);
            expect(result.stderr).toBe("");
            expect(result.status).toBe(0);
        });

        it("accepts a workspace with no package.json at all", () => {
            expect.hasAssertions();

            const result = harness.expectParity({ "pnpm-lock.yaml": "lockfileVersion: 9\n", "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n' }, []);

            expect(result.stdout).toBe(CLEAN);
        });

        it("ignores everything that merely resembles a tool", () => {
            expect.hasAssertions();

            const result = harness.expectParity(
                workspace(
                    { ".github/workflows/ci.yml": "run: pnpm test\n", ".husky/pre-commit": "pnpm lint-staged\n" },
                    {
                        devDependencies: { "@scope/secretlint": "1", "gitleaks-action": "1", "secretlint-rule": "1", "sherif-config": "1", "syncpack-plugin": "1" },
                        scripts: { build: "tsc", digits: "secretlint2", lint: "oxlint", sync: "gitleaksx --help", tool: "xsherif", underscore: "_syncpack_" },
                    },
                ),
                [],
            );

            expect(result.stdout).toBe(CLEAN);
        });
    });

    describe("each kind of finding", () => {
        it.each(["gitleaks", "secretlint", "syncpack", "sherif"])("reports a script that runs %s", (tool: string) => {
            expect.hasAssertions();

            const result = harness.expectParity(workspace({}, { scripts: { build: "tsc", check: `${tool} --fix .` } }), []);

            expect(result.stderr).toContain(`Script "check" still invokes ${tool}: ${tool} --fix .`);
            expect(result.stdout).toBe("");
            expect(result.status).toBe(1);
        });

        it.each(["gitleaks", "@gitleaks/cli", "secretlint", "@secretlint/core", "@secretlint/secretlint-rule-preset-recommend", "syncpack", "sherif"])(
            "reports the devDependency %s",
            (name: string) => {
                expect.hasAssertions();

                expect(harness.expectParity(workspace({}, { devDependencies: { [name]: "^1.0.0" } }), []).stderr).toContain(`devDependency \`${name}\` is still installed`);
            },
        );

        it("does not read the dependencies of other kinds", () => {
            expect.hasAssertions();

            const result = harness.expectParity(workspace({}, { dependencies: { syncpack: "1" }, optionalDependencies: { sherif: "1" }, peerDependencies: { gitleaks: "1" } }), []);

            expect(result.stdout).toBe(CLEAN);
        });

        it.each([
            [{ keep: true }],
            ["on"],
            [1],
            [[]],
            [{}],
        ])("reports a truthy sherif block (%j)", (block: unknown) => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({}, { sherif: block }), []).stderr).toContain("`sherif` config block still present in package.json");
        });

        it.each([[false], [0], [""], [null]])("ignores a falsy sherif block (%j)", (block: unknown) => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({}, { sherif: block }), []).stdout).toBe(CLEAN);
        });

        it.each([".husky/pre-commit", ".vis/hooks/pre-commit", ".git/hooks/pre-commit"])("reports each tool a hook at %s runs", (hook: string) => {
            expect.hasAssertions();

            const result = harness.expectParity(workspace({ [hook]: "#!/bin/sh\ngitleaks protect --staged\nsecretlint .\nsyncpack lint\nsherif\n" }), []);

            expect(reportLines(result.stderr)).toHaveLength(4);
        });

        it("reports a hook with Windows line endings", () => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({ ".husky/pre-commit": "#!/bin/sh\r\ngitleaks protect\r\n" }), []).stderr).toContain("gitleaks invocation still present in hook");
        });

        it.each([...["", ".json", ".js", ".mjs", ".cjs", ".yml", ".yaml"].map((extension) => `.secretlintrc${extension}`)])("reports the secretlint config %s", (name: string) => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({ [name]: "{}\n" }), []).stderr).toContain(`[config] ${name} \u2014 secretlint config should be removed after migration`);
        });

        it.each([
            ".syncpackrc",
            ".syncpackrc.json",
            ".syncpackrc.yaml",
            ".syncpackrc.yml",
            ".syncpackrc.cjs",
            ".syncpackrc.js",
            ".syncpackrc.mjs",
            ".syncpackrc.ts",
            "syncpack.config.cjs",
            "syncpack.config.js",
            "syncpack.config.mjs",
            "syncpack.config.ts",
        ])("reports the syncpack config %s", (name: string) => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({ [name]: "" }), []).stderr).toContain(`[config] ${name} \u2014 syncpack config should be removed after migration`);
        });

        it("reports a config file that is a directory", () => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({ ".secretlintrc.json/keep": "" }), []).stderr).toContain("[config] .secretlintrc.json");
        });

        it.each([".gitlab-ci.yml", ".circleci/config.yml", ".woodpecker.yml", ".drone.yml", ".github/workflows/ci.yml", ".github/workflows/ci.yaml"])(
            "reports syncpack and sherif in the CI file %s",
            (name: string) => {
                expect.hasAssertions();

                const result = harness.expectParity(workspace({ [name]: "steps:\n  - run: syncpack lint\n  - run: sherif\n" }), []);

                expect(reportLines(result.stderr)).toStrictEqual([`  [ci] ${name} \u2014 syncpack invocation still present in CI`, `  [ci] ${name} \u2014 sherif invocation still present in CI`]);
            },
        );

        it("does not look for gitleaks or secretlint in CI files", () => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({ ".github/workflows/ci.yml": "run: gitleaks detect\nrun: secretlint .\n" }), []).stdout).toBe(CLEAN);
        });

        it("ignores a workflow file with another extension, and a workflows directory that is a file", () => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({ ".github/workflows/ci.txt": "sherif\n", ".github/workflows/ci.YML": "sherif\n" }), []).stdout).toBe(CLEAN);
            expect(harness.expectParity(workspace({ ".github/workflows": "sherif\n" }), []).stdout).toBe(CLEAN);
        });

        it("follows a workflows directory that is a link, and a workflow that is a link", () => {
            expect.hasAssertions();

            const result = harness.expectParity(
                workspace({
                    ".github/shared/broken.yml": { link: "missing.yml" },
                    ".github/shared/linked.yml": { link: "other.yml" },
                    ".github/shared/other.yml": "run: sherif\n",
                    ".github/workflows": { link: "shared" },
                }),
                [],
            );

            expect(reportLines(result.stderr)).toHaveLength(2);
        });

        it("reads a hook that is a link and skips a broken one", () => {
            expect.hasAssertions();

            harness.expectParity(workspace({ ".husky/pre-commit": { link: "real" }, ".husky/real": "gitleaks\n", ".vis/hooks/pre-commit": { link: "missing" } }), []);
        });

        it("reports syncpack in package.json catalogs", () => {
            expect.hasAssertions();

            const result = harness.expectParity(
                workspace(
                    {},
                    {
                        catalog: { syncpack: "^1.0.0" },
                        workspaces: { catalog: { syncpack: "^1.0.0" }, catalogs: { legacy: { syncpack: "^1.0.0" }, modern: { other: "1" }, third: { syncpack: "2" } }, packages: ["packages/*"] },
                    },
                ),
                [],
            );

            expect(reportLines(result.stderr)).toStrictEqual([
                "  [catalog] package.json \u2014 `syncpack` still listed in package.json#workspaces.catalog",
                "  [catalog] package.json \u2014 `syncpack` still listed in package.json#workspaces.catalogs.legacy",
                "  [catalog] package.json \u2014 `syncpack` still listed in package.json#workspaces.catalogs.third",
                "  [catalog] package.json \u2014 `syncpack` still listed in package.json#catalog",
            ]);
        });

        it.each([
            [{ workspaces: ["packages/*"] }],
            [{ workspaces: { catalog: { syncpack: 1 } } }],
            [{ workspaces: { catalog: "syncpack" } }],
            [{ workspaces: { catalog: ["syncpack"] } }],
            [{ workspaces: { catalogs: "x" } }],
            [{ workspaces: { catalogs: { a: "syncpack" } } }],
            [{ workspaces: "packages/*" }],
            [{ catalog: { syncpack: null } }],
            [{ catalog: "x" }],
            [{ catalog: ["syncpack"] }],
        ])("reads nothing from %j", (manifest: Record<string, unknown>) => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({}, manifest), []).stdout).toBe(CLEAN);
        });

        it("reads a pnpm-workspace.yaml with no mention of syncpack as clean", () => {
            expect.hasAssertions();

            const yaml = 'packages:\n  - "packages/*"\ncatalog:\n  react: ^19.0.0\ncatalogs:\n  legacy:\n    vue: ^2\n';

            expect(harness.expectParity(workspace({ "pnpm-workspace.yaml": yaml }), []).stdout).toBe(CLEAN);
        });
    });

    describe("the order of the report", () => {
        const dirty = (): Files =>
            workspace(
                {
                    ".github/workflows/ci.yml": "run: syncpack\n",
                    ".gitlab-ci.yml": "script: sherif\n",
                    ".husky/pre-commit": "gitleaks\nsyncpack\n",
                    ".secretlintrc.json": "{}",
                    ".syncpackrc": "{}",
                    "syncpack.config.js": "",
                },
                {
                    devDependencies: { "@secretlint/core": "1", gitleaks: "1", syncpack: "1" },
                    scripts: { lint: "secretlint . && sherif", scan: "gitleaks detect", sync: "syncpack list && gitleaks" },
                    sherif: {},
                    workspaces: { catalog: { syncpack: "1" } },
                },
            );

        it("scans package.json, hooks, configs, CI and catalogs in that order", () => {
            expect.hasAssertions();

            const result = harness.expectParity(dirty(), []);
            const kinds = reportLines(result.stderr).map((line) => /^ {2}\[(\w+)\]/.exec(line)?.[1]);

            expect(kinds).toStrictEqual(["script", "script", "script", "script", "script", "devDep", "devDep", "devDep", "config", "hook", "hook", "config", "config", "config", "ci", "ci", "catalog"]);
            expect(result.stderr.startsWith("Found 17 unmigrated reference(s):\n")).toBe(true);
        });

        it("tests a script for gitleaks, secretlint, syncpack and sherif in that order", () => {
            expect.hasAssertions();

            const result = harness.expectParity(workspace({}, { scripts: { all: "sherif syncpack secretlint gitleaks" } }), []);

            expect(reportLines(result.stderr).map((line) => /invokes (\w+)/.exec(line)?.[1])).toStrictEqual(["gitleaks", "secretlint", "syncpack", "sherif"]);
        });

        it("lists the workflow files in byte order, whatever order the file system holds them in", () => {
            expect.hasAssertions();

            const files = workspace(Object.fromEntries(WORKFLOW_NAMES.toReversed().map((name) => [`.github/workflows/${name}`, "run: sherif\n"])));
            const result = harness.expectParity(files, []);
            const expected = byteOrder(WORKFLOW_NAMES.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))).map((name) => `.github/workflows/${name}`);

            expect(reportLines(result.stderr).map((line) => /\[ci\] (\S+)/.exec(line)?.[1])).toStrictEqual(expected);
        });

        it.each([{ LANG: "en_US.UTF-8" }, { LC_ALL: "en_US.UTF-8" }, { LC_ALL: "de_DE.UTF-8" }, { LC_COLLATE: "en_US.UTF-8" }])("lists the workflow files in byte order under %j, whatever the locale collates them as", (locale: Record<string, string>) => {
            expect.hasAssertions();

            const files = workspace(Object.fromEntries(WORKFLOW_NAMES.toReversed().map((name) => [`.github/workflows/${name}`, "run: sherif\n"])));
            const result = harness.expectParity(files, [], locale);
            const expected = byteOrder(WORKFLOW_NAMES.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))).map((name) => `.github/workflows/${name}`);

            expect(reportLines(result.stderr).map((line) => /\[ci\] (\S+)/.exec(line)?.[1])).toStrictEqual(expected);
        });

        it.skipIf(!rawOrderDiscriminates)("uses names this file system does not list in byte order, so the order case cannot pass by accident", () => {
            expect.hasAssertions();
            expect(rawOrder(WORKFLOW_NAMES)).not.toStrictEqual(byteOrder(WORKFLOW_NAMES));
        });
    });

    describe("text copied from the workspace", () => {
        it.each([
            ["a format directive", "echo %s %d %o %j 100%% gitleaks %%"],
            ["a brace and a dollar", "gitleaks ${HOME} $(pwd) `x`"],
            ["a backslash and a quote", String.raw`gitleaks "a\b" 'c' \n \u00e9`],
            ["an escape character and a tab", "gitleaks \u001B[31mred\u001B[0m\tafter"],
            ["a line break", "gitleaks one\ntwo\r\nthree"],
            ["Unicode", "gitleaks \u00E9\u00FC \u2713 \u4E2D\u6587 \uD83D\uDE00 \u2028 \uFEFF"],
            ["a neighbouring non-ASCII letter", "\u00E9gitleaks\u00E9"],
        ])("copies %s into the message as it is", (_label: string, script: string) => {
            expect.hasAssertions();

            const result = harness.expectParity(workspace({}, { scripts: { [`name %s \u00E9 "q" \u001B`]: script } }), []);

            expect(result.status).toBe(1);
        });

        it("names a workflow file with a non-ASCII name", () => {
            expect.hasAssertions();

            expect(harness.expectParity(workspace({ ".github/workflows/\u00E9t\u00E9.yml": "run: sherif\n" }), []).stderr).toContain("[ci] .github/workflows/\u00E9t\u00E9.yml");
        });

        it("reads a hook and a CI file that are not UTF-8 text", () => {
            expect.hasAssertions();

            const bytes = Buffer.concat([Buffer.from([0xFF, 0xFE, 0x20]), Buffer.from("gitleaks "), Buffer.from([0xC3, 0x28]), Buffer.from(" sherif")]);

            harness.expectParity(workspace({ ".github/workflows/ci.yml": bytes, ".husky/pre-commit": bytes }), []);
        });

        it("reads a hook with a byte order mark and a NUL", () => {
            expect.hasAssertions();

            harness.expectParity(workspace({ ".husky/pre-commit": "\uFEFF#!/bin/sh\0gitleaks\n" }), []);
        });
    });

    describe("a package.json Node reads as no report", () => {
        it.each([
            ["a byte order mark", `\uFEFF${JSON.stringify({ scripts: { scan: "gitleaks" } })}`],
            ["a directory", undefined],
        ])("finds nothing in %s", (_label: string, text: string | undefined) => {
            expect.hasAssertions();

            const files: Files = text === undefined ? { "package.json/keep": "", "pnpm-lock.yaml": "lockfileVersion: 9\n", "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n' } : rawManifest(text);

            expect(harness.expectParity(files, []).stdout).toBe(CLEAN);
        });

        it("still reports the files around a package.json that is a directory", () => {
            expect.hasAssertions();

            const files: Files = { ".husky/pre-commit": "sherif\n", "package.json/keep": "", "pnpm-lock.yaml": "lockfileVersion: 9\n", "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n' };

            expect(harness.expectParity(files, []).stderr).toContain("[hook] .husky/pre-commit");
        });

        it.each([["{}"], ['{"scripts":null}'], ['{"scripts":{},"devDependencies":null}'], ['{"scripts":{"a":1,"b":null,"c":["gitleaks"],"d":{"x":"gitleaks"}}}'], ['{"scripts":{"a":"gitleaks"},"extra":[1,2,{"x":[]}]}']])(
            "answers %s",
            (text: string) => {
                expect.hasAssertions();

                harness.expectParity(rawManifest(text), []);
            },
        );

        it("hands over a package.json of null, where the handler reads a property of null", () => {
            expect.hasAssertions();

            harness.expectDelegation(rawManifest("null"), []);
        });
    });

    describe("the config of the workspace", () => {
        it.each([
            ["a literal with the generated security block", { ...VIS_CONFIG_MODULE, "vis.config.ts": GENERATED_CONFIG }],
            ["a plain literal", { "vis.config.ts": "export default { editorconfig: false, tasks: { build: { command: 'tsc' } } };\n" }],
            ["a literal in vis.config.mts", { "vis.config.mts": "export default { projectIgnore: ['x'] };\n" }],
            ["a literal wrapped in defineConfig", { ...VIS_CONFIG_MODULE, "vis.config.ts": 'import { defineConfig } from "@visulima/vis/config";\nexport default defineConfig({ sponsor: { enabled: false } });\n' }],
            ["a .ts and a .js config, of which Node loads the first", { "vis.config.js": "export default { runtime: 'bun' };\n", "vis.config.ts": "export default { editorconfig: false };\n" }],
        ])("answers a workspace with %s", (_label: string, extra: Files) => {
            expect.hasAssertions();

            const clean = harness.expectParity(workspace(extra), []);
            const dirty = harness.expectParity(workspace({ ...extra, ".husky/pre-commit": "sherif\n" }), []);

            expect(clean.stdout).toBe(CLEAN);
            expect(dirty.status).toBe(1);
        });
    });

    describe("the environment", () => {
        const dirtyFiles = (): Files => workspace({ ".husky/pre-commit": "gitleaks\n" }, { scripts: { scan: "secretlint ." } });

        it.each(COLOUR_ENVIRONMENTS)("prints the same bytes with %j", (environment: Record<string, string>) => {
            expect.hasAssertions();

            expect(harness.expectParity(dirtyFiles(), [], environment).stderr).toContain("Found 2 unmigrated reference(s):\n");
            expect(harness.expectParity(workspace(), [], environment).stdout).toBe(CLEAN);
        });

        it.each([{ COLUMNS: "20" }, { COLUMNS: "200" }, { COLUMNS: "0" }, { COLUMNS: "20", TERM: "dumb" }, { TERM: "xterm" }, { TERM: "screen-256color" }, { NODE_ENV: "production" }, { LANG: "C" }, { LC_ALL: "C" }, { TZ: "Asia/Tokyo" }])(
            "does not depend on %j",
            (environment: Record<string, string>) => {
                expect.hasAssertions();

                harness.expectParity(dirtyFiles(), [], environment);
                harness.expectParity(workspace(), [], environment);
            },
        );

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("hands %j to Node, which warns about the colour variables", (environment: Record<string, string>) => {
            expect.hasAssertions();

            harness.expectDelegation(dirtyFiles(), [], environment);
        });

        it.each([{ NODE_ENV: "test" }, { NODE_ENV: "debug" }, { PAIL_LOG_LEVEL: "debug" }, { DEBUG: "*" }, { CEREBRO_OUTPUT_LEVEL: "8" }])("hands %j to Node", (environment: Record<string, string>) => {
            expect.hasAssertions();

            harness.expectDelegation(dirtyFiles(), [], environment);
        });

        it("hands a run outside CI to Node, which warns that there is no vis.config", () => {
            expect.hasAssertions();

            const result = harness.expectDelegation(dirtyFiles(), [], {}, false);

            expect(result.stderr).toContain("No vis.config.ts found");
        });
    });

    describe("what is handed to Node", () => {
        it.each([["--json"], ["--debug"], ["--no-color"], ["--cwd", "packages/a"], ["extra"], ["--config", "vis.config.ts"]])("hands over `vis migrate verify %s`", (...args: string[]) => {
            expect.hasAssertions();

            harness.expectDelegation(workspace({ ".husky/pre-commit": "sherif\n", "packages/a/package.json": json({ name: "a" }) }), args);
        });

        it.each([
            ["a config only Node can evaluate", { "vis.config.ts": "export default { value: process.env.CI };\n" }],
            ["a config with a runtime", { "vis.config.ts": 'export default { runtime: "bun" };\n' }],
            ["a config that extends another", { "base.ts": "export default {};\n", "vis.config.ts": 'export default { extends: "./base.ts" };\n' }],
            ["a config with a version constraint", { "vis.config.ts": 'export default { versionConstraint: ">=0" };\n' }],
            ["a config with a removed key", { "vis.config.ts": "export default { targetDefaults: {} };\n" }],
            ["a config with another removed key", { "vis.config.ts": "export default { taskRunnerOptions: {} };\n" }],
            ["a config that does not parse", { "vis.config.ts": "export default {\n" }],
            ["a vis.config.json", { "vis.config.json": "{}" }],
            ["a Deno file", { "deno.json": "{}\n" }],
        ])("hands over a workspace with %s", (_label: string, extra: Files) => {
            expect.hasAssertions();

            harness.expectDelegation(workspace({ ...extra, ".husky/pre-commit": "sherif\n" }), []);
        });

        it.each([
            ["a duplicate key", '{"scripts":{"a":"gitleaks","a":"x"}}'],
            ["a fraction", '{"version":1.5,"scripts":{"a":"gitleaks"}}'],
            ["an exponent", '{"size":1e3,"scripts":{"a":"gitleaks"}}'],
            ["an integer-like script name", '{"scripts":{"1":"gitleaks","b":"x","0":"sherif"}}'],
            ["a __proto__ key", '{"scripts":{"__proto__":"gitleaks"}}'],
            ["a lone surrogate", String.raw`{"scripts":{"a":"\ud800 gitleaks"}}`],
            ["a top-level array", "[]"],
            ["scripts that are an array", '{"scripts":["gitleaks","sherif"]}'],
            ["scripts that are a string", '{"scripts":"gitleaks"}'],
            ["devDependencies that are an array", '{"devDependencies":["gitleaks"]}'],
            ["catalogs that are an array", '{"workspaces":{"catalogs":[{"syncpack":"1"}]}}'],
            ["invalid JSON", '{"scripts":{"a":"gitleaks"'],
            ["trailing text", '{"scripts":{"a":"gitleaks"}} x'],
            ["a comment", '{"scripts":{"a":"gitleaks"}}\n// no\n'],
        ])("hands over a package.json with %s", (_label: string, text: string) => {
            expect.hasAssertions();

            harness.expectDelegation(rawManifest(text), []);
        });

        it("hands over a package.json that is not UTF-8", () => {
            expect.hasAssertions();

            const manifest = Buffer.concat([Buffer.from('{"scripts":{"a":"gitleaks \u00FF'), Buffer.from([0xFF, 0xC3]), Buffer.from('"}}')]);

            harness.expectDelegation(workspaceFiles({ "package.json": manifest }), []);
        });

        it.each([
            ["a catalog that lists syncpack", 'packages:\n  - "packages/*"\ncatalog:\n  syncpack: ^1.0.0\n'],
            ["a named catalog that lists syncpack", 'packages:\n  - "packages/*"\ncatalogs:\n  old:\n    syncpack: ^1.0.0\n    other: 1\n'],
            ["syncpack in a comment", 'packages:\n  - "packages/*"\n# syncpack is gone\n'],
            ["syncpack as a quoted key", 'packages:\n  - "packages/*"\ncatalog:\n  "syncpack": "^1"\n'],
            ["syncpack spelled with an escape", 'packages:\n  - "packages/*"\ncatalog:\n  "sync\\x70ack": "^1"\n'],
            ["a backslash", 'packages:\n  - "packages/*"\nnote: "a\\nb"\n'],
            ["a syncpack catalog of another type", 'packages:\n  - "packages/*"\ncatalog:\n  syncpack: [1]\n'],
        ])("hands over a pnpm-workspace.yaml with %s", (_label: string, yaml: string) => {
            expect.hasAssertions();

            harness.expectDelegation(workspace({ "pnpm-workspace.yaml": yaml }), []);
        });

        it("hands over a CI file that is a directory, where Node's read fails without a handler", () => {
            expect.hasAssertions();

            harness.expectDelegation(workspace({ ".github/workflows/dir.yml/keep": "" }), []);
            harness.expectDelegation(workspace({ ".gitlab-ci.yml/keep": "" }), []);
        });

        it("hands over a hook that is a directory", () => {
            expect.hasAssertions();

            harness.expectDelegation(workspace({ ".husky/pre-commit/keep": "" }), []);
        });

        it.skipIf(isRoot)("hands over a hook and a CI file that cannot be read", () => {
            expect.hasAssertions();

            for (const name of [".husky/pre-commit", ".github/workflows/ci.yml", ".drone.yml"]) {
                const files = workspace({ [name]: "sherif\n" });
                const [nodeRoot, nativeRoot] = harness.pair(files);
                const probe = harness.materialize("native", files);

                for (const root of [nodeRoot, nativeRoot, probe]) {
                    chmodSync(join(root, name), 0o000);
                }

                const node = harness.runNode([], nodeRoot);
                const declined = harness.runNative([], probe);
                const native = harness.runNative([], nativeRoot, { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

                // The snapshot reads every file, so the mode goes back before it is taken.
                for (const root of [nodeRoot, nativeRoot, probe]) {
                    chmodSync(join(root, name), 0o644);
                }

                expect(declined.status).toBe(70);
                expect(declined.stdout).toBe("");
                expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
            }
        });

        it.skipIf(isRoot)("reads a pnpm-workspace.yaml that cannot be read as no catalog", () => {
            expect.hasAssertions();

            const files = workspace({});
            const [nodeRoot, nativeRoot] = harness.pair(files);

            for (const root of [nodeRoot, nativeRoot]) {
                chmodSync(join(root, "pnpm-workspace.yaml"), 0o000);
            }

            // The root search needs the file too, so the native side may decline: either way the run matches Node.
            const node = harness.runNode([], nodeRoot);
            const native = harness.runNative([], nativeRoot, { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

            for (const root of [nodeRoot, nativeRoot]) {
                chmodSync(join(root, "pnpm-workspace.yaml"), 0o644);
            }

            expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
        });

        it("hands over a workspace that is not a pnpm one", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ".husky/pre-commit": "sherif\n", "package.json": json({ name: "root", packageManager: "yarn@4.0.0", scripts: { a: "sherif" } }), "yarn.lock": "" }, []);
        });

        it("hands over a run in a workspace project below the root", () => {
            expect.hasAssertions();

            const files = workspace({ "packages/a/package.json": json({ name: "a", scripts: { a: "sherif" } }) });
            const [nodeRoot, nativeRoot] = harness.pair(files);
            const node = harness.runNode([], join(nodeRoot, "packages", "a"));
            const native = harness.runNative([], join(nativeRoot, "packages", "a"), { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

            expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
        });
    });

    describe("what it leaves alone", () => {
        it("writes nothing and creates no directory, whatever it finds", () => {
            expect.hasAssertions();

            const files = workspace({ ".husky/pre-commit": "gitleaks\n", ".secretlintrc.json": "{}" }, { scripts: { a: "gitleaks" } });
            const [nodeRoot, nativeRoot] = harness.pair(files);
            const before = Harness.snapshot(nativeRoot);

            harness.runNode([], nodeRoot);
            harness.runNative([], nativeRoot);

            expect(Harness.snapshot(nativeRoot)).toStrictEqual(before);
            expect(Harness.snapshot(nodeRoot)).toStrictEqual(before);
        });
    });
});
