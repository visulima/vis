import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Fixture, Side } from "./destructive-parity-harness";
import { DestructiveSuite } from "./destructive-parity-harness";
import { binary, nodeEntry } from "./workspace-parity-harness";

/**
 * `vis cache prune` exists twice: the Node handler (`src/commands/cache/prune.ts`, `handler.ts`, with the task runner's
 * `Cache.removeOldEntries`) and the native path (`native/cli/src/cache_prune.rs`). It deletes cache entries, so every case
 * runs both sides on identical throwaway workspaces and compares stdout, stderr, the exit status and the whole state left
 * on disk (see `destructive-parity-harness.ts`). The ages are set relative to now and kept far from every limit, because
 * the two sides read the clock a moment apart. A run the binary declines must hand the call to Node before it prints or
 * removes anything.
 */

const suite = new DestructiveSuite(["cache", "prune"]);

const CACHE = "node_modules/.cache/vis";

const HOUR = 3600;
const DAY = 86_400;

/** An entry: files of the given sizes, one of them nested. */
const entry = (base: string, hash: string, sizes: number[]): Record<string, string> => Object.fromEntries(sizes.map((size, index) => [`${base}/${hash}/${index % 2 === 0 ? "" : "nested/"}file-${String(index)}`, "x".repeat(size)]));

/** The ages of the entries `cache()` writes, in seconds. */
const AGES: Record<string, number> = {
    a1a1a1a1: HOUR,
    b2b2b2b2: 2 * DAY,
    c3c3c3c3: 10 * DAY,
    d4d4d4d4: 40 * DAY,
    e5e5e5e5: 12 * HOUR,
    "plain-file": 20 * DAY,
};

/** A task cache of five entries of different ages and sizes, a plain old file and an old dot directory. */
const cache = (base = CACHE): Record<string, string> => {
    return {
        ...entry(base, "a1a1a1a1", [3000, 1500, 7]),
        ...entry(base, "b2b2b2b2", [1500]),
        ...entry(base, "c3c3c3c3", [100]),
        ...entry(base, "d4d4d4d4", [1]),
        ...entry(base, "e5e5e5e5", [10_000]),
        [`${base}/.hidden/data`]: "x",
        [`${base}/plain-file`]: "old",
    };
};

/** Sets the modification time of each path (relative to the workspace root) to `age` seconds ago. */
const aged = (ages: Record<string, number>, base = CACHE) => (side: Side): void => {
    for (const [name, age] of Object.entries(ages)) {
        const time = Date.now() / 1000 - age;

        utimesSync(join(side.root, base, name), time, time);
    }
};

const prepared = aged(AGES);

const withCache = (): Fixture => {
    return { workspace: cache() };
};

const locked: string[] = [];

