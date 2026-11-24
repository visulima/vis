import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis hook validate` exists twice: the Node handler (`src/commands/hook/validate.ts`) and the native fast path
 * (`native/cli/src/hook/validate.rs`). The native one answers only a hooks directory with nothing to report ("looks
 * good", exit 0); every warning and every error is handed to Node before anything is printed, because Node logs them
 * through pail and ends in a thrown error (see `workspace-parity-harness.ts` for how both are proved).
 */

const harness = new Harness(["hook", "validate"]);

const GOOD_SCRIPT = "#!/usr/bin/env sh\nexec vis hook run pre-commit \"$@\"\n";
const GOOD_CONFIG = `${JSON.stringify({ stages: { "pre-commit": [{ entry: "echo ok", id: "echo" }] }, version: 1 })}\n`;

interface Setup {
    /** What `git config --local core.hooksPath` is set to; `false` leaves it unset. */
    hooksPath?: false | string;
    /** Whether the directory is a git repository. */
    repository?: boolean;
}

const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, env: { ...Harness.environment(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
};

/** A repository in `root`, its stage scripts made executable, `core.hooksPath` set. */
const prepare = (root: string, directory: string, setup: Setup, executable: string[]): void => {
    if (setup.repository !== false) {
        git(root, "init", "-q");

        if (setup.hooksPath !== false) {
            git(root, "config", "--local", "core.hooksPath", setup.hooksPath ?? `${directory}/_`);
        }
    }

    for (const file of executable) {
        chmodSync(join(root, file), 0o755);
    }
};

const withoutGit = (outcome: ReturnType<typeof Harness.outcome>): ReturnType<typeof Harness.outcome> => {
    return { ...outcome, tree: Object.fromEntries(Object.entries(outcome.tree).filter(([name]) => !name.startsWith(".git/"))) };
};

/** A workspace whose hooks directory holds `scripts` (executable) and `extra`, with the dispatcher directory in place. */
const project = (scripts: Record<string, string>, extra: Files = {}, directory = ".vis/hooks"): { executable: string[]; files: Files } => {
    return {
        executable: Object.keys(scripts).map((stage) => `${directory}/${stage}`),
        files: workspaceFiles({
            ...Object.fromEntries(Object.entries(scripts).map(([stage, content]) => [`${directory}/${stage}`, content])),
            [`${directory}/_/.gitignore`]: "*\n",
            ...extra,
        }),
    };
};

const run = (files: Files, executable: string[], args: string[], setup: Setup, environment: Record<string, string>, delegated: boolean) => {
    const directory = args.find((argument) => argument.startsWith("--hooks-dir="))?.slice("--hooks-dir=".length) ?? args[args.indexOf("--hooks-dir") + 1] ?? ".vis/hooks";
    const [nodeRoot, nativeRoot] = harness.pair(files);

    prepare(nodeRoot, directory, setup, executable);
    prepare(nativeRoot, directory, setup, executable);

    const node = harness.runNode(args, nodeRoot, environment);

    if (delegated) {
        const probe = harness.materialize("native", files);

        prepare(probe, directory, setup, executable);

        const declined = harness.runNative(args, probe, environment);

        expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
        expect(declined.stdout, "a declined run prints nothing").toBe("");
    }

    const native = harness.runNative(args, nativeRoot, delegated ? { ...environment, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath } : environment);

    if (!delegated) {
        expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    }

    expect(withoutGit(Harness.outcome(native, nativeRoot))).toStrictEqual(withoutGit(Harness.outcome(node, nodeRoot)));

    return native;
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis hook validate: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-hook-validate-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    const parity = (built: { executable: string[]; files: Files }, args: string[] = [], setup: Setup = {}, environment: Record<string, string> = {}) =>
        run(built.files, built.executable, args, setup, environment, false);

    const delegation = (built: { executable: string[]; files: Files }, args: string[] = [], setup: Setup = {}, environment: Record<string, string> = {}) =>
        run(built.files, built.executable, args, setup, environment, true);

    describe("accepted shapes", () => {
        it("says the directory looks good", () => {
            expect.hasAssertions();

            const result = parity(project({ "pre-commit": GOOD_SCRIPT }, { ".vis/hooks/config.json": GOOD_CONFIG }));

            expect(result.stdout).toBe("Hook directory .vis/hooks/ looks good.\n");
            expect(result.status).toBe(0);
        });

        it("accepts several stages, a README and a hidden file", () => {
            expect.hasAssertions();

            parity(
                project(
                    { "commit-msg": "#!/bin/sh\nexit 0\n", "pre-commit": GOOD_SCRIPT, "pre-push": "#!/bin/sh\nif true; then\n  echo x\nfi\n" },
                    { ".vis/hooks/.keep": "", ".vis/hooks/config.json": GOOD_CONFIG, ".vis/hooks/README.md": "# hooks\n" },
                ),
            );
        });

        it("accepts a hooks directory with no stage script, with and without a config", () => {
            expect.hasAssertions();

            parity(project({}, { ".vis/hooks/config.json": GOOD_CONFIG }));
            parity(project({}));
        });

        it("does not look at config.json when no stage script is there", () => {
            expect.hasAssertions();

            parity(project({}, { ".vis/hooks/config.json": "{ not json" }));
        });

        it("accepts a config with unknown fields, which Node ignores", () => {
            expect.hasAssertions();

            const config = `${JSON.stringify({ extra: 1, stages: { "pre-commit": [{ entry: "echo", id: "a", unknown: true }] }, version: 1 })}\n`;

            parity(project({ "pre-commit": GOOD_SCRIPT }, { ".vis/hooks/config.json": config }));
        });

        it("ignores a directory named like a stage", () => {
            expect.hasAssertions();

            parity(project({ "pre-commit": GOOD_SCRIPT }, { ".vis/hooks/config.json": GOOD_CONFIG, ".vis/hooks/pre-push/inner": "x\n" }));
        });

        it.each([["--hooks-dir", ".githooks"], ["--hooks-dir=.githooks"]])("validates the directory given as %s", (...args: string[]) => {
            expect.hasAssertions();

            const built = project({ "pre-commit": GOOD_SCRIPT }, { ".githooks/config.json": GOOD_CONFIG }, ".githooks");

            expect(parity(built, args).stdout).toBe("Hook directory .githooks/ looks good.\n");
        });

        it("accepts a core.hooksPath with a checkout prefix", () => {
            expect.hasAssertions();

            const built = project({ "pre-commit": GOOD_SCRIPT }, { ".vis/hooks/config.json": GOOD_CONFIG, "sub/.vis/hooks/_/.gitignore": "*\n" });

            parity(built, [], { hooksPath: "sub/.vis/hooks/_" });
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("prints what Node does under %j", (...[environment]: Record<string, string>[]) => {
            expect.hasAssertions();

            parity(project({ "pre-commit": GOOD_SCRIPT }, { ".vis/hooks/config.json": GOOD_CONFIG }), [], {}, environment);
        });
    });

    describe("outcomes handed to Node", () => {
        const good = (extra: Files = {}, scripts?: Record<string, string>) => project(scripts ?? { "pre-commit": GOOD_SCRIPT }, { ".vis/hooks/config.json": GOOD_CONFIG, ...extra });

        it("a repository without core.hooksPath is a warning", () => {
            expect.hasAssertions();

            delegation(good(), [], { hooksPath: false });
        });

        it("a core.hooksPath that names another directory is a warning", () => {
            expect.hasAssertions();

            delegation(good(), [], { hooksPath: ".githooks/_" });
            delegation(good({ "/abs/.vis/hooks/_/.gitignore": "x" }), [], { hooksPath: "/nowhere/.vis/hooks/_" });
        });

        it("a missing dispatcher directory is an error", () => {
            expect.hasAssertions();

            const files = Object.fromEntries(Object.entries(good().files).filter(([name]) => name !== ".vis/hooks/_/.gitignore"));

            delegation({ executable: [".vis/hooks/pre-commit"], files });
        });

        it("a missing hooks directory is an error", () => {
            expect.hasAssertions();

            delegation({ executable: [], files: workspaceFiles({ ".vis/hooks/_/.gitignore": "*\n" }) }, ["--hooks-dir", "missing"], { hooksPath: "missing/_" });
        });

        it("a stage script that is not executable is a warning", () => {
            expect.hasAssertions();

            const built = good();

            delegation({ ...built, executable: [] });
        });

        it("a stage script with a shell syntax error is an error", () => {
            expect.hasAssertions();

            delegation(good({}, { "pre-commit": "#!/bin/sh\nif then\n" }));
        });

        it("an unknown file in the hooks directory is a warning", () => {
            expect.hasAssertions();

            delegation(good({ ".vis/hooks/not-a-hook": "x\n" }));
            delegation(good({ ".vis/hooks/pre-commit.bak": "x\n" }));
        });

        it("a stage script without config.json is an error", () => {
            expect.hasAssertions();

            delegation(project({ "pre-commit": GOOD_SCRIPT }));
        });

        it("a config.json Node rejects is an error", () => {
            expect.hasAssertions();

            for (const config of ["{ not json", "[]", '{"version":2,"stages":{}}', '{"version":1}', '{"version":1,"stages":{"pre-commit":{}}}', '{"version":1,"stages":{"pre-commit":[{"id":"a"}]}}', '{"version":1,"stages":{"pre-commit":[{"id":"a","entry":"x","builtin":"y"}]}}']) {
                delegation(project({ "pre-commit": GOOD_SCRIPT }, { ".vis/hooks/config.json": `${config}\n` }));
            }
        });

        it("a directory that is not a git repository is declined", () => {
            expect.hasAssertions();

            delegation(good(), [], { repository: false });
        });

        it("a stage script that is a broken symbolic link is declined", () => {
            expect.hasAssertions();

            delegation(project({}, { ".vis/hooks/config.json": GOOD_CONFIG, ".vis/hooks/pre-commit": { link: "missing" } }));
        });

        it("a missing dispatcher in a linked worktree is a warning, and a present one is clean", () => {
            expect.hasAssertions();

            const built = good();
            const [nodeRoot, nativeRoot] = harness.pair(built.files);

            for (const root of [nodeRoot, nativeRoot]) {
                prepare(root, ".vis/hooks", {}, built.executable);
                git(root, "add", "-A");
                git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x");
                git(root, "worktree", "add", "-q", `${root}-wt`);
            }

            // Node warns about the worktree that has no dispatcher; the binary leaves the verdict to Node.
            expect(harness.runNative([], nativeRoot).status).toBe(70);
            expect(harness.runNode([], nodeRoot).stdout).not.toContain("looks good");

            for (const root of [nodeRoot, nativeRoot]) {
                mkdirSync(join(`${root}-wt`, ".vis", "hooks", "_"), { recursive: true });
            }

            const native = harness.runNative([], nativeRoot);

            expect(native.status).toBe(0);
            expect(Harness.normalize(native.stdout, nativeRoot)).toBe(Harness.normalize(harness.runNode([], nodeRoot).stdout, nodeRoot));
        });

        it.each([["--json"], ["extra"], ["--hooks-dir"], ["--hooks-dir", "/abs"], ["--hooks-dir", "a/../b"], ["--hooks-dir", "123"]])("`hook validate %s` is declined", (...args: string[]) => {
            expect.hasAssertions();

            delegation(good(), args);
        });

        it("a run outside CI is declined", () => {
            expect.hasAssertions();

            const built = good();
            const [nodeRoot, nativeRoot] = harness.pair(built.files);

            for (const root of [nodeRoot, nativeRoot]) {
                prepare(root, ".vis/hooks", {}, built.executable);
            }

            expect(harness.runNative([], nativeRoot, { VIS_CLI_TEST: "1" }, false).status).toBe(70);
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("%j is declined", (environment) => {
            expect.hasAssertions();

            delegation(good(), [], {}, environment);
        });

        it.each([{ NODE_ENV: "test" }, { DEBUG: "vis" }, { PAIL_LOG_LEVEL: "debug" }, { CEREBRO_OUTPUT_LEVEL: "4" }])("the output setting %j is declined", (environment) => {
            expect.hasAssertions();

            delegation(good(), [], {}, environment);
        });
    });
});
