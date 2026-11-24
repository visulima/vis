import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Fixture, Side } from "./destructive-parity-harness";
import { DestructiveSuite } from "./destructive-parity-harness";
import { binary, nodeEntry } from "./workspace-parity-harness";

/**
 * `vis cache clean` exists twice: the Node handler (`src/commands/cache/clean.ts`, `handler.ts`) and the native path
 * (`native/cli/src/cache_clean.rs`). It deletes the task cache and the per-user stores, so every case runs both
 * sides on identical throwaway `HOME` directories and workspaces and compares stdout, stderr, the exit status and the
 * whole state left on disk (see `destructive-parity-harness.ts`). A run the binary declines must hand the call to
 * Node before it prints or removes anything.
 */

const suite = new DestructiveSuite(["cache", "clean"]);

const CACHE = "node_modules/.cache/vis";

/** The default task cache: entries with nested files, a dot file, a plain file and the branch container. */
const taskCache = (): Record<string, string> => {
    return {
        [`${CACHE}/.task-index.json`]: "{}",
        [`${CACHE}/aaaa1111/code`]: "0",
        [`${CACHE}/aaaa1111/outputs.tar.br`]: "x".repeat(2000),
        [`${CACHE}/bbbb2222/nested/deep/file`]: "y".repeat(1500),
        [`${CACHE}/branches/feature-x/cccc3333/code`]: "0",
        [`${CACHE}/branches/feature-x/dddd4444/outputs`]: "z".repeat(1_100_000),
        [`${CACHE}/branches/main/eeee5555/code`]: "0",
        [`${CACHE}/plain-file`]: "x",
    };
};

/** The four per-user stores, each with a file that is not a record. */
const stores = (): Record<string, string> => {
    return {
        ".vis/cache/ai/a.json": "{}",
        ".vis/cache/ai/b.json": "{ }",
        ".vis/cache/ai/note.txt": "keep",
        ".vis/cache/deps-dev/advisories/a.json": "{}",
        ".vis/cache/deps-dev/projects/p.json": "{}",
        ".vis/cache/deps-dev/versions/v.json": "{}",
        ".vis/cache/snyk/issues/i.json": "{}",
        ".vis/cache/socket-security/s.json": "{}",
        ".vis/state/tips.json": "{}",
    };
};

const full = (): Fixture => {
    return { home: stores(), workspace: taskCache() };
};

const git = (cwd: string, ...args: string[]): void => {
    const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

    expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
};

