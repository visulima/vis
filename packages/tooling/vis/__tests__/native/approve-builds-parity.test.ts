/* eslint-disable perfectionist/sort-objects -- the key order of the fixtures is what the tests are about */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis approve-builds --scan` exists twice: the Node handler (`src/commands/approve-builds/handler.ts`) and the native report
 * (`native/cli/src/approve_builds.rs`, on the triage of `security list`). Without `--scan` a pnpm workspace gets `pnpm approve-builds`,
 * a prompt, and that is Node's. With `--scan` the handler only reads, and prints the unapproved packages with the snippet to approve
 * them. For every input the native path accepts it must print the same text on the same streams and end with the same exit status as
 * Node; every input it declines (a report with stale or outdated allowlist entries, a name outside ASCII, every other flag) must be handed
 * to Node before anything is printed or written (see `workspace-parity-harness.ts` for how both are proved).
 */

const harness = new Harness(["approve-builds"]);
const ARGS = ["--scan"];

/** A directory with a `pnpm` that does nothing and succeeds: the run without `--scan` hands a pnpm workspace to `pnpm approve-builds`. */
let stubs: string;

const stubbed = (extra: Record<string, string> = {}): Record<string, string> => {
    return { ...extra, PATH: `${stubs}:${process.env["PATH"] ?? ""}` };
};

const delegated = (files: Files, args: string[], extra: Record<string, string> = {}, ci = true): ReturnType<Harness["expectDelegation"]> => harness.expectDelegation(files, args, stubbed(extra), ci);

/** A flat `node_modules` package: its `package.json`, and the extra files given. */
const pkg = (path: string, manifest: unknown, extra: Files = {}): Files => {
    return {
        [`node_modules/${path}/package.json`]: typeof manifest === "string" ? manifest : json(manifest),
        ...Object.fromEntries(Object.entries(extra).map(([name, content]) => [`node_modules/${path}/${name}`, content])),
    };
};

const config = (security: Record<string, unknown>): Files => {
    return { "vis.config.ts": `export default { security: ${JSON.stringify(security, null, 4)} };\n` };
};

const allow = (entries: Record<string, boolean>, more: Record<string, unknown> = {}): Files => config({ policies: { installScripts: { allow: entries } }, ...more });

const HOOKS = { scripts: { preinstall: "a", install: "b", postinstall: "c", prepare: "d", test: "e" } };

/** A mixed tree: unapproved and clean packages, scoped ones and nested ones. */
const tree = (): Files => {
    return {
        ...pkg("esbuild", { name: "esbuild", version: "0.20.0", scripts: { postinstall: "node install.js" } }),
        ...pkg("sharp", { name: "sharp", version: "0.33.0", ...HOOKS }),
        ...pkg("plain", { name: "plain", version: "1.0.0", scripts: { test: "x" } }),
        ...pkg("native-addon", { name: "native-addon", version: "2.0.0" }, { "binding.gyp": "{}" }),
        ...pkg("@scope/tool", { name: "@scope/tool", version: "1.2.3", scripts: { install: "x" } }),
        ...pkg("@scope/other", { name: "@scope/other", scripts: { postinstall: "x" } }),
        ...pkg("with-nested", { name: "with-nested", version: "1.0.0" }),
        ...pkg("with-nested/node_modules/inner", { name: "inner", version: "9.9.9", scripts: { install: "x" } }),
    };
};

/** A pnpm-style tree: the real packages under `.pnpm`, symbolic links at the top. */
const pnpmTree = (): Files => {
    return {
        ...pkg(".pnpm/esbuild@0.20.0/node_modules/esbuild", { name: "esbuild", version: "0.20.0", scripts: { postinstall: "x" } }),
        ...pkg(".pnpm/sharp@0.33.0/node_modules/sharp", { name: "sharp", version: "0.33.0", scripts: { install: "x" } }),
        ...pkg(".pnpm/esbuild@0.19.0/node_modules/esbuild", { name: "esbuild", version: "0.19.0", scripts: { postinstall: "x" } }),
        "node_modules/.pnpm/lock.yaml": "lockfileVersion: 9\n",
        "node_modules/esbuild": { link: ".pnpm/esbuild@0.20.0/node_modules/esbuild" },
        "node_modules/sharp": { link: ".pnpm/sharp@0.33.0/node_modules/sharp" },
    };
};

const both = (files: Files, extra: Record<string, string> = {}): ReturnType<Harness["expectParity"]> => harness.expectParity(files, ARGS, extra);

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis approve-builds --scan: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-approve-builds-parity-");
        stubs = mkdtempSync(join(tmpdir(), "vis-approve-builds-stubs-"));
        writeFileSync(join(stubs, "pnpm"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(stubs, "pnpm"), 0o755);
    });

    afterAll(() => {
        harness.teardown();
        rmSync(stubs, { force: true, recursive: true });
    });

    describe("the report", () => {
        it("says there is nothing to approve in an empty workspace", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles({}));

            expect(result.stdout).toContain("No unapproved build scripts found.");
            expect(result.status).toBe(0);
        });

        it("lists the packages with lifecycle scripts and the snippet to approve them", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles(tree()));

            expect(result.stderr).toContain("Found 6 packages with unapproved build scripts:");
            expect(result.stdout).toContain("  sharp (preinstall, install, postinstall, prepare)");
            expect(result.stdout).toContain('"@scope/tool": true,');
            expect(result.stdout).toContain("Or run 'pnpm approve-builds' to update pnpm-workspace.yaml directly.");
        });

        it("says `package` for one", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles(pkg("esbuild", { name: "esbuild", version: "0.20.0", scripts: { install: "x" } })));

            expect(result.stderr).toContain("Found 1 package with unapproved build scripts:");
        });

        it("reads a pnpm-style tree", () => {
            expect.hasAssertions();

            both(workspaceFiles(pnpmTree()));
        });

        it("says there is nothing to approve once the allowlist covers everything", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles({ ...pkg("esbuild", { name: "esbuild", version: "0.20.0", scripts: { install: "x" } }), ...allow({ esbuild: true }) }));

            expect(result.stdout).toContain("No unapproved build scripts found.");
        });

        it("lists what the allowlist leaves out", () => {
            expect.hasAssertions();

            both(workspaceFiles({ ...tree(), ...allow({ esbuild: true, sharp: true, "@scope/*": true }) }));
        });

        it("names the version in the snippet under pinVersions", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles({ ...tree(), ...allow({ "sharp@0.33.0": true }, { pinVersions: true }) }));

            expect(result.stdout).toContain('"esbuild@0.20.0": true,');
        });

        it("ignores a falsy allowlist entry", () => {
            expect.hasAssertions();

            both(workspaceFiles({ ...pkg("esbuild", { name: "esbuild", version: "0.20.0", scripts: { install: "x" } }), ...allow({ esbuild: false }) }));
        });
    });

    describe("what the environment decides", () => {
        const files = (): Files => workspaceFiles(tree());

        it.each([...SHORT_COLOUR_ENVIRONMENTS, { FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }, { CI: "true", FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }])("prints the same under %j", (extra) => {
            expect.hasAssertions();

            both(files(), extra);
        });

        it.each([{ COLUMNS: "45" }, { COLUMNS: "60" }, { COLUMNS: "120" }])("wraps the long lines like pail under %j", (extra) => {
            expect.hasAssertions();

            both(workspaceFiles({ ...files(), ...pkg("a-package-with-a-rather-long-name-to-wrap", { name: "a-package-with-a-rather-long-name-to-wrap", version: "1.0.0", scripts: { install: "x", postinstall: "y" } }) }), extra);
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("hands the run to Node under %j", (extra) => {
            expect.hasAssertions();

            delegated(files(), ARGS, extra);
        });

        it("hands a run outside CI to Node", () => {
            expect.hasAssertions();

            delegated(files(), ARGS, {}, false);
        });

        it.each([{ NODE_ENV: "test" }, { DEBUG: "1" }, { PAIL_LOG_LEVEL: "error" }])("hands the run to Node under %j", (extra) => {
            expect.hasAssertions();

            delegated(files(), ARGS, extra);
        });
    });

    describe("what the native path leaves to Node", () => {
        const files = (): Files => workspaceFiles(tree());

        // The run without `--scan` hands a pnpm workspace to `pnpm approve-builds`, which prompts: only the binary's half runs.
        it.each([[[]], [["--all"]], [["--write"]], [["--sync-native"]], [["--no-scan"]]])("declines the arguments %j, which do not scan", (args) => {
            expect.hasAssertions();

            const probe = harness.materialize("native", files());
            const before = Harness.snapshot(probe);
            const declined = harness.runNative(args, probe, { VIS_DEBUG_DECLINE: "1" });

            expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
            expect(declined.stdout).toBe("");
            expect(Harness.snapshot(probe)).toStrictEqual(before);
        });

        it.each([[["--scan", "--all"]], [["--scan", "--scan"]], [["--scan=true"]], [["--scan", "--sync-native"]], [["--scan", "--write"]]])("declines the arguments %j", (args) => {
            expect.hasAssertions();

            delegated(files(), args);
        });

        it("declines `--scan --write`, which edits vis.config.ts, and leaves the edit to Node", () => {
            expect.hasAssertions();

            delegated({ ...workspaceFiles(tree()), "vis.config.ts": "export default { security: {} };\n" }, ["--scan", "--write"]);
        });

        it.each([
            ["a stale allowlist entry", allow({ esbuild: true, "gone-package": true })],
            ["a pinned entry for an outdated version", allow({ "esbuild@0.19.0": true }, { pinVersions: true })],
            ["a config Node evaluates", { "vis.config.ts": "export default { security: { policies: { installScripts: { allow: Object.fromEntries([['esbuild', true]]) } } } };\n" }],
            ["a json config, which Node does not load", { "vis.config.json": "{}" }],
            ["a config that only Node reads", { "vis.config.ts": "export default { runtime: 'node', security: {} };\n" }],
        ] as [string, Files][])("declines %s", (_name, extra) => {
            expect.hasAssertions();

            delegated(workspaceFiles({ ...tree(), ...extra }), ARGS);
        });

        it("declines a package name outside ASCII", () => {
            expect.hasAssertions();

            delegated(workspaceFiles({ ...tree(), ...pkg("café", { name: "café", version: "1.0.0", scripts: { install: "x" } }) }), ARGS);
        });

        it("declines a package.json under node_modules that is not strict JSON", () => {
            expect.hasAssertions();

            delegated(workspaceFiles({ ...tree(), ...pkg("odd", "{ not json") }), ARGS);
        });

        it("declines a workspace that is not pnpm", () => {
            expect.hasAssertions();

            const npm = workspaceFiles(tree());

            delete npm["pnpm-workspace.yaml"];
            delete npm["pnpm-lock.yaml"];
            delegated({ ...npm, "package-lock.json": "{}\n" }, ARGS);
        });
    });
});
