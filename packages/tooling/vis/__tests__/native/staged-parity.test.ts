import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import { tree } from "./destructive-parity-harness";
import { ISOLATED_GIT, NODE_FALLBACK } from "./hook-git-harness";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis staged` exists twice: the Node command (`src/commands/staged/`, `src/staged/`) and the native path
 * (`native/cli/src/staged/`). The native one answers a run whose output and effect it can reproduce, and hands every
 * other run to Node before it changes anything (see `workspace-parity-harness.ts` for how both are proved).
 *
 * It answers two shapes, because an emptied commit makes Node print a stack trace that no other program can: a run on a
 * git range (`--diff &lt;range>`), which makes no backup, re-stages nothing and never makes the check, and a run on the
 * index under `--quiet`, which prints only the one red line. The first prints everything the plain renderer prints;
 * the second prints nothing, so its cases prove themselves by what they leave in the index, the working tree and the
 * stash list.
 *
 * Both sides run on identical repositories (the commits are made with a pinned identity and clock, so the backup stash
 * of a failed run has the same sha on both) and are compared on stdout, stderr, the exit status, every file with its
 * mode, the index, `git status` and the stash list. The only things normalised are the duration of a task, which is a
 * clock reading, and the pid and time inside the message of the backup stash.
 */

const harness = new Harness(["staged"]);

const PINNED = {
    ...ISOLATED_GIT,
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_AUTHOR_NAME: "t",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
};

/** What the launcher gives the binary: the Node it started. Tasks and `git` search the directory of that Node too. */
const LAUNCHER = { VIS_NODE: process.execPath };

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...Harness.environment(), ...PINNED }, stdio: ["ignore", "pipe", "pipe"] });

interface Case {
    /** Flags after `staged`. */
    args?: string[];
    /** Files of the first commit. */
    committed?: Files;
    /** The source of the `staged` block. */
    config: string;
    /** A different `vis.config.ts` as a whole. */
    configSource?: string;
    environment?: Record<string, string>;
    /** Paths made executable before the commit. */
    executables?: string[];
    /** More git setup, run in the repository after the files are in place. */
    prepare?: (root: string) => void;
    /** Files written over the commit and added to the index. */
    staged?: Files;
    /** Files written after that and left out of the index. */
    unstaged?: Files;
}

/** A run on the changes against `HEAD`: no backup, nothing re-staged, and it prints everything. */
const RANGE = ["--diff", "HEAD"];

/** A run on the index that prints nothing, whatever happens, but the one line of an emptied commit. */
const QUIET = ["--quiet"];

const write = (root: string, files: Files): void => {
    for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        writeFileSync(join(root, name), content as string | Buffer);
    }
};

const filesOf = (c: Case): Files =>
    workspaceFiles({
        ".gitignore": "node_modules\n",
        "vis.config.ts": c.configSource ?? `export default {\n    staged: ${c.config},\n};\n`,
        ...(c.committed ?? { "a.txt": "a\n" }),
    });

/** A repository with the commit, the staged changes and the unstaged ones. */
const setUp = (root: string, c: Case): void => {
    for (const name of c.executables ?? []) {
        chmodSync(join(root, name), 0o755);
    }

    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    write(root, c.staged ?? { "a.txt": "a\nb\n" });
    git(root, "add", "-A");
    write(root, c.unstaged ?? {});
    c.prepare?.(root);
};

const STASH_MESSAGE = /vis_staged_automatic_backup-\d+-\d+-[0-9a-f]{6}/g;

interface Outcome {
    index: string;
    porcelain: string;
    stash: string;
    status: number | null;
    stderr: string;
    stdout: string;
    tree: Record<string, string>;
}

const outcome = (result: { status: number | null; stderr: string; stdout: string }, root: string): Outcome => {
    return {
        index: git(root, "ls-files", "-s"),
        porcelain: git(root, "status", "--porcelain=v1", "-uall"),
        stash: git(root, "stash", "list").replaceAll(STASH_MESSAGE, "<BACKUP>"),
        status: result.status,
        // The frames of a stack trace name the async call chain, whose depth differs from one run of Node to the next.
        stderr: Harness.normalize(result.stderr, root).replaceAll(/\(\d+ms\)/g, "(Nms)").replaceAll(/^ {4}at .*\n/gm, ""),
        stdout: Harness.normalize(result.stdout, root),
        tree: tree(root),
    };
};

/** The repository as a run leaves it, with no run to show. */
const stateOf = (root: string): Outcome => outcome({ status: null, stderr: "", stdout: "" }, root);

const environmentOf = (c: Case, extra: Record<string, string> = {}): Record<string, string> => { return { ...PINNED, ...LAUNCHER, ...c.environment, ...extra }; };

const argsOf = (c: Case): string[] => c.args ?? RANGE;

const pairOf = (c: Case): [string, string] => {
    const pair = harness.pair(filesOf(c));

    for (const root of pair) {
        setUp(root, c);
    }

    return pair;
};

/** The native side answers, and leaves the same output, status, files, index and stash as Node. */
const parity = (c: Case, extra: Record<string, string> = {}) => {
    const [nodeRoot, nativeRoot] = pairOf(c);
    const node = harness.runNode(argsOf(c), nodeRoot, environmentOf(c, extra));
    const native = harness.runNative(argsOf(c), nativeRoot, environmentOf(c, extra));

    expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    expect(outcome(native, nativeRoot)).toStrictEqual(outcome(node, nodeRoot));

    return outcome(native, nativeRoot);
};

/** The native side declines (exit 70, nothing printed, nothing changed), and the delegated run matches Node. */
const delegation = (c: Case, extra: Record<string, string> = {}, options: { args?: string[]; ci?: boolean; launcher?: boolean } = {}) => {
    const args = options.args ?? argsOf(c);
    const ci = options.ci ?? true;
    const environment = options.launcher === false ? { ...PINNED, ...c.environment, ...extra } : environmentOf(c, extra);
    const [nodeRoot, nativeRoot] = pairOf(c);
    const [, probe] = pairOf(c);
    const before = stateOf(probe);
    const node = harness.runNode(args, nodeRoot, environment, ci);
    const declined = harness.runNative(args, probe, environment, ci);

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect(stateOf(probe), "a declined run must not change the repository").toStrictEqual(before);

    const delegated = harness.runNative(args, nativeRoot, { ...environment, ...NODE_FALLBACK }, ci);

    expect(outcome(delegated, nativeRoot)).toStrictEqual(outcome(node, nodeRoot));

    return outcome(delegated, nativeRoot);
};

const append = String.raw`{ "*.txt": "sh -c 'printf X >> \"$1\"' sh" }`;

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis staged: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-staged-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe("a run on a git range", () => {
        it("runs a command over the changed file and prints the plain renderer's lines", () => {
            expect.hasAssertions();

            const native = parity({ config: append });

            expect(native.status).toBe(0);
            expect(native.stderr).toBe("> Running staged tasks on 1 file across 1 pattern\n> *.txt — 1 file\n  ✓ sh -c 'printf X >> \"$1\"' sh (Nms)\n✓ *.txt — 1 file\n");
            expect(native.porcelain).toBe("MM a.txt\n");
            expect(native.stash).toBe("");
        });

        it("prints the ASCII glyphs where the terminal is the Linux console", () => {
            expect.hasAssertions();

            const native = parity({ config: `{ "*.txt": "true" }` }, { TERM: "linux" });

            expect(native.stderr).toContain("\u221A *.txt");
        });

        it("shows the output of a command with --verbose", () => {
            expect.hasAssertions();

            const native = parity({ args: [...RANGE, "--verbose"], config: `{ "*.txt": "sh -c 'echo out; echo err >&2' sh" }` });

            expect(native.stderr).toContain("  … sh -c 'echo out; echo err >&2' sh\n");
            expect(native.stderr).toContain("    out\n    \n    err\n");
        });

        it("runs a list of commands in order, and flattens a list inside a list", () => {
            expect.hasAssertions();

            const native = parity({ args: [...RANGE, "--verbose"], config: `{ "*.txt": ["echo one", ["echo two", ["sh -c 'echo three' sh"]]] }` });

            expect(native.stderr.indexOf("one")).toBeLessThan(native.stderr.indexOf("two"));
            expect(native.stderr.indexOf("two")).toBeLessThan(native.stderr.indexOf("three"));
        });

        it("hands the files to the command as absolute paths, or relative ones with --relative", () => {
            expect.hasAssertions();

            const config = `{ "*.txt": "printf '%s|'" }`;
            const absolute = parity({ args: [...RANGE, "--verbose"], config });
            const relative = parity({ args: [...RANGE, "--verbose", "--relative"], config });

            expect(absolute.stderr).toContain("<ROOT>/a.txt|");
            expect(relative.stderr).toContain("    a.txt|");
        });

        it("matches basename patterns, path patterns, braces and globstars", () => {
            expect.hasAssertions();

            const committed = { "a.txt": "a\n", "docs/guide.md": "g\n", "src/app/main.ts": "m\n", "src/app/view.tsx": "v\n", "src/util.ts": "u\n" };
            const staged = { "a.txt": "a\nb\n", "docs/guide.md": "g\nb\n", "src/app/main.ts": "m\nb\n", "src/app/view.tsx": "v\nb\n", "src/util.ts": "u\nb\n" };
            const native = parity({
                args: [...RANGE, "--concurrent", "false"],
                committed,
                config: `{
        "*.{ts,tsx}": "echo ts",
        "src/**/*.ts": "echo deep",
        "docs/*": "echo docs",
        "*.txt": "echo txt",
        "**/*.zzz": "echo none",
        "src/*": "echo shallow",
    }`,
                staged,
            });

            expect(native.stderr).toContain("*.{ts,tsx} — 3 files");
            expect(native.stderr).toContain("src/**/*.ts — 2 files");
            expect(native.stderr).toContain("src/* — 1 file\n");
            expect(native.stderr).not.toContain("*.zzz");
        });

        it("matches an upper-case pattern and an upper-case name the way the file system does", () => {
            expect.hasAssertions();

            parity({ args: [...RANGE, "--concurrent", "false"], committed: { "a.txt": "a\n", "README.MD": "r\n" }, config: `{ "*.md": "echo lower", "*.TXT": "echo upper" }`, staged: { "a.txt": "a\nb\n", "README.MD": "r\nb\n" } });
        });

        it("finds a program in node_modules/.bin and runs a script by its relative path", () => {
            expect.hasAssertions();

            const native = parity({
                args: [...RANGE, "--verbose"],
                committed: { "a.txt": "a\n", "fix.sh": "#!/bin/sh\necho fix \"$#\"\n", "node_modules/.bin/mytool": "#!/bin/sh\necho tool \"$0\"\n" },
                config: `{ "*.txt": ["mytool", "./fix.sh"] }`,
                executables: ["fix.sh", "node_modules/.bin/mytool"],
            });

            expect(native.stderr).toContain("    tool <ROOT>/node_modules/.bin/mytool\n");
            expect(native.stderr).toContain("    fix 1\n");
        });

        it("runs a command once per chunk of files that fits the argument budget", () => {
            expect.hasAssertions();

            const names = Array.from({ length: 700 }, (_, index) => `${"d".repeat(200)}${String(index).padStart(4, "0")}.txt`);
            const committed = Object.fromEntries(names.map((name) => [name, "a\n"]));
            const staged = Object.fromEntries(names.map((name) => [name, "a\nb\n"]));
            const native = parity({ args: [...RANGE, "--verbose"], committed, config: `{ "*.txt": "sh -c 'echo count $#' sh" }`, staged });

            expect(native.stderr.match(/count \d+/g)?.length).toBeGreaterThan(1);
        });

        it("keeps a quoted word and an escaped space intact", () => {
            expect.hasAssertions();

            parity({ args: [...RANGE, "--verbose"], config: String.raw`{ "*.txt": "sh -c 'echo \"two words\" \\$0' sh\\ x" }` });
        });

        it("says that no file changed", () => {
            expect.hasAssertions();

            const native = parity({ config: `{ "*.txt": "true" }`, staged: {} });

            expect(native.stderr).toBe("No staged files found.\n");
            expect(native.status).toBe(0);
        });

        it("says that no changed file matched", () => {
            expect.hasAssertions();

            const native = parity({ config: `{ "*.zzz": "true" }` });

            expect(native.stderr).toBe("No staged files matched any pattern.\nNo staged files matched any pattern.\n");
        });

        it("takes a range of two revisions", () => {
            expect.hasAssertions();

            parity({
                args: ["--diff", "HEAD~1...HEAD"],
                config: `{ "*.txt": "echo ranged" }`,
                prepare: (root) => {
                    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "second");
                },
            });
        });

        it("does not make a backup, whatever else is asked", () => {
            expect.hasAssertions();

            parity({ args: [...RANGE, "--no-stash", "--revert"], config: append });
        });

        it("accepts a config with keys no staged run reads", () => {
            expect.hasAssertions();

            parity({ config: "", configSource: `export default {\n    $schema: "./schemas/vis-config.schema.json",\n    sponsor: { enabled: false },\n    staged: { "*.txt": "true" },\n};\n` });
        });

        it("runs the patterns one after the other when --concurrent is 1 or false", () => {
            expect.hasAssertions();

            parity({ args: [...RANGE, "--concurrent", "1"], config: `{ "*.txt": "echo first", "a*": "echo second" }` });
            parity({ args: [...RANGE, "--concurrent=false"], config: `{ "a*": "echo second", "*.txt": "echo first" }` });
        });

        it("runs two patterns with the default concurrency when only one matches", () => {
            expect.hasAssertions();

            parity({ config: `{ "*.txt": "true", "*.zzz": "true" }` });
        });

        it("is not stopped by an emptied commit, which a range never checks", () => {
            expect.hasAssertions();

            const native = parity({ config: String.raw`{ "*.txt": "sh -c 'printf \"a\\n\" > \"$1\"' sh" }` });

            expect(native.status).toBe(0);
            expect(native.stderr).not.toContain("Error");
        });
    });

    describe("a run on a git range that fails", () => {
        it("reports the output of a failed command and goes no further in its pattern", () => {
            expect.hasAssertions();

            const native = parity({ config: `{ "*.txt": ["sh -c 'echo out; echo err >&2; exit 3' sh", "echo never"] }` });

            expect(native.status).toBe(1);
            expect(native.stderr).toContain("  ✖ sh -c 'echo out; echo err >&2; exit 3' sh (Nms)\nout\n\nerr\n    out\n    \n    err\n");
            expect(native.stderr).not.toContain("never");
        });

        it("names the exit code of a command that says nothing", () => {
            expect.hasAssertions();

            const native = parity({ config: `{ "*.txt": "sh -c 'exit 7' sh" }` });

            expect(native.stderr).toContain("Exit code 7 from sh\n");
        });

        it("reports a command that a signal ended", () => {
            expect.hasAssertions();

            const native = parity({ config: `{ "*.txt": "sh -c 'kill -9 $$' sh" }` });

            expect(native.stderr).toContain("Task killed by signal SIGKILL.\n");
        });

        it("skips the patterns after the failed one", () => {
            expect.hasAssertions();

            const native = parity({ args: [...RANGE, "--concurrent", "false"], config: `{ "*.txt": "false", "a*": ["echo x", "echo y"], "*.t*": "echo z" }` });

            expect(native.stderr).toContain("  — echo x (Nms)\n");
            expect(native.stderr).toContain("— a* — 1 file\n");
        });

        it("says that it reverts, though a range has nothing to revert from", () => {
            expect.hasAssertions();

            const native = parity({ args: [...RANGE, "--revert"], config: `{ "*.txt": "sh -c 'printf X >> a.txt; exit 1' sh" }` });

            expect(native.stderr).toContain("Reverting working tree from backup stash.\n");
            expect(native.stash).toBe("");
        });

        it("prints only the errors of a quiet run", () => {
            expect.hasAssertions();

            expect(parity({ args: [...RANGE, "--quiet"], config: `{ "*.txt": "sh -c 'echo hi; exit 1' sh" }` }).stderr).toBe("");
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("prints what Node prints in %j", (environment) => {
            expect.hasAssertions();

            parity({ args: [...RANGE, "--verbose", "--concurrent", "false"], config: `{ "*.txt": ["echo fine", "sh -c 'echo out; echo err >&2; exit 2' sh"], "a*": "echo skipped" }` }, environment);
        });

        it("colours a multi-line failure line by line", () => {
            expect.hasAssertions();

            const native = parity({ args: [...RANGE, "--concurrent", "false"], config: `{ "*.txt": "sh -c 'echo one; echo two; exit 2' sh", "a*": "echo skipped" }` }, { FORCE_COLOR: "1" });

            expect(native.stderr).toContain("\u001B[2mone\u001B[22m\n\u001B[2mtwo\u001B[22m\n");
        });
    });

    describe("a quiet run on the index", () => {
        it("stages what a command changed", () => {
            expect.hasAssertions();

            const native = parity({ args: QUIET, config: append });

            expect(native.status).toBe(0);
            expect(native.stderr).toBe("");
            expect(native.porcelain).toBe("M  a.txt\n");
            expect(native.stash).toBe("");
        });

        it("drops the backup when the failed command left everything as it was, and keeps it when it did not", () => {
            expect.hasAssertions();

            const clean = parity({ args: QUIET, config: `{ "*.txt": "sh -c 'exit 3' sh" }` });
            const changed = parity({ args: QUIET, config: `{ "*.txt": "sh -c 'printf X >> a.txt; exit 1' sh" }` });

            expect(clean.status).toBe(1);
            expect(clean.stash).toBe("");
            expect(changed.status).toBe(1);
            expect(changed.stash).toContain("<BACKUP>");
            expect(changed.stderr).toBe("");
        });

        it("puts the working tree back with --revert", () => {
            expect.hasAssertions();

            const native = parity({ args: [...QUIET, "--revert"], config: `{ "*.txt": "sh -c 'printf X >> a.txt; exit 1' sh" }` });

            expect(native.stash).toBe("");
            expect(native.tree["a.txt"]).toBe(`file 644 ${Buffer.from("a\nb\n").toString("hex")}`);
        });

        it("restores the staged change and says so when the commands empty the commit", () => {
            expect.hasAssertions();

            const native = parity({ args: QUIET, config: String.raw`{ "*.txt": "sh -c 'printf \"a\\n\" > \"$1\"' sh" }` });

            expect(native.status).toBe(1);
            expect(native.stderr).toBe("All staged changes were reverted by tasks. Re-stage changes or rerun with --allow-empty.\n");
            expect(native.porcelain).toBe("M  a.txt\n");
            expect(native.stash).toBe("");
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("colours that line as Node does in %j", (environment) => {
            expect.hasAssertions();

            parity({ args: QUIET, config: String.raw`{ "*.txt": "sh -c 'printf \"a\\n\" > \"$1\"' sh" }` }, environment);
        });

        it("makes no backup with --no-stash", () => {
            expect.hasAssertions();

            const native = parity({ args: [...QUIET, "--no-stash"], config: append });

            expect(native.stash).toBe("");
            expect(native.porcelain).toBe("M  a.txt\n");
        });

        it("hands the files over in chunks, as they are written or relative with --relative", () => {
            expect.hasAssertions();

            const names = Array.from({ length: 700 }, (_, index) => `${"d".repeat(200)}${String(index).padStart(4, "0")}.txt`);
            const committed = Object.fromEntries(names.map((name) => [name, "a\n"]));
            const staged = Object.fromEntries(names.map((name) => [name, "a\nb\n"]));
            // A log of the counts only: the absolute paths would differ between the two roots.
            const counts = `{ "*.txt": "sh -c 'echo $# >> calls.log' sh" }`;
            const logArguments = String.raw`{ "*.txt": "sh -c 'for f in \"$@\"; do echo \"$f\" >> args.log; done' sh" }`;
            const text = (result: { tree: Record<string, string> }, file: string): string => Buffer.from(result.tree[file]!.split(" ")[2]!, "hex").toString();

            expect(text(parity({ args: QUIET, committed, config: counts, staged }), "calls.log").trim().split("\n").length).toBeGreaterThan(1);

            const relative = parity({ args: [...QUIET, "--relative"], committed, config: logArguments, staged });

            expect(text(relative, "args.log")).toContain(`${"d".repeat(200)}0000.txt\n`);
            expect(text(relative, "args.log")).not.toContain("/");
        });

        it("runs the patterns in the order of the file, and none after a failure", () => {
            expect.hasAssertions();

            const native = parity({
                args: [...QUIET, "--concurrent", "false"],
                config: `{ "a*": "sh -c 'echo first >> order.log' sh", "*.txt": ["sh -c 'echo second >> order.log; exit 1' sh", "sh -c 'echo never >> order.log' sh"], "*.t*": "sh -c 'echo skipped >> order.log' sh" }`,
            });

            expect(Buffer.from(native.tree["order.log"]!.split(" ")[2]!, "hex").toString()).toBe("first\nsecond\n");
        });

        it("says nothing when nothing is staged or nothing matches", () => {
            expect.hasAssertions();

            expect(parity({ args: QUIET, config: `{ "*.txt": "true" }`, prepare: (root) => git(root, "reset", "-q") }).stderr).toBe("");
            expect(parity({ args: QUIET, config: `{ "*.zzz": "true" }` }).stderr).toBe("");
        });

        it("leaves an unstaged change in a file that is not staged alone", () => {
            expect.hasAssertions();

            const native = parity({ args: QUIET, committed: { "a.txt": "a\n", "o.md": "o\n" }, config: append, unstaged: { "o.md": "o\nx\n" } });

            expect(native.porcelain).toBe("M  a.txt\n M o.md\n");
        });

        it("runs a command that is a program of node_modules/.bin", () => {
            expect.hasAssertions();

            const native = parity({
                args: QUIET,
                committed: { "a.txt": "a\n", "node_modules/.bin/mytool": "#!/bin/sh\necho ran > tool.log\n" },
                config: `{ "*.txt": "mytool" }`,
                executables: ["node_modules/.bin/mytool"],
            });

            expect(native.tree["tool.log"]).toBeDefined();
        });
    });

    describe("a run it leaves to Node", () => {
        const plain: Case = { config: `{ "*.txt": "true" }` };

        it("does not answer a run on the index that could end in a stack trace", () => {
            expect.hasAssertions();

            const delegated = delegation({ args: [], config: String.raw`{ "*.txt": "sh -c 'printf \"a\\n\" > \"$1\"' sh" }` });

            expect(delegated.stderr).toContain("ApplyEmptyCommitError");
            expect(delegated.status).toBe(1);

            delegation({ ...plain, args: ["--verbose"] });
            delegation({ ...plain, args: ["--quiet", "--verbose"] });
            delegation({ ...plain, args: ["--relative", "--revert"] });
        });

        it.each([["--allow-empty"], ["--auto-stage"], ["--continue-on-error"], ["--fail-on-changes"], ["--force-kill"], ["--hide-unstaged"], ["--hide-partially-staged"]])(
            "does not answer %s, which the Node handler does not read",
            (flag) => {
                expect.hasAssertions();

                delegation({ ...plain, args: [...QUIET, flag] });
                delegation({ ...plain, args: [...RANGE, flag] });
            },
        );

        it.each([
            [["--debug"]],
            [["--diff-filter", "A"]],
            [["--cwd", "."]],
            [["--concurrent", "true"]],
            [["--concurrent", "2.5"]],
            [["--concurrent", "0"]],
            [["--stash"]],
            [["--unknown"]],
            [["extra"]],
            [["--no-color"]],
        ])("does not answer the option %j", (args) => {
            expect.hasAssertions();

            delegation({ ...plain, args: [...QUIET, ...args] });
        });

        it.each([["nonexistent-ref"], ["123"], ["true"], ["HEAD -- a.txt"], ["--stat"]])("does not answer the range %j", (range) => {
            expect.hasAssertions();

            delegation({ ...plain, args: ["--diff", range] });
        });

        it("does not answer several patterns that would run side by side", () => {
            expect.hasAssertions();

            delegation({ args: RANGE, config: `{ "*.txt": "echo a", "a*": "echo b" }` });
            delegation({ args: [...RANGE, "--concurrent", "2"], config: `{ "*.txt": "echo a", "a*": "echo b" }` });
        });

        it("does not answer a concurrency from the environment", () => {
            expect.hasAssertions();

            delegation(plain, { VIS_STAGED_CONCURRENT: "1" });
        });

        it.each([
            ["an object task", `{ "*.txt": { command: "true" } }`],
            ["a task with a function", `{ "*.txt": (files) => "true" }`],
            ["a pattern the matcher does not read", `{ "*.{ts,{a,b}}": "true" }`],
            ["a negated pattern", `{ "!*.md": "true" }`],
            ["an empty config", `{}`],
            ["an empty list", `{ "*.txt": [] }`],
            ["a blank command", `{ "*.txt": "   " }`],
            ["an unterminated quote", `{ "*.txt": "echo 'x" }`],
            ["a program that is not there", `{ "*.txt": "no-such-program-here" }`],
            ["a script with no shebang", `{ "*.txt": "./plain.sh" }`],
            ["a numeric key", `{ "1": "true", "*.txt": "true" }`],
            ["a duplicate key", `{ "*.txt": "true", "*.txt": "false" }`],
        ])("does not answer %s", (_name, config) => {
            expect.hasAssertions();

            delegation({
                committed: { "a.txt": "a\n", "plain.sh": "echo hi\n" },
                config,
                executables: ["plain.sh"],
            });
        });

        it("does not answer a config that is not a literal or holds other keys", () => {
            expect.hasAssertions();

            delegation({ config: "", configSource: `export default { staged: { "*.txt": "true" }, tasks: { build: { command: "echo" } } };\n` });
            delegation({ config: "", configSource: `const staged = { "*.txt": "true" };\nexport default { staged };\n` });
            delegation({ config: "", configSource: `export default { staged: { ...{ "*.txt": "true" } } };\n` });
            delegation({ config: "", configSource: `export default {};\n` });
        });

        it("does not answer a file that is partly staged", () => {
            expect.hasAssertions();

            const c: Case = { ...plain, args: QUIET, unstaged: { "a.txt": "a\nb\nc\n" } };

            delegation(c);
            delegation({ ...c, args: [...RANGE, "--no-stash"] });
        });

        it("does not answer a run without a backup next to a partly staged file that no pattern reads", () => {
            expect.hasAssertions();

            delegation({ args: [...QUIET, "--no-stash"], committed: { "a.txt": "a\n", "o.md": "o\n" }, config: `{ "*.txt": "true" }`, staged: { "a.txt": "a\nb\n", "o.md": "o\nb\n" }, unstaged: { "o.md": "o\nb\nc\n" } });
        });

        it("does not answer an intent-to-add entry, a merge in progress or a conflict", () => {
            expect.hasAssertions();

            delegation({
                ...plain,
                prepare: (root) => {
                    write(root, { "new.txt": "n\n" });
                    git(root, "add", "-N", "new.txt");
                },
            });
            delegation({
                ...plain,
                prepare: (root) => {
                    writeFileSync(join(root, ".git", "MERGE_MSG"), "merge\n");
                },
            });
            delegation({
                ...plain,
                prepare: (root) => {
                    git(root, "reset", "-q", "--hard");
                    git(root, "checkout", "-q", "-b", "other");
                    write(root, { "a.txt": "other\n" });
                    git(root, "commit", "-q", "-am", "other");
                    git(root, "checkout", "-q", "main");
                    write(root, { "a.txt": "main\n" });
                    git(root, "commit", "-q", "-am", "main");

                    try {
                        git(root, "cherry-pick", "other");
                    } catch {
                        // The conflict is what the case is for.
                    }
                },
            });
        });

        it("does not answer a repository without a commit, or a working directory below the root", () => {
            expect.hasAssertions();

            const [root] = harness.pair(filesOf(plain));

            git(root, "init", "-q", "-b", "main");
            git(root, "add", "-A");

            const noCommit = harness.runNative(RANGE, root, environmentOf(plain));

            expect(noCommit.status).toBe(70);
            expect(noCommit.stdout).toBe("");

            const [below] = pairOf({ ...plain, committed: { "a.txt": "a\n", "packages/app/package.json": "{}\n" } });
            const declined = harness.runNative(RANGE, join(below, "packages", "app"), environmentOf(plain));

            expect(declined.status).toBe(70);
            expect(declined.stdout).toBe("");
        });

        it.each([
            ["NODE_ENV=test", { NODE_ENV: "test" }],
            ["NODE_ENV=debug", { NODE_ENV: "debug" }],
            ["DEBUG", { DEBUG: "1" }],
            ["CEREBRO_OUTPUT_LEVEL", { CEREBRO_OUTPUT_LEVEL: "128" }],
            ["PAIL_LOG_LEVEL", { PAIL_LOG_LEVEL: "debug" }],
            ["FORCE_COLOR with NO_COLOR", { FORCE_COLOR: "1", NO_COLOR: "1" }],
            ["an inherited root for another directory", { VIS_MONOREPO_ROOT: "/" }],
        ])("does not answer with %s in the environment", (_name, extra) => {
            expect.hasAssertions();

            delegation(plain, extra);
        });

        it("does not answer outside CI", () => {
            expect.hasAssertions();

            delegation(plain, {}, { ci: false });
        });

        it("does not answer a run the launcher did not start (no VIS_NODE names the Node whose directory joins the search path)", () => {
            expect.hasAssertions();

            delegation(plain, {}, { launcher: false });
        });
    });
});