/** Makes the workspace of a side a primary checkout and runs the case in a linked worktree of it, which shares the primary one's cache. */
const linkedWorktree = (side: Side): void => {
    git(side.root, "init", "-q", "-b", "main");
    git(side.root, "add", "-f", ".gitignore", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/app/package.json");
    git(side.root, "commit", "-q", "-m", "init");
    git(side.root, "worktree", "add", "-q", "-b", "linked", join(side.home, "linked"));
    side.workspace = join(side.home, "linked");
};

const locked: string[] = [];

/** Files made immutable (macOS `chflags uchg`), which `access(2)` does not report and a removal fails on. */
const pinned: string[] = [];

/** Makes a directory of a side read-only, to be restored after the case. */
const lock = (side: Side, path: string): void => {
    const directory = join(side.home, path);

    locked.push(directory);
    chmodSync(directory, 0o555);
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis cache clean: native vs Node", () => {
    beforeAll(() => {
        suite.setup("vis-cache-clean-parity-");
    });

    afterEach(() => {
        for (const file of pinned.splice(0)) {
            execFileSync("chflags", ["nouchg", file]);
        }

        for (const directory of locked.splice(0)) {
            if (existsSync(directory)) {
                chmodSync(directory, 0o755);
            }
        }
    });

    afterAll(() => {
        suite.teardown();
    });

    describe("answered natively", () => {
        it("clears the task cache and every store", () => {
            expect.hasAssertions();

            const result = suite.expectParity(full(), []);

            expect(result.stdout).toContain("Cleared cache:");
        });

        it.each([["task"], ["ai"], ["socket"], ["deps-dev"], ["snyk"], ["all"]])("clears only the %s store with --type", (type) => {
            expect.hasAssertions();

            suite.expectParity(full(), ["--type", type]);
            suite.expectParity(full(), [`--type=${type}`]);
        });

        it("previews what it would remove", () => {
            expect.hasAssertions();

            const result = suite.expectParity(full(), ["--dry-run"]);

            expect(result.stdout).toContain("Would remove");
        });

        it.each([["task"], ["ai"], ["socket"], ["deps-dev"], ["snyk"]])("previews the %s store", (type) => {
            expect.hasAssertions();

            suite.expectParity(full(), ["--dry-run", "--type", type]);
        });

        it("counts one entry and one record in the singular", () => {
            expect.hasAssertions();

            suite.expectParity(
                { home: { ".vis/cache/ai/a.json": "{}", ".vis/cache/snyk/issues/i.json": "{}" }, workspace: { [`${CACHE}/only/code`]: "0" } },
                ["--dry-run"],
            );
            suite.expectParity({ home: { ".vis/cache/ai/a.json": "{}" }, workspace: { [`${CACHE}/only/code`]: "0" } }, []);
        });

        it("reports a missing task cache and empty stores", () => {
            expect.hasAssertions();

            const result = suite.expectParity({}, []);

            expect(result.stdout).toContain("No cache directory to clean at");

            suite.expectParity({}, ["--dry-run"]);
        });

        it("clears a task cache that holds nothing", () => {
            expect.hasAssertions();

            suite.expectParity({ workspace: { [`${CACHE}/.keep`]: "" } }, ["--type", "task"]);
            suite.expectParity({ workspace: { [`${CACHE}/.keep`]: "" } }, ["--type", "task", "--dry-run"]);
        });

        it("leaves the state directory and the other files of the home alone", () => {
            expect.hasAssertions();

            const { native } = suite.sides(full());

            expect(existsSync(join(native.home, ".vis", "state", "tips.json"))).toBe(true);

            suite.expectParity(full(), []);
        });

        it("answers from a directory below the workspace root", () => {
            expect.hasAssertions();

            suite.expectParity(full(), [], {}, { cwd: "packages/app" });
        });

        it("clears a cache directory outside the workspace at the default location, with --force", () => {
            expect.hasAssertions();

            suite.expectParity({ home: { [`ext/${CACHE}/aaaa/code`]: "0" } }, (side) => ["--type", "task", "--cache-dir", join(side.home, "ext", CACHE), "--force"]);
        });

        it("refuses to clear a cache directory outside the workspace without --force", () => {
            expect.hasAssertions();

            const result = suite.expectParity({ home: { [`ext/${CACHE}/aaaa/code`]: "0" } }, (side) => ["--type", "task", "--cache-dir", join(side.home, "ext", CACHE)]);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain("Refusing to clean an out-of-workspace cache");
        });

        it("previews a cache directory outside the workspace and one of any other name", () => {
            expect.hasAssertions();

            suite.expectParity({ home: { "ext/custom/aaaa/code": "0" } }, (side) => ["--type", "task", "--dry-run", "--cache-dir", join(side.home, "ext", "custom")]);
            suite.expectParity({ workspace: { "custom/aaaa/code": "0" } }, ["--type", "task", "--dry-run", "--cache-dir", "custom"]);
        });

        it("refuses to delete the workspace root, and goes on to the stores", () => {
            expect.hasAssertions();

            const result = suite.expectParity(full(), ["--cache-dir", "."]);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain("Refusing to delete the workspace root");
        });

        it("refuses to clear the shared cache from a linked worktree without --force, and clears it with --force", () => {
            expect.hasAssertions();

            const fixture = { workspace: { ...taskCache(), ".gitignore": "node_modules\n" } };
            const refused = suite.expectParity(fixture, ["--type", "task"], {}, { prepare: linkedWorktree });

            expect(refused.status).toBe(1);

            suite.expectParity(fixture, ["--type", "task", "--force"], {}, { prepare: linkedWorktree });
            suite.expectParity(fixture, ["--type", "task", "--dry-run"], {}, { prepare: linkedWorktree });
        });

        it("does not touch an empty store directory or a missing one", () => {
            expect.hasAssertions();

            suite.expectParity({ home: { ".vis/cache/ai/note.txt": "keep" } }, []);
        });

        it.each([{ COLUMNS: "40" }, { COLUMNS: "200" }, ...SHORT_COLOUR_ENVIRONMENTS])("prints the same in %j", (environment) => {
            expect.hasAssertions();

            suite.expectParity(full(), [], environment);
            suite.expectParity(full(), ["--dry-run"], environment);
            // The warning and the error blocks go to stderr, and the long warning wraps.
            suite.expectParity(full(), ["--cache-dir", "."], environment);
            suite.expectParity({ home: { [`ext/${CACHE}/aaaa/code`]: "0" } }, (side) => ["--type", "task", "--cache-dir", join(side.home, "ext", CACHE)], environment);
        });
    });

    describe("handed to Node", () => {
        it("a task cache at another location than the default", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { "custom/aaaa/code": "0" } }, ["--type", "task", "--cache-dir", "custom"]);
        });

        it("an out-of-workspace cache directory with --force at another location", () => {
            expect.hasAssertions();

            suite.expectDelegation({ home: { "ext/custom/aaaa/code": "0" } }, (side) => ["--type", "task", "--cache-dir", join(side.home, "ext", "custom"), "--force"]);
        });

        it("a cache directory above the workspace", () => {
            expect.hasAssertions();

            suite.expectDeclined({ workspace: taskCache() }, (side) => ["--type", "task", "--cache-dir", dirname(side.root), "--force"]);
        });

        it("a task cache that is a symbolic link", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { "elsewhere/aaaa/code": "0", "node_modules/.keep": "" } }, ["--type", "task"], {}, {
                prepare: (side) => {
                    mkdirSync(join(side.root, "node_modules", ".cache"), { recursive: true });
                    symlinkSync(join(side.root, "elsewhere"), join(side.root, CACHE));
                },
            });
        });

        it("a task cache with a directory that cannot be removed", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { [`${CACHE}/locked/file`]: "x" } }, ["--type", "task"], {}, {
                prepare: (side) => {
                    locked.push(join(side.root, CACHE, "locked"));
                    chmodSync(join(side.root, CACHE, "locked"), 0o555);
                },
            });
        });

        // The removal would fail after the plan was made, which Node reports in its own words.
        it.skipIf(process.platform !== "darwin")("a task cache that holds an immutable file", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { [`${CACHE}/entry/file`]: "x" } }, ["--type", "task"], {}, {
                prepare: (side) => {
                    const file = join(side.root, CACHE, "entry", "file");

                    execFileSync("chflags", ["uchg", file]);
                    pinned.push(file);
                },
            });
        });

        it.skipIf(process.platform !== "darwin")("a store record that is immutable", () => {
            expect.hasAssertions();

            suite.expectDelegation({ home: { ".vis/cache/ai/a.json": "{}" } }, ["--type", "ai"], {}, {
                prepare: (side) => {
                    const file = join(side.home, ".vis/cache/ai/a.json");

                    execFileSync("chflags", ["uchg", file]);
                    pinned.push(file);
                },
            });
        });

        it("a store record that is a directory", () => {
            expect.hasAssertions();

            suite.expectDelegation({ home: { ".vis/cache/ai/dir.json/inner": "x" } }, ["--type", "ai"]);
        });

        it("a store that is a file", () => {
            expect.hasAssertions();

            suite.expectDelegation({ home: { ".vis/cache/socket-security": "not a directory" } }, ["--type", "socket"]);
        });

        it("a store directory that cannot take a removal", () => {
            expect.hasAssertions();

            suite.expectDelegation({ home: { ".vis/cache/snyk/issues/i.json": "{}" } }, ["--type", "snyk"], {}, { prepare: (side) => { lock(side, ".vis/cache/snyk/issues"); } });
        });

        it.each([
            [["--type", "bogus"]],
            [["--type"]],
            [["--dry-run", "--dry-run"]],
            [["--force", "--force"]],
            [["--dry-run=true"]],
            [["--scope", "all"]],
            [["--type", "ai", "--type", "snyk"]],
            [["extra"]],
            [["--cache-dir"]],
            [["--no-color"]],
        ])("with the arguments %j", (args: string[]) => {
            expect.hasAssertions();

            suite.expectDelegation(full(), args);
        });

        it("outside CI", () => {
            expect.hasAssertions();

            suite.expectDelegation(full(), [], { VIS_CLI_TEST: "1" }, { ci: false });
        });

        it("when pail would have a width below its header", () => {
            expect.hasAssertions();

            suite.expectDelegation(full(), [], { COLUMNS: "20" });
        });

        it.each([{ DEBUG: "1" }, { CEREBRO_OUTPUT_LEVEL: "64" }, { NODE_ENV: "test" }, { PAIL_LOG_LEVEL: "debug" }, { FORCE_COLOR: "1", NO_COLOR: "1" }])("with %j in the environment", (environment) => {
            expect.hasAssertions();

            suite.expectDelegation(full(), [], environment);
        });

        it.each([["task"], ["ai"], ["all"]])("when the workspace has a vis.config that has to be evaluated, with --type %s", (type) => {
            expect.hasAssertions();

            suite.expectDelegation(
                { home: stores(), workspace: { ...taskCache(), "vis.config.ts": 'export default { taskRunner: { cacheDirectory: ["x"].join("") } };\n' } },
                ["--type", type],
            );
        });

        it("when the workspace has a vis.config.json", () => {
            expect.hasAssertions();

            suite.expectDelegation({ home: stores(), workspace: { "vis.config.json": "{}\n" } }, ["--type", "snyk"]);
        });
    });
});