/** Files made immutable (macOS `chflags uchg`), which `access(2)` does not report and a removal fails on. */
const pinned: string[] = [];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis cache prune: native vs Node", () => {
    beforeAll(() => {
        suite.setup("vis-cache-prune-parity-");
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
        it("removes what is older than seven days by default", () => {
            expect.hasAssertions();

            const result = suite.expectParity(withCache(), [], {}, { prepare: prepared });

            expect(result.stdout).toContain("Pruned 2 entries");
        });

        it("reports nothing to prune", () => {
            expect.hasAssertions();

            const result = suite.expectParity({ workspace: cache() }, [], {}, { prepare: aged({ a1a1a1a1: HOUR, b2b2b2b2: 2 * DAY, c3c3c3c3: 3 * DAY, d4d4d4d4: 4 * DAY, e5e5e5e5: 12 * HOUR, "plain-file": DAY }) });

            expect(result.stdout).toContain("Nothing to prune");
        });

        it("reports a missing cache directory", () => {
            expect.hasAssertions();

            const result = suite.expectParity({}, []);

            expect(result.stdout).toContain("No cache directory to prune at");
        });

        it("says entry in the singular", () => {
            expect.hasAssertions();

            const result = suite.expectParity({ workspace: { ...entry(CACHE, "old1", [10]), ...entry(CACHE, "new1", [10]) } }, [], {}, { prepare: aged({ new1: HOUR, old1: 30 * DAY }) });

            expect(result.stdout).toContain("Pruned 1 entry");
        });

        it.each([["0"], ["1"], ["2"], ["3"], ["5"], ["100"]])("keeps the %s newest entries with --keep-last", (keep) => {
            expect.hasAssertions();

            suite.expectParity(withCache(), ["--keep-last", keep], {}, { prepare: prepared });
            suite.expectParity(withCache(), [`--keep-last=${keep}`], {}, { prepare: prepared });
        });

        it.each([["0.5"], ["1"], ["1.5"], ["5"], ["30"], ["100"], ["0"]])("removes what is older than %s days with --max-age-days", (days) => {
            expect.hasAssertions();

            suite.expectParity(withCache(), ["--max-age-days", days], {}, { prepare: prepared });
        });

        it.each([["1KB"], ["5KB"], ["10KB"], ["12KB"], ["1MB"], ["1GB"], ["1TB"]])("evicts the oldest entries beyond %s with --max-size", (limit) => {
            expect.hasAssertions();

            suite.expectParity(withCache(), ["--max-size", limit], {}, { prepare: prepared });
            suite.expectParity(withCache(), ["--max-age-days", "100", `--max-size=${limit}`], {}, { prepare: prepared });
        });

        it("combines the three limits", () => {
            expect.hasAssertions();

            suite.expectParity(withCache(), ["--keep-last", "4", "--max-age-days", "5", "--max-size", "13KB"], {}, { prepare: prepared });
            suite.expectParity(withCache(), ["--keep-last", "4", "--max-age-days", "100", "--max-size", "11KB"], {}, { prepare: prepared });
        });

        it("keeps the v2 subtree from the age and size limits but not from --keep-last", () => {
            expect.hasAssertions();

            const fixture = { workspace: { ...cache(), [`${CACHE}/v2/cas/blob`]: "x".repeat(4000) } };
            const prepare = (side: Side): void => {
                prepared(side);
                aged({ v2: 60 * DAY })(side);
            };

            suite.expectParity(fixture, [], {}, { prepare });
            suite.expectParity(fixture, ["--max-size", "1KB"], {}, { prepare });
            suite.expectParity(fixture, ["--keep-last", "2"], {}, { prepare });
        });

        it("prunes a cache directory given with --cache-dir, relative or absolute", () => {
            expect.hasAssertions();

            suite.expectParity({ workspace: cache("custom") }, ["--cache-dir", "custom"], {}, { prepare: aged(AGES, "custom") });
            suite.expectParity({ home: cache("ext"), workspace: {} }, (side) => ["--cache-dir", join(side.home, "ext")], {}, {
                prepare: (side) => {
                    for (const [name, age] of Object.entries(AGES)) {
                        const time = Date.now() / 1000 - age;

                        utimesSync(join(side.home, "ext", name), time, time);
                    }
                },
            });
        });

        it("prunes the shared and the worktree cache once when they are the same, with --scope", () => {
            expect.hasAssertions();

            for (const scope of ["shared", "worktree", "all"]) {
                suite.expectParity(withCache(), ["--scope", scope], {}, { prepare: prepared });
            }
        });

        it("answers from a directory below the workspace root", () => {
            expect.hasAssertions();

            suite.expectParity(withCache(), [], {}, { cwd: "packages/app", prepare: prepared });
        });

        describe("with branch scoping on", () => {
            const config = "export default { branchScopedCache: true };\n";
            const branches = (): Record<string, string> => {
                return {
                    ...cache(`${CACHE}/branches/feature-x`),
                    ...cache(`${CACHE}/branches/main`),
                    ...cache(),
                    "vis.config.ts": config,
                };
            };
            const prepare = (side: Side): void => {
                prepared(side);
                aged(AGES, `${CACHE}/branches/feature-x`)(side);
                aged({ ...AGES, c3c3c3c3: 3 * DAY, d4d4d4d4: 9 * DAY }, `${CACHE}/branches/main`)(side);
                aged({ branches: DAY })(side);
            };

            it("prunes the base and every branch, each under a header", () => {
                expect.hasAssertions();

                const result = suite.expectParity({ workspace: branches() }, [], {}, { prepare });

                expect(result.stdout).toContain("# ");
            });

            it("applies --keep-last and --max-size to each directory", () => {
                expect.hasAssertions();

                suite.expectParity({ workspace: branches() }, ["--keep-last", "2"], {}, { prepare });
                suite.expectParity({ workspace: branches() }, ["--max-size", "5KB"], {}, { prepare });
            });

            it("finds the branch directories gone once the expired container is removed", () => {
                expect.hasAssertions();

                const result = suite.expectParity({ workspace: branches() }, [], {}, {
                    prepare: (side) => {
                        prepare(side);
                        aged({ branches: 30 * DAY })(side);
                    },
                });

                expect(result.stdout).toContain("No cache directory to prune at");
            });
        });

        it.each([{ COLUMNS: "40" }, { COLUMNS: "200" }, ...SHORT_COLOUR_ENVIRONMENTS])("prints the same in %j", (environment) => {
            expect.hasAssertions();

            suite.expectParity(withCache(), [], environment, { prepare: prepared });
            suite.expectParity({}, [], environment);
        });
    });

    describe("handed to Node", () => {
        it("an entry that is a symbolic link", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { ...cache(), "elsewhere/inner/file": "x" } }, [], {}, {
                prepare: (side) => {
                    prepared(side);
                    symlinkSync("../../../elsewhere", join(side.root, CACHE, "linked"));
                },
            });
        });

        it("an entry with a directory that cannot be removed", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { ...entry(CACHE, "old1", [10]), [`${CACHE}/old1/locked/file`]: "x" } }, [], {}, {
                prepare: (side) => {
                    aged({ old1: 30 * DAY })(side);
                    locked.push(join(side.root, CACHE, "old1", "locked"));
                    chmodSync(join(side.root, CACHE, "old1", "locked"), 0o555);
                },
            });
        });

        // The removal would fail after the plan was made, so the native path must see it first.
        it.skipIf(process.platform !== "darwin")("an expired entry that holds an immutable file", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { ...entry(CACHE, "old1", [10]), ...entry(CACHE, "new1", [10]) } }, [], {}, {
                prepare: (side) => {
                    aged({ new1: HOUR, old1: 30 * DAY })(side);

                    const file = join(side.root, CACHE, "old1", "file-0");

                    execFileSync("chflags", ["uchg", file]);
                    pinned.push(file);
                },
            });
        });

        it.skipIf(process.platform !== "darwin")("an entry that --keep-last drops and that holds an immutable file", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { ...entry(CACHE, "old1", [10]), ...entry(CACHE, "new1", [10]) } }, ["--keep-last", "1"], {}, {
                prepare: (side) => {
                    aged({ new1: HOUR, old1: 2 * HOUR })(side);

                    const file = join(side.root, CACHE, "old1", "file-0");

                    execFileSync("chflags", ["uchg", file]);
                    pinned.push(file);
                },
            });
        });

        it("an entry whose name is not ASCII", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { ...cache(), [`${CACHE}/éntry/file`]: "x" } }, [], {}, { prepare: prepared });
        });

        it.each([
            [["--keep-last", "-1"]],
            [["--keep-last", "1.5"]],
            [["--keep-last", "abc"]],
            [["--keep-last", "01"]],
            [["--keep-last", "1e1"]],
            [["--keep-last"]],
            [["--max-age-days", "-1"]],
            [["--max-age-days", "abc"]],
            [["--max-age-days", "1e3"]],
            [["--max-age-days", ".5"]],
            [["--max-size", "500mb"]],
            [["--max-size", "500 MB"]],
            [["--max-size", "0MB"]],
            [["--max-size", "1.5GB"]],
            [["--max-size", "500"]],
            [["--max-size", "500B"]],
            [["--max-size", "bogus"]],
            [["--scope", "bogus"]],
            [["--keep-last", "1", "--keep-last", "2"]],
            [["--dry-run"]],
            [["extra"]],
            [["--no-color"]],
        ])("with the arguments %j", (args: string[]) => {
            expect.hasAssertions();

            suite.expectDelegation(withCache(), args, {}, { prepare: prepared });
        });

        it("a nothing-to-prune line that pail wraps differently", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: cache() }, [], { COLUMNS: "60" }, { prepare: aged({ a1a1a1a1: HOUR, b2b2b2b2: DAY, c3c3c3c3: DAY, d4d4d4d4: DAY, e5e5e5e5: HOUR, "plain-file": DAY }) });
        });

        it("outside CI", () => {
            expect.hasAssertions();

            suite.expectDelegation(withCache(), [], { VIS_CLI_TEST: "1" }, { ci: false, prepare: prepared });
        });

        it.each([{ DEBUG: "1" }, { CEREBRO_OUTPUT_LEVEL: "64" }, { NODE_ENV: "test" }, { PAIL_LOG_LEVEL: "debug" }, { FORCE_COLOR: "1", NO_COLOR: "1" }])("with %j in the environment", (environment) => {
            expect.hasAssertions();

            suite.expectDelegation(withCache(), [], environment, { prepare: prepared });
        });

        it("when the workspace has a vis.config that has to be evaluated", () => {
            expect.hasAssertions();

            suite.expectDelegation({ workspace: { ...cache(), "vis.config.ts": 'export default { taskRunner: { cacheDirectory: ["x"].join("") } };\n' } }, [], {}, { prepare: prepared });
        });
    });
});
