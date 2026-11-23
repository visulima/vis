import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";

/**
 * `vis run &lt;target>` exists twice: the Node orchestrator and the native answer for a run in which every task
 * is a local cache hit (`native/cli/src/run.rs`). Each workspace below is generated here, run twice through
 * Node to fill the cache, and then run through both: stdout (as a set of lines, durations masked: Node prints
 * the lines of tasks that run side by side in the order they finish), stderr, the exit status and
 * `.vis/last-summary.json` field by field must match. For every input that changes a task key the binary must
 * hand the run to Node, which is the dangerous direction: a native hit where Node would miss serves stale output.
 *
 * The binary's fallback entry is a stub that prints a marker, so a run that quietly delegated is caught.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const marker = "NATIVE-DELEGATED";
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

interface Shape {
    /** Every package depends on the one before it. */
    chain?: boolean;
    packages: number;
    scoped?: boolean;
    tsconfig?: boolean;
    /** Indexes of packages that have no `build` script. */
    withoutScript?: number[];
}

const packageName = (shape: Shape, index: number): string => (shape.scoped ? `@acme/p${index}` : `p${index}`);

const write = (root: string, file: string, content: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
};

/** A pnpm workspace the native path accepts: lockfile, a fresh install marker, scripts only, no config. */
const generate = (root: string, shape: Shape): void => {
    write(root, "package.json", JSON.stringify({ name: "root", private: true, scripts: { build: "echo root-build" } }, undefined, 2));
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write(root, "node_modules/.modules.yaml", "layoutVersion: 5\n");

    // The install marker is newer than the lockfile, as after a real install.
    const now = Date.now() / 1000;

    utimesSync(join(root, "pnpm-lock.yaml"), now - 60, now - 60);
    utimesSync(join(root, "node_modules/.modules.yaml"), now - 30, now - 30);

    if (shape.tsconfig) {
        write(root, "tsconfig.json", '{ "compilerOptions": { "strict": true } }\n');
    }

    for (let index = 1; index <= shape.packages; index += 1) {
        const name = packageName(shape, index);
        const directory = `packages/p${index}`;
        const scripts: Record<string, string> = { test: "true" };

        if (!shape.withoutScript?.includes(index)) {
            // Half of the tasks print something, so the stored output is replayed for them.
            scripts["build"] = index % 2 === 0 ? `echo built-${index}` : "true";
        }

        write(
            root,
            `${directory}/package.json`,
            JSON.stringify(
                {
                    dependencies: shape.chain && index > 1 ? { [packageName(shape, index - 1)]: "workspace:*" } : undefined,
                    name,
                    scripts,
                    version: "1.0.0",
                },
                undefined,
                2,
            ),
        );
        write(root, `${directory}/src/index.ts`, `export const value${index} = ${index};\n`);
        write(root, `${directory}/src/nested/util.ts`, `export const util${index} = ${index};\n`);
    }
};

/** Names of every file under `root` with its size and mtime, so any write shows up. */
const snapshot = (root: string, relative = ""): string[] => {
    const directory = join(root, relative);

    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory, { withFileTypes: true })
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => {
            const path = join(relative, entry.name);
            const stats = statSync(join(root, path));

            return entry.isDirectory() ? [`${path}/ ${stats.mtimeMs}`, ...snapshot(root, path)] : [`${path} ${stats.size} ${stats.mtimeMs}`];
        });
};

const home = mkdtempSync(join(tmpdir(), "vis-run-home-"));

/** An environment built from scratch: a CI runner's colour variables must not leak into either side. */
const baseEnvironment = (extra: Record<string, string> = {}, ci = true): Record<string, string> => {
    const env: Record<string, string> = { HOME: home, PATH: process.env["PATH"] ?? "" };

    if (ci) {
        env["CI"] = "1";
    }

    return { ...env, ...extra };
};

const runNode = (cwd: string, args: string[], env: Record<string, string> = baseEnvironment()) =>
    spawnSync(process.execPath, [nodeEntry, ...args], { cwd, encoding: "utf8", env });

/** The binary, started the way the launcher starts it (`VIS_HANDOFF`, the Node version), with a stub as its fallback. */
const runNative = (cwd: string, args: string[], stub: string, env: Record<string, string> = baseEnvironment(), handoff = true) =>
    spawnSync(binary as string, args, {
        cwd,
        encoding: "utf8",
        env: {
            ...env,
            VIS_FALLBACK_ENTRY: stub,
            VIS_FALLBACK_ENTRY_OVERRIDE: stub,
            VIS_NODE: process.execPath,
            VIS_VERSION: version,
            ...(handoff ? { VIS_HANDOFF: "launcher", VIS_NODE_VERSION: process.version } : {}),
        },
    });

