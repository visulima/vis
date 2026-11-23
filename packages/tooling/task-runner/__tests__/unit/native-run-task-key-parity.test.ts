/**
 * Parity between the Rust task keys (`task-runner-core`'s `compute_task_keys` and
 * `lookup_entry`, shared with the native `vis` CLI) and this package's own declared
 * hash path: the real `InProcessTaskHasher`, `createTaskGraph` and `TaskOrchestrator`
 * run on small generated workspaces, and every task's key must be identical. A single
 * differing key is a failure.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Cache } from "../../src/cache";
import { EmptyLifeCycle } from "../../src/life-cycle";
import type { NativeRunProject } from "../../src/native-binding";
import { loadNativeBindings } from "../../src/native-binding";
import { createTaskGraph } from "../../src/task-graph";
import { InProcessTaskHasher } from "../../src/task-hasher";
import { TaskOrchestrator } from "../../src/task-orchestrator";
import { TaskScheduler } from "../../src/task-scheduler";
import type { DependencyType, ProjectConfiguration, ProjectGraph, TargetConfiguration, Task, TaskExecutor, TaskGraph } from "../../src/types";

const native = loadNativeBindings();

if (typeof native?.nativeRunTaskKeys !== "function" || typeof native.nativeRunLookupEntry !== "function") {
    throw new TypeError("the loaded addon has no nativeRunTaskKeys / nativeRunLookupEntry: rebuild it with `pnpm build:native:debug`");
}

const { nativeRunLookupEntry, nativeRunTaskKeys } = native;

const TARGET = "build";

interface Edge {
    kind?: "dev" | "peer" | "static";
    project: string;
}

interface ProjectSpec {
    cache?: boolean;
    dependencies?: Edge[];
    /** The directory under `packages/`; the name when absent. */
    dir?: string;
    name: string;
    outputs?: string[];
    /** `undefined`: the project has no script for the target. */
    script?: string;
}

const roots: string[] = [];

// eslint-disable-next-line vitest/require-top-level-describe -- removes the workspaces every describe below creates
afterAll(() => {
    for (const root of roots) {
        rmSync(root, { force: true, recursive: true });
    }
});

const projectRoot = (spec: ProjectSpec): string => `packages/${spec.dir ?? spec.name}`;

const put = (root: string, relative: string, content: string): void => {
    const path = join(root, relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
};

/** A pnpm workspace: root files, and per project a `package.json` and a source file. */
const createWorkspace = (specs: ProjectSpec[], options: { lockfile?: boolean; prefix?: string } = {}): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), options.prefix ?? "key-parity-")));

    roots.push(root);

    put(root, "package.json", JSON.stringify({ name: "root", private: true }));
    put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");

    if (options.lockfile !== false) {
        put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    }

    for (const spec of specs) {
        put(
            root,
            `${projectRoot(spec)}/package.json`,
            JSON.stringify({ name: spec.name, scripts: spec.script === undefined ? {} : { [TARGET]: spec.script } }),
        );
        put(root, `${projectRoot(spec)}/src/index.ts`, `export const ${spec.name.replaceAll(/\W/g, "_")} = 1;\n`);
    }

    return root;
};

const edgeType = (kind: Edge["kind"]): DependencyType => (kind === "dev" ? "devDependency" : kind === "peer" ? "peerDependency" : "static");

