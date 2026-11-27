import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Setup } from "./hook-git-harness";
import { commitAll, git, hookOutcome, hooksPath, ISOLATED_GIT, modeOf, prepare, state } from "./hook-git-harness";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis hook install` exists twice: the Node handler (`src/commands/hook/{handler,install}.ts`) and the native fast path
 * (`native/cli/src/hook/install.rs`). The native one answers a repository with one checkout where nothing else claims
 * the hooks, and writes the same dispatcher files with the same modes, sets the same `core.hooksPath` and prints the
 * same two lines. Every other shape is handed to Node before anything is printed (see `workspace-parity-harness.ts`
 * for how both are proved). The outcome compared is the output, the exit status, every file, its permission bits and
 * `core.hooksPath`.
 */

const harness = new Harness(["hook", "install"]);

const GOOD_CONFIG = `${JSON.stringify({ stages: { "pre-commit": [{ entry: "echo ok", id: "echo" }] }, version: 1 })}\n`;

interface Case extends Setup {
    /** Run the Node install in both workspaces first, so the run under test is a second one. */
    installed?: boolean;
}

const run = (files: Files, args: string[], setup: Case, environment: Record<string, string>, delegated: "declined" | "partial" | false) => {
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const env = { ...ISOLATED_GIT, ...environment };

    for (const root of [nodeRoot, nativeRoot]) {
        prepare(root, setup);

        if (setup.installed) {
            harness.runNode(args, root, env);
        }
    }

    const node = harness.runNode(args, nodeRoot, env);

    if (delegated) {
        const probe = harness.materialize("native", files);

        prepare(probe, setup);

        if (setup.installed) {
            harness.runNode(args, probe, env);
        }

        const before = state(probe);
        const declined = harness.runNative(args, probe, env);

        expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
        expect(declined.stdout, "a declined run prints nothing").toBe("");

        if (delegated === "declined") {
            expect(state(probe), "a declined run must not change core.hooksPath or a file").toStrictEqual(before);
        }
    }

    const native = harness.runNative(args, nativeRoot, delegated ? { ...env, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath } : env);

    if (!delegated) {
        expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    }

    expect(hookOutcome(native, nativeRoot)).toStrictEqual(hookOutcome(node, nodeRoot));

    return { native, nativeRoot, node: hookOutcome(node, nodeRoot) };
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis hook install: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-hook-install-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    const parity = (files: Files = workspaceFiles({}), args: string[] = [], setup: Case = {}, environment: Record<string, string> = {}) =>
        run(files, args, setup, environment, false);

    const delegation = (files: Files = workspaceFiles({}), args: string[] = [], setup: Case = {}, environment: Record<string, string> = {}, mode: "declined" | "partial" = "declined") =>
        run(files, args, setup, environment, mode);

    describe("accepted shapes", () => {
        it("installs the dispatcher, sets core.hooksPath and creates pre-commit", () => {
            expect.hasAssertions();

            const { native, nativeRoot } = parity();

            expect(native.stdout).toBe("Installing git hooks in .vis/hooks/...\nGit hooks installed successfully.\n");
            expect(native.status).toBe(0);
            expect(hooksPath(nativeRoot)).toBe(".vis/hooks/_");
            expect(modeOf(nativeRoot, ".vis/hooks/_/h")).toBe("755");
            expect(modeOf(nativeRoot, ".vis/hooks/_/.gitignore")).not.toBe("755");
            expect(modeOf(nativeRoot, ".vis/hooks/pre-commit")).toBe("755");
        });

        it("installs over an installation, keeping the modes of the files it rewrites", () => {
            expect.hasAssertions();

            parity(workspaceFiles({}), [], { installed: true });
        });

        it("keeps the mode of a dispatcher file and of a pre-commit that someone changed", () => {
            expect.hasAssertions();

            // The changed modes are applied after the first install, on both sides, so the pair is run by hand.
            const [nodeRoot, nativeSide] = harness.pair(workspaceFiles({}));

            for (const root of [nodeRoot, nativeSide]) {
                prepare(root, {});
                harness.runNode([], root, ISOLATED_GIT);
                chmodSync(join(root, ".vis/hooks/_/h"), 0o700);
                chmodSync(join(root, ".vis/hooks/_/pre-push"), 0o644);
                chmodSync(join(root, ".vis/hooks/pre-commit"), 0o600);
            }

            const node = harness.runNode([], nodeRoot, ISOLATED_GIT);
            const native = harness.runNative([], nativeSide, ISOLATED_GIT);

            expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
            expect(hookOutcome(native, nativeSide)).toStrictEqual(hookOutcome(node, nodeRoot));
            expect(modeOf(nativeSide, ".vis/hooks/_/h")).toBe("700");
        });

        it("leaves an existing pre-commit alone", () => {
            expect.hasAssertions();

            const { nativeRoot } = parity(workspaceFiles({ ".vis/hooks/pre-commit": "#!/bin/sh\nexec vis hook run pre-commit \"$@\"\n" }));

            expect(modeOf(nativeRoot, ".vis/hooks/pre-commit")).not.toBe("755");
        });

        it("accepts a core.hooksPath that already names the dispatcher", () => {
            expect.hasAssertions();

            parity(workspaceFiles({}), [], { config: { "core.hooksPath": ".vis/hooks/_" } });
        });

        it("replaces a core.hooksPath that only the user's global configuration set", () => {
            expect.hasAssertions();

            const directory = mkdtempSync(join(tmpdir(), "vis-hook-install-global-"));
            const file = join(directory, "gitconfig");

            writeFileSync(file, "[core]\n\thooksPath = /nowhere/else\n");

            try {
                const { native, nativeRoot } = parity(workspaceFiles({}), [], {}, { GIT_CONFIG_GLOBAL: file });

                expect(native.stdout).toContain("installed successfully");
                expect(hooksPath(nativeRoot)).toBe(".vis/hooks/_");
            } finally {
                rmSync(directory, { force: true, recursive: true });
            }
        });

        it.each([[["--hooks-dir", ".githooks"]], [["--hooks-dir=ci/hooks"]], [["--hooks-dir", "a/b/c/d"]]])("installs in the directory given as %j", (args) => {
            expect.hasAssertions();

            parity(workspaceFiles({}), args);
            parity(workspaceFiles({}), args, { installed: true });
        });

        it("bakes skipInCI of config.json into the dispatcher", () => {
            expect.hasAssertions();

            const config = `${JSON.stringify({ skipInCI: true, stages: {}, version: 1 })}\n`;
            const { nativeRoot } = parity(workspaceFiles({ ".vis/hooks/config.json": config }));

            expect(Harness.snapshot(nativeRoot)[".vis/hooks/_/h"]).toContain(Buffer.from("[ -n \"${CI-}\" ]").toString("hex"));
        });

        it.each([[`${JSON.stringify({ skipInCI: false, stages: {}, version: 1 })}\n`], [GOOD_CONFIG], [`${JSON.stringify({ extra: 1, stages: {}, version: 1 })}\n`]])("reads a config.json that leaves it off: %s", (config) => {
            expect.hasAssertions();

            parity(workspaceFiles({ ".vis/hooks/config.json": config }));
        });

        it("reports a directory that is not a git repository", () => {
            expect.hasAssertions();

            const { native } = parity(workspaceFiles({}), [], { repository: false });

            expect(native.stdout).toBe("Installing git hooks in .vis/hooks/...\n.git directory not found (not a git repository)\n");
        });

        it("reports that VIS_GIT_HOOKS=0 disables it, and writes nothing", () => {
            expect.hasAssertions();

            const { native, nativeRoot } = parity(workspaceFiles({}), [], {}, { VIS_GIT_HOOKS: "0" });

            expect(native.stdout).toBe("Installing git hooks in .vis/hooks/...\nskip install (git hooks disabled via VIS_GIT_HOOKS=0)\n");
            expect(existsSync(join(nativeRoot, ".vis"))).toBe(false);
        });

        it.each(["1", "2", "false"])("installs under VIS_GIT_HOOKS=%s", (value) => {
            expect.hasAssertions();

            parity(workspaceFiles({}), [], {}, { VIS_GIT_HOOKS: value });
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("prints what Node does under %j", (...[environment]: Record<string, string>[]) => {
            expect.hasAssertions();

            parity(workspaceFiles({}), [], {}, environment);
        });
    });

    describe("outcomes handed to Node", () => {
        it.each([[".husky"], [".config/husky"]])("a husky directory (%s) is a question", (directory) => {
            expect.hasAssertions();

            delegation(workspaceFiles({ [`${directory}/pre-commit`]: "npx lint\n" }));
        });

        it.each([[".pre-commit-config.yaml"], [".pre-commit-config.yml"], ["prek.toml"]])("a prek configuration (%s) is a question", (file) => {
            expect.hasAssertions();

            delegation(workspaceFiles({ [file]: "repos: []\n" }));
        });

        it("a pre-1.0 .vis-hooks directory is moved by Node", () => {
            expect.hasAssertions();

            delegation(workspaceFiles({ ".vis-hooks/config.json": GOOD_CONFIG, ".vis-hooks/pre-commit": "#!/bin/sh\n" }));
        });

        it.each([[".githooks/_"], ["sub/.vis/hooks/_"], ["/nowhere/.vis/hooks/_"], [".git/hooks"]])("a core.hooksPath of %s is arbitrated by Node", (value) => {
            expect.hasAssertions();

            delegation(workspaceFiles({}), [], { config: { "core.hooksPath": value } });
        });

        it("a core.hooksPath that holds another tool's hooks is left alone", () => {
            expect.hasAssertions();

            delegation(workspaceFiles({ ".githooks/_/pre-commit": "#!/bin/sh\n" }), [], { config: { "core.hooksPath": ".githooks/_" } });
        });

        it("--force takes the hooks path over", () => {
            expect.hasAssertions();

            delegation(workspaceFiles({}), ["--force"], { config: { "core.hooksPath": ".githooks/_" } });
        });

        it("a working directory below the top level of the repository is Node's", () => {
            expect.hasAssertions();

            const files: Files = Object.fromEntries(Object.entries(workspaceFiles({})).map(([name, content]) => [`ws/${name}`, content]));
            const [nodeRoot, nativeRoot] = harness.pair(files);

            for (const root of [nodeRoot, nativeRoot]) {
                git(root, "init", "-q");
            }

            const nodeCwd = join(nodeRoot, "ws");
            const nativeCwd = join(nativeRoot, "ws");
            const node = harness.runNode([], nodeCwd, ISOLATED_GIT);
            const declined = harness.runNative([], harness.materialize("native", files), ISOLATED_GIT);

            expect(declined.status).toBe(70);

            const native = harness.runNative([], nativeCwd, { ...ISOLATED_GIT, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

            expect({ status: native.status, stderr: Harness.normalize(native.stderr, nativeRoot), stdout: Harness.normalize(native.stdout, nativeRoot) }).toStrictEqual({
                status: node.status,
                stderr: Harness.normalize(node.stderr, nodeRoot),
                stdout: Harness.normalize(node.stdout, nodeRoot),
            });
            expect(hooksPath(nativeRoot)).toBe(hooksPath(nodeRoot));
            expect(hooksPath(nativeRoot)).toBe("ws/.vis/hooks/_");
        });

        it("a repository with a linked worktree needs a dispatcher in each checkout", () => {
            expect.hasAssertions();

            const files = workspaceFiles({});
            const [nodeRoot, nativeRoot] = harness.pair(files);

            for (const root of [nodeRoot, nativeRoot]) {
                prepare(root, {});
                commitAll(root);
                git(root, "worktree", "add", "-q", `${root}-wt`);
            }

            const node = harness.runNode([], nodeRoot, ISOLATED_GIT);

            expect(harness.runNative([], nativeRoot, ISOLATED_GIT).status).toBe(70);

            const native = harness.runNative([], nativeRoot, { ...ISOLATED_GIT, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

            expect(Harness.normalize(native.stdout, nativeRoot)).toBe(Harness.normalize(node.stdout, nodeRoot));
            expect(existsSync(join(`${nativeRoot}-wt`, ".vis/hooks/_/h"))).toBe(true);
            expect(existsSync(join(`${nodeRoot}-wt`, ".vis/hooks/_/h"))).toBe(true);
        });

        it.each(["{ not json", "[]", "null", '{"version":2,"stages":{}}', '{"version":1}', '{"version":1,"stages":{"pre-commit":{}}}'])("a config.json that is %s", (config) => {
            expect.hasAssertions();

            delegation(workspaceFiles({ ".vis/hooks/config.json": `${config}\n` }));
        });

        it("a pre-commit that is a broken symbolic link is declined", () => {
            expect.hasAssertions();

            delegation(workspaceFiles({ ".vis/hooks/pre-commit": { link: "missing" } }));
        });

        it("a write that fails after the first one is finished by Node, which ends in the same tree", () => {
            expect.hasAssertions();

            // `h` is a directory, so the dispatcher is written up to `.gitignore` and then fails.
            const result = delegation(workspaceFiles({ ".vis/hooks/_/h/keep": "x\n" }), [], {}, {}, "partial");

            expect(result.node.status).toBe(1);
            expect(result.node.hooksPath, "core.hooksPath is only set once the dispatcher is written").toBeUndefined();
        });

        it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("a dispatcher directory that cannot be written is Node's error", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ".vis/hooks/_/.keep": "" });
            const [nodeRoot, nativeRoot] = harness.pair(files);

            for (const root of [nodeRoot, nativeRoot]) {
                prepare(root, {});
                chmodSync(join(root, ".vis/hooks/_"), 0o555);
            }

            try {
                const node = harness.runNode([], nodeRoot, ISOLATED_GIT);
                const native = harness.runNative([], nativeRoot, { ...ISOLATED_GIT, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

                expect(node.status).toBe(1);
                expect(hookOutcome(native, nativeRoot)).toStrictEqual(hookOutcome(node, nodeRoot));
            } finally {
                for (const root of [nodeRoot, nativeRoot]) {
                    chmodSync(join(root, ".vis/hooks/_"), 0o755);
                }
            }
        });

        it.each([["a..b"], ["x/y..z"], ["..a"]])("a hooks directory with `..` in it (%s) is Node's error", (directory) => {
            expect.hasAssertions();

            const result = delegation(workspaceFiles({}), ["--hooks-dir", directory]);

            expect(result.node.status).toBe(1);
            expect(result.node.stderr).toContain("\"..\" is not allowed in hooks directory path");
        });

        it.each([[["--json"]], [["extra"]], [["--hooks-dir"]], [["--hooks-dir", "/abs"]], [["--hooks-dir", "a/../b"]], [["--hooks-dir", "123"]], [["--force", "--hooks-dir", ".githooks"]]])("`hook install %j` is declined", (args) => {
            expect.hasAssertions();

            delegation(workspaceFiles({}), args);
        });

        it("a run outside CI is declined", () => {
            expect.hasAssertions();

            const [, nativeRoot] = harness.pair(workspaceFiles({}));

            prepare(nativeRoot, {});

            expect(harness.runNative([], nativeRoot, { ...ISOLATED_GIT, VIS_CLI_TEST: "1" }, false).status).toBe(70);
            expect(existsSync(join(nativeRoot, ".vis"))).toBe(false);
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("%j is declined", (environment) => {
            expect.hasAssertions();

            delegation(workspaceFiles({}), [], {}, environment);
        });

        it.each([{ NODE_ENV: "test" }, { DEBUG: "vis" }, { PAIL_LOG_LEVEL: "debug" }, { CEREBRO_OUTPUT_LEVEL: "4" }])("the output setting %j is declined", (environment) => {
            expect.hasAssertions();

            delegation(workspaceFiles({}), [], {}, environment);
        });
    });
});

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis hook install under a path that is not ASCII", () => {
    const unicode = new Harness(["hook", "install"]);

    beforeAll(() => {
        unicode.setup("vis-hook-install-ä-");
    });

    afterAll(() => {
        unicode.teardown();
    });

    it("hands over, because git prints the top level as UTF-8 text", () => {
        expect.hasAssertions();

        const [nodeRoot, nativeRoot] = unicode.pair(workspaceFiles({}));

        for (const root of [nodeRoot, nativeRoot]) {
            prepare(root, {});
        }

        const node = unicode.runNode([], nodeRoot, ISOLATED_GIT);
        const declined = unicode.runNative([], nativeRoot, ISOLATED_GIT);

        expect(node.status).toBe(0);
        expect(declined.status).toBe(70);
        expect(existsSync(join(nativeRoot, ".vis"))).toBe(false);
    });
});
