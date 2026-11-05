import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "@visulima/path";
import type { Task, TaskGraph } from "@visulima/task-runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import runExecute from "../../../src/commands/run/handler";
import { applyGraphScope, scopeTaskGraph } from "../../../src/commands/run/scope-task-graph";
import { VisUserError } from "../../../src/errors/vis-user-error";
import { cleanupTemporaryDirectory, createTemporaryDirectory } from "../../test-helpers";

const task = (project: string, target: string): Task => ({ id: `${project}:${target}`, overrides: {}, target: { project, target } } as Task);

/** Graph: app:test → app:build → lib:build, and app:test → lib:test (a `^test` edge). */
const graph = (): { initial: Task[]; taskGraph: TaskGraph } => {
    const tasks = [task("app", "test"), task("app", "build"), task("lib", "build"), task("lib", "test")];

    return {
        initial: [tasks[0] as Task],
        taskGraph: {
            dependencies: { "app:build": ["lib:build"], "app:test": ["app:build", "lib:test"], "lib:build": [], "lib:test": [] },
            roots: ["app:test"],
            tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
        },
    };
};

describe(scopeTaskGraph, () => {
    it("keeps only the dependency closure for deps-only, with the new top tasks as roots", () => {
        expect.assertions(3);

        const { initial, taskGraph } = graph();
        const scoped = scopeTaskGraph(taskGraph, initial, "test", "deps-only", () => false);

        // lib:test is another project's test task, so it is a dependency, not a requested task.
        expect(Object.keys(scoped.taskGraph.tasks).toSorted()).toStrictEqual(["app:build", "lib:build", "lib:test"]);
        expect(scoped.taskGraph.roots.toSorted()).toStrictEqual(["app:build", "lib:test"]);
        expect(scoped.initialTasks.map((t) => t.id).toSorted()).toStrictEqual(["app:build", "lib:test"]);
    });

    it("keeps the dependencies for skip-deps, marked satisfied, so their hashes still fold into the requested task's key", () => {
        expect.assertions(3);

        const { initial, taskGraph } = graph();
        const scoped = scopeTaskGraph(taskGraph, initial, "test", "skip-deps", () => false);
        const satisfied = Object.values(scoped.taskGraph.tasks).flatMap((t) => (t.satisfied ? [t.id] : []));

        expect(satisfied.toSorted()).toStrictEqual(["app:build", "lib:build", "lib:test"]);
        expect(scoped.taskGraph.dependencies).toStrictEqual(taskGraph.dependencies);
        expect(scoped.initialTasks.map((t) => t.id)).toStrictEqual(["app:test"]);
    });

    it("refuses a partitioned skip-deps run whose shard depends on the same target in another project", () => {
        expect.assertions(1);

        const tasks = [task("app", "build"), task("lib", "build")];
        const built = {
            initialTasks: [tasks[0] as Task],
            persistentTasks: [],
            taskGraph: { dependencies: { "app:build": ["lib:build"], "lib:build": [] }, roots: ["app:build"], tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) },
        };
        const logger = { info: () => undefined } as never;

        expect(() => applyGraphScope(built, { logger, partitioned: true, scope: "skip-deps", target: "build" })).toThrow("--skip-deps cannot partition build");
    });

    describe("with services, finally-tasks and unrelated tasks", () => {
        /** App:test needs app:build and the db service; app:cleanup always runs after app:test; docs:lint is unrelated. */
        const mixed = (): { initial: Task[]; isService: (t: Task) => boolean; taskGraph: TaskGraph } => {
            const cleanup = { ...task("app", "cleanup"), always: true } as Task;
            const tasks = [task("app", "test"), task("app", "build"), task("db", "serve"), cleanup, task("docs", "lint")];

            return {
                initial: [tasks[0] as Task],
                isService: (t) => t.id === "db:serve",
                taskGraph: {
                    dependencies: { "app:build": [], "app:cleanup": ["app:test"], "app:test": ["app:build", "db:serve"], "db:serve": [], "docs:lint": [] },
                    roots: ["app:cleanup", "docs:lint"],
                    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
                },
            };
        };

        it("runs only real, non-service dependencies for deps-only", () => {
            expect.assertions(1);

            const { initial, isService, taskGraph } = mixed();

            expect(Object.keys(scopeTaskGraph(taskGraph, initial, "test", "deps-only", isService).taskGraph.tasks)).toStrictEqual(["app:build"]);
        });

        it("keeps the service and the finally-task for skip-deps", () => {
            expect.assertions(2);

            const { initial, isService, taskGraph } = mixed();
            const scoped = scopeTaskGraph(taskGraph, initial, "test", "skip-deps", isService);

            expect(Object.keys(scoped.taskGraph.tasks).toSorted()).toStrictEqual(["app:build", "app:cleanup", "app:test", "db:serve"]);
            // The service still starts; only the build is already done.
            expect(Object.values(scoped.taskGraph.tasks).flatMap((t) => (t.satisfied ? [t.id] : []))).toStrictEqual(["app:build"]);
        });
    });
});