/** What vis hands the engine for script-only projects, the way `buildRunTasks` builds it. */
const buildGraph = (
    specs: ProjectSpec[],
    caret: boolean,
): { projectGraph: ProjectGraph; projects: Record<string, ProjectConfiguration>; taskGraph: TaskGraph } => {
    const projects: Record<string, ProjectConfiguration> = {};

    for (const spec of specs) {
        const target: TargetConfiguration = { command: spec.script };

        if (caret) {
            target.dependsOn = [`^${TARGET}`];
        }

        if (spec.cache !== undefined) {
            target.cache = spec.cache;
        }

        projects[spec.name] = { root: projectRoot(spec), targets: spec.script === undefined ? {} : { [TARGET]: target } };
    }

    const projectGraph: ProjectGraph = {
        dependencies: Object.fromEntries(
            specs.map((spec) => [
                spec.name,
                (spec.dependencies ?? []).map((edge) => {
                    return { source: spec.name, target: edge.project, type: edgeType(edge.kind) };
                }),
            ]),
        ),
        nodes: Object.fromEntries(
            specs.map((spec) => [spec.name, { data: projects[spec.name] as ProjectConfiguration, name: spec.name, type: "library" as const }]),
        ),
    };

    // `buildInitialTasks`: one task per project with the script, command and the empty options object in the overrides.
    const initialTasks: Task[] = specs
        .filter((spec) => spec.script !== undefined)
        .map((spec) => {
            return {
                cache: spec.cache,
                declaresInputs: false,
                id: `${spec.name}:${TARGET}`,
                outputs: spec.outputs ?? [],
                overrides: { command: spec.script, visOptions: {} },
                projectRoot: projectRoot(spec),
                target: { project: spec.name, target: TARGET },
            };
        });

    const taskGraph = createTaskGraph(initialTasks, { projectGraph, workspace: { projects } });

    return { projectGraph, projects, taskGraph };
};

interface NodeRun {
    cache: Cache;
    cacheDirectory: string;
    hashes: Record<string, string>;
    results: Map<string, { status: string; terminalOutput?: string }>;
    taskGraph: TaskGraph;
}

/** Runs the real orchestrator with a stub executor, and the cache on, over a fresh task graph. */
const runNode = async (root: string, specs: ProjectSpec[], caret: boolean): Promise<NodeRun> => {
    const { projectGraph, projects, taskGraph } = buildGraph(specs, caret);
    const cacheDirectory = join(root, "node_modules", ".cache", "vis");
    const cache = new Cache({ cacheDirectory, workspaceRoot: root });

    await cache.ensureReady();

    const taskExecutor: TaskExecutor = async (task) => {
        return { code: 0, terminalOutput: `ran ${task.id}\n` };
    };
    const orchestrator = new TaskOrchestrator({
        cache,
        dataDirectory: join(root, ".vis"),
        lifeCycle: new EmptyLifeCycle(),
        scheduler: new TaskScheduler(taskGraph, projectGraph, 3),
        skipCache: false,
        taskExecutor,
        taskGraph,
        taskHasher: new InProcessTaskHasher({ projects, workspaceRoot: root }),
        whenContext: { branch: "" },
        workspaceRoot: root,
    });
    const results = await orchestrator.run();

    return {
        cache,
        cacheDirectory,
        hashes: Object.fromEntries(Object.entries(taskGraph.tasks).map(([id, task]) => [id, task.hash as string])),
        results,
        taskGraph,
    };
};

const toNativeProjects = (specs: ProjectSpec[]): NativeRunProject[] =>
    specs.map((spec) => {
        return {
            cache: spec.cache,
            dependencies: (spec.dependencies ?? []).map((edge) => {
                return { kind: edge.kind ?? "static", project: edge.project };
            }),
            name: spec.name,
            outputs: spec.outputs,
            root: projectRoot(spec),
            script: spec.script,
        };
    });

const rustKeys = (root: string, specs: ProjectSpec[], caret: boolean) => nativeRunTaskKeys(root, TARGET, toNativeProjects(specs), caret);

