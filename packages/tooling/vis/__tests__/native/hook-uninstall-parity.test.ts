import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import { tree } from "./destructive-parity-harness";
import type { Setup } from "./hook-git-harness";
import { commitAll, git, hookOutcome, hooksPath, ISOLATED_GIT, NODE_FALLBACK, prepare, state } from "./hook-git-harness";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis hook uninstall` exists twice: the Node handler (`src/commands/hook/{handler,uninstall}.ts`) and the native fast
 * path (`native/cli/src/hook/uninstall.rs`). The native one answers a `core.hooksPath` that names the vis dispatcher
 * (or none at all): it unsets the key, removes the dispatcher directory of each checkout and prints the same two lines.
 * Everything else is handed to Node before anything is printed or changed. The outcome compared is the output, the
 * exit status, every file, its permission bits and `core.hooksPath` (see `hook-install-parity.test.ts`).
 */

const harness = new Harness(["hook", "uninstall"]);

const DISPATCHER: Files = { ".vis/hooks/_/.gitignore": "*", ".vis/hooks/_/h": "#!/usr/bin/env sh\n", ".vis/hooks/_/pre-commit": "#!/usr/bin/env sh\n", ".vis/hooks/pre-commit": "#!/usr/bin/env sh\n" };

const installed: Setup = { config: { "core.hooksPath": ".vis/hooks/_" } };

const run = (files: Files, args: string[], setup: Setup, environment: Record<string, string>, delegated: boolean) => {
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const env = { ...ISOLATED_GIT, ...environment };

    prepare(nodeRoot, setup);
    prepare(nativeRoot, setup);

    const node = harness.runNode(args, nodeRoot, env);

    if (delegated) {
        const probe = harness.materialize("native", files);

        prepare(probe, setup);

        const before = state(probe);
        const declined = harness.runNative(args, probe, env);

        expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
        expect(declined.stdout, "a declined run prints nothing").toBe("");
        expect(state(probe), "a declined run must not change core.hooksPath or a file").toStrictEqual(before);
    }

    const native = harness.runNative(args, nativeRoot, delegated ? { ...env, ...NODE_FALLBACK } : env);

    if (!delegated) {
        expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    }

    expect(hookOutcome(native, nativeRoot)).toStrictEqual(hookOutcome(node, nodeRoot));

    return { native, nativeRoot };
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis hook uninstall: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-hook-uninstall-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    const parity = (files: Files = workspaceFiles(DISPATCHER), args: string[] = [], setup: Setup = installed, environment: Record<string, string> = {}) =>
        run(files, args, setup, environment, false);

    const delegation = (files: Files = workspaceFiles(DISPATCHER), args: string[] = [], setup: Setup = installed, environment: Record<string, string> = {}) =>
        run(files, args, setup, environment, true);

    describe("accepted shapes", () => {
        it("unsets core.hooksPath and removes the dispatcher, keeping the stage scripts", () => {
            expect.hasAssertions();

            const { native, nativeRoot } = parity();

            expect(native.stdout).toBe("Removing git hooks...\nGit hooks removed successfully.\n");
            expect(native.status).toBe(0);
            expect(hooksPath(nativeRoot)).toBeUndefined();
            expect(existsSync(join(nativeRoot, ".vis/hooks/_"))).toBe(false);
            expect(existsSync(join(nativeRoot, ".vis/hooks/pre-commit"))).toBe(true);
        });

        it("unsets core.hooksPath when the dispatcher is already gone", () => {
            expect.hasAssertions();

            parity(workspaceFiles({ ".vis/hooks/pre-commit": "#!/usr/bin/env sh\n" }));
        });

        it("removes a dispatcher with a nested directory and a read-only file", () => {
            expect.hasAssertions();

            const files = workspaceFiles({ ...DISPATCHER, ".vis/hooks/_/sub/deeper/file": "x\n" });
            const [nodeRoot, nativeRoot] = harness.pair(files);

            for (const root of [nodeRoot, nativeRoot]) {
                prepare(root, installed);
                chmodSync(join(root, ".vis/hooks/_/h"), 0o444);
            }

            const node = harness.runNode([], nodeRoot, ISOLATED_GIT);
            const native = harness.runNative([], nativeRoot, ISOLATED_GIT);

            expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
            expect(hookOutcome(native, nativeRoot)).toStrictEqual(hookOutcome(node, nodeRoot));
            expect(existsSync(join(nativeRoot, ".vis/hooks/_"))).toBe(false);
        });

        it("reads an empty core.hooksPath as the default dispatcher", () => {
            expect.hasAssertions();

            parity(workspaceFiles(DISPATCHER), [], { config: { "core.hooksPath": "" } });
        });

        it("reports a repository that has no core.hooksPath, and changes nothing", () => {
            expect.hasAssertions();

            const { native } = parity(workspaceFiles(DISPATCHER), [], {});

            expect(native.stdout).toBe("Removing git hooks...\nNo custom hooks path configured\n");
        });

        it("reports a directory that is not a git repository", () => {
            expect.hasAssertions();

            const { native } = parity(workspaceFiles(DISPATCHER), [], { repository: false });

            expect(native.stdout).toBe("Removing git hooks...\nNo custom hooks path configured\n");
        });

        it.each([[["--hooks-dir", ".githooks"], ".githooks"], [["--hooks-dir=ci/hooks"], "ci/hooks"]])("removes the dispatcher of the directory given as %j", (args, directory) => {
            expect.hasAssertions();

            parity(workspaceFiles({ [`${directory}/_/h`]: "x\n", [`${directory}/pre-commit`]: "x\n" }), args, { config: { "core.hooksPath": `${directory}/_` } });
        });

        it("accepts a core.hooksPath with a checkout prefix", () => {
            expect.hasAssertions();

            parity(workspaceFiles({ "sub/.vis/hooks/_/h": "x\n" }), [], { config: { "core.hooksPath": "sub/.vis/hooks/_" } });
        });

        it("leaves a dispatcher that is a link that leads nowhere", () => {
            expect.hasAssertions();

            parity(workspaceFiles({ ".vis/hooks/_": { link: "missing" } }));
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("prints what Node does under %j", (...[environment]: Record<string, string>[]) => {
            expect.hasAssertions();

            parity(workspaceFiles(DISPATCHER), [], installed, environment);
        });
    });

    describe("outcomes handed to Node", () => {
        it.each([[".githooks/_"], [".husky/_"], ["/nowhere/.vis/hooks/_"], [".git/hooks"], ["../outside/.vis/hooks/_"], ["./.vis/hooks/_"], [".vis/hooks"]])("a core.hooksPath of %s is removed by Node, wherever it points", (value) => {
            expect.hasAssertions();

            delegation(workspaceFiles({ ...DISPATCHER, ".githooks/_/pre-commit": "x\n", ".husky/_/h": "x\n" }), [], { config: { "core.hooksPath": value } });
        });

        it("a dispatcher that is a link is removed as a link by Node", () => {
            expect.hasAssertions();

            delegation(workspaceFiles({ ".vis/hooks/_": { link: "../../elsewhere" }, "elsewhere/keep": "x\n" }));
        });

        it("a dispatcher that is a file is removed by Node", () => {
            expect.hasAssertions();

            delegation(workspaceFiles({ ".vis/hooks/_": "not a directory\n" }));
        });

        it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("a dispatcher that cannot be removed is Node's warning", () => {
            expect.hasAssertions();

            const files = workspaceFiles(DISPATCHER);
            const [nodeRoot, nativeRoot] = harness.pair(files);
            const probe = harness.materialize("native", files);
            const roots = [nodeRoot, nativeRoot, probe];

            for (const root of roots) {
                prepare(root, installed);
                chmodSync(join(root, ".vis/hooks/_"), 0o555);
            }

            try {
                const node = harness.runNode([], nodeRoot, ISOLATED_GIT);
                const before = state(probe);
                const declined = harness.runNative([], probe, ISOLATED_GIT);

                expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
                expect(state(probe), "core.hooksPath is still set when the run is handed over").toStrictEqual(before);

                const native = harness.runNative([], nativeRoot, { ...ISOLATED_GIT, ...NODE_FALLBACK });

                expect(hookOutcome(native, nativeRoot)).toStrictEqual(hookOutcome(node, nodeRoot));
                expect(node.stderr).toContain("could not remove 1 dispatcher director(ies)");
            } finally {
                for (const root of roots) {
                    chmodSync(join(root, ".vis/hooks/_"), 0o755);
                }
            }
        });

        // `chflags uchg` makes a file refuse removal for its owner, which no permission check before the run can see.
        it.skipIf(process.platform !== "darwin")("a removal that fails after core.hooksPath was unset puts it back and is finished by Node", () => {
            expect.hasAssertions();

            const files = workspaceFiles(DISPATCHER);
            const [nodeRoot, nativeRoot] = harness.pair(files);
            const locked = [".vis/hooks/_/h"];

            for (const root of [nodeRoot, nativeRoot]) {
                prepare(root, installed);
                execFileSync("chflags", ["uchg", ...locked.map((name) => join(root, name))]);
            }

            try {
                const node = harness.runNode([], nodeRoot, ISOLATED_GIT);
                const native = harness.runNative([], nativeRoot, { ...ISOLATED_GIT, ...NODE_FALLBACK });

                expect(node.stderr).toContain("could not remove 1 dispatcher director(ies)");
                expect(hookOutcome(native, nativeRoot)).toStrictEqual(hookOutcome(node, nodeRoot));
            } finally {
                for (const root of [nodeRoot, nativeRoot]) {
                    execFileSync("chflags", ["nouchg", ...locked.map((name) => join(root, name))]);
                }
            }
        });

        it("a linked worktree has a dispatcher of its own, which is removed too", () => {
            expect.hasAssertions();

            const [nodeRoot, nativeRoot] = harness.pair(workspaceFiles({ tracked: "x\n" }));

            for (const root of [nodeRoot, nativeRoot]) {
                prepare(root, installed);
                commitAll(root);
                git(root, "worktree", "add", "-q", `${root}-wt`);

                for (const checkout of [root, `${root}-wt`]) {
                    mkdirSync(join(checkout, ".vis/hooks/_"), { recursive: true });
                    writeFileSync(join(checkout, ".vis/hooks/_/h"), "x\n");
                    symlinkSync("x", join(checkout, ".vis/hooks/_/link"));
                }
            }

            const node = harness.runNode([], nodeRoot, ISOLATED_GIT);
            const native = harness.runNative([], nativeRoot, ISOLATED_GIT);

            expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
            expect(Harness.normalize(native.stdout, nativeRoot)).toBe(Harness.normalize(node.stdout, nodeRoot));

            expect(tree(`${nativeRoot}-wt`)).toStrictEqual(tree(`${nodeRoot}-wt`));
            expect(existsSync(join(`${nativeRoot}-wt`, ".vis/hooks/_"))).toBe(false);
            expect(hooksPath(nativeRoot)).toBeUndefined();
        });

        it.each([[["--json"]], [["extra"]], [["--force"]], [["--hooks-dir"]], [["--hooks-dir", "/abs"]], [["--hooks-dir", "a/../b"]], [["--hooks-dir", "123"]]])("`hook uninstall %j` is declined", (args) => {
            expect.hasAssertions();

            delegation(workspaceFiles(DISPATCHER), args);
        });

        it("a run outside CI is declined", () => {
            expect.hasAssertions();

            const [, nativeRoot] = harness.pair(workspaceFiles(DISPATCHER));

            prepare(nativeRoot, installed);

            expect(harness.runNative([], nativeRoot, { ...ISOLATED_GIT, VIS_CLI_TEST: "1" }, false).status).toBe(70);
            expect(hooksPath(nativeRoot)).toBe(".vis/hooks/_");
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("%j is declined", (environment) => {
            expect.hasAssertions();

            delegation(workspaceFiles(DISPATCHER), [], installed, environment);
        });

        it.each([{ NODE_ENV: "test" }, { DEBUG: "vis" }, { PAIL_LOG_LEVEL: "debug" }, { CEREBRO_OUTPUT_LEVEL: "4" }])("the output setting %j is declined", (environment) => {
            expect.hasAssertions();

            delegation(workspaceFiles(DISPATCHER), [], installed, environment);
        });
    });
});

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis hook uninstall under a path that is not ASCII", () => {
    const unicode = new Harness(["hook", "uninstall"]);

    beforeAll(() => {
        unicode.setup("vis-hook-uninstall-ä-");
    });

    afterAll(() => {
        unicode.teardown();
    });

    it("hands over, because git prints the linked worktrees as UTF-8 text", () => {
        expect.hasAssertions();

        const [nodeRoot, nativeRoot] = unicode.pair(workspaceFiles(DISPATCHER));

        for (const root of [nodeRoot, nativeRoot]) {
            prepare(root, installed);
        }

        const node = unicode.runNode([], nodeRoot, ISOLATED_GIT);
        const declined = unicode.runNative([], nativeRoot, ISOLATED_GIT);

        expect(node.status).toBe(0);
        expect(declined.status).toBe(70);
        expect(hooksPath(nativeRoot)).toBe(".vis/hooks/_");
    });
});
