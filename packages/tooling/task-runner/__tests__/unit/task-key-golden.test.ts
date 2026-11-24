/**
 * Golden task keys. The values below were captured from the real declared-hash path (`InProcessTaskHasher`, the
 * dependency fold and `computeTaskHash`, driven by the orchestrator) on this fixture. A change to how a key is
 * composed must not move any of them: a different key leaves a populated cache unreachable.
 *
 * The fixture has fixed contents, so the keys are the same on every machine. It covers the pieces a key is built
 * from: global input files (including `.env`), hidden files and directories, a command with escapes, declared
 * outputs, extra override keys, a configuration, dependencies listed out of order, `globalEnv`, a glob input with a
 * negation and a project that has no input file.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Cache } from "../../src/cache";
import { EmptyLifeCycle } from "../../src/life-cycle";
import { createTaskGraph } from "../../src/task-graph";
import { computeTaskHash, InProcessTaskHasher } from "../../src/task-hasher";
import { TaskOrchestrator } from "../../src/task-orchestrator";
import { TaskScheduler } from "../../src/task-scheduler";
import type { ProjectConfiguration, ProjectGraph, Task, TaskExecutor } from "../../src/types";

const roots: string[] = [];

// eslint-disable-next-line vitest/require-top-level-describe -- removes the workspaces created below
afterAll(() => {
    for (const root of roots) {
        rmSync(root, { force: true, recursive: true });
    }
});

const put = (root: string, relative: string, content: string): void => {
    const path = join(root, relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
};

const createFixture = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "key-golden-")));

    roots.push(root);

    put(root, "package.json", "{\"name\":\"root\",\"private\":true}\n");
    put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    put(root, "tsconfig.json", "{\"compilerOptions\":{}}\n");
    put(root, ".env", "A=1\n");

    for (const name of ["core", "util", "app", "web", "docs"]) {
        put(root, `packages/${name}/package.json`, `{"name":"${name}"}\n`);
    }

    put(root, "packages/core/src/index.ts", "export const core = 1;\n");
    put(root, "packages/core/src/deep/more.ts", "export const more = 2;\n");
    put(root, "packages/core/.hidden", "hidden\n");
    put(root, "packages/core/src/.dot/inside.ts", "dot\n");
    put(root, "packages/core/node_modules/dep/index.js", "ignored\n");
    put(root, "packages/core/dist/out.js", "ignored\n");
    put(root, "packages/util/src/index.ts", "export const util = 1;\n");
    put(root, "packages/util/README.md", "readme\n");
    put(root, "packages/app/src/index.ts", "export const app = 1;\n");
    put(root, "packages/app/src/skip/generated.ts", "generated\n");
    put(root, "packages/app/src/other.js", "other\n");
    put(root, "packages/web/src/index.ts", "export const web = 1;\n");
    put(root, "packages/docs/.hidden", "only a hidden file\n");

    return root;
};

const projects: Record<string, ProjectConfiguration> = {
    app: {
        root: "packages/app",
        targets: {
            build: {
                command: "tsc -p .",
                dependsOn: ["^build"],
                inputs: ["{projectRoot}/src/**/*.ts", "!{projectRoot}/src/skip/**"],
                outputs: ["dist/**", "build/**"],
            },
        },
    },
    core: {
        root: "packages/core",
        targets: { build: { command: "echo \"quoted\" && echo 'single'\n\tline \\ two", dependsOn: ["^build"], outputs: ["dist"] } },
    },
    docs: { root: "packages/docs", targets: { build: { command: "true", dependsOn: ["^build"] } } },
    util: { root: "packages/util", targets: { build: { command: "node build.js", dependsOn: ["^build"] } } },
    web: { root: "packages/web", targets: { build: { command: "vite build", dependsOn: ["^build"] } } },
};

/** `web` depends on `util` then `core`, `app` on `web`, `core` and `util`, so no dependency list is in sorted order. */
const edges: Record<string, string[]> = { app: ["web", "core", "util"], core: [], docs: ["app"], util: ["core"], web: ["util", "core"] };