/** Asserts the Rust graph, ids and every key equal the orchestrator's, and the cache lookup equals `Cache.get`. */
const expectParity = async (root: string, specs: ProjectSpec[], caret: boolean): Promise<NodeRun> => {
    const node = await runNode(root, specs, caret);
    const rust = rustKeys(root, specs, caret);

    expect(rust.notReproducible).toBeUndefined();
    expect(rust.keys.map((key) => key.id)).toStrictEqual(Object.keys(node.taskGraph.tasks));
    expect(Object.fromEntries(rust.keys.map((key) => [key.id, key.hash]))).toStrictEqual(node.hashes);
    expect(rust.roots).toStrictEqual(node.taskGraph.roots);

    for (const key of rust.keys) {
        expect(key.dependencies, `dependencies of ${key.id}`).toStrictEqual(node.taskGraph.dependencies[key.id]);
        expect(key.keyed).toBe(true);

        // The entries the orchestrator just wrote: the Rust lookup answers what `Cache.get` answers.
        // eslint-disable-next-line no-await-in-loop -- one entry at a time
        const stored = await node.cache.get(key.hash);
        const lookup = nativeRunLookupEntry(node.cacheDirectory, key.hash);

        expect(stored?.terminalOutput).toBe(`ran ${key.id}\n`);
        expect(lookup).toMatchObject({ code: stored?.code, status: "hit", terminalOutput: stored?.terminalOutput });
    }

    return node;
};

const chain: ProjectSpec[] = [
    { name: "a", script: "tsc -p ." },
    { dependencies: [{ project: "a" }], name: "b", script: "tsc -p ." },
    { dependencies: [{ project: "b" }], name: "c", script: "tsc -p ." },
];

const diamond: ProjectSpec[] = [
    { dependencies: [{ project: "b" }, { kind: "dev", project: "c" }], name: "d", script: "node build.js" },
    { dependencies: [{ project: "a" }], name: "b", script: "node build.js" },
    { dependencies: [{ project: "a" }], name: "c", script: "node build.js" },
    { name: "a", script: "node build.js" },
];