const mask = (text: string): string =>
    text
        .replaceAll(/\(\d+ ms\)/g, "(N ms)")
        .replaceAll(/Took \d+ ms/g, "Took N ms")
        .replaceAll(/· \d+\.\ds/g, "· Ns");

const lines = (text: string): string[] => mask(text).split("\n");

/** The summary with every run-specific value replaced, tasks in id order; key order is kept. */
const normaliseSummary = (text: string): string => {
    const summary = JSON.parse(text) as Record<string, unknown> & { tasks: Record<string, unknown>[] };
    const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

    expect(summary["id"]).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);

    for (const field of ["startTime", "endTime"]) {
        expect(summary[field]).toMatch(timestamp);

        summary[field] = "TIME";
    }

    expect(summary["duration"]).toBeTypeOf("number");

    summary["duration"] = "MS";
    summary["id"] = "ID";

    for (const task of summary.tasks) {
        for (const field of ["startTime", "endTime"]) {
            expect(task[field]).toMatch(timestamp);

            task[field] = "TIME";
        }

        expect(task["duration"]).toBeTypeOf("number");

        task["duration"] = "MS";
    }

    summary.tasks.sort((a, b) => String(a["taskId"]).localeCompare(String(b["taskId"])));

    return JSON.stringify(summary, undefined, 2);
};

const readSummary = (root: string): string => readFileSync(join(root, ".vis", "last-summary.json"), "utf8");

