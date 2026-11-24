/* eslint-disable perfectionist/sort-objects, @stylistic/quote-props -- the key order of the fixtures is what the tests are about */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis security list --json` exists twice: the Node handler (`src/commands/security/list.ts`) and the native report
 * (`native/cli/src/security_list/`). For every input the native path accepts it must print the same JSON with the same
 * exit status as Node, and every input it declines must be handed to Node before anything is printed (see
 * `workspace-parity-harness.ts` for how both are proved).
 */

const harness = new Harness(["security", "list"]);
const ARGS = ["--json"];

/** A flat `node_modules` package: its `package.json`, and the extra files given. */
const pkg = (path: string, manifest: unknown, extra: Files = {}): Files => {
    return {
        [`node_modules/${path}/package.json`]: typeof manifest === "string" ? manifest : json(manifest),
        ...Object.fromEntries(Object.entries(extra).map(([name, content]) => [`node_modules/${path}/${name}`, content])),
    };
};

const config = (security: Record<string, unknown>, rest = ""): Files => {
    return { "vis.config.ts": `export default {${rest} security: ${JSON.stringify(security, null, 4)} };\n` };
};

const allow = (entries: Record<string, boolean>, more: Record<string, unknown> = {}): Files => config({ policies: { installScripts: { allow: entries } }, ...more });

const HOOKS = { scripts: { preinstall: "a", install: "b", postinstall: "c", prepare: "d", test: "e" } };

/** A mixed tree: approved, unapproved and clean packages, scoped ones, nested ones and odd manifests. */
const tree = (): Files => {
    return {
        ...pkg("esbuild", { name: "esbuild", version: "0.20.0", scripts: { postinstall: "node install.js" } }),
        ...pkg("sharp", { name: "sharp", version: "0.33.0", ...HOOKS }),
        ...pkg("plain", { name: "plain", version: "1.0.0", scripts: { test: "x" } }),
        ...pkg("native-addon", { name: "native-addon", version: "2.0.0" }, { "binding.gyp": "{}" }),
        ...pkg("native-with-install", { name: "native-with-install", version: "2.0.0", scripts: { install: "x" } }, { "binding.gyp": "{}" }),
        ...pkg("prepare-only", { name: "prepare-only", version: "3.0.0", scripts: { prepare: "x" } }, { "binding.gyp": "{}" }),
        ...pkg("@scope/tool", { name: "@scope/tool", version: "1.2.3", scripts: { install: "x" } }),
        ...pkg("@scope/other", { name: "@scope/other", scripts: { postinstall: "x" } }),
        ...pkg("falsy-hooks", { name: "falsy-hooks", version: "1.0.0", scripts: { install: "", postinstall: 0, preinstall: null } }),
        ...pkg("truthy-odd", { name: "truthy-odd", version: "1.0.0", scripts: { install: 1, postinstall: true, preinstall: {} } }),
        ...pkg("scripts-string", { name: "scripts-string", scripts: "install" }),
        ...pkg("version-number", { name: "version-number", version: 1, scripts: { install: "x" } }),
        ...pkg("with-nested", { name: "with-nested", version: "1.0.0" }),
        ...pkg("with-nested/node_modules/inner", { name: "inner", version: "9.9.9", scripts: { install: "x" } }),
        ...pkg("with-nested/node_modules/@deep/pkg", { name: "@deep/pkg", version: "1.0.0", scripts: { install: "x" } }),
        ...pkg(".hidden", { name: "hidden", scripts: { install: "x" } }),
        ...pkg("not-a-package", "null"),
        ...pkg("array-manifest", "[]", { "binding.gyp": "{}" }),
        ...pkg("string-manifest", '"text"'),
        ...pkg("number-manifest", "5"),
        "node_modules/a-file": "just a file\n",
        "node_modules/@scope/file-in-scope": "x",
        "node_modules/no-manifest/readme.md": "x",
    };
};

/** A pnpm-style tree: the real packages under `.pnpm`, symbolic links at the top. */
const pnpmTree = (): Files => {
    return {
        ...pkg(".pnpm/esbuild@0.20.0/node_modules/esbuild", { name: "esbuild", version: "0.20.0", scripts: { postinstall: "x" } }),
        ...pkg(".pnpm/sharp@0.33.0/node_modules/sharp", { name: "sharp", version: "0.33.0", scripts: { install: "x" } }),
        ...pkg(".pnpm/@scope+tool@1.0.0/node_modules/@scope/tool", { name: "@scope/tool", version: "1.0.0", scripts: { install: "x" } }),
        ...pkg(".pnpm/peer@1.0.0_x@2/node_modules/peer", { name: "peer", version: "1.0.0", scripts: { install: "x" } }),
        ...pkg(".pnpm/esbuild@0.19.0/node_modules/esbuild", { name: "esbuild", version: "0.19.0", scripts: { postinstall: "x" } }),
        ...pkg(".pnpm/node_modules/hoisted", { name: "hoisted", version: "1.0.0", scripts: { install: "x" } }),
        "node_modules/.pnpm/lock.yaml": "lockfileVersion: 9\n",
        "node_modules/esbuild": { link: ".pnpm/esbuild@0.20.0/node_modules/esbuild" },
        "node_modules/sharp": { link: ".pnpm/sharp@0.33.0/node_modules/sharp" },
        "node_modules/@scope/tool": { link: "../.pnpm/@scope+tool@1.0.0/node_modules/@scope/tool" },
        "node_modules/broken": { link: ".pnpm/nothing/node_modules/broken" },
        "node_modules/.bin/esbuild": "#!/bin/sh\n",
    };
};

const run = (files: Files, extra: Record<string, string> = {}): void => {
    harness.expectParity(files, ARGS, extra);
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis security list --json: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-security-list-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe("without a config", () => {
        it("reports an empty workspace", () => {
            expect.hasAssertions();

            expect(harness.expectParity(workspaceFiles({}), ARGS).stdout).toContain('"packageManager": "pnpm"');
        });

        it("reports every package with a lifecycle script as unapproved", () => {
            expect.hasAssertions();

            const result = harness.expectParity(workspaceFiles(tree()), ARGS);

            expect(result.stdout).toContain('"unapproved"');
            expect(result.stdout).toContain("install (binding.gyp)");
        });

        it("reads manifests the way JSON.parse does: a BOM-free `__proto__` key, and the word inside strings", () => {
            expect.hasAssertions();

            run(
                workspaceFiles({
                    ...pkg("proto", '{ "name": "proto", "__proto__": { "scripts": { "install": "x" } }, "scripts": { "install": "y" }, "bin": { "__proto__": "x" } }'),
                    ...pkg("dunder", { name: "dunder-proto", description: "the __proto__ getter", keywords: ["__proto__"], scripts: { postinstall: "x" } }),
                }),
            );
        });

        it("walks a pnpm store with its links, hoisted copies and a broken link", () => {
            expect.hasAssertions();

            run(workspaceFiles(pnpmTree()));
        });

        it("walks both layouts together", () => {
            expect.hasAssertions();

            run(workspaceFiles({ ...tree(), ...Object.fromEntries(Object.entries(pnpmTree()).filter(([name]) => name.startsWith("node_modules/.pnpm"))) }));
        });

        it("lists names in byte order, the way readdir sorts them", () => {
            expect.hasAssertions();

            const names = ["b", "a", "B", "A", "_x", "-y", "a.b", "a-b", "a_b", "a1", "aa", "10", "9", "z", "Z"];

            run(workspaceFiles(Object.assign({}, ...names.map((name) => pkg(name, { name, version: "1.0.0", scripts: { install: "x" } })))));
            run(workspaceFiles(Object.assign({}, ...names.map((name) => pkg(name, { name, version: "1.0.0", scripts: { install: "x" } })))), { LANG: "en_US.UTF-8" });
        });

        it("reads the config `vis init` writes: a `defineConfig` call from the vis config module", () => {
            expect.hasAssertions();

            const stub: Files = {
                "node_modules/@visulima/vis/dist/config.js": "export const defineConfig = (config) => config;\n",
                "node_modules/@visulima/vis/package.json": json({ exports: { "./config": { default: "./dist/config.js" } }, name: "@visulima/vis", type: "module", version: "1.0.0" }),
            };
            const source = 'import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ security: { policies: { installScripts: { allow: { esbuild: true, gone: true } } } } });\n';

            run(workspaceFiles({ ...tree(), ...stub, "vis.config.ts": source }));
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("prints the same under %j", (...[environment]: Record<string, string>[]) => {
            expect.hasAssertions();

            run(workspaceFiles(tree()), environment);
        });

        it("runs from a workspace with projects, and ignores their own node_modules", () => {
            expect.hasAssertions();

            run(workspaceFiles({ ...tree(), "packages/a/package.json": json({ name: "a" }), ...pkg("../packages/a/node_modules/inner", { name: "inner", scripts: { install: "x" } }) }));
        });
    });

    describe("with an allowlist", () => {
        const APPROVALS: Record<string, Record<string, boolean>> = {
            exact: { esbuild: true },
            "everything exact": { esbuild: true, sharp: true, "@scope/tool": true, "@scope/other": true, "native-addon": true },
            "a false entry": { esbuild: false, sharp: true },
            "any version": { "esbuild@*": true, "sharp@*": true },
            "a prefix": { "@scope/*": true, "native*": true },
            "stale entries": { gone: true, "gone@*": true, "gone*": true, "@nothing/*": true, esbuild: true },
            "a pinned version": { "esbuild@0.20.0": true, "sharp@0.1.0": true, "@scope/tool@1.2.3": true },
            "a version that is no longer installed": { "esbuild@0.19.0": true, "sharp@*": true },
            "nested and deep packages": { inner: true, "@deep/pkg": true, "with-nested": true },
            "a package without a version": { "@scope/other@1.0.0": true, "@scope/other": true },
            "other truthy values": { esbuild: true, sharp: true },
        };

        it.each(Object.keys(APPROVALS))("%s", (name) => {
            expect.hasAssertions();

            run(workspaceFiles({ ...tree(), ...allow(APPROVALS[name] as Record<string, boolean>) }));
            run(workspaceFiles({ ...tree(), ...allow(APPROVALS[name] as Record<string, boolean>, { pinVersions: true }) }));
        });

        it("keeps the order of the allowlist in the stale and drift lists", () => {
            expect.hasAssertions();

            const result = harness.expectParity(
                workspaceFiles({ ...tree(), ...allow({ zeta: true, "alpha@*": true, mid: true, "esbuild@0.1.0": true, "sharp@0.0.1": true, "aaa*": true }, { pinVersions: true }) }),
                ARGS,
            );

            expect(result.stdout.indexOf("zeta")).toBeLessThan(result.stdout.indexOf("alpha@*"));
        });

        it("reads keys in quotes and in identifiers alike", () => {
            expect.hasAssertions();

            run(workspaceFiles({ ...tree(), "vis.config.ts": "export default { security: { policies: { installScripts: { allow: { esbuild: true, 'sharp': true, \"@scope/tool\": true, 'x-y': false } } } } };\n" }));
        });

        it("reads a literal config under `export default` with other literal keys", () => {
            expect.hasAssertions();

            run(workspaceFiles({ ...tree(), "vis.config.ts": "export default { tasks: { build: { command: 'x' } }, security: { policies: { installScripts: { allow: { esbuild: true } } } } };\n" }));
        });

        it("accepts a config with no security block", () => {
            expect.hasAssertions();

            run(workspaceFiles({ ...tree(), "vis.config.ts": "export default { tasks: {} };\n" }));
            run(workspaceFiles({ ...tree(), "vis.config.ts": "export default {};\n" }));
        });

        it("accepts security blocks without an allowlist", () => {
            expect.hasAssertions();

            run(workspaceFiles({ ...tree(), ...config({ blockExoticSubdeps: true }) }));
            run(workspaceFiles({ ...tree(), ...config({ policies: {} }) }));
            run(workspaceFiles({ ...tree(), ...config({ policies: { installScripts: { strict: true } } }) }));
            run(workspaceFiles({ ...tree(), ...config({ policies: null, pinVersions: true }) }));
            run(workspaceFiles({ ...tree(), ...config({ policies: { installScripts: null } }) }));
            run(workspaceFiles({ ...tree(), ...config({ policies: { installScripts: { allow: null } } }) }));
        });
    });

    describe("bin conflicts", () => {
        const withBins = (bins: Record<string, Record<string, string> | string>): Files =>
            Object.assign({}, ...Object.entries(bins).map(([name, bin]) => pkg(name, { name, version: "1.0.0", bin })));

        /** Two or three packages (`&lt;bin>_one`, `&lt;bin>_two`, ...) per bin name, each exposing only that bin. */
        const conflicting = (bins: string[], copies = 2): Files =>
            withBins(Object.fromEntries(bins.flatMap((bin) => ["one", "two", "three"].slice(0, copies).map((copy) => [`${bin}_${copy}`, { [bin]: "x.js" }]))));

        it("records a package under the first bin of its file only, so a second bin never conflicts", () => {
            expect.hasAssertions();

            const result = harness.expectParity(workspaceFiles(withBins({ one: { z: "x", a: "x" }, two: { a: "x", z: "x" } })), ARGS);

            expect(result.stdout).not.toContain('"bin": "a"');
            expect(result.stdout).not.toContain('"bin": "z"');
        });

        it("lists a single conflict, whatever the bin is called", () => {
            expect.hasAssertions();

            run(workspaceFiles(withBins({ one: { Tool: "x.js", other: "y.js" }, two: { Tool: "x.js" }, three: { solo: "z" } })));
            run(workspaceFiles(conflicting(["Tool"], 3)));
            run(workspaceFiles(conflicting(["@weird bin"])));
        });

        it("sorts several conflicts the way localeCompare does", () => {
            expect.hasAssertions();

            const bins = ["tsc", "tsserver", "a_b", "a-b", "a.b", "a1", "aa", "ab", "_x", "1", "z9", "z10", "node-gyp", "node_gyp", "eslint", "0", "9", "a", "b"];

            run(workspaceFiles(conflicting(bins)));
            run(workspaceFiles(conflicting(bins.toReversed(), 3)));
        });

        it("orders integer-like bin names of one package first, as a JS object does", () => {
            expect.hasAssertions();

            run(workspaceFiles(withBins({ one: { b: "x", "10": "x", "2": "x" }, two: { "2": "x", "10": "x" }, three: { "10": "x" } })));
        });

        it("reads string and array bins, scoped names and duplicates", () => {
            expect.hasAssertions();

            run(
                workspaceFiles({
                    ...pkg("@scope/cli", { name: "@scope/cli", bin: "bin.js" }),
                    ...pkg("cli", { name: "cli", bin: "bin.js" }),
                    ...pkg("@other/cli", { name: "@other/cli", bin: "bin.js" }),
                    ...pkg("arr1", { name: "arr1", bin: ["a.js", "b.js"] }),
                    ...pkg("arr2", { name: "arr2", bin: ["a.js"] }),
                    ...pkg("nameless", { bin: "x.js" }),
                    ...pkg("nameless/node_modules/nameless", { bin: "y.js" }),
                    ...pkg("empty-bin", { name: "empty-bin", bin: "" }),
                    ...pkg("null-bin", { name: "null-bin", bin: null }),
                    ...pkg("number-bin", { name: "number-bin", bin: 5 }),
                    ...pkg("renamed", { name: "somebody-else", bin: { run: "x" } }),
                    ...pkg("renamed2", { name: "somebody-else-2", bin: { run: "x" } }),
                }),
            );
        });

        it("lists the relative path of the first copy found", () => {
            expect.hasAssertions();

            run(workspaceFiles({ ...pnpmTree(), ...withBins({ tool1: { go: "x" }, tool2: { go: "y" } }) }));
        });

        it("drops the conflicts `allowBins` blesses, by bin and by package", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ...conflicting(["a", "b", "c"]), ...withBins({ c_three: { c: "x" } }) });

            run({ ...files, ...config({ allowBins: { a: true } }) });
            run({ ...files, ...config({ allowBins: { "b_one#b": true, "b_two#b": true } }) });
            run({ ...files, ...config({ allowBins: { "b_one#b": true } }) });
            run({ ...files, ...config({ allowBins: { a: false, b: 1, "c_one#c": true, "c_two#c": true, "c_three#c": true } }) });
            run({ ...files, ...config({ allowBins: null }) });
            run({ ...files, ...config({ allowBins: "x" }) });
            run({ ...files, ...config({ allowBins: 1 }) });
            run({ ...files, ...config({ allowBins: true }) });
        });

        it("hands an array-valued `allowBins` to Node, whose lookup `allowBins[bin]` indexes the array", () => {
            expect.hasAssertions();

            // `[true]["0"] === true` blesses a bin called `0` in Node.
            const zero = workspaceFiles(conflicting(["0", "a"]));

            for (const allowBins of [["a"], [], [false, true]]) {
                harness.expectDelegation({ ...zero, ...config({ allowBins }) }, ARGS);
            }

            const blessed = harness.expectDelegation({ ...zero, ...config({ allowBins: [true] }) }, ARGS);

            expect(blessed.stdout).not.toContain('"bin": "0"');
            expect(blessed.stdout).toContain('"bin": "a"');
        });

        it.each([{ LANG: "en_US.UTF-8" }, { LC_ALL: "C" }, { LANG: "POSIX" }, { LC_ALL: "en_GB.UTF-8" }, { LC_MESSAGES: "" }])("sorts under the locale %j as Node does", (environment) => {
            expect.hasAssertions();

            run(workspaceFiles(conflicting(["a_b", "a-b", "ab", "a.b"])), environment);
        });
    });

    describe("drift against pnpm-workspace.yaml", () => {
        const yaml = (text: string): Files => {
            return { "pnpm-workspace.yaml": `packages:\n  - "packages/*"\n${text}` };
        };

        const drifting = (settings: Record<string, unknown>): Files => config({ policies: settings });

        it("reports a clean state", () => {
            expect.hasAssertions();

            run(workspaceFiles({ ...yaml("onlyBuiltDependencies:\n  - esbuild\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - webpack\n"), ...drifting({ installScripts: { allow: { esbuild: true } }, firstSeen: { minutes: 1440, exclude: ["webpack"] } }) }));
        });

        it("reports each kind of drift", () => {
            expect.hasAssertions();

            const base = tree();

            run(workspaceFiles({ ...base, ...yaml("onlyBuiltDependencies:\n  - esbuild\n  - other\n"), ...drifting({ installScripts: { allow: { esbuild: true, sharp: true, off: false } } }) }));
            run(workspaceFiles({ ...base, ...yaml("allowBuilds:\n  esbuild: true\n  'x': false\n  '@s/y': true\n"), ...drifting({ installScripts: { allow: { esbuild: true, sharp: true } } }) }));
            run(workspaceFiles({ ...base, ...yaml("minimumReleaseAge: 10\n"), ...drifting({ firstSeen: { minutes: 2880 } }) }));
            run(workspaceFiles({ ...base, ...yaml(""), ...drifting({ firstSeen: { minutes: 2880 } }) }));
            run(workspaceFiles({ ...base, ...yaml("minimumReleaseAge: '10'\n"), ...drifting({ firstSeen: { minutes: 0 } }) }));
            run(workspaceFiles({ ...base, ...yaml("minimumReleaseAgeExclude:\n  - a\n  - b\n  - a\n"), ...drifting({ firstSeen: { exclude: ["b", "c", "c"] } }) }));
            run(workspaceFiles({ ...base, ...yaml(""), ...drifting({ firstSeen: { exclude: [] } }) }));
            run(workspaceFiles({ ...base, ...yaml("allowBuilds:\nonlyBuiltDependencies:\n  - a\n"), ...drifting({ installScripts: { allow: {} } }) }));
        });

        it("reports all three at once, in Node's key order", () => {
            expect.hasAssertions();

            const result = harness.expectParity(
                workspaceFiles({
                    ...tree(),
                    ...yaml("onlyBuiltDependencies:\n  - pm-only\n  - esbuild\nminimumReleaseAge: 5\nminimumReleaseAgeExclude:\n  - pm-only\n"),
                    ...drifting({ installScripts: { allow: { esbuild: true, "vis-only": true } }, firstSeen: { minutes: 7, exclude: ["vis-only"] } }),
                }),
                ARGS,
            );

            expect(result.stdout).toContain('"hasDrift": true');
        });

        it("reads the yaml only when the config asks for a comparison", () => {
            expect.hasAssertions();

            // A grammar this crate does not read, but nothing compares with it.
            run(workspaceFiles({ ...tree(), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\nfoo: [1, 2]\n' }));
            run(workspaceFiles({ ...tree(), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\nfoo: [1, 2]\n', ...config({ pinVersions: true }) }));
        });
    });

    describe("handed to Node", () => {
        const base = (): Files => workspaceFiles({ ...tree(), ...allow({ esbuild: true }) });

        it.each([[[]], [["--json", "--json"]], [["--json", "--cwd", "."]], [["--json=true"]], [["--json", "--other"]], [["extra", "--json"]]])("`security list %s` is declined", (args: string[]) => {
            expect.hasAssertions();

            harness.expectDelegation(base(), args);
        });

        it("the other security subcommands are not native", () => {
            expect.hasAssertions();

            for (const words of [["sync"], ["run"], ["tripwire", "--status"], ["keys-refresh", "--clear"]]) {
                expect(harness.runNative(words, harness.materialize("native", base())).status, words.join(" ")).toBeGreaterThan(0);
            }
        });

        it("a run outside CI is declined", () => {
            expect.hasAssertions();

            // Node prints a random, rate-limited tip outside CI; VIS_CLI_TEST keeps it out of the comparison.
            harness.expectDelegation(base(), ARGS, { VIS_CLI_TEST: "1" }, false);
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("%j is declined", (environment) => {
            expect.hasAssertions();

            harness.expectDelegation(base(), ARGS, environment);
        });

        it.each([{ NODE_ENV: "test" }, { NODE_ENV: "debug" }, { DEBUG: "vis" }, { PAIL_LOG_LEVEL: "debug" }, { CEREBRO_OUTPUT_LEVEL: "4" }])("the output setting %j is declined", (environment) => {
            expect.hasAssertions();

            harness.expectDelegation(base(), ARGS, environment);
        });

        it("another package manager is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation(workspaceFiles({ ...tree() }, { packageManager: "npm@10.0.0" }), ARGS);
        });

        const CONFIGS: Record<string, string> = {
            "a config Node evaluates": "export default { security: { policies: { installScripts: { allow: Object.fromEntries([['esbuild', true]]) } } } };\n",
            "a config with a call": "import { x } from './x.js';\nexport default { security: x() };\n",
            extends: "export default { extends: './base.ts', security: { policies: { installScripts: { allow: { esbuild: true } } } } };\n",
            runtime: "export default { runtime: 'node', security: { policies: { installScripts: { allow: { esbuild: true } } } } };\n",
            "a version constraint": "export default { versionConstraint: '>=0.0.1', security: { policies: { installScripts: { allow: { esbuild: true } } } } };\n",
            "numeric keys in the allowlist": "export default { security: { policies: { installScripts: { allow: { 10: true, esbuild: true, 2: true } } } } };\n",
            "a duplicate key": "export default { security: { policies: { installScripts: { allow: { esbuild: true, esbuild: false } } } } };\n",
            "an allowlist that is not an object": "export default { security: { policies: { installScripts: { allow: ['esbuild'] } } } };\n",
            "a spread": "const more = {};\nexport default { security: { policies: { installScripts: { allow: { ...more, esbuild: true } } } } };\n",
            "security that is not an object": "export default { security: true };\n",
            "a __proto__ key": "export default { security: { allowBins: { __proto__: true }, policies: { installScripts: { allow: { esbuild: true } } } } };\n",
            "a computed key": "export default { security: { policies: { installScripts: { allow: { ['esbuild']: true } } } } };\n",
            "a minutes value that is not an integer": "export default { security: { policies: { firstSeen: { minutes: 1.5 } } } };\n",
            "a minutes value that is a string": "export default { security: { policies: { firstSeen: { minutes: '2d' } } } };\n",
            "an exclude list with other types": "export default { security: { policies: { firstSeen: { exclude: [1, 'a'] } } } };\n",
        };

        it.each(Object.keys(CONFIGS))("%s is declined", (name) => {
            expect.hasAssertions();

            harness.expectDelegation({ ...tree(), ...workspaceFiles({ ...tree(), "vis.config.ts": CONFIGS[name] as string, "base.ts": "export default {};\n" }) }, ARGS);
        });

        it("a json config is declined, and two configs in one directory read as Node reads them", () => {
            expect.hasAssertions();

            harness.expectDelegation(workspaceFiles({ ...tree(), "vis.config.json": '{ "security": {} }\n' }), ARGS);
            run(workspaceFiles({ ...tree(), ...allow({ esbuild: true }), "vis.config.mjs": "export default {};\n" }));
        });

        it("a config in a parent directory is declined", () => {
            expect.hasAssertions();

            const [, nativeRoot] = harness.pair(workspaceFiles({ ...tree(), "vis.config.ts": "export default {};\n", "packages/a/package.json": json({ name: "a" }) }));

            expect(harness.runNative(ARGS, `${nativeRoot}/packages/a`).status).toBe(70);
        });

        it("a manifest under node_modules that is not strict JSON is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation(workspaceFiles({ ...tree(), ...pkg("odd", '{ "name": "odd", // note\n "scripts": { "install": "x" } }\n') }), ARGS);
            harness.expectDelegation(workspaceFiles({ ...tree(), ...pkg("broken", "{ not json") }), ARGS);
            harness.expectDelegation(workspaceFiles({ ...tree(), ...pkg("bom", `\uFEFF${json({ name: "bom", scripts: { install: "x" } })}`) }), ARGS);
        });

        it("several conflicts it cannot order are declined", () => {
            expect.hasAssertions();

            const two = (a: string, b: string): Files =>
                workspaceFiles(
                    Object.assign({}, ...[a, b].flatMap((bin, index) => ["x", "y"].map((copy) => pkg(`p${index}${copy}`, { name: `p${index}${copy}`, bin: { [bin]: "x" } })))),
                );

            harness.expectDelegation(two("Alpha", "beta"), ARGS);
            harness.expectDelegation(two("a@b", "a+b"), ARGS);
            harness.expectDelegation(two("aa", "ab"), ARGS, { LANG: "da_DK.UTF-8" });
            harness.expectDelegation(two("aa", "ab"), ARGS, { LC_ALL: "sv_SE.UTF-8" });
        });

        it("a yaml it cannot read is declined when the config compares with it", () => {
            expect.hasAssertions();

            const yaml = (text: string): Files => {
                return { "pnpm-workspace.yaml": `packages:\n  - "packages/*"\n${text}` };
            };

            for (const text of ["foo: [1, 2]\n", "minimumReleaseAge: 1.5\n", "minimumReleaseAge: 007\n", "allowBuilds:\n  a: yes\n", "onlyBuiltDependencies:\n  - 123\n", "a: &x 1\n", "n:\n  a:\n    b: 1\n", "x: 1\nx: 2\n", "a:\n\t- b\n"]) {
                harness.expectDelegation(workspaceFiles({ ...tree(), ...yaml(text), ...config({ policies: { firstSeen: { minutes: 10 }, installScripts: { allow: { esbuild: true } } } }) }), ARGS);
            }
        });

        it("declines before it walks `node_modules` when the yaml is outside the grammar", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ...tree(), "pnpm-workspace.yaml": "packages:\n  - \"packages/*\"\nminimumReleaseAge: 10 # minutes\n", ...config({ policies: { firstSeen: { minutes: 10 } } }) });
            const [, nativeRoot] = harness.pair(files);

            // The walk reads every `node_modules/*/package.json`; a pipe nobody writes to blocks that read for good, so a
            // binary that walked first would not answer within the timeout.
            mkdirSync(join(nativeRoot, "node_modules", "trap"), { recursive: true });

            expect(spawnSync("mkfifo", [join(nativeRoot, "node_modules", "trap", "package.json")]).status).toBe(0);

            const result = harness.runNative(ARGS, nativeRoot, {}, true, 10_000);

            expect(result.error).toBeUndefined();
            expect(result.status).toBe(70);
            expect(result.stdout).toBe("");
        });

        it("a workspace that is not rooted at the working directory is declined", () => {
            expect.hasAssertions();

            const [, nativeRoot] = harness.pair(workspaceFiles({ ...tree(), "packages/a/package.json": json({ name: "a" }) }));

            expect(harness.runNative(ARGS, `${nativeRoot}/packages/a`).status).toBe(70);
        });
    });
});
