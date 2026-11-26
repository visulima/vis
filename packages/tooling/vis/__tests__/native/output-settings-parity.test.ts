import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, packageRoot, workspaceFiles } from "./workspace-parity-harness";

/**
 * Node prints some commands through a logger that obeys the output settings (`NODE_ENV`, `DEBUG`, `PAIL_LOG_LEVEL`,
 * `CEREBRO_*`), and traces every command under `DEBUG` and cerebro's debug level. A native command that answers without
 * looking at them prints something else than Node does with one set, so each command here is compared with Node under the
 * settings: a command that may not answer (`FULL`) must hand the run to Node before it prints anything, and a command
 * whose own output no setting but `DEBUG` and `CEREBRO_*` changes (`TRACED`) must still answer where the others do not.
 *
 * `Harness.environment` starts from `HOME` and `PATH` alone, so the `NODE_ENV=test` that vitest sets, which the native
 * path correctly declines, does not leak into the runs.
 */

const fixtures = join(packageRoot, "native", "cli", "tests", "fixtures");

/** Every file under a fixture directory, as the harness writes them. */
const tree = (directory: string): Files => {
    const files: Files = {};

    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            const path = join(entry.parentPath, entry.name);

            files[relative(directory, path)] = readFileSync(path, "utf8");
        }
    }

    return files;
};

const GIT_ENVIRONMENT = {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_AUTHOR_NAME: "t",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: { ...Harness.environment(), ...GIT_ENVIRONMENT }, stdio: "ignore" });
};

interface Case {
    args: string[];
    /** Files written on top of the second commit of a git repository (the first holds `files`). */
    changed?: Files;
    files: Files;
    /** Whether the run needs a git repository. */
    repository?: boolean;
}

const REC = "./rec.sh";
const app = (name: string): Files => {
    return { [`packages/${name}/package.json`]: json({ name, scripts: { build: "tsc" }, version: "1.0.0" }) };
};
const hookProject: Files = workspaceFiles({
    ".vis/hooks/config.json": json({ stages: { "pre-commit": [{ entry: REC, id: "t", name: "Recorder", verbose: true }] }, version: 1 }),
    "a.txt": "a\n",
    "rec.sh": '#!/bin/sh\necho "$# $*"\n',
});

/** The commands that print through pail or whose output a trace of Node wraps, with a shape the native path answers. */
const FULL: Record<string, Case> = {
    affected: { args: ["affected", "build", "--sparse-checkout", "--base=HEAD~1", "--head=HEAD"], changed: { "packages/a/src.ts": "x\n" }, files: workspaceFiles(app("a")), repository: true },
    "cache hash": { args: ["cache", "hash", "app:build"], files: tree(join(fixtures, "cache-hash", "recorded")) },
    "cache hash --format json": { args: ["cache", "hash", "app:build", "--format", "json"], files: tree(join(fixtures, "cache-hash", "recorded")) },
    "cache why": { args: ["cache", "why", "app:build"], files: tree(join(fixtures, "cache-hash", "recorded")) },
    clean: { args: ["clean", "--dry-run"], files: workspaceFiles({ ...app("a"), "node_modules/x/index.js": "x\n", "packages/a/node_modules/y/index.js": "y\n" }) },
    ignore: { args: ["ignore", "--target", "docker"], files: workspaceFiles(app("a")) },
    list: { args: ["list"], files: tree(join(fixtures, "list", "basic")) },
    replay: { args: ["replay"], files: tree(join(fixtures, "cache-hash", "recorded")) },
    status: { args: ["status"], files: tree(join(fixtures, "list", "basic")) },
};

/** The commands that print nothing of their own through pail, with a shape the native path answers (`FAKE_PACKAGE_MANAGER` stands in for `pnpm`). */
const TRACED: Record<string, Case> = {
    "advisories bloom status": { args: ["advisories", "bloom", "status", "--format", "json", "--cache-dir", "cache"], files: workspaceFiles(app("a")) },
    dedupe: { args: ["dedupe"], files: workspaceFiles(app("a")) },
    exec: { args: ["exec", "echo", "hi"], files: workspaceFiles(app("a")) },
    "hook run": { args: ["hook", "run", "pre-commit", "--all-files"], files: hookProject, repository: true },
    link: { args: ["link", "../x"], files: workspaceFiles(app("a")) },
    pm: { args: ["pm", "cache", "dir"], files: workspaceFiles(app("a")) },
    remove: { args: ["remove", "left-pad"], files: workspaceFiles(app("a")) },
    unlink: { args: ["unlink"], files: workspaceFiles(app("a")) },
    why: { args: ["why", "left-pad"], files: workspaceFiles(app("a")) },
};