const copy = (from: string, to: string): string => {
    cpSync(from, to, { preserveTimestamps: true, recursive: true });

    return to;
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis run, all tasks cached: native vs Node", () => {
    const paths = { scratch: "", stub: "" };
    let counter = 0;

    /** A fresh copy of `from` to mutate and run in. */
    const fresh = (from: string): string => {
        counter += 1;

        return copy(from, join(paths.scratch, `copy-${counter}`));
    };

    beforeAll(() => {
        paths.scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-run-parity-")));
        paths.stub = join(paths.scratch, "stub.mjs");

        writeFileSync(paths.stub, `console.log("${marker}");\nprocess.exit(99);\n`);
    });

    afterAll(() => {
        rmSync(paths.scratch, { force: true, recursive: true });
        rmSync(home, { force: true, recursive: true });
    });

    /** A workspace with a warm cache, and what Node printed and wrote for the all-hit run. */
    const warm = (name: string, shape: Shape, mutate?: (root: string) => void) => {
        const root = join(paths.scratch, name);

        generate(root, shape);
        mutate?.(root);

        const cold = runNode(root, ["run", "build"]);

        expect(cold.status).toBe(0);

        const hit = runNode(root, ["run", "build"]);

        expect(hit.status).toBe(0);
        expect(hit.stdout).toContain("read from cache");

        return { root, stderr: hit.stderr, stdout: hit.stdout, summary: readSummary(root) };
    };

    const shapes: [string, Shape][] = [
        ["one package", { packages: 1 }],
        ["twenty independent packages", { packages: 20 }],
        ["a chain of twenty", { chain: true, packages: 20 }],
        ["a project without the script", { packages: 6, withoutScript: [2, 5] }],
        ["scoped names", { chain: true, packages: 4, scoped: true }],
        ["a global tsconfig.json", { packages: 5, tsconfig: true }],
    ];

    describe.each(shapes)("%s", (name, shape) => {
        const reference = { root: "", stderr: "", stdout: "", summary: "" };

        beforeAll(() => {
            Object.assign(reference, warm(name.replaceAll(" ", "-"), shape));
        }, 120_000);

        it("prints, writes and exits like Node", () => {
            expect.hasAssertions();

            const root = fresh(reference.root);
            const before = snapshot(root, "node_modules/.cache/vis");
            const native = runNative(root, ["run", "build"], paths.stub);

            // The marker is only printed by the stub, so it shows that the binary answered itself.
            expect(native.stdout).not.toContain(marker);
            expect(native.status).toBe(0);
            expect(native.stderr).toBe(reference.stderr);

            const nodeLines = lines(reference.stdout);
            const nativeLines = lines(native.stdout);

            expect(nativeLines.toSorted()).toStrictEqual(nodeLines.toSorted());
            // Header and footer do not interleave with anything.
            expect(nativeLines.slice(0, 4)).toStrictEqual(nodeLines.slice(0, 4));
            expect(nativeLines.slice(-6)).toStrictEqual(nodeLines.slice(-6));
            expect(native.stdout.endsWith("\n")).toBe(true);

            const nativeSummary = readSummary(root);

            expect(nativeSummary).toBe(JSON.stringify(JSON.parse(nativeSummary), undefined, 2));
            expect(normaliseSummary(nativeSummary)).toBe(normaliseSummary(reference.summary));
            // A hit writes nothing into the cache.
            expect(snapshot(root, "node_modules/.cache/vis")).toStrictEqual(before);
        });

        it("writes only .vis/last-summary.json", () => {
            expect.assertions(2);

            const root = fresh(reference.root);

            rmSync(join(root, ".vis"), { force: true, recursive: true });

            const before = snapshot(root).filter((entry) => !entry.startsWith(".vis"));

            runNative(root, ["run", "build"], paths.stub);

            expect(snapshot(root).filter((entry) => !entry.startsWith(".vis"))).toStrictEqual(before);
            expect(readdirSync(join(root, ".vis"))).toStrictEqual(["last-summary.json"]);
        });
    });

    describe("the all-hit decision follows Node's", () => {
        const shape: Shape = { chain: true, packages: 5, tsconfig: true };
        const base = { root: "", summary: "" };

        beforeAll(() => {
            Object.assign(base, warm("mutations", shape));
        }, 120_000);

        /** Runs both on a mutated copy: Node must not be all-hit, and the binary must hand the run to Node, untouched. */
        const expectBothMiss = (mutate: (root: string) => void): void => {
            const root = fresh(base.root);

            mutate(root);

            const before = snapshot(root);
            const native = runNative(root, ["run", "build"], paths.stub);

            expect(native.stdout).toBe(`${marker}\n`);
            expect(native.status).toBe(99);
            expect(snapshot(root)).toStrictEqual(before);

            const node = runNode(root, ["run", "build"]);
            const { stats } = JSON.parse(readSummary(root)) as { stats: { cached: number; total: number } };

            expect(node.status).toBe(0);
            expect(stats.cached).toBeLessThan(stats.total);
        };

        it.each([
            ["a source file is edited", (root: string) => { write(root, "packages/p3/src/index.ts", "export const changed = true;\n"); }],
            ["a nested source file is edited", (root: string) => { write(root, "packages/p1/src/nested/util.ts", "export const changed = true;\n"); }],
            ["a file is added", (root: string) => { write(root, "packages/p4/src/extra.ts", "export {};\n"); }],
            ["a file is deleted", (root: string) => { rmSync(join(root, "packages/p2/src/nested/util.ts")); }],
            ["a file is added at the project root", (root: string) => { write(root, "packages/p5/README.md", "# p5\n"); }],
            [
                "the script text changes",
                (root: string) => { write(root, "packages/p3/package.json", JSON.stringify({ name: "p3", scripts: { build: "echo different" }, version: "1.0.0" }, undefined, 2)); },
            ],
            [
                "another package.json field changes",
                (root: string) => { write(root, "packages/p2/package.json", readFileSync(join(root, "packages/p2/package.json"), "utf8").replace("1.0.0", "1.0.1")); },
            ],
            ["a global input (tsconfig.json) is edited", (root: string) => { write(root, "tsconfig.json", '{ "compilerOptions": { "strict": false } }\n'); }],
            ["a global input (.env) appears", (root: string) => { write(root, ".env", "A=1\n"); }],
            [
                "the lockfile changes and the install marker is refreshed",
                (root: string) => {
                    write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed\n");

                    const later = Date.now() / 1000 + 120;

                    utimesSync(join(root, "node_modules/.modules.yaml"), later, later);
                },
            ],
            [
                "a dependency's own key changes",
                // The first project of the chain: its dependents have no task edge, so only its own task misses.
                (root: string) => { write(root, "packages/p1/src/index.ts", "export const changed = 1;\n"); },
            ],
        ])("%s", (_name, mutate) => {
            expect.assertions(5);

            expectBothMiss(mutate);
        });

        it("one cache entry is deleted", () => {
            expect.assertions(5);

            expectBothMiss((root) => {
                const { tasks } = JSON.parse(readSummary(root)) as { tasks: { hash: string }[] };

                rmSync(join(root, "node_modules/.cache/vis", tasks[2]?.hash as string), { force: true, recursive: true });
            });
        });

        it("an entry is half written (no .commit)", () => {
            expect.assertions(5);

            expectBothMiss((root) => {
                const { tasks } = JSON.parse(readSummary(root)) as { tasks: { hash: string }[] };

                rmSync(join(root, "node_modules/.cache/vis", tasks[1]?.hash as string, ".commit"));
            });
        });

        it("an entry's code is not a number", () => {
            expect.assertions(5);

            expectBothMiss((root) => {
                const { tasks } = JSON.parse(readSummary(root)) as { tasks: { hash: string }[] };

                writeFileSync(join(root, "node_modules/.cache/vis", tasks[0]?.hash as string, "code"), "abc");
            });
        });

        it("ignored files do not change the key on either side", () => {
            expect.hasAssertions();

            const mutate = (root: string): void => {
                write(root, "packages/p2/.dotfile", "x\n");
                write(root, "packages/p2/dist/out.js", "x\n");
                write(root, "packages/p3/node_modules/dep/index.js", "x\n");
                write(root, "packages/p3/coverage/index.html", "x\n");
            };
            const nodeRoot = fresh(base.root);

            mutate(nodeRoot);

            const node = runNode(nodeRoot, ["run", "build"]);
            const root = fresh(base.root);

            mutate(root);

            const native = runNative(root, ["run", "build"], paths.stub);

            expect(node.stdout).toContain("5 read from cache");
            expect(native.stdout).not.toContain(marker);
            expect(lines(native.stdout).toSorted()).toStrictEqual(lines(node.stdout).toSorted());
            expect(normaliseSummary(readSummary(root))).toBe(normaliseSummary(readSummary(nodeRoot)));
        });

        const delegated = (label: string, setup: (root: string) => void, env?: Record<string, string>, args = ["run", "build"], handoff = true): void => {
            it(`delegates when ${label}`, () => {
                expect.assertions(4);

                const root = fresh(base.root);

                setup(root);

                const before = snapshot(root);
                const native = runNative(root, args, paths.stub, env ?? baseEnvironment(), handoff);

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.stderr).toBe("");
                expect(native.status).toBe(99);
                // Nothing is written before the hand-off, not even the `.vis` directory or the summary.
                expect(snapshot(root)).toStrictEqual(before);
            });
        };

        const entryOf = (root: string, index: number): string => {
            const { tasks } = JSON.parse(readSummary(root)) as { tasks: { hash: string }[] };

            return join(root, "node_modules/.cache/vis", tasks[index]?.hash as string);
        };

        delegated("an entry is older than the sweep window", (root) => {
            const old = Date.now() / 1000 - 8 * 24 * 60 * 60;

            utimesSync(entryOf(root, 0), old, old);
        });
        delegated("an unrelated entry is older than the sweep window", (root) => {
            const old = Date.now() / 1000 - 30 * 24 * 60 * 60;

            mkdirSync(join(root, "node_modules/.cache/vis/ffffffffffffffffffffffffffffffff"));
            utimesSync(join(root, "node_modules/.cache/vis/ffffffffffffffffffffffffffffffff"), old, old);
        });
        delegated("a cache entry holds outputs", (root) => {
            writeFileSync(join(entryOf(root, 0), "outputs.tar.br"), "x");
        });
        delegated("a cache entry holds a fingerprint", (root) => {
            writeFileSync(join(entryOf(root, 0), "fingerprint.json"), "{}");
        });
        delegated("a cached task failed", (root) => {
            writeFileSync(join(entryOf(root, 0), "code"), "1");
        });
        delegated("an entry's output is not UTF-8", (root) => {
            writeFileSync(join(entryOf(root, 1), "terminalOutput"), Buffer.from([0xff, 0xfe, 0x41]));
        });
        delegated("the task cache directory is missing", (root) => {
            rmSync(join(root, "node_modules/.cache"), { force: true, recursive: true });
        });
        delegated("a project sets cache: false", (root) => {
            write(root, "packages/p2/project.json", JSON.stringify({ name: "p2", targets: { build: { cache: false } } }));
        });
        delegated("a project declares outputs", (root) => {
            write(root, "packages/p2/project.json", JSON.stringify({ name: "p2", targets: { build: { outputs: ["{projectRoot}/dist"] } } }));
        });
        delegated("a vis.config file exists", (root) => {
            write(root, "vis.config.ts", "export default {};\n");
        });
        delegated("there is no lockfile", (root) => {
            rmSync(join(root, "pnpm-lock.yaml"));
        });
        delegated("another package manager's lockfile exists", (root) => {
            write(root, "package-lock.json", "{}\n");
        });
        delegated("the lockfile is newer than the install", (root) => {
            const later = Date.now() / 1000 + 600;

            utimesSync(join(root, "pnpm-lock.yaml"), later, later);
        });
        delegated("there is no install marker", (root) => {
            rmSync(join(root, "node_modules/.modules.yaml"));
        });
        delegated("a toolchain pin exists (.nvmrc)", (root) => {
            write(root, ".nvmrc", "22\n");
        });
        delegated("a toolchain pin exists (packageManager)", (root) => {
            write(root, "package.json", JSON.stringify({ name: "root", packageManager: "pnpm@10.0.0", private: true }));
        });
        delegated("run history exists", (root) => {
            mkdirSync(join(root, ".vis/runs"), { recursive: true });
        });
        delegated("the legacy task-runner directory exists", (root) => {
            mkdirSync(join(root, ".task-runner"));
        });
        delegated("a package has no name", (root) => {
            write(root, "packages/p2/package.json", JSON.stringify({ scripts: { build: "true" } }));
        });
        delegated("a script uses a ${ token", (root) => {
            write(root, "packages/p2/package.json", JSON.stringify({ name: "p2", scripts: { build: "echo ${affected.files}" } }));
        });
        delegated("a package has an inference marker (vite.config.ts)", (root) => {
            write(root, "packages/p2/vite.config.ts", "export default {};\n");
        });
        delegated("a package's script target is missing in every project", () => undefined, undefined, ["run", "nothing-defines-this"]);
        delegated("not in CI", () => undefined, baseEnvironment({}, false));
        delegated("the process was not started by the launcher", () => undefined, undefined, ["run", "build"], false);
        delegated("a flag is given", () => undefined, undefined, ["run", "build", "--no-cache"]);
        delegated("--parallel is given", () => undefined, undefined, ["run", "build", "--parallel=2"]);
        delegated("two targets are given", () => undefined, undefined, ["run", "build", "test"]);
        delegated("a filter is given", () => undefined, undefined, ["run", "build", "--filter=p1"]);
        delegated("the target is a selector", () => undefined, undefined, ["run", "p1:build"]);
        delegated("no target is given", () => undefined, undefined, ["run"]);
        delegated("a remote cache is configured in the environment", () => undefined, baseEnvironment({ TURBO_API: "http://127.0.0.1:1" }));
        delegated("the cache directory is overridden", () => undefined, baseEnvironment({ VIS_CACHE_DIRECTORY: "/tmp/elsewhere" }));
        delegated("the concurrency is overridden", () => undefined, baseEnvironment({ VIS_RUN_CONCURRENCY_LIMIT: "1" }));
        delegated("a runtime is chosen", () => undefined, baseEnvironment({ VIS_RUNTIME: "node" }));
        delegated("the logger is configured", () => undefined, baseEnvironment({ PAIL_LOG_LEVEL: "debug" }));
        delegated("NODE_ENV is test", () => undefined, baseEnvironment({ NODE_ENV: "test" }));

        it("still answers when only a dot file, the v2 store or an entry inside the window is old", () => {
            expect.assertions(2);

            const root = fresh(base.root);
            const old = Date.now() / 1000 - 40 * 24 * 60 * 60;
            const recent = Date.now() / 1000 - 5 * 24 * 60 * 60;

            mkdirSync(join(root, "node_modules/.cache/vis/v2"));
            write(root, "node_modules/.cache/vis/.task-index.json", "{}");
            utimesSync(join(root, "node_modules/.cache/vis/v2"), old, old);
            utimesSync(join(root, "node_modules/.cache/vis/.task-index.json"), old, old);
            utimesSync(entryOf(root, 3), recent, recent);

            const native = runNative(root, ["run", "build"], paths.stub);

            expect(native.stdout).not.toContain(marker);
            expect(native.status).toBe(0);
        });

        it("delegates when the working directory is not the workspace root", () => {
            expect.assertions(2);

            const root = fresh(base.root);
            const native = runNative(join(root, "packages", "p1"), ["run", "build"], paths.stub);

            expect(native.stdout).toBe(`${marker}\n`);
            expect(existsSync(join(root, "packages", "p1", ".vis"))).toBe(false);
        });

        it("delegates when VIS_MONOREPO_ROOT names another directory", () => {
            expect.assertions(1);

            const native = runNative(fresh(base.root), ["run", "build"], paths.stub, baseEnvironment({ VIS_MONOREPO_ROOT: paths.scratch }));

            expect(native.stdout).toBe(`${marker}\n`);
        });

        it("ignores a stale VIS_NODE_VERSION when the launcher did not start it", () => {
            expect.assertions(2);

            const native = runNative(fresh(base.root), ["run", "build"], paths.stub, baseEnvironment({ VIS_NODE_VERSION: "v1.2.3" }), false);

            expect(native.stdout).toBe(`${marker}\n`);
            expect(native.status).toBe(99);
        });

        it("records the launcher's Node version, not its own", () => {
            expect.assertions(1);

            const root = fresh(base.root);

            runNative(root, ["run", "build"], paths.stub);

            expect((JSON.parse(readSummary(root)) as { environment: { nodeVersion: string } }).environment.nodeVersion).toBe(process.version);
        });

        it("hands a stale `last-summary.json` over: the next run overwrites it", () => {
            expect.assertions(2);

            const root = fresh(base.root);

            write(root, ".vis/last-summary.json", "{}");

            const native = runNative(root, ["run", "build"], paths.stub);

            expect(native.stdout).not.toContain(marker);
            expect((JSON.parse(readSummary(root)) as { stats: { total: number } }).stats.total).toBe(5);
        });
    });

    describe("the colour environment", () => {
        const shape: Shape = { packages: 4 };
        const reference = { root: "" };

        beforeAll(() => {
            reference.root = warm("colour", shape).root;
        }, 120_000);

        const environments = [...COLOUR_ENVIRONMENTS, ...DELEGATED_COLOUR_ENVIRONMENTS];

        it.each(environments.map((colour) => [JSON.stringify(colour), colour] as const))("%s: native only where Node prints plain text", (_label, colour) => {
            expect.assertions(1);

            const env = baseEnvironment(colour);
            const root = fresh(reference.root);
            const node = runNode(root, ["run", "build"], env);
            const native = runNative(fresh(reference.root), ["run", "build"], paths.stub, env);
            const answered = !native.stdout.includes(marker);
            // Colour codes and CI log groups are not reproduced, so the binary must leave those runs to Node.
            const plain = !node.stdout.includes("\u001B") && !node.stdout.includes("::group::") && node.stderr === "";

            // Either the binary answered and Node printed plain text with the same lines, or it left the run to Node untouched.
            const expected = answered
                ? { lines: lines(node.stdout).toSorted(), plain: true, status: 0, stderr: node.stderr }
                : { lines: [marker, ""], plain: plain || true, status: 99, stderr: "" };
            const actual = {
                lines: answered ? lines(native.stdout).toSorted() : lines(native.stdout),
                plain: !answered || plain,
                status: native.status,
                stderr: native.stderr,
            };

            expect(actual).toStrictEqual(expected);
        });

        it.each([{}, { TERM: "dumb" }, { NO_COLOR: "1" }, { FORCE_COLOR: "0" }, { TERM: "xterm-256color" }, { COLORTERM: "truecolor" }, { CLICOLOR_FORCE: "1" }, { COLUMNS: "50" }])(
            "answers natively with %j",
            (colour: Record<string, string>) => {
                expect.assertions(2);

                const native = runNative(fresh(reference.root), ["run", "build"], paths.stub, baseEnvironment(colour));

                expect(native.stdout).not.toContain(marker);
                expect(native.status).toBe(0);
            },
        );

        it.each([{ GITHUB_ACTIONS: "true" }, { GITLAB_CI: "true" }, { BUILDKITE: "true" }, { TF_BUILD: "True" }, { FORCE_COLOR: "1" }, { FORCE_COLOR: "3" }, { CIRCLECI: "true" }])(
            "leaves a coloured or grouped run to Node with %j",
            (colour: Record<string, string>) => {
                expect.assertions(2);

                const native = runNative(fresh(reference.root), ["run", "build"], paths.stub, baseEnvironment(colour));

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
            },
        );
    });

    describe("a long name", () => {
        it("goes to Node when a rendered line could wrap", () => {
            expect.assertions(2);

            const root = join(paths.scratch, "long-name");

            generate(root, { packages: 2 });
            write(root, "packages/p1/package.json", JSON.stringify({ name: "x".repeat(60), scripts: { build: "true" }, version: "1.0.0" }));
            runNode(root, ["run", "build"]);

            const native = runNative(root, ["run", "build"], paths.stub);

            expect(native.stdout).toBe(`${marker}\n`);
            expect(native.status).toBe(99);
        });
    });
});
