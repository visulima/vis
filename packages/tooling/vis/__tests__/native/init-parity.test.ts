import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Files, Outcome, Result } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis init` exists twice: the Node handler (`src/commands/init/handler.ts`) and the native one (`native/cli/src/init.rs`),
 * which answers the flags that ask nothing (no terminal on stdin, so Node would run `runStaticInit`): `--schema`, `--agent`,
 * `--force`, `--no-interactive`, `--sync-native` and `--editor vscode`. Every other shape, and every file the native side
 * would merge into or read differently, is handed to Node before anything is printed or written (see
 * `workspace-parity-harness.ts` for how both are proved). The outcome compared is the output, the exit status, every file
 * with its bytes and its permission bits, and the directories left behind. The harness runs both sides without a terminal
 * on stdin, which is the only shape the native side answers.
 */

const harness = new Harness(["init"]);

interface Setup {
    /** Permission bits to set on a file after it is written, in both workspaces. */
    modes?: Record<string, number>;
}

interface State extends Outcome {
    directories: string[];
    modes: Record<string, number>;
}

/** Text as one line, for a message pail wrapped at the width of the harness paths. */
const flat = (text: string): string => text.replaceAll(/\s+/g, " ");

const modeOf = (path: string): number => lstatSync(path).mode % 0o1000;

const state = (result: Result, root: string): State => {
    const modes: Record<string, number> = {};
    const directories: string[] = [];

    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        const path = join(entry.parentPath, entry.name);

        if (entry.isDirectory()) {
            directories.push(relative(root, path));
        } else if (entry.isFile()) {
            modes[relative(root, path)] = modeOf(path);
        }
    }

    return { ...Harness.outcome(result, root), directories: directories.toSorted(), modes };
};

const prepare = (root: string, setup: Setup): void => {
    for (const [name, mode] of Object.entries(setup.modes ?? {})) {
        chmodSync(join(root, name), mode);
    }
};

/** Both sides on identical workspaces; the native one must answer, and everything must match. */
const expectParity = (files: Files, args: string[], setup: Setup = {}, extra: Record<string, string> = {}): State => {
    const [nodeRoot, nativeRoot] = harness.pair(files);

    prepare(nodeRoot, setup);
    prepare(nativeRoot, setup);

    const node = harness.runNode(args, nodeRoot, extra);
    const native = harness.runNative(args, nativeRoot, extra);

    expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    expect(state(native, nativeRoot)).toStrictEqual(state(node, nodeRoot));

    return state(native, nativeRoot);
};

/** The native side declines (exit 70, nothing printed, nothing touched) and the delegated run matches Node. */
const expectDelegation = (files: Files, args: string[], setup: Setup = {}, extra: Record<string, string> = {}, ci = true): State => {
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const probe = harness.materialize("native", files);

    for (const root of [nodeRoot, nativeRoot, probe]) {
        prepare(root, setup);
    }

    const node = harness.runNode(args, nodeRoot, extra, ci);
    const before = state({ status: 0, stderr: "", stdout: "" }, probe);
    const declined = harness.runNative(args, probe, extra, ci);

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect(state({ status: 0, stderr: "", stdout: "" }, probe), "a declined run must not touch the files").toStrictEqual(before);

    const native = harness.runNative(args, nativeRoot, { ...extra, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }, ci);

    expect(state(native, nativeRoot)).toStrictEqual(state(node, nodeRoot));

    return state(native, nativeRoot);
};

const workspace = (extra: Files = {}, manifest: Record<string, unknown> = {}): Files => workspaceFiles(extra, { scripts: { build: "tsc", lint: "oxlint" }, ...manifest });

/** `@visulima/vis/config` resolvable from the workspace, so a config that wraps itself in `defineConfig` can be read as data. */
const VIS_CONFIG_MODULE: Files = {
    "node_modules/@visulima/vis/config.mjs": "export const defineConfig = (config) => config;\n",
    "node_modules/@visulima/vis/package.json": json({ exports: { "./config": "./config.mjs" }, name: "@visulima/vis", type: "module", version: "0.0.0" }),
};

const GENERATED = `import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ security: { policies: { installScripts: { allow: {} }, firstSeen: { minutes: 2880 } } } });\n`;

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis init: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-init-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe("a workspace with no config", () => {
        it.each([[[]], [["--no-interactive"]], [["--force"]], [["--force", "--no-interactive"]]])("writes the secure defaults for `vis init %j`", (args: string[]) => {
            expect.hasAssertions();

            const result = expectParity(workspace(), args);

            expect(flat(result.stdout)).toContain("Created <ROOT>/vis.config.ts");
            expect(Object.keys(result.modes)).toContain("vis.config.ts");
            expect(Object.keys(result.modes)).toContain(".gitignore");
        });

        it("creates the config and the .gitignore with the default mode", () => {
            expect.hasAssertions();

            const result = expectParity(workspace(), []);

            expect(result.modes["vis.config.ts"]).toBe(0o644);
            expect(result.modes[".gitignore"]).toBe(0o644);
        });
    });

    describe("an existing config", () => {
        it.each(["vis.config.ts", "vis.config.mts", "vis.config.js", "vis.config.mjs"])("warns about %s and writes nothing, not even the .gitignore", (name: string) => {
            expect.hasAssertions();

            const result = expectParity(workspace({ [name]: "export default {};\n" }), []);

            expect(flat(result.stderr)).toContain(`Config already exists: <ROOT>/${name}`);
            expect(flat(result.stdout)).toContain("Use --force to overwrite, or edit the existing file.");
            expect(result.status).toBe(0);
            expect(Object.keys(result.modes)).not.toContain(".gitignore");
        });

        it("names the first of several config files, in Node's order", () => {
            expect.hasAssertions();

            const result = expectParity(workspace({ "vis.config.js": "export default {};\n", "vis.config.mjs": "export default {};\n", "vis.config.ts": "export default {};\n" }), []);

            expect(flat(result.stderr)).toContain("<ROOT>/vis.config.ts");
        });

        it("accepts the config `vis init` itself writes, where `defineConfig` resolves", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({ ...VIS_CONFIG_MODULE, "vis.config.ts": GENERATED }), []).status).toBe(0);
            expect(expectParity(workspace({ ...VIS_CONFIG_MODULE, "vis.config.ts": GENERATED }), ["--force"]).status).toBe(0);
        });

        it("accepts a .js config in a package that says `type: module`", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({ "vis.config.js": "export default {};\n" }, { type: "module" }), []).stderr).toContain("Config already exists");
        });

        it.each(["vis.config.ts", "vis.config.mjs"])("overwrites %s with --force, and the new file does not keep the old mode", (name: string) => {
            expect.hasAssertions();

            const result = expectParity(workspace({ [name]: "export default { staged: {} };\n" }), ["--force"], { modes: { [name]: 0o600 } });

            expect(flat(result.stdout)).toContain(`Created <ROOT>/${name}`);
            expect(result.modes[name]).toBe(0o644);
            expect(result.tree[name]).not.toBe(Buffer.from("export default { staged: {} };\n").toString("hex"));
        });

        it("keeps the other config files when --force overwrites the first", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({ "vis.config.js": "export default {};\n", "vis.config.ts": "export default {};\n" }), ["--force"]).stdout).toContain("vis.config.ts");
        });

        it("sets the scaffolded editor and agent files before it reports the existing config", () => {
            expect.hasAssertions();

            const result = expectParity(workspace({ "vis.config.ts": "export default {};\n" }, { devDependencies: { oxfmt: "1.0.0" } }), ["--agent", "--editor", "vscode"]);

            expect(flat(result.stdout)).toContain("Created .ai/instructions");
            expect(flat(result.stderr)).toContain("Config already exists");
        });
    });

    describe(".gitignore", () => {
        it.each([
            ["a file without the entries", "node_modules\ndist\n"],
            ["a file without a final newline", "dist"],
            ["trailing blank lines", "dist\n\n\n\n"],
            ["CRLF line ends", "dist\r\n\r\n"],
            ["a lone carriage return", "dist\rbuild\n"],
            ["one entry already there", ".vis/last-summary.json\n"],
            ["an entry without its slash", ".vis/last-failures\nnode_modules\n"],
            ["an entry with spaces around it", "  .vis/runs/  \n"],
            ["a commented entry", "# .vis/runs/\n"],
            ["a broad .vis rule", ".vis\n"],
            ["a broad .vis/ rule", ".vis/\n"],
            ["a broad .vis/* rule", ".vis/*\n!.vis/templates\n"],
            ["a broad glob rule", "**/.vis/**\n"],
            ["a rule that only looks like .vis", ".visual\n.vis/templates\n"],
            ["every entry", ".vis/last-summary.json\n.vis/last-failures/\n.vis/runs/\n"],
            ["a byte order mark", "\uFEFFdist\n"],
            ["an empty file", ""],
        ])("matches Node for %s", (_label: string, content: string) => {
            expect.hasAssertions();

            expect(expectParity(workspace({ ".gitignore": content }), []).status).toBe(0);
        });

        it("rewrites the file with the default mode, as a new file", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({ ".gitignore": "dist\n" }), [], { modes: { ".gitignore": 0o600 } }).modes[".gitignore"]).toBe(0o644);
        });

        it("replaces a symbolic link with a file, as Node does", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({ ".gitignore": { link: "ignored.txt" }, "ignored.txt": "dist\n" }), []).status).toBe(0);
        });

        it("hands a .gitignore that is not UTF-8 to Node", () => {
            expect.hasAssertions();

            expect(expectDelegation(workspace({ ".gitignore": Buffer.from([0x64, 0x69, 0xff, 0x0a]) }), []).status).toBe(0);
        });

        it("hands a .gitignore that is a directory to Node", () => {
            expect.hasAssertions();

            expect(expectDelegation(workspace({ ".gitignore/keep": "" }), []).status).not.toBe(70);
        });
    });

    describe("--agent", () => {
        it.each([
            ["all three scripts", { build: "tsc", lint: "oxlint", test: "vitest" }],
            ["only the scripts that are strings", { build: "tsc", lint: 1, test: ["x"] }],
            ["no scripts", {}],
        ])("writes the instructions with %s", (_label: string, scripts: Record<string, unknown>) => {
            expect.hasAssertions();

            expect(expectParity(workspaceFiles({}, { scripts }), ["--agent"]).stdout).toContain("Created .ai/instructions");
        });

        it("writes the instructions of a root package.json without scripts, or without a package.json", () => {
            expect.hasAssertions();

            expect(expectParity(workspaceFiles({}, { scripts: undefined }), ["--agent"]).status).toBe(0);
            expect(expectParity({ "pnpm-lock.yaml": "lockfileVersion: 9\n", "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n' }, ["--agent"]).status).toBe(0);
        });

        it("leaves instructions that exist alone and says nothing", () => {
            expect.hasAssertions();

            const result = expectParity(workspace({ ".ai/instructions": "mine\n" }), ["--agent"]);

            expect(flat(result.stdout)).not.toContain(".ai/instructions");
            expect(Buffer.from(result.tree[".ai/instructions"]!, "hex").toString()).toBe("mine\n");
        });

        it("writes the file into an existing .ai directory", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({ ".ai/other.md": "x\n" }), ["--agent"]).stdout).toContain("Created .ai/instructions");
        });

        it.each([
            ["a package.json with a byte order mark", { "package.json": `\uFEFF${json({ name: "root", scripts: { build: "tsc" } })}` }],
            ["a package.json that is not JSON", { "package.json": "{ not json" }],
            ["a package.json with a comment", { "package.json": '{ "name": "root", /* c */ "scripts": { "build": "tsc" } }\n' }],
        ])("hands %s to Node", (_label: string, files: Files) => {
            expect.hasAssertions();

            expect(expectDelegation(workspaceFiles(files), ["--agent"]).status).toBe(0);
        });

        it("hands a .ai that is a file to Node", () => {
            expect.hasAssertions();

            expect(expectDelegation(workspace({ ".ai": "a file" }), ["--agent"]).status).toBe(1);
        });
    });

    describe("--editor vscode", () => {
        it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])("writes the editor files when oxfmt is declared in %s", (field: string) => {
            expect.hasAssertions();

            const result = expectParity(workspace({}, { [field]: { oxfmt: "1.0.0" } }), ["--editor", "vscode"]);

            expect(flat(result.stdout)).toContain("Created .vscode/settings.json");
            expect(flat(result.stdout)).toContain("Created .vscode/extensions.json");
            expect(Object.keys(result.modes)).toContain(".vscode/settings.json");
        });

        it("reads the flag spelled with an equals sign", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({}, { devDependencies: { oxfmt: "1.0.0" } }), ["--editor=vscode"]).stdout).toContain("Created .vscode/settings.json");
        });

        it.each([
            ["no oxfmt", {}],
            ["oxfmt that is not a string", { devDependencies: { oxfmt: 1 } }],
            ["oxfmt in a field Node does not read", { bundledDependencies: { oxfmt: "1.0.0" } }],
        ])("skips .vscode with %s and creates no directory", (_label: string, manifest: Record<string, unknown>) => {
            expect.hasAssertions();

            const result = expectParity(workspace({}, manifest), ["--editor", "vscode"]);

            expect(flat(result.stdout)).toContain("Skipped .vscode");
            expect(result.directories).not.toContain(".vscode");
        });

        it("writes the files into an existing .vscode directory that holds other files", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({ ".vscode/launch.json": "{}\n" }, { devDependencies: { oxfmt: "1.0.0" } }), ["--editor", "vscode"]).stdout).toContain("Created .vscode/settings.json");
        });

        it.each([[".vscode/settings.json"], [".vscode/extensions.json"]])("hands the merge into an existing %s to Node", (name: string) => {
            expect.hasAssertions();

            const result = expectDelegation(workspace({ [name]: '{ "editor.tabSize": 2 }\n' }, { devDependencies: { oxfmt: "1.0.0" } }), ["--editor", "vscode"]);

            expect(flat(result.stdout)).toContain("Merged .vscode");
        });

        it("hands a .vscode that is a file to Node", () => {
            expect.hasAssertions();

            expect(expectDelegation(workspace({ ".vscode": "a file" }, { devDependencies: { oxfmt: "1.0.0" } }), ["--editor", "vscode"]).status).toBe(1);
        });
    });

    describe("--sync-native", () => {
        it.each([
            ["the workspace file of the fixture", 'packages:\n  - "packages/*"\n'],
            ["a file without a final newline", 'packages:\n  - "packages/*"'],
            ["a minimumReleaseAge already set", 'packages:\n  - "packages/*"\nminimumReleaseAge: 10\n'],
            ["an allowBuilds block", 'packages:\n  - "packages/*"\nallowBuilds:\n  esbuild: true\n'],
            ["an onlyBuiltDependencies list", 'packages:\n  - "packages/*"\nonlyBuiltDependencies:\n  - esbuild\n'],
            ["a trailing comment", 'packages:\n  - "packages/*"\n# the end\n'],
        ])("rewrites pnpm-workspace.yaml with %s", (_label: string, yaml: string) => {
            expect.hasAssertions();

            const result = expectParity(workspace({ "pnpm-workspace.yaml": yaml }), ["--sync-native"]);

            expect(flat(result.stdout)).toContain("All 0 allowBuilds entries already present in pnpm-workspace.yaml.");
            expect(flat(result.stdout)).toContain("Updated pnpm-workspace.yaml minimumReleaseAge: 2880 minutes");
        });

        it("does not touch package.json", () => {
            expect.hasAssertions();

            const files = workspace({});
            const result = expectParity(files, ["--sync-native"]);

            expect(result.tree["package.json"]).toBe(Buffer.from(files["package.json"] as string).toString("hex"));
        });

        it("syncs after the config is written, and not at all when a config exists without --force", () => {
            expect.hasAssertions();

            expect(expectParity(workspace(), ["--sync-native", "--force"]).stdout).toContain("minimumReleaseAge");
            expect(expectParity(workspace({ "vis.config.ts": "export default {};\n" }), ["--sync-native"]).stdout).not.toContain("minimumReleaseAge");
        });

        it("hands a workspace file with text the edits do not reproduce to Node", () => {
            expect.hasAssertions();

            expect(expectDelegation(workspace({ "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n# café\n' }), ["--sync-native"]).status).toBe(0);
        });
    });

    describe("--schema", () => {
        it("prints the schema paths and writes nothing", () => {
            expect.hasAssertions();

            const result = expectParity(workspace(), ["--schema"]);

            expect(flat(result.stdout)).toContain("project.json");
            expect(Object.keys(result.modes)).not.toContain("vis.config.ts");
            expect(Object.keys(result.modes)).not.toContain(".gitignore");
        });

        it("prints the same with the other flags, which it ignores, and next to an existing config", () => {
            expect.hasAssertions();

            const plain = expectParity(workspace(), ["--schema"]);

            expect(expectParity(workspace(), ["--schema", "--force", "--agent", "--editor", "vscode", "--sync-native"]).stdout).toBe(plain.stdout);
            expect(expectParity(workspace({ ...VIS_CONFIG_MODULE, "vis.config.ts": GENERATED }), ["--schema"]).stdout).toBe(plain.stdout);
        });

        // The em dash of the closing notice and the arrows are two columns wide for pail, which only shows where a line breaks.
        it.each([40, 41, 52, 60, 70, 74, 75, 76, 77, 78, 79, 80, 81, 90, 100, 120, 160])("wraps like pail at %i columns", (columns: number) => {
            expect.hasAssertions();

            expect(expectParity(workspace(), ["--schema"], {}, { COLUMNS: String(columns) }).status).toBe(0);
        });
    });

    describe("widths and colour", () => {
        it.each([40, 60, 77, 80, 100])("wraps the notices and the created path like pail at %i columns", (columns: number) => {
            expect.hasAssertions();

            expect(expectParity(workspace({}, { devDependencies: { oxfmt: "1" } }), ["--agent", "--editor", "vscode", "--sync-native"], {}, { COLUMNS: String(columns) }).status).toBe(0);
        });

        it.each([{ GITHUB_ACTIONS: "true" }, { FORCE_COLOR: "1" }, { FORCE_COLOR: "3" }, { NO_COLOR: "1" }, { TERM: "xterm-256color" }])("colours the headers like pail with %j", (environment: Record<string, string>) => {
            expect.hasAssertions();

            expect(expectParity(workspace(), ["--force"], {}, environment).status).toBe(0);
        });
    });

    describe("every flag together", () => {
        it("answers the full set", () => {
            expect.hasAssertions();

            expect(expectParity(workspace({ ".gitignore": "dist\n" }, { devDependencies: { oxfmt: "1" } }), ["--force", "--agent", "--editor", "vscode", "--sync-native", "--no-interactive"]).status).toBe(0);
        });
    });

    describe("shapes the binary hands to Node before it prints or writes anything", () => {
        it.each([
            ["--yes, which is not an option of init", ["--yes"], 1],
            ["--interactive", ["--interactive"], 0],
            ["another editor", ["--editor", "zed"], 1],
            ["--editor without a value", ["--editor"], 1],
            ["a repeated flag", ["--force", "--force"], 0],
            ["a positional", ["extra"], 1],
            ["a value on a flag", ["--force=true"], 0],
        ])("%s", (_label: string, args: string[], status: number) => {
            expect.hasAssertions();

            expect(expectDelegation(workspace(), args).status).toBe(status);
        });

        it.each([
            ["a config that needs evaluating", "export default { x: process.env.CI };\n"],
            ["a config key only Node reads", 'export default { runtime: "bun" };\n'],
        ])("an existing config with %s", (_label: string, config: string) => {
            expect.hasAssertions();

            expect(expectDelegation(workspace({ "vis.config.ts": config }), []).status).toBe(0);
        });

        it.each(
            [
                ["vis.config.cts", {}],
                ["vis.config.cjs", {}],
                ["vis.config.js", { type: "commonjs" }],
            ].flatMap(([name, manifest]) => [[], ["--force"], ["--schema"]].map((args) => [name, manifest, args] as const)),
        )("an existing %s that Node fails to load as an ES module, in %j, with %j", (name: string, manifest: Record<string, unknown>, args: string[]) => {
            expect.hasAssertions();

            expect(flat(expectDelegation(workspace({ [name]: "export default {};\n" }, manifest), args).stderr)).toContain("Failed to load");
        });

        it("a config that wraps itself in `defineConfig` where `@visulima/vis` does not resolve", () => {
            expect.hasAssertions();

            expect(expectDelegation(workspace({ "vis.config.ts": GENERATED }), []).stderr).toContain("Failed to load");
        });

        it("an existing config that is a symbolic link", () => {
            expect.hasAssertions();

            expect(expectDelegation(workspace({ "real.config.ts": "export default {};\n", "vis.config.ts": { link: "real.config.ts" } }), []).status).toBe(0);
        });

        // The error Node prints names its own temporary file, whose suffix is random.
        it.skipIf(process.getuid?.() === 0)("a target directory that refuses a new file, which the binary finds before it renames anything", () => {
            expect.hasAssertions();

            const files = workspace();
            const [nodeRoot, nativeRoot] = harness.pair({ ...files, ".ai/keep": "" });
            const probe = harness.materialize("native", { ...files, ".ai/keep": "" });
            const unnamed = (text: string): string => text.replaceAll(/instructions\.[0-9a-z]+\.[0-9a-f]+\.tmp/g, "instructions.TMP");

            try {
                for (const root of [nodeRoot, nativeRoot, probe]) {
                    chmodSync(join(root, ".ai"), 0o555);
                }

                const node = harness.runNode(["--agent"], nodeRoot);
                const declined = harness.runNative(["--agent"], probe);
                const native = harness.runNative(["--agent"], nativeRoot, { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

                expect(declined.status).toBe(70);
                expect(declined.stdout).toBe("");
                expect(readdirSync(probe, { recursive: true })).not.toContain(".gitignore");
                expect(node.status).toBe(1);

                const normalised = (result: Result, root: string) => {
                    return { status: result.status, stderr: unnamed(Harness.normalize(result.stderr, root)), stdout: unnamed(Harness.normalize(result.stdout, root)) };
                };

                expect(normalised(native, nativeRoot)).toStrictEqual(normalised(node, nodeRoot));
            } finally {
                for (const root of [nodeRoot, nativeRoot, probe]) {
                    chmodSync(join(root, ".ai"), 0o755);
                }
            }
        });

        it("a run outside CI", () => {
            expect.hasAssertions();

            expect(expectDelegation(workspace(), [], {}, {}, false).status).toBe(0);
        });

        it.each([{ NODE_ENV: "test" }, { DEBUG: "vis" }, { PAIL_LOG_LEVEL: "error" }])("a run with %j", (environment: Record<string, string>) => {
            expect.hasAssertions();

            expect(expectDelegation(workspace(), [], {}, environment).status).toBe(0);
        });
    });
});