/**
 * `outdated` prints a catalog notice that the stubbed package manager of this suite does not reproduce, so its native answer
 * is not compared with Node's; it is only handed over under the tracing settings and must match Node through the hand-off.
 */
const OUTDATED: Case = { args: ["outdated"], files: workspaceFiles(app("a")) };

/** The settings that change what Node prints around every command. */
const TRACING: Record<string, string>[] = [{ DEBUG: "1" }, { CEREBRO_OUTPUT_LEVEL: "128" }];

/** The settings that change what pail prints, which only a command that logs through it follows. */
const LOGGING: Record<string, string>[] = [{ PAIL_LOG_LEVEL: "error" }, { NODE_ENV: "debug" }, { NODE_ENV: "test" }];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("native commands and the output settings: native vs Node", () => {
    const harness = new Harness([]);
    const paths = { bin: "" };

    beforeAll(() => {
        harness.setup("vis-output-settings-");

        paths.bin = mkdtempSync(join(tmpdir(), "vis-output-settings-pm-"));
        mkdirSync(join(paths.bin, "bin"));
        writeFileSync(join(paths.bin, "bin", "pnpm"), '#!/bin/sh\necho "FAKE-PNPM $*"\n');
        chmodSync(join(paths.bin, "bin", "pnpm"), 0o755);
    });

    afterAll(() => {
        harness.teardown();
        rmSync(paths.bin, { force: true, recursive: true });
    });

    /** A repository holding `files`, and `changed` on top of a second commit; the dates are fixed so both sides' objects match. */
    const prepare = (root: string, spec: Case): void => {
        if (spec.repository !== true) {
            return;
        }

        git(root, "init", "-q");

        if (existsSync(join(root, "rec.sh"))) {
            chmodSync(join(root, "rec.sh"), 0o755);
        }

        git(root, "add", "-A");
        git(root, "commit", "-q", "-m", "first");

        if (spec.changed !== undefined) {
            for (const [name, content] of Object.entries(spec.changed)) {
                mkdirSync(join(root, name, ".."), { recursive: true });
                writeFileSync(join(root, name), content as string);
            }

            git(root, "add", "-A");
            git(root, "commit", "-q", "-m", "second");
        }
    };

    const outcome = (result: Parameters<typeof Harness.outcome>[0], root: string): ReturnType<typeof Harness.outcome> => {
        const full = Harness.outcome(result, root);

        return { ...full, tree: Object.fromEntries(Object.entries(full.tree).filter(([name]) => !name.startsWith(".git/"))) };
    };

    /** Node's run and the binary's run on the same files, the binary with no way to start Node (a run it declines exits 70). */
    const compare = (spec: Case, extra: Record<string, string>, delegated: boolean): void => {
        const environment = { PATH: `${join(paths.bin, "bin")}:${process.env["PATH"] ?? ""}`, ...extra };
        const [nodeRoot, nativeRoot] = harness.pair(spec.files);

        prepare(nodeRoot, spec);
        prepare(nativeRoot, spec);

        const node = harness.runNode(spec.args, nodeRoot, environment);

        if (delegated) {
            const probe = harness.materialize("native", spec.files);

            prepare(probe, spec);

            const declined = harness.runNative(spec.args, probe, environment);

            expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
            expect(declined.stdout, "a declined run prints nothing").toBe("");

            const handedOver = harness.runNative(spec.args, nativeRoot, { ...environment, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

            expect(outcome(handedOver, nativeRoot)).toStrictEqual(outcome(node, nodeRoot));

            return;
        }

        const native = harness.runNative(spec.args, nativeRoot, environment);

        expect(native.status, `the binary handed the run to Node. stderr: ${native.stderr}`).not.toBe(70);
        expect(outcome(native, nativeRoot)).toStrictEqual(outcome(node, nodeRoot));
    };

    describe.each(Object.entries(FULL))("%s", (_name, spec) => {
        it("is answered natively with no setting", () => {
            expect.assertions(2);

            compare(spec, {}, false);
        });

        it.each([...LOGGING, ...TRACING])("hands the run to Node under %j", (setting) => {
            expect.assertions(3);

            compare(spec, setting, true);
        });
    });

    describe.each(Object.entries(TRACED))("%s", (_name, spec) => {
        it("is answered natively with no setting", () => {
            expect.assertions(2);

            compare(spec, {}, false);
        });

        it.each(LOGGING)("is still answered natively under %j, which changes nothing Node prints for it", (setting) => {
            expect.assertions(2);

            compare(spec, setting, false);
        });

        it.each(TRACING)("hands the run to Node under %j", (setting) => {
            expect.assertions(3);

            compare(spec, setting, true);
        });
    });

    describe("outdated", () => {
        it.each(TRACING)("hands the run to Node under %j", (setting) => {
            expect.assertions(3);

            compare(OUTDATED, setting, true);
        });
    });
});