describe("native run task keys equal the orchestrator's keys", () => {
    it.each([
        ["chain", chain],
        ["diamond", diamond],
    ])("%s, default graph: no task depends on another", async (_name, specs) => {
        expect.hasAssertions();

        const root = createWorkspace(specs);
        const node = await expectParity(root, specs, false);

        expect(Object.values(node.taskGraph.dependencies).every((dependencies) => dependencies.length === 0)).toBe(true);
    });

    it.each([
        ["chain", chain],
        ["diamond", diamond],
    ])("%s, `dependsOn: [^build]`: dependency keys are folded in", async (_name, specs) => {
        expect.hasAssertions();

        const root = createWorkspace(specs);
        const node = await expectParity(root, specs, true);

        expect(Object.values(node.taskGraph.dependencies).some((dependencies) => dependencies.length > 0)).toBe(true);

        // Every task depends on `a`, so a changed source file of `a` changes every key (a dependent's through the fold).
        put(root, "packages/a/src/index.ts", "export const a = 2;\n");

        const rerun = await expectParity(root, specs, true);

        for (const [id, hash] of Object.entries(rerun.hashes)) {
            expect(hash, id).not.toBe(node.hashes[id]);
        }
    });

    it("answers a second run from the entries of the first", async () => {
        expect.hasAssertions();

        const root = createWorkspace(chain);
        const first = await expectParity(root, chain, true);
        const second = await runNode(root, chain, true);

        expect(second.hashes).toStrictEqual(first.hashes);
        expect([...second.results.values()].map((result) => result.status)).toStrictEqual(["local-cache", "local-cache", "local-cache"]);
    });

    it("skips a project that has no script, in both graphs", async () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [
            { name: "a", script: "tsc" },
            { dependencies: [{ project: "a" }], name: "gap" },
            { dependencies: [{ project: "gap" }, { project: "a" }], name: "b", script: "tsc" },
            { dependencies: [{ kind: "peer", project: "a" }, { project: "b" }], name: "c", script: "tsc" },
        ];
        const root = createWorkspace(specs);

        for (const caret of [false, true]) {
            // eslint-disable-next-line no-await-in-loop -- one run at a time
            const node = await expectParity(root, specs, caret);

            expect(Object.keys(node.hashes)).toStrictEqual(["a:build", "b:build", "c:build"]);
        }
    });

    it("keys twenty independent packages the same way", async () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = Array.from({ length: 20 }, (_, index) => {
            return { dependencies: index === 0 ? [] : [{ project: `p${index}` }], name: `p${index + 1}`, script: "true" };
        });
        const root = createWorkspace(specs);

        await expectParity(root, specs, false);
    });

    it("escapes script text the way JSON.stringify does", async () => {
        expect.hasAssertions();

        const scripts = [
            "echo \"quoted\" && echo 'single'",
            String.raw`echo back\slash \n literal`,
            "line one\nline two\ttabbed\r\n",
            "bell\u0007 esc\u001B form\u000C back\u0008 nul-free \u007F del",
            "unicode: é ü 日本語 😀 \u2028 \u2029 \u00A0",
            "  leading and trailing  ",
            "a ; b | c > d $HOME `cmd` $(cmd) $1 $@",
        ];
        const specs: ProjectSpec[] = scripts.map((script, index) => {
            return { name: `s${index}`, script };
        });
        const root = createWorkspace(specs);

        await expectParity(root, specs, false);
    });

    it("hashes the same files: names with spaces and unicode, hidden files, ignored directories and symlinks", async () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [{ name: "a", script: "tsc" }];
        const root = createWorkspace(specs);

        put(root, "packages/a/src/with space.ts", "1");
        put(root, "packages/a/src/日本語-é.ts", "2");
        put(root, "packages/a/src/[brackets] (parens) {braces} !bang #hash.ts", "3");
        put(root, "packages/a/src/a,b+c@d=e.ts", "4");
        put(root, "packages/a/src/nested/deep/er/file.json", "{}");
        put(root, "packages/a/.hidden", "h");
        put(root, "packages/a/.env", "SECRET=1");
        put(root, "packages/a/src/.dot/x.ts", "dot dir");
        put(root, "packages/a/src/.dot/nested/y.ts", "dot dir, nested");
        put(root, "packages/a/node_modules/dep/index.js", "ignored");
        put(root, "packages/a/src/node_modules/dep/index.js", "ignored, nested");
        put(root, "packages/a/dist/out.js", "ignored");
        put(root, "packages/a/coverage/lcov.info", "ignored");
        put(root, "packages/a/.cache/x", "ignored");
        put(root, "packages/a/src/.cache/x", "ignored, nested");
        put(root, "packages/a/.git/HEAD", "ignored");
        // A file (not a directory) named like an ignored directory is a real input.
        put(root, "packages/a/docs/dist", "a file named dist");
        put(root, "packages/a/docs/coverage", "a file named coverage");
        put(root, "packages/a/docs/.cache", "a hidden file named .cache");
        symlinkSync(join(root, "packages/a/src/with space.ts"), join(root, "packages/a/link-to-file.ts"));
        symlinkSync(join(root, "packages/a/src"), join(root, "packages/a/link-to-dir"));
        symlinkSync(join(root, "packages/a/missing"), join(root, "packages/a/dangling"));

        await expectParity(root, specs, false);
    });

    it("hashes the same global inputs: with and without a lockfile, tsconfig files and .env", async () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [{ name: "a", script: "tsc" }];

        for (const files of [
            [],
            ["pnpm-lock.yaml"],
            ["pnpm-lock.yaml", "tsconfig.json"],
            ["tsconfig.base.json", "tsconfig.json", ".env"],
            ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.base.json", "tsconfig.json", ".env"],
        ]) {
            const root = createWorkspace(specs, { lockfile: false });

            for (const file of files) {
                put(root, file, `content of ${file}\n`);
            }

            // eslint-disable-next-line no-await-in-loop -- one workspace at a time
            await expectParity(root, specs, false);
        }
    });

    it("treats a directory named like a global input as absent", async () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [{ name: "a", script: "tsc" }];
        const root = createWorkspace(specs, { lockfile: false });

        mkdirSync(join(root, "yarn.lock"));
        put(root, "tsconfig.json", "{}");

        await expectParity(root, specs, false);
    });

    it("keys a workspace whose path holds dots and spaces", async () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [{ name: "a", script: "tsc" }];
        const root = createWorkspace(specs, { prefix: ".dot dir " });

        await expectParity(root, specs, false);
    });

    it("keys a scoped project name", async () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [
            { dir: "a", name: "@scope/a", script: "tsc" },
            { dependencies: [{ project: "@scope/a" }], dir: "b", name: "@scope/b", script: "tsc" },
        ];
        const root = createWorkspace(specs);

        for (const caret of [false, true]) {
            // eslint-disable-next-line no-await-in-loop -- one run at a time
            await expectParity(root, specs, caret);
        }
    });
});