const projectGraph: ProjectGraph = {
    dependencies: Object.fromEntries(
        Object.entries(edges).map(([name, targets]) => [name, targets.map((target) => ({ source: name, target, type: "static" as const }))]),
    ),
    nodes: Object.fromEntries(
        Object.entries(projects).map(([name, data]) => [name, { data, name, type: "library" as const }]),
    ),
};

const initialTask = (name: string, overrides: Record<string, unknown>, extra: Partial<Task> = {}): Task => {
    const target = projects[name]?.targets?.["build"];

    return {
        declaresInputs: target?.inputs !== undefined,
        id: `${name}:build`,
        outputs: target?.outputs ?? [],
        overrides: { command: target?.command, visOptions: {}, ...overrides },
        projectRoot: projects[name]?.root as string,
        target: { project: name, target: "build" },
        ...extra,
    };
};

const run = async (root: string): Promise<Record<string, string>> => {
    const initialTasks = [
        initialTask("core", {}),
        initialTask("util", { visForwardedArgs: ["--flag", "a b"], visTaskArgEnv: { Z: "1", A: "2" } }),
        initialTask("web", { visOptions: { pool: { size: 2, kind: "x" } } }),
        initialTask("app", {}),
        initialTask("docs", {}),
    ];
    const taskGraph = createTaskGraph(initialTasks, { projectGraph, workspace: { projects } });
    const cache = new Cache({ cacheDirectory: join(root, "node_modules", ".cache", "vis"), workspaceRoot: root });

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
        taskHasher: new InProcessTaskHasher({
            envVars: ["GOLDEN_ENV_VAR"],
            globalEnv: ["GOLDEN_GLOBAL_ENV", "GOLDEN_GLOBAL_ENV_UNSET"],
            projects,
            workspaceRoot: root,
        }),
        whenContext: { branch: "" },
        workspaceRoot: root,
    });

    await orchestrator.run();

    return Object.fromEntries(Object.entries(taskGraph.tasks).map(([id, task]) => [id, task.hash as string]));
};

const withEnvironment = async <T>(values: Record<string, string>, callback: () => Promise<T>): Promise<T> => {
    const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));

    Object.assign(process.env, values);

    try {
        return await callback();
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    }
};

// Captured from the code before the hashers were shared with the native CLI.
const GOLDEN: Record<string, string> = {
    "app:build": "f66e483c133aec8af9b44228731b9e3f",
    "core:build": "0c52805358fe6ea33d585e11783b942a",
    "docs:build": "8b4346c2ee289fc030bb4ace0e133ac3",
    "util:build": "ea8910cb39e06b02c646767e155aba74",
    "web:build": "672fd6636cc43d5b69e914f0809446e0",
};

/** A task with a configuration, outside any graph: the key of `computeTaskHash(hashTask(task))`. */
const GOLDEN_CONFIGURATION = "4152d8d0e3ba0e35a9a31eaceb82ab7f";

describe.skipIf(process.platform === "win32")("golden task keys", () => {
    it("keeps every key of the fixture", async () => {
        expect.hasAssertions();

        const keys = await withEnvironment({ GOLDEN_ENV_VAR: "value", GOLDEN_GLOBAL_ENV: "global" }, async () => run(createFixture()));

        expect(keys).toStrictEqual(GOLDEN);
    });

    it("keeps the key of a task with a configuration", async () => {
        expect.hasAssertions();

        const root = createFixture();
        const hasher = new InProcessTaskHasher({ projects, workspaceRoot: root });
        const task = initialTask("util", {}, { id: "util:build:prod", target: { configuration: "prod", project: "util", target: "build" } });
        const details = await hasher.hashTask(task);

        expect(computeTaskHash(details)).toBe(GOLDEN_CONFIGURATION);
    });
});
