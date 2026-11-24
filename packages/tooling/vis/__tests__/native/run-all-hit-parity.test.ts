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
            VIS_NODE: process.execPath,
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
        .replaceAll(/Took \d+ ms/g, "Took N ms")
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
        ["many files and two workspace patterns", { apps: true, busy: true, chain: true, packages: 9 }],
        ["projects with no scripts", { emptyScripts: [4], noScripts: [2], packages: 6 }],
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