describe("what the native run does not reproduce", () => {
    it.each([
        ["a task that disables the cache", [{ cache: false, name: "a", script: "tsc" }], /disables the cache/],
        ["a task with declared outputs", [{ name: "a", outputs: ["{projectRoot}/dist"], script: "tsc" }], /declares outputs/],
        ["an empty script", [{ name: "a", script: "" }], /empty script/],
        // eslint-disable-next-line no-template-curly-in-string -- the token is the point
        ["a script with a token to expand", [{ name: "a", script: "eslint ${affected.files}" }], /token/],
        ["a script with an escaped token", [{ name: "a", script: String.raw`echo \${affected.files}` }], /token/],
        ["no project with the script", [{ name: "a" }], /no project has the target/],
    ] as [string, ProjectSpec[], RegExp][])("%s", (_name, specs, reason) => {
        expect.hasAssertions();

        const root = createWorkspace(specs);
        const result = rustKeys(root, specs, false);

        expect(result.notReproducible).toMatch(reason);
        expect(result.keys).toStrictEqual([]);
    });

    it("a project with no input files", () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [{ name: "a", script: "tsc" }];
        const root = createWorkspace(specs);

        rmSync(join(root, "packages/a/package.json"));
        rmSync(join(root, "packages/a/src"), { recursive: true });
        put(root, "packages/a/.hidden", "only a hidden file");

        expect(rustKeys(root, specs, false).notReproducible).toMatch(/no input files/);
    });

    it("a dependency cycle", () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [
            { dependencies: [{ kind: "dev", project: "b" }], name: "a", script: "tsc" },
            { dependencies: [{ project: "a" }], name: "b", script: "tsc" },
        ];
        const root = createWorkspace(specs);

        expect(rustKeys(root, specs, true).notReproducible).toMatch(/cycle/);
        // With no `dependsOn` the two tasks do not depend on each other, whatever the packages do.
        expect(rustKeys(root, specs, false).notReproducible).toBeUndefined();
    });

    it.each(["[x]", "{a,b}", "a*b", "a?b", "(x)", "a!b"])("a workspace path with %s", (fragment) => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [{ name: "a", script: "tsc" }];
        const root = createWorkspace(specs, { prefix: `${fragment}-` });

        expect(rustKeys(root, specs, false).notReproducible).toMatch(/not a plain absolute path/);
    });

    it("a selector in the target name", () => {
        expect.hasAssertions();

        const specs: ProjectSpec[] = [{ name: "a", script: "tsc" }];
        const root = createWorkspace(specs);

        expect(nativeRunTaskKeys(root, "app:build", toNativeProjects(specs), false).notReproducible).toMatch(/not a plain target name/);
    });
});

