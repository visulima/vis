import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
    /** Every third package lives under `apps/` (a second workspace pattern) instead of `packages/`. */
    apps?: boolean;
    /** Many files per package, created in an order that is not the sorted one, with mixed case, `_`, `-`, digits and non-ASCII names. */
    busy?: boolean;
    /** Every package depends on the one before it. */
    chain?: boolean;
    packages: number;
    scoped?: boolean;
    tsconfig?: boolean;
    /** Indexes of packages that have no `build` script. */
    withoutScript?: number[];
}

const packageName = (shape: Shape, index: number): string => (shape.scoped ? `@acme/p${index}` : `p${index}`);

const directoryOf = (shape: Shape, index: number): string => (shape.apps && index % 3 === 0 ? `apps/p${index}` : `packages/p${index}`);

/** Not in sorted order on purpose: the key order of `hashDetails.nodes` is part of what is compared. */
const BUSY_FILES = ["src/b.ts", "src/Bb.ts", "src/_private.ts", "src/10.ts", "src/2.ts", "src/a-b.ts", "src/a_b.ts", "src/a.b.ts", "src/Zed/inner.ts", "src/yed/inner.ts", "src/\u00FCn\u00EF.ts", "z.md", "A.md"];

const write = (root: string, file: string, content: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
};

/** A pnpm workspace the native path accepts: lockfile, a fresh install marker, scripts only, no config. */
const generate = (root: string, shape: Shape): void => {
    write(root, "package.json", JSON.stringify({ name: "root", private: true, scripts: { build: "echo root-build" } }, undefined, 2));
    write(root, "pnpm-workspace.yaml", `packages:\n  - "packages/*"\n${shape.apps ? '  - "apps/*"\n' : ""}`);
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
        const directory = directoryOf(shape, index);
        const scripts: Record<string, string> = { test: "true" };

        if (!shape.withoutScript?.includes(index)) {
            // Half of the tasks print something, so the stored output is replayed for them.
            scripts["build"] = index % 4 === 0 ? `echo "  first-${index}" && echo second-${index}` : index % 2 === 0 ? `echo built-${index}` : "true";
        }

        const hasScripts = !shape.noScripts?.includes(index);

        write(
            root,
            `${directory}/package.json`,
            JSON.stringify(
                {
                    dependencies: shape.chain && index > 1 ? { [packageName(shape, index - 1)]: "workspace:*" } : undefined,
                    name,
                    scripts: shape.emptyScripts?.includes(index) ? {} : hasScripts ? scripts : undefined,
                    version: "1.0.0",
                },
                undefined,
                2,
            ),
        );
        write(root, `${directory}/src/index.ts`, `export const value${index} = ${index};\n`);
        write(root, `${directory}/src/nested/util.ts`, `export const util${index} = ${index};\n`);

        for (const file of shape.busy ? BUSY_FILES : []) {
            write(root, `${directory}/${file}`, `export const file${index} = ${JSON.stringify(file)};\n`);
        }
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
            VIS_NODE: env["VIS_NODE"] ?? process.execPath,
            VIS_VERSION: version,
            ...(handoff ? { VIS_HANDOFF: "launcher", VIS_NODE_VERSION: process.version } : {}),
        },
    });

/** `node bin/vis.mjs`, the way `vis` starts when the native executable is not installed at `bin/vis`. */
const runLauncher = (cwd: string, args: string[], stub: string, env: Record<string, string> = baseEnvironment()) =>
    spawnSync(process.execPath, [join(packageRoot, "bin", "vis.mjs"), ...args], { cwd, encoding: "utf8", env: { ...env, VIS_FALLBACK_ENTRY_OVERRIDE: stub } });

const mask = (text: string): string =>
    text
        .replaceAll(/section_(start|end):\d+:/g, "section_$1:T:")
        .replaceAll(/\(\d+ ms\)/g, "(N ms)")
        .replaceAll(/Took \d+ (?:ms|s|min|h)(?: \d+ (?:ms|s|min|h))*/g, "Took N ms")
        .replaceAll(/· \d+\.\ds/g, "· Ns");

const lines = (text: string): string[] => mask(text).split("\n");

const ESC = String.fromCodePoint(27);
const SEPARATOR = new RegExp(`^(?:${ESC}\\[2m)?\u2014{80}(?:${ESC}\\[22m)?$`);

/**
 * The output block of each task, in the order the lines come, each as one string: the grouping directives (or the
 * separator lines) and the output between them. A sorted line comparison cannot see this structure: a block that
 * interleaves with the `\u2713` line of another task, or lost a directive, has the same sorted lines.
 */