describe("vis run --deps-only / --skip-deps", () => {
    let workspaceRoot: string;

    const marker = (name: string): string => join(workspaceRoot, `${name}.ran`);

    beforeEach(() => {
        workspaceRoot = createTemporaryDirectory("vis-run-graph-scope-");
        writeFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({ name: "root" }));

        for (const name of ["lib", "app"]) {
            mkdirSync(join(workspaceRoot, "packages", name), { recursive: true });
        }

        writeFileSync(join(workspaceRoot, "packages", "lib", "package.json"), JSON.stringify({ name: "lib" }));
        writeFileSync(
            join(workspaceRoot, "packages", "lib", "project.json"),
            JSON.stringify({ targets: { build: { command: `touch ${JSON.stringify(marker("lib-build"))}`, outputs: [] } } }),
        );
        writeFileSync(join(workspaceRoot, "packages", "app", "package.json"), JSON.stringify({ dependencies: { lib: "workspace:*" }, name: "app" }));
        writeFileSync(
            join(workspaceRoot, "packages", "app", "project.json"),
            JSON.stringify({ targets: { test: { command: `touch ${JSON.stringify(marker("app-test"))}`, dependsOn: ["^build"], outputs: [] } } }),
        );
    });

    afterEach(() => {
        cleanupTemporaryDirectory(workspaceRoot);
    });

    const run = async (options: Record<string, unknown>): Promise<void> => {
        await runExecute({
            argument: ["test"],
            logger: { debug: () => undefined, error: () => undefined, info: () => undefined, warn: () => undefined },
            options: { cache: false, parallel: 1, skipToolchain: true, ...options },
            runtime: {} as never,
            visConfig: undefined,
            workspaceRoot,
        } as never);
    };

    it("runs the dependencies without the requested task for --deps-only", async () => {
        expect.assertions(2);

        await run({ depsOnly: true });

        expect(existsSync(marker("lib-build"))).toBe(true);
        expect(existsSync(marker("app-test"))).toBe(false);
    });

    it("runs the requested task without its dependencies for --skip-deps", async () => {
        expect.assertions(2);

        await run({ skipDeps: true });

        expect(existsSync(marker("app-test"))).toBe(true);
        expect(existsSync(marker("lib-build"))).toBe(false);
    });

    it("re-runs a task whose dependency changed when the steps use the cache", async () => {
        expect.assertions(2);

        const log = join(workspaceRoot, "app-test.log");

        writeFileSync(
            join(workspaceRoot, "packages", "app", "project.json"),
            JSON.stringify({ targets: { test: { command: `echo run >> ${JSON.stringify(log)}`, dependsOn: ["^build"], hashMode: "declared", outputs: [] } } }),
        );
        writeFileSync(join(workspaceRoot, "packages", "lib", "index.js"), "export default 1;\n");
        await run({ cache: true });
        // Nothing changed: a cache hit, so the command does not run again.
        await run({ cache: true, depsOnly: true });
        await run({ cache: true, skipDeps: true });

        expect(readFileSync(log, "utf8")).toBe("run\n");

        // Only lib's source changes, so app:test's own inputs are the same as before.
        appendFileSync(join(workspaceRoot, "packages", "lib", "index.js"), "export const changed = true;\n");
        await run({ cache: true, depsOnly: true });
        await run({ cache: true, skipDeps: true });

        expect(readFileSync(log, "utf8")).toBe("run\nrun\n");
    });

    it("rejects both flags together", async () => {
        expect.assertions(1);

        await expect(run({ depsOnly: true, skipDeps: true })).rejects.toThrow(VisUserError);
    });

    it("rejects --deps-only with --partition", async () => {
        expect.assertions(1);

        await expect(run({ depsOnly: true, partition: "1/2" })).rejects.toThrow("--deps-only cannot be combined with --partition");
    });
});