describe("native cache lookup equals Cache.get", () => {
    const HASH = "0bf3560be734757197a4fee351196867";

    const entry = (name: string): { cache: Cache; directory: string; put: (file: string, content: string | Uint8Array) => void } => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), `lookup-${name}-`)));

        roots.push(root);

        const directory = join(root, "cache");

        mkdirSync(join(directory, HASH), { recursive: true });

        return {
            cache: new Cache({ cacheDirectory: directory, workspaceRoot: root }),
            directory,
            put: (file, content) => {
                writeFileSync(join(directory, HASH, file), content);
            },
        };
    };

    it("answers a complete entry with its code and output", async () => {
        expect.hasAssertions();

        const { cache, directory, put: write } = entry("hit");

        write(".commit", "");
        write("code", "0");
        write("terminalOutput", "hello\nwarn — ünïcode 😀\n");

        const stored = await cache.get(HASH);

        expect(nativeRunLookupEntry(directory, HASH)).toMatchObject({ code: stored?.code, status: "hit", terminalOutput: stored?.terminalOutput });
    });

    it.each(["0\n", " 2 ", "12abc", "0x1f", "-3", "+7", "1e3", "3.9", "\uFEFF1"])("reads the exit code %j as parseInt does", async (code) => {
        expect.hasAssertions();

        const { cache, directory, put: write } = entry("code");

        write(".commit", "");
        write("code", code);

        const stored = await cache.get(HASH);

        expect(nativeRunLookupEntry(directory, HASH)).toMatchObject({ code: stored?.code, status: "hit", terminalOutput: "" });
    });

    it.each(["abc", "", "-", "\u0085 1"])("a code of %j is a miss for both", async (code) => {
        expect.hasAssertions();

        const { cache, directory, put: write } = entry("nan");

        write(".commit", "");
        write("code", code);

        await expect(cache.get(HASH)).resolves.toBeUndefined();
        expect(nativeRunLookupEntry(directory, HASH).status).toBe("miss");
    });

    it("a missing .commit, a missing code and a missing entry are misses for both", async () => {
        expect.hasAssertions();

        const noCommit = entry("no-commit");

        noCommit.put("code", "0");

        const noCode = entry("no-code");

        noCode.put(".commit", "");

        for (const { cache, directory } of [noCommit, noCode]) {
            // eslint-disable-next-line no-await-in-loop -- two cases
            await expect(cache.get(HASH)).resolves.toBeUndefined();
            expect(nativeRunLookupEntry(directory, HASH).status).toBe("miss");
        }

        expect(nativeRunLookupEntry(noCode.directory, "ffffffffffffffffffffffffffffffff").status).toBe("miss");
    });

    it("answers a hit with a non-zero code, as Cache.get does", async () => {
        expect.hasAssertions();

        const { cache, directory, put: write } = entry("failed");

        write(".commit", "");
        write("code", "1");
        write("terminalOutput", "boom\n");

        const stored = await cache.get(HASH);

        expect(stored?.code).toBe(1);
        expect(nativeRunLookupEntry(directory, HASH)).toMatchObject({ code: 1, status: "hit", terminalOutput: "boom\n" });
    });

    it.each(["outputs.tar.br", "outputs-manifest.json", "fingerprint.json"])("does not reproduce an entry with %s", (file) => {
        expect.hasAssertions();

        const { directory, put: write } = entry("restore");

        write(".commit", "");
        write("code", "0");
        write(file, "");

        expect(nativeRunLookupEntry(directory, HASH).status).toBe("not-reproducible");
    });

    it("does not reproduce output that is not valid UTF-8", () => {
        expect.hasAssertions();

        const { directory, put: write } = entry("bytes");

        write(".commit", "");
        write("code", "0");
        write("terminalOutput", new Uint8Array([0x68, 0xff, 0xfe]));

        expect(nativeRunLookupEntry(directory, HASH).status).toBe("not-reproducible");
    });

    it("refuses a value that is not a task hash", () => {
        expect.hasAssertions();

        const { directory } = entry("hash");

        for (const bad of ["../escape", "", "0BF3560BE734757197A4FEE351196867"]) {
            expect(nativeRunLookupEntry(directory, bad).status).toBe("not-reproducible");
        }
    });
});
