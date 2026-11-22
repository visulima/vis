import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "@visulima/path";
import type { Task, TaskGraph } from "@visulima/task-runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import runExecute from "../../../src/commands/run/handler";
import { applyGraphScope, mergeScopedRuns, scopeTaskGraph } from "../../../src/commands/run/scope-task-graph";
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

        it("runs the finally-task of a dependency once, in deps-only, and not in skip-deps", () => {
            expect.assertions(4);

            const { initial, isService, taskGraph } = mixed();
            const buildCleanup = { ...task("app", "build-cleanup"), always: true } as Task;
            const withDependencyCleanup: TaskGraph = {
                ...taskGraph,
                dependencies: { ...taskGraph.dependencies, "app:build-cleanup": ["app:build"] },
                roots: [...taskGraph.roots, "app:build-cleanup"],
                tasks: { ...taskGraph.tasks, "app:build-cleanup": buildCleanup },
            };
            const depsOnly = scopeTaskGraph(withDependencyCleanup, initial, "test", "deps-only", isService);
            const skipDeps = scopeTaskGraph(withDependencyCleanup, initial, "test", "skip-deps", isService);

            expect(Object.keys(depsOnly.taskGraph.tasks).toSorted()).toStrictEqual(["app:build", "app:build-cleanup"]);
            expect(depsOnly.taskGraph.dependencies["app:build-cleanup"]).toStrictEqual(["app:build"]);
            // The requested task's own finally-task stays on the skip-deps side.
            expect(Object.keys(skipDeps.taskGraph.tasks)).not.toContain("app:build-cleanup");
            expect(Object.keys(skipDeps.taskGraph.tasks)).toContain("app:cleanup");
        });

        it("keeps a service that a dependency needs for deps-only, and leaves one only the requested task needs", () => {
            expect.assertions(2);

            const { initial, isService, taskGraph } = mixed();
            const tasks = { ...taskGraph.tasks, "cache:serve": task("cache", "serve") };
            const withBuildService: TaskGraph = {
                ...taskGraph,
                dependencies: { ...taskGraph.dependencies, "app:build": ["cache:serve"], "cache:serve": [] },
                tasks,
            };
            const scoped = scopeTaskGraph(withBuildService, initial, "test", "deps-only", (t) => isService(t) || t.id === "cache:serve");

            expect(Object.keys(scoped.taskGraph.tasks).toSorted()).toStrictEqual(["app:build", "cache:serve"]);
            expect(scoped.taskGraph.dependencies["app:build"]).toStrictEqual(["cache:serve"]);
        });

        it("runs a finally-task only with skip-deps, even when the requested task lists it as a dependency", () => {
            expect.assertions(2);

            const { initial, isService, taskGraph } = mixed();
            const withCleanupDependency: TaskGraph = { ...taskGraph, dependencies: { ...taskGraph.dependencies, "app:cleanup": [], "app:test": ["app:build", "app:cleanup"] } };

            expect(Object.keys(scopeTaskGraph(withCleanupDependency, initial, "test", "deps-only", isService).taskGraph.tasks)).toStrictEqual(["app:build"]);
            expect(scopeTaskGraph(withCleanupDependency, initial, "test", "skip-deps", isService).taskGraph.tasks["app:cleanup"]?.satisfied).toBeUndefined();
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

describe(mergeScopedRuns, () => {
    it("keeps every task once, unions the edges and makes the tasks nothing depends on the roots", () => {
        expect.assertions(4);

        const [shared, build, gen] = [task("lib", "gen"), task("app", "build"), task("lib", "gen2")];
        const first: TaskGraph = {
            dependencies: { "app:build": ["lib:gen"], "lib:gen": [] },
            roots: ["app:build"],
            tasks: { "app:build": build, "lib:gen": shared },
        };
        const second: TaskGraph = {
            dependencies: { "lib:gen": [], "lib:gen2": ["lib:gen"] },
            roots: ["lib:gen2"],
            tasks: { "lib:gen": { ...shared }, "lib:gen2": gen },
        };
        const merged = mergeScopedRuns([
            { persistentTasks: [], taskGraph: first },
            { persistentTasks: [], taskGraph: second },
        ]);

        expect(Object.keys(merged.taskGraph.tasks).toSorted()).toStrictEqual(["app:build", "lib:gen", "lib:gen2"]);
        // The first copy of a shared task wins.
        expect(merged.taskGraph.tasks["lib:gen"]).toBe(shared);
        expect(merged.taskGraph.dependencies).toStrictEqual({ "app:build": ["lib:gen"], "lib:gen": [], "lib:gen2": ["lib:gen"] });
        expect(merged.initialTasks.map((t) => t.id).toSorted()).toStrictEqual(["app:build", "lib:gen2"]);
    });
});

describe("vis run <target>,<target> --deps-only", () => {
    let workspaceRoot: string;

    const log = (name: string): string => join(workspaceRoot, `${name}.log`);
    const lines = (name: string): string[] => (existsSync(log(name)) ? readFileSync(log(name), "utf8").split("\n").filter(Boolean) : []);
    const append = (name: string): string => `echo run >> ${JSON.stringify(log(name))}`;

    beforeEach(() => {
        workspaceRoot = createTemporaryDirectory("vis-run-target-list-");
        writeFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
        writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({ name: "root" }));

        for (const name of ["lib", "app"]) {
            mkdirSync(join(workspaceRoot, "packages", name), { recursive: true });
        }

        // `gen` has caching disabled: only one run can keep it from executing once per target.
        writeFileSync(join(workspaceRoot, "packages", "lib", "package.json"), JSON.stringify({ name: "lib" }));
        writeFileSync(join(workspaceRoot, "packages", "lib", "project.json"), JSON.stringify({ targets: { gen: { cache: false, command: append("gen"), outputs: [] } } }));
        writeFileSync(join(workspaceRoot, "packages", "app", "package.json"), JSON.stringify({ dependencies: { lib: "workspace:*" }, name: "app" }));
        writeFileSync(
            join(workspaceRoot, "packages", "app", "project.json"),
            JSON.stringify({
                targets: {
                    build: { cache: false, command: append("build"), dependsOn: ["^gen"], outputs: [] },
                    lint: { command: append("lint"), outputs: [] },
                    test: { command: append("test"), dependsOn: ["build", "^gen"], outputs: [] },
                },
            }),
        );
    });

    afterEach(() => {
        cleanupTemporaryDirectory(workspaceRoot);
    });

    const run = async (argument: string[], options?: Record<string, unknown>): Promise<void> => {
        await runExecute({
            argument,
            logger: { debug: () => undefined, error: () => undefined, info: () => undefined, warn: () => undefined },
            options: { cache: false, parallel: 1, skipToolchain: true, ...(options ?? { depsOnly: true }) },
            runtime: {} as never,
            visConfig: undefined,
            workspaceRoot,
        } as never);
    };

    it("runs a dependency the targets share once, where one run per target repeats it", async () => {
        expect.assertions(2);

        await run(["build,test"]);

        // Both targets need lib:gen: one run builds it once.
        expect(lines("gen")).toHaveLength(1);

        rmSync(log("gen"), { force: true });
        await run(["build"]);
        await run(["test"]);

        expect(lines("gen")).toHaveLength(2);
    });

    it("executes the union of the single-target dependency runs, each task once, and never the listed tasks themselves", async () => {
        expect.assertions(4);

        await run(["build,test"]);

        // test depends on build, so the dependency step of the pair still builds app:build, once.
        expect(lines("gen")).toHaveLength(1);
        expect(lines("build")).toHaveLength(1);
        expect(lines("test")).toHaveLength(0);
        expect(lines("lint")).toHaveLength(0);
    });

    it("collapses a repeated target, and treats a list that names one target as that target", async () => {
        expect.assertions(4);

        await run(["build,build,test"]);

        expect(lines("gen")).toHaveLength(1);
        expect(lines("build")).toHaveLength(1);

        rmSync(log("gen"), { force: true });
        await run(["build,build"]);
        await run(["build,"], { depsOnly: true });

        expect(lines("gen")).toHaveLength(2);

        await expect(run([","])).rejects.toThrow("names no target");
    });

    it("skips a target no project has with --if-present, and does nothing when none has it", async () => {
        expect.assertions(3);

        await run(["missing,test"], { depsOnly: true, ifPresent: true });

        expect(lines("gen")).toHaveLength(1);

        rmSync(log("gen"), { force: true });
        await run(["missing,absent"], { depsOnly: true, ifPresent: true });

        expect(lines("gen")).toHaveLength(0);

        await expect(run(["missing,test"])).rejects.toThrow(VisUserError);
    });

    it("rejects a list without --deps-only, with --skip-deps and with arguments after it", async () => {
        expect.assertions(3);

        await expect(run(["build,test"], {})).rejects.toThrow("run together only with --deps-only");
        await expect(run(["build,test"], { skipDeps: true })).rejects.toThrow("run together only with --deps-only");
        await expect(run(["build,test", "extra"])).rejects.toThrow("cannot follow the list");
    });
});