const blocksOf = (text: string): string[] => {
    const blocks: string[] = [];
    const isStart = (line: string): boolean => line.startsWith("::group::") || line.includes("section_start:") || line.startsWith("##[group]") || line.startsWith("--- ") || SEPARATOR.test(line);
    const isEnd = (line: string): boolean => line.startsWith("::endgroup::") || line.includes("section_end:") || line.startsWith("##[endgroup]");
    // A Buildkite block has no end line: it runs to the next line the renderer prints itself.
    const endsBuildkite = (line: string): boolean => line === "" || line.includes("[cache]") || line.includes(">") || line.includes("VIS");
    let current: { buildkite: boolean; lines: string[]; separated: boolean; separators: number } | undefined;

    for (const line of lines(text)) {
        if (current === undefined) {
            if (isStart(line)) {
                const separated = SEPARATOR.test(line);

                current = { buildkite: line.startsWith("--- "), lines: [line], separated, separators: separated ? 1 : 0 };
            }

            continue;
        }

        if (current.buildkite && endsBuildkite(line)) {
            blocks.push(current.lines.join("\n"));
            current = undefined;

            continue;
        }

        current.lines.push(line);

        if (current.separated && SEPARATOR.test(line)) {
            current.separators += 1;
        }

        if ((current.separated && current.separators === 2) || (!current.separated && !current.buildkite && isEnd(line))) {
            blocks.push(current.lines.join("\n"));
            current = undefined;
        }
    }

    return blocks;
};

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
    const warm = (name: string, shape: Shape, mutate?: (root: string) => void, env: Record<string, string> = baseEnvironment()) => {
        const root = join(paths.scratch, name);

        generate(root, shape);
        mutate?.(root);

        const cold = runNode(root, ["run", "build"], env);

        expect(cold.status).toBe(0);

        const hit = runNode(root, ["run", "build"], env);

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
        ["many files and two workspace patterns", { apps: true, busy: true, chain: true, packages: 9 }],
        ["projects with no scripts", { emptyScripts: [4], noScripts: [2], packages: 6 }],
        // The tasks are keyed and looked up side by side: the printed order and the summary stay the project order.
        ["two hundred packages in two workspace patterns", { apps: true, busy: true, packages: 200 }],
    ];

    describe.each(shapes)("%s", (name, shape) => {
        const reference = { root: "", stderr: "", stdout: "", summary: "" };

        beforeAll(() => {
            Object.assign(reference, warm(name.replaceAll(" ", "-"), shape));
        }, 300_000);

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
        it.each(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", "aube-lock.yaml"])("delegates when %s exists", (lockfile) => {
            expect.assertions(3);

            const root = fresh(base.root);

            write(root, lockfile, "{}\n");

            const before = snapshot(root);
            const native = runNative(root, ["run", "build"], paths.stub);

            expect(native.stdout).toBe(`${marker}\n`);
            expect(native.status).toBe(99);
            expect(snapshot(root)).toStrictEqual(before);
        });
        delegated("the lockfile is newer than the install", (root) => {
            const later = Date.now() / 1000 + 600;

            utimesSync(join(root, "pnpm-lock.yaml"), later, later);
        });
        delegated("there is no install marker", (root) => {
            rmSync(join(root, "node_modules/.modules.yaml"));
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
        delegated("a package has an inference marker (tsconfig.json)", (root) => {
            write(root, "packages/p2/tsconfig.json", "{}\n");
        });
        delegated("a package has an inference marker (vite.config.ts)", (root) => {
            write(root, "packages/p2/vite.config.ts", "export default {};\n");
        });
        delegated("a package's script target is missing in every project", () => undefined, undefined, ["run", "nothing-defines-this"]);
        delegated("not in CI", () => undefined, baseEnvironment({}, false));
        delegated("only CONTINUOUS_INTEGRATION is set", () => undefined, baseEnvironment({ CONTINUOUS_INTEGRATION: "1" }, false));
        delegated("CI is empty", () => undefined, baseEnvironment({ CI: "" }, false));
        delegated("CI is false", () => undefined, baseEnvironment({ CI: "false" }, false));
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

        it("through the launcher, answers a hit natively and runs Node in the same process for a miss", () => {
            expect.assertions(7);

            const hit = fresh(base.root);
            const answered = runLauncher(hit, ["run", "build"], paths.stub);

            expect(answered.stdout).not.toContain(marker);
            expect(answered.status).toBe(0);

            const missed = fresh(base.root);

            write(missed, "packages/p3/src/index.ts", "export const changed = true;\n");

            const before = snapshot(missed);
            const handed = runLauncher(missed, ["run", "build"], paths.stub);

            // The marker once: the binary handed the run back, and the launcher's own Node CLI printed it.
            expect(handed.stdout).toBe(`${marker}\n`);
            expect(handed.stderr).toBe("");
            expect(handed.status).toBe(99);
            expect(snapshot(missed)).toStrictEqual(before);
            expect(runLauncher(missed, ["run", "build", "--no-cache"], paths.stub).stdout).toBe(`${marker}\n`);
        });

        it("hands a run it cannot answer back with the launcher's status, and only for a launcher start", () => {
            expect.assertions(5);

            const root = fresh(base.root);

            write(root, "packages/p3/src/index.ts", "export const changed = true;\n");

            const env = baseEnvironment({ VIS_HANDBACK_STATUS: "75" });
            const handedBack = runNative(root, ["run", "build"], paths.stub, env);

            expect(handedBack.status).toBe(75);
            expect(handedBack.stdout).toBe("");

            // A stale status from a parent process is dropped without the hand-off marker.
            const standalone = runNative(root, ["run", "build"], paths.stub, env, false);

            expect(standalone.status).toBe(99);
            expect(standalone.stdout).toBe(`${marker}\n`);
            expect(standalone.stderr).toBe("");
        });

        it("starts Node itself for any hand-back status but the launcher's, even with the hand-off marker", () => {
            expect.assertions(6);

            const root = fresh(base.root);

            write(root, "packages/p3/src/index.ts", "export const changed = true;\n");

            for (const status of ["0", "3", "75x"]) {
                const forged = runNative(root, ["run", "build"], paths.stub, baseEnvironment({ VIS_HANDBACK_STATUS: status }));

                expect(forged.status).toBe(99);
                expect(forged.stdout).toBe(`${marker}\n`);
            }
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

        it("ignores a stale VIS_NODE_VERSION when the launcher did not start it, and asks the Node it would delegate to", () => {
            expect.assertions(3);

            const root = fresh(base.root);
            const native = runNative(root, ["run", "build"], paths.stub, baseEnvironment({ VIS_NODE_VERSION: "v1.2.3" }), false);

            expect(native.stdout).not.toContain(marker);
            expect(native.status).toBe(0);
            expect((JSON.parse(readSummary(root)) as { environment: { nodeVersion: string } }).environment.nodeVersion).toBe(process.version);
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

    describe("the colour and log grouping environment", () => {
        // Four packages, two of them print (`built-2`, and a two-line output), so the blocks have something to wrap.
        const shape: Shape = { packages: 4 };
        const reference = { root: "" };

        beforeAll(() => {
            reference.root = warm("colour", shape).root;
        }, 120_000);

        /** The environments of a CI runner and its neighbours: the grouping compares exactly, the colour is presence based. */
        const GROUPING_ENVIRONMENTS: Record<string, string>[] = [
            { GITHUB_ACTIONS: "true" },
            { GITHUB_ACTIONS: "1" },
            { GITHUB_ACTIONS: "false" },
            { GITHUB_ACTIONS: "TRUE" },
            { GITHUB_WORKFLOW: "ci" },
            { GITLAB_CI: "true" },
            { GITLAB_CI: "1" },
            { BUILDKITE: "true" },
            { BUILDKITE: "1" },
            { TF_BUILD: "True" },
            { AGENT_NAME: "agent", TF_BUILD: "True" },
            { TF_BUILD: "true" },
            { TF_BUILD: "TRUE" },
            { TF_BUILD: "yes" },
            { AGENT_NAME: "agent", FORCE_COLOR: "0", TF_BUILD: "True" },
            { GITHUB_ACTIONS: "true", GITLAB_CI: "true" },
            { BUILDKITE: "true", GITLAB_CI: "true" },
            { BUILDKITE: "true", TF_BUILD: "True" },
            { GITHUB_ACTIONS: "true", GITLAB_CI: "true", TF_BUILD: "True" },
            { GITHUB_ACTIONS: "true", TERM: "xterm-256color" },
            { FORCE_COLOR: "1", GITLAB_CI: "true" },
            { FORCE_COLOR: "0", GITLAB_CI: "true" },
            { FORCE_COLOR: "", GITLAB_CI: "true" },
            { FORCE_COLOR: "abc", GITHUB_ACTIONS: "true" },
            { GITLAB_CI: "true", NO_COLOR: "1" },
            { GITLAB_CI: "true", TERM: "dumb" },
            { BUILDKITE: "true", TERM: "xterm-mono" },
            { TRAVIS: "true" },
            { DRONE: "true" },
            { GITEA_ACTIONS: "true" },
            { CI_NAME: "codeship" },
            { CI_NAME: "other" },
            { TERM: "xterm-mono" },
            { FORCE_COLOR: "" },
            { FORCE_COLOR: "abc" },
            // What a real runner sets besides the provider's marker.
            {
                ACTIONS_CACHE_URL: "http://127.0.0.1:1/",
                ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:1/",
                ACTIONS_RUNTIME_TOKEN: "token",
                GITHUB_ACTIONS: "true",
                GITHUB_REF: "refs/heads/main",
                GITHUB_REPOSITORY: "owner/repo",
                GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
                GITHUB_TOKEN: "token",
                GITHUB_WORKFLOW: "ci",
                RUNNER_OS: "Linux",
            },
            {
                CI_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
                CI_JOB_TOKEN: "token",
                CI_PIPELINE_SOURCE: "push",
                CI_PROJECT_PATH: "owner/repo",
                GITLAB_CI: "true",
            },
            { BUILDKITE: "true", BUILDKITE_BUILD_ID: "1", BUILDKITE_COMMIT: "0123456789abcdef0123456789abcdef01234567" },
            { AGENT_NAME: "agent", BUILD_SOURCEVERSION: "0123456789abcdef", SYSTEM_TEAMPROJECT: "p", TF_BUILD: "True" },
        ];
        const environments = [...COLOUR_ENVIRONMENTS, ...GROUPING_ENVIRONMENTS];

        it.each(environments.map((colour) => [JSON.stringify(colour), colour] as const))("%s: native prints what Node prints", (_label, colour) => {
            expect.hasAssertions();

            // The provider's own files (the step summary, the output file) are left alone by both sides.
            const files = ["summary", "output"].map((name) => join(paths.scratch, `${name}-${counter}`));

            for (const file of files) {
                writeFileSync(file, "");
            }

            const env = baseEnvironment({ ...colour, ...(colour["GITHUB_ACTIONS"] === "true" ? { GITHUB_OUTPUT: files[1] as string, GITHUB_STEP_SUMMARY: files[0] as string } : {}) });
            const node = runNode(fresh(reference.root), ["run", "build"], env);
            const nativeRoot = fresh(reference.root);
            const native = runNative(nativeRoot, ["run", "build"], paths.stub, env);

            expect(native.stdout).not.toContain(marker);
            expect(native.status).toBe(0);
            expect(native.stderr).toBe(node.stderr);
            expect(lines(native.stdout).toSorted()).toStrictEqual(lines(node.stdout).toSorted());
            // Header and footer do not interleave with anything.
            expect(lines(native.stdout).slice(0, 4)).toStrictEqual(lines(node.stdout).slice(0, 4));
            expect(lines(native.stdout).slice(-6)).toStrictEqual(lines(node.stdout).slice(-6));
            expect(blocksOf(native.stdout).toSorted()).toStrictEqual(blocksOf(node.stdout).toSorted());
            expect(blocksOf(native.stdout)).toHaveLength(2);

            for (const file of files) {
                expect(readFileSync(file, "utf8")).toBe("");
            }
        });

        it("groups a task's output the way each provider does", () => {
            expect.assertions(8);

            const output = (extra: Record<string, string>): string => runNative(fresh(reference.root), ["run", "build"], paths.stub, baseEnvironment(extra)).stdout;

            expect(output({ GITHUB_ACTIONS: "true", NO_COLOR: "1" })).toContain("::group::\u2713 p2:build\nbuilt-2\n::endgroup::\n");
            expect(output({ GITHUB_ACTIONS: "true", NO_COLOR: "1" })).toContain("::group::\u2713 p4:build\nfirst-4\nsecond-4\n::endgroup::\n");
            expect(output({ BUILDKITE: "true", NO_COLOR: "1" })).toContain("--- \u2713 p2:build\nbuilt-2\n");
            expect(output({ AGENT_NAME: "a", NO_COLOR: "1", TF_BUILD: "True" })).toContain("##[group]\u2713 p2:build\nbuilt-2\n##[endgroup]\n");
            expect(output({ GITLAB_CI: "true", NO_COLOR: "1" })).toMatch(
                new RegExp(`${ESC}\\[0Ksection_start:\\d+:p2_build_[\\da-f]{6}\\[collapsed=true\\]\\r${ESC}\\[0K\u2713 p2:build\\nbuilt-2\\n${ESC}\\[0Ksection_end:\\d+:p2_build_[\\da-f]{6}\\r${ESC}\\[0K\\n`),
            );
            expect(output({ GITHUB_ACTIONS: "true" })).toContain("::group::\u001B[32m\u2713\u001B[39m p2:build\nbuilt-2\n::endgroup::\n");
            expect(output({ GITHUB_ACTIONS: "true" })).toContain("\u001B[1m\u001B[7m VIS \u001B[22m\u001B[27m \u001B[1m\u001B[37m\u2022\u001B[22m\u001B[39m  Running target build for 4 projects\n");
            // No grouping directive without a provider, and no colour code with no colour.
            expect(output({ NO_COLOR: "1" })).not.toMatch(new RegExp(String.raw`::group|section_start|##\[group|^--- |${ESC}`, "m"));
        });

        it("gives the GitLab section of a scoped task name the key Node gives it", () => {
            expect.assertions(3);

            const scoped = join(paths.scratch, "gitlab-scoped");

            generate(scoped, { chain: true, packages: 3, scoped: true });
            write(scoped, "packages/p2/package.json", JSON.stringify({ name: "@acme/p2", scripts: { build: "echo built-2" }, version: "1.0.0" }));
            runNode(scoped, ["run", "build"]);

            const env = baseEnvironment({ GITLAB_CI: "true", NO_COLOR: "1" });
            const node = runNode(fresh(scoped), ["run", "build"], env);
            const native = runNative(fresh(scoped), ["run", "build"], paths.stub, env);

            expect(node.stdout).toMatch(/section_start:\d+:_acme_p2_build_[\da-f]{6}\[collapsed=true\]/);
            expect(blocksOf(native.stdout)).toStrictEqual(blocksOf(node.stdout));
            expect(lines(native.stdout).toSorted()).toStrictEqual(lines(node.stdout).toSorted());
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

        it.each(DELEGATED_COLOUR_ENVIRONMENTS.map((colour) => [JSON.stringify(colour), colour] as const))("%s: leaves the run to Node, which warns on stderr", (_label, colour) => {
            expect.assertions(3);

            const native = runNative(fresh(reference.root), ["run", "build"], paths.stub, baseEnvironment({ GITHUB_ACTIONS: "true", ...colour }));

            expect(native.stdout).toBe(`${marker}\n`);
            expect(native.stderr).toBe("");
            expect(native.status).toBe(99);
        });
    });

    describe("the toolchain pins and the Node version", () => {
        const shape: Shape = { packages: 4 };

        /** A directory of tools that print a version, first on PATH; `undefined` leaves the tool out, a string is the shell body. */
        const stubDirectory = (name: string, tools: Record<string, string | undefined>): string => {
            const directory = join(paths.scratch, `stubs-${name}`);

            mkdirSync(directory, { recursive: true });

            for (const [tool, body] of Object.entries(tools)) {
                if (body !== undefined) {
                    writeFileSync(join(directory, tool), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
                }
            }

            return directory;
        };
        // `NVM_DIR` makes Node count nvm as an installed manager, which is what turns a pin that is not met into a printed
        // line (with no manager installed Node's check stays quiet about it), so the cases below can tell met from unmet.
        const MANAGER = { NVM_DIR: "/nonexistent-nvm" };
        const environmentWith = (directory: string, extra: Record<string, string> = {}): Record<string, string> =>
            baseEnvironment({ PATH: `${directory}:${process.env["PATH"] ?? ""}`, ...MANAGER, ...extra });
        /** The Node the Node CLI itself runs under, which the pins below are written against (a stub `node` would break the tasks). */
        const major = process.versions.node.split(".")[0] as string;
        const toolsAt = (versions: { node?: string; npm?: string; pnpm?: string }): Record<string, string | undefined> => {
            return {
                node: versions.node === undefined ? undefined : `echo ${versions.node}`,
                npm: versions.npm === undefined ? undefined : `echo ${versions.npm}`,
                pnpm: versions.pnpm === undefined ? undefined : `echo ${versions.pnpm}`,
            };
        };
        const rootWith = (extra: Record<string, unknown>) => (root: string) => {
            write(root, "package.json", JSON.stringify({ name: "root", private: true, scripts: { build: "echo root-build" }, ...extra }, undefined, 2));
        };

        interface PinCase {
            files?: Record<string, string>;
            manifest?: Record<string, unknown>;
            name: string;
            versions: { node?: string; npm?: string; pnpm?: string };
        }

        // Pins whose tools report a version that meets them: Node's preflight prints nothing, so the binary answers.
        const met: PinCase[] = [
            { manifest: { packageManager: "pnpm@10.4.1" }, name: "packageManager equal to the installed pnpm", versions: { pnpm: "10.4.1" } },
            { manifest: { packageManager: "pnpm@10.4.1+sha512.0123456789abcdef" }, name: "packageManager with a checksum", versions: { pnpm: "10.4.1" } },
            { manifest: { packageManager: "pnpm@10" }, name: "packageManager with only a major", versions: { pnpm: "10.4.1" } },
            { manifest: { packageManager: "pnpm" }, name: "a packageManager without a version", versions: {} },
            { manifest: { engines: { node: `>=${major}` } }, name: "engines.node as a range", versions: {} },
            { manifest: { engines: { node: `^1 || ^${major}`, pnpm: "^10" } }, name: "engines for two tools", versions: { pnpm: "10.4.1" } },
            // A stub `npm` on PATH breaks the tasks themselves, so this one asks the installed npm ("installed npm" in the name).
            { manifest: { engines: { npm: ">=1" } }, name: "engines.npm against the installed npm", versions: {} },
            { manifest: { engines: { node: `>=${major}`, vscode: "^1.90.0" } }, name: "engines with a key Node ignores", versions: {} },
            { manifest: { engines: {} }, name: "empty engines", versions: {} },
            { manifest: { engines: { node: 22 } }, name: "engines with a non-string value", versions: {} },
            { files: { ".nvmrc": `v${major}\n` }, name: ".nvmrc", versions: {} },
            { files: { ".node-version": `${process.versions.node}\r\n` }, name: ".node-version", versions: {} },
            { files: { ".node-version": `${major}\n`, ".nvmrc": "\n" }, name: "an empty .nvmrc before a .node-version", versions: {} },
            { files: { ".nvmrc": "lts/*\n" }, name: "an .nvmrc the range matcher does not know", versions: {} },
            { files: { ".nvmrc": `${major}\n` }, manifest: { engines: { node: ">=99999" } }, name: ".nvmrc over engines.node", versions: {} },
            {
                files: { ".nvmrc": `${major}\n` },
                manifest: { engines: { node: `>=${major}`, pnpm: "^10" }, packageManager: "pnpm@10.4.1" },
                name: "every source at once",
                versions: { pnpm: "10.4.1" },
            },
        ];

        // The installed npm answers in tens to hundreds of milliseconds; on a machine too busy for that the case is left out.
        const npmIsQuick = ((): boolean => {
            const started = Date.now();
            const result = spawnSync("npm", ["--version"], { encoding: "utf8" });

            return result.status === 0 && Date.now() - started < 700;
        })();

        describe.each(met.filter((pin) => npmIsQuick || !pin.name.includes("installed npm")))("a pin that is met: $name", (pin) => {
            const reference = { env: baseEnvironment(), root: "", stderr: "", stdout: "" };

            beforeAll(() => {
                const directory = stubDirectory(pin.name.replaceAll(/\W+/g, "-"), toolsAt(pin.versions));

                reference.env = environmentWith(directory);
                Object.assign(
                    reference,
                    warm(
                        `pinned-${pin.name.replaceAll(/\W+/g, "-")}`,
                        shape,
                        (root) => {
                            rootWith(pin.manifest ?? {})(root);

                            for (const [file, content] of Object.entries(pin.files ?? {})) {
                                write(root, file, content);
                            }
                        },
                        reference.env,
                    ),
                );
            }, 120_000);

            it.each([true, false])("answers like Node, and nothing else is written (started by the launcher: %s)", (handoff) => {
                expect.hasAssertions();

                const root = fresh(reference.root);
                const before = snapshot(root, "node_modules/.cache/vis");
                const node = runNode(fresh(reference.root), ["run", "build"], reference.env);
                const native = runNative(root, ["run", "build"], paths.stub, reference.env, handoff);

                expect(native.stdout).not.toContain(marker);
                expect(native.status).toBe(0);
                expect(native.stderr).toBe(node.stderr);
                expect(node.stderr).toBe("");
                expect(lines(native.stdout).toSorted()).toStrictEqual(lines(node.stdout).toSorted());
                expect(blocksOf(native.stdout).toSorted()).toStrictEqual(blocksOf(node.stdout).toSorted());
                expect(snapshot(root, "node_modules/.cache/vis")).toStrictEqual(before);
                expect(normaliseSummary(readSummary(root))).toBe(normaliseSummary(readSummary(join(paths.scratch, `pinned-${pin.name.replaceAll(/\W+/g, "-")}`))));
            });
        });

        // The same workspaces with a tool that does not meet the pin, is missing, or cannot report: Node may print or
        // install, so the binary hands the run over before anything is printed or written.
        // `prints: false` is a case in which Node itself stays quiet (it falls back to the Node that runs it), and still goes to Node here.
        const unmet: { env: (directory: string) => Record<string, string>; name: string; pin: Omit<PinCase, "name" | "versions">; prints?: boolean; tools: Record<string, string | undefined> }[] = [
            { env: (d) => environmentWith(d), name: "pnpm older than the pin", pin: { manifest: { packageManager: "pnpm@10.4.1" } }, tools: toolsAt({ node: "v22.1.0", pnpm: "9.1.0" }) },
            { env: (d) => environmentWith(d), name: "pnpm newer than an exact pin", pin: { manifest: { packageManager: "pnpm@10.4.1" } }, tools: toolsAt({ node: "v22.1.0", pnpm: "10.5.0" }) },
            { env: (d) => environmentWith(d), name: "a pin prefix that is not a prefix of the version", pin: { manifest: { packageManager: "pnpm@10.4" } }, tools: toolsAt({ node: "v22.1.0", pnpm: "10.40.0" }) },
            { env: (d) => environmentWith(d), name: "node below engines.node", pin: { manifest: { engines: { node: ">=24" } } }, tools: toolsAt({ node: "v22.1.0" }) },
            { env: (d) => environmentWith(d), name: "node past an upper bound", pin: { manifest: { engines: { node: ">=20 <22" } } }, tools: toolsAt({ node: "v22.1.0" }) },
            { env: (d) => environmentWith(d), name: "a caret on another major", pin: { manifest: { engines: { node: "^20" } } }, tools: toolsAt({ node: "v22.1.0" }) },
            { env: (d) => environmentWith(d), name: "npm below engines.npm", pin: { manifest: { engines: { npm: ">=11" } } }, tools: toolsAt({ node: "v22.1.0", npm: "10.5.0" }) },
            { env: (d) => environmentWith(d), name: "npm that fails", pin: { manifest: { engines: { npm: ">=1" } } }, tools: { ...toolsAt({ node: "v22.1.0" }), npm: "exit 2" } },
            { env: (d) => environmentWith(d), name: ".nvmrc on another major", pin: { files: { ".nvmrc": "20\n" } }, tools: toolsAt({ node: "v22.1.0" }) },
            { env: (d) => environmentWith(d), name: ".node-version on another version", pin: { files: { ".node-version": "22.2.0\n" } }, tools: toolsAt({ node: "v22.1.0" }) },
            { env: (d) => environmentWith(d), name: ".nvmrc over a looser engines.node", pin: { files: { ".nvmrc": "20\n" }, manifest: { engines: { node: ">=18" } } }, tools: toolsAt({ node: "v22.1.0" }) },
            { env: (d) => environmentWith(d), name: "a pinned tool that fails", pin: { manifest: { packageManager: "pnpm@10.4.1" } }, tools: { ...toolsAt({ node: "v22.1.0" }), pnpm: "exit 3" } },
            { env: (d) => environmentWith(d), name: "a pinned tool that prints no version", pin: { manifest: { packageManager: "pnpm@10.4.1" } }, tools: { ...toolsAt({ node: "v22.1.0" }), pnpm: "echo unknown" } },
            { env: (d) => environmentWith(d), name: "a pinned tool that is too slow", pin: { manifest: { packageManager: "pnpm@10.4.1" } }, tools: { ...toolsAt({ node: "v22.1.0" }), pnpm: "sleep 4; echo 10.4.1" } },
            { env: (d) => environmentWith(d), name: "node that fails while pinned", pin: { manifest: { engines: { node: ">=20" } } }, prints: false, tools: { node: "exit 1" } },
            { env: (d) => baseEnvironment({ PATH: d, ...MANAGER }), name: "a pinned pnpm that is not on PATH", pin: { manifest: { packageManager: "pnpm@10.4.1" } }, tools: toolsAt({ node: "v22.1.0" }) },
            { env: (d) => baseEnvironment({ PATH: `${d}:/usr/bin:/bin`, ...MANAGER }), name: "a pinned node that is not on PATH", pin: { manifest: { engines: { node: ">=20" } } }, prints: false, tools: {} },
        ];

        describe("a pin that is not met leaves the run to Node untouched", () => {
            const base = { root: "" };

            beforeAll(() => {
                // The cache is filled with no pin; the pin is added to a copy afterwards (the pins do not change the task keys).
                base.root = warm("unmet", shape).root;
            }, 120_000);

            it.each(unmet.map((entry) => [entry.name, entry] as const))("%s", (name, entry) => {
                expect.assertions(6);

                const root = fresh(base.root);
                const directory = stubDirectory(`unmet-${name.replaceAll(/\W+/g, "-")}`, entry.tools);

                rootWith(entry.pin.manifest ?? {})(root);

                for (const [file, content] of Object.entries(entry.pin.files ?? {})) {
                    write(root, file, content);
                }

                const before = snapshot(root);
                const native = runNative(root, ["run", "build"], paths.stub, entry.env(directory));

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.stderr).toBe("");
                expect(native.status).toBe(99);
                expect(snapshot(root)).toStrictEqual(before);

                // Node itself, on the same workspace: still a run of cache hits (so the twin does reach the pin check),
                // and a line about the pin where its check has something to say.
                const node = runNode(root, ["run", "build"], entry.env(directory));
                const { stats } = JSON.parse(readSummary(root)) as { stats: { cached: number; total: number } };

                expect(stats.cached).toBe(stats.total);
                expect(entry.prints === false || /toolchain:/.test(node.stdout + node.stderr)).toBe(true);
            }, 30_000);
        });

        describe("a pin the binary does not read leaves the run to Node untouched", () => {
            const base = { root: "" };

            beforeAll(() => {
                base.root = warm("unread", shape).root;
            }, 120_000);

            it.each([
                ["a pnpm-only volta pin", { manifest: { volta: { node: "22.1.0" } } }],
                ["an empty volta field", { manifest: { volta: {} } }],
                ["a yarn engines pin", { manifest: { engines: { yarn: ">=1" } } }],
                ["a bun engines pin", { manifest: { engines: { bun: ">=1" } } }],
                ["a yarn packageManager", { manifest: { packageManager: "yarn@4.0.0" } }],
                ["a bun packageManager", { manifest: { packageManager: "bun@1.1.0" } }],
                ["a go engines pin", { manifest: { engines: { go: "1.22" } } }],
                ["a packageManager that is not a string", { manifest: { packageManager: 10 } }],
                ["engines that is an array", { manifest: { engines: ["node"] } }],
                ["engines that is a string", { manifest: { engines: "node" } }],
                ["a .tool-versions file", { files: { ".tool-versions": "nodejs 22.1.0\n" } }],
                ["a .prototools file", { files: { ".prototools": 'node = "22.1.0"\n' } }],
                ["a .mise.toml file", { files: { ".mise.toml": '[tools]\nnode = "22.1.0"\n' } }],
                ["a mise.toml file", { files: { "mise.toml": '[tools]\nnode = "22.1.0"\n' } }],
                ["a .config/mise.toml file", { files: { ".config/mise.toml": '[tools]\nnode = "22.1.0"\n' } }],
                ["an .nvmrc that is not ASCII", { files: { ".nvmrc": "22\u00A0\n" } }],
                ["an .nvmrc that is a directory", { directories: [".nvmrc"] }],
                ["a packageManager that is not ASCII", { manifest: { packageManager: "pnpm@10.4.1\u00E9" } }],
            ] as [string, { directories?: string[]; files?: Record<string, string>; manifest?: Record<string, unknown> }][])("%s", (_name, pin) => {
                expect.assertions(3);

                const root = fresh(base.root);
                const directory = stubDirectory("unread", toolsAt({ node: "v22.1.0", pnpm: "10.4.1" }));

                rootWith(pin.manifest ?? {})(root);

                for (const [file, content] of Object.entries(pin.files ?? {})) {
                    write(root, file, content);
                }

                for (const entry of pin.directories ?? []) {
                    mkdirSync(join(root, entry));
                }

                const before = snapshot(root);
                const native = runNative(root, ["run", "build"], paths.stub, environmentWith(directory));

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
                expect(snapshot(root)).toStrictEqual(before);
            });
        });

        it("asks a tool once even when two pins name it", () => {
            expect.hasAssertions();

            const probes = join(paths.scratch, "probe-count.log");
            const directory = stubDirectory("probe-count", { pnpm: `echo x >> ${probes}\necho 10.4.1` });
            const env = environmentWith(directory);
            const { root } = warm("probe-count", shape, rootWith({ engines: { pnpm: "^10" }, packageManager: "pnpm@10.4.1" }), env);

            writeFileSync(probes, "");

            const native = runNative(fresh(root), ["run", "build"], paths.stub, env);

            expect(native.stdout).not.toContain(marker);
            expect(readFileSync(probes, "utf8")).toBe("x\n");
            expect(native.status).toBe(0);
        });

        it("asks the tool on PATH, never one of the workspace's own bin directory", () => {
            expect.hasAssertions();

            const probes = join(paths.scratch, "bin-probe-count.log");
            const directory = stubDirectory("bin-probe", { pnpm: "echo 10.4.1" });
            const env = environmentWith(directory);
            const { root } = warm(
                "bin-probe",
                shape,
                (workspace) => {
                    rootWith({ packageManager: "pnpm@10.4.1" })(workspace);
                    write(workspace, "node_modules/.bin/pnpm", `#!/bin/sh\necho x >> ${probes}\necho 1.0.0\n`);
                    chmodSync(join(workspace, "node_modules/.bin/pnpm"), 0o755);
                },
                env,
            );

            writeFileSync(probes, "");

            const node = runNode(fresh(root), ["run", "build"], env);
            const native = runNative(fresh(root), ["run", "build"], paths.stub, env);

            // Neither side looks into the workspace's `.bin`, so the pin is met by the pnpm on PATH on both.
            expect(readFileSync(probes, "utf8")).toBe("");
            expect(node.status).toBe(0);
            expect(native.stdout).not.toContain(marker);
            expect(lines(native.stdout).toSorted()).toStrictEqual(lines(node.stdout).toSorted());
        });

        describe("with the installed tools", () => {
            const installed = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
            // A pnpm that manages its own version would fetch the pinned one into the (fresh) test home; this asks plain `pnpm --version`.
            const env = baseEnvironment(MANAGER);

            it.skipIf(installed.status !== 0)("answers a run pinned to the installed pnpm and Node range, like Node", (context) => {
                expect.hasAssertions();

                // The binary gives a tool two seconds to answer; on a machine too busy for that it correctly leaves the run to Node.
                const started = Date.now();

                spawnSync("pnpm", ["--version"], { env });

                if (Date.now() - started > 700) {
                    context.skip();
                }

                const pnpm = installed.stdout.trim();
                const { root, stdout } = warm(
                    "installed-tools",
                    shape,
                    (workspace) => {
                        rootWith({ engines: { node: `>=${major}` }, packageManager: `pnpm@${pnpm}` })(workspace);

                        // A version-managing pnpm adds the pinned version to the lockfile the first time it is asked, which a real
                        // lockfile already holds; ask it once here and make the install marker newer again.
                        spawnSync("pnpm", ["--version"], { cwd: workspace, env });

                        const now = Date.now() / 1000;

                        utimesSync(join(workspace, "pnpm-lock.yaml"), now - 60, now - 60);
                        utimesSync(join(workspace, "node_modules/.modules.yaml"), now - 30, now - 30);
                    },
                    env,
                );
                const native = runNative(fresh(root), ["run", "build"], paths.stub, env);

                expect(native.stdout).not.toContain(marker);
                expect(native.status).toBe(0);
                expect(native.stderr).toBe("");
                expect(lines(native.stdout).toSorted()).toStrictEqual(lines(stdout).toSorted());
            }, 60_000);
        });

        describe("a pinned tool that changes the workspace while it answers", () => {
            const base = { root: "" };

            beforeAll(() => {
                base.root = warm("changing-probe", shape).root;
            }, 120_000);

            // Node asks before it reads the lockfile and keys the tasks, so a change made by the answer is part of its run.
            it.each([
                ["the lockfile", "echo '# touched' >> pnpm-lock.yaml", "pnpm-lock.yaml", "# touched"],
                ["a source file of a project", "echo '// touched' >> packages/p1/src/index.ts", "packages/p1/src/index.ts", "// touched"],
                ["the manifest of a project", "echo ' ' >> packages/p2/package.json", "packages/p2/package.json", "} \n"],
            ])("delegates when it changes %s", (name, change, file, landed) => {
                expect.assertions(5);

                const root = fresh(base.root);
                const directory = stubDirectory(`changing-${name.replaceAll(/\W+/g, "-")}`, { pnpm: `${change}\necho 10.4.1` });

                rootWith({ packageManager: "pnpm@10.4.1" })(root);

                const native = runNative(root, ["run", "build"], paths.stub, environmentWith(directory));

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
                expect(native.stderr).toBe("");
                // The stub did change the workspace (so the run did reach the probe), and nothing was written after it.
                expect(readFileSync(join(root, file), "utf8")).toContain(landed);
                expect(readSummary(root)).toBe(readSummary(base.root));
            });
        });

        describe("tools that share one file, and probes that misbehave", () => {
            const base = { root: "" };

            beforeAll(() => {
                base.root = warm("probe-edge-cases", shape).root;
            }, 120_000);

            /** A version manager's shim: one file linked under several names, answering by the name it is started under. */
            const shimDirectory = (name: string, answers: Record<string, string>): string => {
                const directory = join(paths.scratch, `shim-${name}`);
                const shim = join(directory, "shim");
                const cases = Object.entries(answers).map(([tool, answer]) => `*/${tool}) echo ${answer};;`).join(" ");

                mkdirSync(directory, { recursive: true });
                writeFileSync(shim, `#!/bin/sh\ncase "$0" in ${cases} *) exit 1;; esac\n`, { mode: 0o755 });

                for (const tool of Object.keys(answers)) {
                    symlinkSync(shim, join(directory, tool));
                }

                return directory;
            };

            it.each([true, false])("asks each name of a shim on its own and answers when every pin is met (started by the launcher: %s)", (handoff) => {
                expect.assertions(3);

                const root = fresh(base.root);
                const directory = shimDirectory(`met-${handoff}`, { node: "v22.1.0", npm: "10.5.0" });

                rootWith({ engines: { node: ">=18", npm: ">=9" } })(root);

                const native = runNative(root, ["run", "build"], paths.stub, environmentWith(directory), handoff);

                expect(native.stdout).not.toContain(marker);
                expect(native.status).toBe(0);
                expect(native.stderr).toBe("");
            });

            it.each([true, false])("does not take Node's answer for npm's when they share a shim (started by the launcher: %s)", (handoff) => {
                expect.assertions(3);

                const root = fresh(base.root);
                const directory = shimDirectory(`unmet-${handoff}`, { node: "v22.1.0", npm: "8.0.0" });

                rootWith({ engines: { node: ">=18", npm: ">=9" } })(root);

                const native = runNative(root, ["run", "build"], paths.stub, environmentWith(directory), handoff);

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
                expect(readSummary(root)).toBe(readSummary(base.root));
            });

            // Two aliases of one tool: Node walks `engines` in file order and the later one wins, so the run is Node's either way.
            it.each([
                // The key order is the case: it is the order of the file.
                // eslint-disable-next-line perfectionist/sort-objects
                ["the lenient alias first", { nodejs: ">=1", node: ">=99999" }],
                ["the strict alias first", { node: ">=99999", nodejs: ">=1" }],
            ])("delegates an engines that names node twice: %s", (_name, engines) => {
                expect.assertions(3);

                const root = fresh(base.root);

                rootWith({ engines })(root);

                const native = runNative(root, ["run", "build"], paths.stub, environmentWith(stubDirectory("aliases", toolsAt({ node: "v22.1.0" }))));

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
                expect(readSummary(root)).toBe(readSummary(base.root));
            });

            it("delegates when the Node it asks for its version changes a task input, with no pin", () => {
                expect.assertions(5);

                const root = fresh(base.root);
                const directory = stubDirectory("touching-node", {
                    node: `if [ "$1" = "--version" ]; then echo '// touched' >> packages/p1/src/index.ts; echo v22.1.0; else exec ${process.execPath} "$@"; fi`,
                });
                const native = runNative(root, ["run", "build"], paths.stub, baseEnvironment({ VIS_NODE: join(directory, "node") }), false);

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
                expect(native.stderr).toBe("");
                expect(readFileSync(join(root, "packages/p1/src/index.ts"), "utf8")).toContain("// touched");
                expect(readSummary(root)).toBe(readSummary(base.root));
            });

            it("keeps the run's times in order and the time a probe takes out of its duration", () => {
                expect.assertions(6);

                const root = fresh(base.root);
                const directory = stubDirectory("slow-pnpm", { pnpm: "sleep 1; echo 10.4.1" });

                rootWith({ packageManager: "pnpm@10.4.1" })(root);

                const native = runNative(root, ["run", "build"], paths.stub, environmentWith(directory));
                const summary = JSON.parse(readSummary(root)) as { duration: number; endTime: string; startTime: string; tasks: { endTime: string; startTime: string }[] };
                const at = (text: string): number => Date.parse(text);

                expect(native.stdout).not.toContain(marker);
                expect(summary.tasks.length).toBeGreaterThan(0);
                expect(summary.tasks.every((task) => at(summary.startTime) <= at(task.startTime))).toBe(true);
                expect(summary.tasks.every((task) => at(summary.endTime) >= at(task.endTime))).toBe(true);
                // The probe slept a second; neither the duration nor the span of the timestamps contains it.
                expect(summary.duration).toBeLessThan(800);
                expect(at(summary.endTime) - at(summary.startTime)).toBeLessThan(800);
            });

            it("delegates promptly when a probe prints without end", () => {
                expect.assertions(3);

                const root = fresh(base.root);
                const directory = stubDirectory("noisy-pnpm", { pnpm: "exec yes 10.4.1" });

                rootWith({ packageManager: "pnpm@10.4.1" })(root);

                const started = Date.now();
                const native = runNative(root, ["run", "build"], paths.stub, environmentWith(directory));

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
                // Ending the probe at its output limit does not wait for the two seconds of its timeout.
                expect(Date.now() - started).toBeLessThan(1800);
            });

            it("delegates when a probe leaves a process holding its output open", () => {
                expect.assertions(2);

                const root = fresh(base.root);
                const directory = stubDirectory("holding-pnpm", { pnpm: "sleep 30 &\necho 10.4.1" });

                rootWith({ packageManager: "pnpm@10.4.1" })(root);

                const native = runNative(root, ["run", "build"], paths.stub, environmentWith(directory));

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
            }, 20_000);
        });

        describe("the Node version without the launcher", () => {
            const base = { root: "" };

            beforeAll(() => {
                base.root = warm("without-launcher", shape).root;
            }, 120_000);

            const recorded = (root: string): string => (JSON.parse(readSummary(root)) as { environment: { nodeVersion: string } }).environment.nodeVersion;

            it.each(["v24.0.0-rc.1", "v26.99.0", "v27.0.0-nightly20261124abcdef0123"])("records the version of the Node the run would delegate to (VIS_NODE): %s", (nodeVersion) => {
                expect.assertions(3);

                const directory = stubDirectory(`vis-node-${nodeVersion}`, { node: `echo ${nodeVersion}` });
                const root = fresh(base.root);
                const native = runNative(root, ["run", "build"], paths.stub, baseEnvironment({ VIS_NODE: join(directory, "node") }), false);

                expect(native.stdout).not.toContain(marker);
                expect(native.status).toBe(0);
                expect(recorded(root)).toBe(nodeVersion);
            });

            it("records the version of the `node` on PATH when VIS_NODE is not set", () => {
                expect.assertions(2);

                const directory = stubDirectory("path-node", { node: "echo v26.98.1" });
                const root = fresh(base.root);
                const env = baseEnvironment({ PATH: `${directory}:${process.env["PATH"] ?? ""}` });
                const native = spawnSync(binary as string, ["run", "build"], { cwd: root, encoding: "utf8", env: { ...env, VIS_FALLBACK_ENTRY: paths.stub, VIS_FALLBACK_ENTRY_OVERRIDE: paths.stub } });

                expect(native.stdout).not.toContain(marker);
                expect(recorded(root)).toBe("v26.98.1");
            });

            it.each([
                ["fails", "exit 1"],
                ["prints nothing", "true"],
                ["prints something that is not a version", "echo not-a-version"],
                ["prints a version with a quote", 'echo \'v1.2"3\''],
                ["prints two lines", "echo v22.1.0; echo v22.1.1"],
                ["is too slow", "sleep 4; echo v22.1.0"],
            ])("delegates when the Node it would delegate to %s", (_name, body) => {
                expect.assertions(4);

                // Only `--version` misbehaves; the delegated run (`node <entry> run build`) goes to the real Node.
                const directory = stubDirectory(`bad-node-${_name.replaceAll(/\W+/g, "-")}`, { node: `if [ "$1" = "--version" ]; then ${body}; else exec ${process.execPath} "$@"; fi` });
                const root = fresh(base.root);
                const before = snapshot(root);
                const native = runNative(root, ["run", "build"], paths.stub, baseEnvironment({ VIS_NODE: join(directory, "node") }), false);

                expect(native.stdout).toBe(`${marker}\n`);
                expect(native.status).toBe(99);
                expect(native.stderr).toBe("");
                expect(snapshot(root)).toStrictEqual(before);
            }, 20_000);

            it("delegates when no Node can be found", () => {
                expect.assertions(2);

                const root = fresh(base.root);
                const before = snapshot(root);
                const native = runNative(root, ["run", "build"], paths.stub, baseEnvironment({ PATH: "/nonexistent", VIS_NODE: "no-such-node" }), false);

                // The binary cannot start the Node it would delegate to either, so there is nothing to print.
                expect(native.stdout).not.toContain("Successfully ran");
                expect(snapshot(root)).toStrictEqual(before);
            });

            it("does not ask Node again when the launcher passed its version", () => {
                expect.assertions(2);

                const root = fresh(base.root);
                const marker2 = join(paths.scratch, "node-was-asked");
                const directory = stubDirectory("launcher-node", { node: `echo asked >> ${marker2}\necho v1.0.0` });

                writeFileSync(marker2, "");

                runNative(root, ["run", "build"], paths.stub, baseEnvironment({ VIS_NODE: join(directory, "node") }));

                expect(readFileSync(marker2, "utf8")).toBe("");
                expect(recorded(root)).toBe(process.version);
            });
        });
    });

    describe("a miss in a large workspace", () => {
        // A miss at the first, a middle and the last project: the tasks are worked on side by side and the first one
        // that is not a hit ends the attempt, so the position must not matter to the decision.
        const shape: Shape = { apps: true, busy: true, packages: 200, tsconfig: true };
        const positions: [string, number][] = [
            ["the first project", 1],
            ["a middle project", 100],
            ["the last project", 200],
        ];
        const base = { root: "", summary: "" };

        beforeAll(() => {
            Object.assign(base, warm("large-miss", shape));
        }, 300_000);

        const entryOf = (root: string, position: number): string => {
            const { tasks } = JSON.parse(readSummary(root)) as { tasks: { hash: string; taskId: string }[] };
            const task = tasks.find((candidate) => candidate.taskId === `p${position}:build`);

            return join(root, "node_modules/.cache/vis", task?.hash as string);
        };

        /** The binary hands the run to Node without writing anything. */
        const expectDelegated = (mutate: (root: string) => void): string => {
            const root = fresh(base.root);

            mutate(root);

            const before = snapshot(root);
            const native = runNative(root, ["run", "build"], paths.stub);

            expect(native.stdout).toBe(`${marker}\n`);
            expect(native.status).toBe(99);
            expect(snapshot(root)).toStrictEqual(before);

            return root;
        };

        /** The binary hands the run to Node, and Node is not all-hit on the same copy. */
        const expectBothMiss = (mutate: (root: string) => void): void => {
            const root = expectDelegated(mutate);
            const node = runNode(root, ["run", "build"]);
            const { stats } = JSON.parse(readSummary(root)) as { stats: { cached: number; total: number } };

            expect(node.status).toBe(0);
            expect(stats.cached).toBeLessThan(stats.total);
        };

        describe.each(positions)("at %s", (_where, position) => {
            const directory = directoryOf(shape, position);

            it.each([
                ["a source file is edited", (root: string) => { write(root, `${directory}/src/index.ts`, "export const changed = true;\n"); }],
                ["a nested file is edited", (root: string) => { write(root, `${directory}/src/nested/util.ts`, "export const changed = true;\n"); }],
                ["a file is added", (root: string) => { write(root, `${directory}/src/extra.ts`, "export {};\n"); }],
                ["a file is deleted", (root: string) => { rmSync(join(root, `${directory}/src/nested/util.ts`)); }],
                ["a file of the project root is added", (root: string) => { write(root, `${directory}/README.md`, "# readme\n"); }],
                [
                    "the script text changes",
                    (root: string) => { write(root, `${directory}/package.json`, JSON.stringify({ name: `p${position}`, scripts: { build: "echo different" }, version: "1.0.0" }, undefined, 2)); },
                ],
                ["its cache entry is deleted", (root: string) => { rmSync(entryOf(root, position), { force: true, recursive: true }); }],
                ["its cache entry is half written", (root: string) => { rmSync(join(entryOf(root, position), ".commit")); }],
            ])("%s", (_name, mutate) => {
                expect.assertions(5);

                expectBothMiss(mutate);
            });

            // Node serves these entries; the binary does not reproduce what a hit does for them, so it hands the run over.
            it.each([
                ["its cache entry stores a failure", (root: string) => { writeFileSync(join(entryOf(root, position), "code"), "1"); }],
                ["its cache entry holds outputs", (root: string) => { writeFileSync(join(entryOf(root, position), "outputs-manifest.json"), "{}"); }],
            ])("%s", (_name, mutate) => {
                expect.assertions(3);

                expectDelegated(mutate);
            });
        });

        it("a global input is edited, so every project misses", () => {
            expect.assertions(5);

            expectBothMiss((root) => { write(root, "tsconfig.json", '{ "compilerOptions": { "strict": false } }\n'); });
        });

        // A detector's config file changes what Node infers for the project, and a file under a dot directory is no
        // input of the key: every key still hits, so only the detector's marker can hand the run over. The binary
        // has to find it in the listing of any of 200 projects, one directory down.
        it.each([
            ["a nested config file in the first project", `${directoryOf(shape, 1)}/.changeset/config.json`],
            ["a nested config file in a middle project", `${directoryOf(shape, 100)}/.vitepress/config.mjs`],
            ["a nested config file in the last project", `${directoryOf(shape, 200)}/.storybook/main.ts`],
        ])("%s hands the run to Node", (_name, file) => {
            expect.assertions(3);

            expectDelegated((root) => { write(root, file, "export default {};\n"); });
        });

        it("the first and the last project both miss", () => {
            expect.assertions(5);

            expectBothMiss((root) => {
                write(root, `${directoryOf(shape, 1)}/src/index.ts`, "export const changed = 1;\n");
                write(root, `${directoryOf(shape, 200)}/src/index.ts`, "export const changed = 200;\n");
            });
        });

        it("hands the run back with the launcher's status through the launcher, and Node reports the miss", () => {
            expect.assertions(4);

            const root = fresh(base.root);

            write(root, `${directoryOf(shape, 200)}/src/index.ts`, "export const changed = 200;\n");

            const launcher = spawnSync(process.execPath, [join(packageRoot, "bin", "vis.mjs"), "run", "build"], { cwd: root, encoding: "utf8", env: baseEnvironment() });
            const { stats } = JSON.parse(readSummary(root)) as { stats: { cached: number; failed: number; succeeded: number; total: number } };

            expect(launcher.status).toBe(0);
            expect(stats.total).toBe(200);
            expect(stats.cached).toBe(199);
            expect(stats.succeeded).toBe(1);
        });
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
