/**
 * Parity between the configured task graph `task-runner-core` builds in Rust (`task_config.rs`, reached through the
 * addon's `nativeConfiguredTaskGraph` probe) and the graph Node builds: the real `discoverWorkspace`,
 * `buildProjectGraph` and `createTaskGraph` run on workspaces written to disk, with the same config object, and the
 * task ids and their order, every task's dependencies, the roots, the warnings and the carried task fields must be
 * identical. A shape the Rust side cannot reproduce must be refused, never approximated: each refusal case also
 * checks that Node does what makes the refusal necessary, so a refusal is not vacuous.
 *
 * Build the addon first: `pnpm build:native:debug` in `packages/tooling/task-runner` (and `pnpm build` there, so
 * `@visulima/task-runner` resolves to its bundle).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { TargetConfiguration, Task, TaskGraph } from "@visulima/task-runner";
import { createTaskGraph } from "@visulima/task-runner";
import { afterAll, describe, expect, it } from "vitest";

// The addon loader is not an export of the package (the probe is not part of its API), so the suite reaches it by path.
// eslint-disable-next-line import/no-relative-packages
import { nativeConfiguredTaskGraph } from "../../../task-runner/index.js";
import type { VisConfig } from "../../src/config/types";
import { buildProjectGraph, discoverWorkspace } from "../../src/config/workspace";

// A stale addon without the probe must fail this suite, not skip it.
if (typeof nativeConfiguredTaskGraph !== "function") {
    throw new TypeError("the loaded addon has no nativeConfiguredTaskGraph: rebuild it with `pnpm build:native:debug` in packages/tooling/task-runner");
}

interface Spec {
    dependencies?: string[];
    devDependencies?: string[];
    /** The directory under `packages/`; the name without its scope when absent. */
    dir?: string;
    name: string;
    peerDependencies?: string[];
    scripts?: Record<string, string>;
}

type Seed = { target: string } | "all";

const roots: string[] = [];

// eslint-disable-next-line vitest/require-top-level-describe -- removes the workspaces every describe below creates
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

const directoryOf = (spec: Spec): string => `packages/${spec.dir ?? spec.name.replace(/^@[^/]+\//, "")}`;

const workspaceDeps = (names: string[] | undefined): Record<string, string> | undefined =>
    (names === undefined ? undefined : Object.fromEntries(names.map((name) => [name, "workspace:*"])));

/** A pnpm workspace: the root files and, per project, a `package.json` with its scripts and dependencies. */
const createWorkspace = (specs: Spec[]): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "graph-parity-")));

    roots.push(root);
    put(root, "package.json", JSON.stringify({ name: "root", private: true }));
    put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");

    for (const spec of specs) {
        put(
            root,
            `${directoryOf(spec)}/package.json`,
            JSON.stringify({
                dependencies: workspaceDeps(spec.dependencies),
                devDependencies: workspaceDeps(spec.devDependencies),
                name: spec.name,
                peerDependencies: workspaceDeps(spec.peerDependencies),
                scripts: spec.scripts ?? {},
            }),
        );
    }

    return root;
};

interface NodeResult {
    /** Dependency cycles Node broke because they run only through `devDependencies` edges. */
    brokenCycles: string[][];
    command: (id: string) => string | undefined;
    graph: TaskGraph;
    /** The workspace's edges and roots as the project graph lists them, for the Rust input. */
    projectEdges: Record<string, { kind: string; project: string }[]>;
    /** The project names in the order Node discovered them. */
    projectOrder: string[];
    projectRoots: Record<string, string>;
    /** The keys of each project's `targets` object: the target set and its order. */
    projectTargets: Record<string, string[]>;
    unmatched: string[];
}

/** The seeds of `run &lt;target>` (`buildInitialTasks`), or `undefined` when no project has the target. */
const runSeeds = (
    target: string,
    workspace: ReturnType<typeof discoverWorkspace>["workspace"],
    projectOptions: ReturnType<typeof discoverWorkspace>["projectOptions"],
): Task[] | undefined => {
    const seeds: Task[] = [];

    for (const name of Object.keys(workspace.projects)) {
        const visTarget = projectOptions.get(name)?.[target];

        if (visTarget === undefined) {
            continue;
        }

        const project = workspace.projects[name]!;
        const projectRoot = project.root.length > 0 ? project.root : ".";

        seeds.push({
            cache: visTarget.cache,
            declaresInputs: visTarget.inputs !== undefined,
            id: `${name}:${target}`,
            outputs: (visTarget.outputs ?? []).map((output) =>
                (typeof output === "string" ? output.replaceAll("{projectRoot}", projectRoot).replaceAll("{projectName}", name) : output),
            ),
            overrides: { command: visTarget.command },
            projectRoot: project.root,
            target: { project: name, target },
        });
    }

    return seeds.length === 0 ? undefined : seeds;
};

/** What `run &lt;target>` (or, for `"all"`, `task-why`) builds: the real discovery, project graph and `createTaskGraph`. */
const nodeGraph = (root: string, config: Record<string, unknown>, seed: Seed): NodeResult | undefined => {
    const { packageJsons, projectOptions, workspace } = discoverWorkspace(root, config);
    const projectGraph = buildProjectGraph(root, workspace, packageJsons);
    const brokenCycles: string[][] = [];
    const unmatched: string[] = [];
    let initialTasks: Task[] | undefined;
    let targetDefaults: Record<string, Partial<TargetConfiguration>> | undefined;

    if (seed === "all") {
        // `task-why`: every target of every project, bare, and no `targetDefaults` (the merged targets carry them).
        initialTasks = Object.entries(workspace.projects).flatMap(([name, project]) =>
            Object.keys(project.targets ?? {}).map((target) => {
                return { id: `${name}:${target}`, outputs: [], overrides: {}, target: { project: name, target } };
            }),
        );
    } else {
        initialTasks = runSeeds(seed.target, workspace, projectOptions);
        targetDefaults = config["tasks"] as Record<string, Partial<TargetConfiguration>> | undefined;
    }

    if (initialTasks === undefined) {
        return undefined;
    }

    const graph = createTaskGraph(initialTasks, {
        onCycleBroken: (cycle) => {
            brokenCycles.push(cycle);
        },
        onUnmatchedProjectSelector: (selector) => {
            unmatched.push(selector);
        },
        projectGraph,
        targetDefaults,
        workspace,
    });

    return {
        brokenCycles,
        command: (id) => {
            const { project, target } = graph.tasks[id]!.target;

            return projectOptions.get(project)?.[target]?.command;
        },
        graph,
        projectEdges: Object.fromEntries(
            Object.entries(projectGraph.dependencies).map(([name, edges]) => [
                name,
                edges.map((edge) => {
                    return { kind: edge.type === "devDependency" ? "dev" : edge.type === "peerDependency" ? "peer" : "static", project: edge.target };
                }),
            ]),
        ),
        projectOrder: Object.keys(workspace.projects),
        projectRoots: Object.fromEntries(Object.entries(workspace.projects).map(([name, project]) => [name, project.root])),
        projectTargets: Object.fromEntries(Object.entries(workspace.projects).map(([name, project]) => [name, Object.keys(project.targets ?? {})])),
        unmatched,
    };
};

/**
 * The Rust graph for the same workspace. The projects come in Node's discovery order with the edges of Node's
 * project graph (discovery and the project graph have their own native readers and tests); the scripts come from the
 * spec, in the order of the file.
 */
const rustGraph = (
    specs: Spec[],
    node: NodeResult,
    config: Record<string, unknown>,
    seed: Seed,
    options: { inference?: string; noProjectFiles?: boolean } = {},
) => {
    const scriptsOf = new Map(specs.map((spec) => [spec.name, Object.entries(spec.scripts ?? {})]));

    return nativeConfiguredTaskGraph(
        JSON.stringify(config),
        Object.keys((config["tasks"] as object | undefined) ?? {}),
        node.projectOrder.map((name) => {
            return {
                dependencies: node.projectEdges[name] ?? [],
                name,
                root: node.projectRoots[name] as string,
                scripts: (scriptsOf.get(name) ?? []).map(([script, command]) => {
                    return { command, name: script };
                }),
            };
        }),
        seed === "all" ? undefined : seed.target,
        options.inference ?? "nothing-to-infer",
        options.noProjectFiles ?? true,
    );
};

/** Whether `dependencies` (task id to the ids it depends on) has a cycle. */
const hasCycle = (dependencies: Record<string, string[]>): boolean => {
    const state = new Map<string, "done" | "open">();
    const visit = (id: string): boolean => {
        if (state.get(id) === "open") {
            return true;
        }

        if (state.get(id) === "done") {
            return false;
        }

        state.set(id, "open");

        const cyclic = (dependencies[id] ?? []).some((dependency) => visit(dependency));

        state.set(id, "done");

        return cyclic;
    };

    return Object.keys(dependencies).some((id) => visit(id));
};

/** Asserts the Rust graph equals Node's in everything the graph carries. */
const expectParity = (specs: Spec[], config: Record<string, unknown>, seed: Seed): NodeResult => {
    const root = createWorkspace(specs);
    const node = nodeGraph(root, config, seed);

    expect(node, "Node has seed tasks").toBeDefined();

    const found = node as NodeResult;
    const rust = rustGraph(specs, found, config, seed);

    expect(rust.refusal ?? undefined).toBeUndefined();
    expect(found.brokenCycles).toStrictEqual([]);
    expect(hasCycle(found.graph.dependencies)).toBe(false);
    expect(rust.tasks.map((task) => task.id)).toStrictEqual(Object.keys(found.graph.tasks));
    expect(rust.roots).toStrictEqual(found.graph.roots);
    expect(rust.warnings).toStrictEqual(found.unmatched);

    // `task-why` seeds every target of every project, so the tasks list each project's target set in order: the set
    // `project_targets` returns (it shares the iterator), which `status` and the target checks need.
    if (seed === "all") {
        const targets: Record<string, string[]> = Object.fromEntries(found.projectOrder.map((name) => [name, []]));

        for (const task of rust.tasks) {
            targets[task.project]?.push(task.target);
        }

        expect(targets).toStrictEqual(found.projectTargets);
    }

    for (const task of rust.tasks) {
        const expected = found.graph.tasks[task.id] as Task;

        expect(task.dependencies, `dependencies of ${task.id}`).toStrictEqual(found.graph.dependencies[task.id]);
        expect(task.project).toBe(expected.target.project);
        expect(task.target).toBe(expected.target.target);
        expect(task.command, `command of ${task.id}`).toBe(found.command(task.id) ?? "");

        // A `task-why` seed is bare in Node (no cache, outputs, inputs or root), so the carried fields are compared
        // for the tasks `run` builds.
        if (seed !== "all") {
            expect(task.root).toBe(expected.projectRoot);
            expect(task.cache ?? undefined, `cache of ${task.id}`).toBe(expected.cache);
            expect(JSON.parse(task.outputs), `outputs of ${task.id}`).toStrictEqual(expected.outputs);
            expect(task.declaresInputs, `declaresInputs of ${task.id}`).toBe(expected.declaresInputs === true);
        }
    }

    return found;
};

/** Asserts the Rust graph is refused with a reason matching `reason`; returns Node's side for further checks. */
const expectRefused = (specs: Spec[], config: Record<string, unknown>, seed: Seed, reason: RegExp, options?: { inference?: string; noProjectFiles?: boolean }) => {
    const root = createWorkspace(specs);
    const node = nodeGraph(root, config, seed);
    const rust = rustGraph(specs, node ?? ({ projectEdges: {}, projectOrder: specs.map((spec) => spec.name), projectRoots: Object.fromEntries(specs.map((spec) => [spec.name, directoryOf(spec)])) } as unknown as NodeResult), config, seed, options);

    expect(rust.refusal).toMatch(reason);
    expect(rust.tasks).toStrictEqual([]);

    return node;
};

const sh = (script: string): Record<string, string> => {
    return { build: script };
};

const chain: Spec[] = [
    { name: "a", scripts: sh("tsc -p .") },
    { dependencies: ["a"], name: "b", scripts: sh("tsc -p .") },
    { dependencies: ["b"], name: "c", scripts: sh("tsc -p .") },
];

const diamond: Spec[] = [
    { dependencies: ["b"], devDependencies: ["c"], name: "d", scripts: sh("node build.js") },
    { dependencies: ["a"], name: "b", scripts: sh("node build.js") },
    { dependencies: ["a"], name: "c", peerDependencies: ["a"], scripts: sh("node build.js") },
    { name: "a", scripts: sh("node build.js") },
];

const caret = { tasks: { build: { dependsOn: ["^build"] } } };

describe("the configured task graph equals the graph Node builds", () => {
    it.each([
        ["a chain, no config", chain, {}],
        ["a chain, `^build`", chain, caret],
        ["a diamond with a dev and a peer edge, `^build`", diamond, caret],
        ["a diamond, a config with no tasks", diamond, { $schema: "https://example.test/vis.json" }],
    ] as [string, Spec[], Record<string, unknown>][])("run build: %s", (_name, specs, config) => {
        expect.hasAssertions();

        const node = expectParity(specs, config, { target: "build" });

        expect(Object.keys(node.graph.tasks)).toHaveLength(specs.length);
    });

    it("keeps a project without the script out of the graph and does not bridge over it", () => {
        expect.hasAssertions();

        const specs: Spec[] = [
            { name: "a", scripts: sh("tsc") },
            { dependencies: ["a"], name: "gap" },
            { dependencies: ["gap", "a"], name: "b", scripts: sh("tsc") },
            { dependencies: ["gap"], name: "c", scripts: sh("tsc") },
        ];
        const node = expectParity(specs, caret, { target: "build" });

        expect(Object.keys(node.graph.tasks)).toStrictEqual(["a:build", "b:build", "c:build"]);
        expect(node.graph.dependencies["c:build"]).toStrictEqual([]);
    });

    it("visits the tasks breadth first: the seeds, then what they queued", () => {
        expect.hasAssertions();

        const specs: Spec[] = [
            { dependencies: ["z"], name: "a", scripts: { build: "x", gen: "y" } },
            { name: "b", scripts: { build: "x" } },
            { name: "z", scripts: { build: "x" } },
        ];
        const config = { tasks: { build: { dependsOn: ["^build", "gen"] }, gen: {} } };
        const node = expectParity(specs, config, { target: "build" });

        expect(Object.keys(node.graph.tasks)).toStrictEqual(["a:build", "b:build", "z:build", "a:gen"]);
    });

    it("resolves a same-project dependency only where the project has the target", () => {
        expect.hasAssertions();

        const specs: Spec[] = [
            { name: "a", scripts: { test: "t" } },
            { name: "b", scripts: { build: "b", test: "t" } },
        ];
        const node = expectParity(specs, { tasks: { test: { dependsOn: ["build"] } } }, { target: "test" });

        expect(Object.keys(node.graph.tasks)).toStrictEqual(["a:test", "b:test", "b:build"]);
    });

    it("gives no edge and no warning for a dependency on a target nobody has", () => {
        expect.hasAssertions();

        const node = expectParity(chain, { tasks: { build: { dependsOn: ["nope", "^nope", "^build"] } } }, { target: "build" });

        expect(node.unmatched).toStrictEqual([]);
        expect(node.graph.dependencies["b:build"]).toStrictEqual(["a:build"]);
    });

    it("lists a dependency once per resolved edge, a duplicate included", () => {
        expect.hasAssertions();

        const config = { tasks: { build: { dependsOn: ["^build", { dependencies: true, target: "build" }] } } };
        const node = expectParity(chain, config, { target: "build" });

        expect(node.graph.dependencies["b:build"]).toStrictEqual(["a:build", "a:build"]);
    });

    it("resolves `{ target, dependencies: true, params }` like `^target`", () => {
        expect.hasAssertions();

        const config = { tasks: { build: { dependsOn: [{ dependencies: true, params: "forward", target: "build" }] } } };

        expectParity(diamond, config, { target: "build" });
    });

    const scoped: Spec[] = [
        { dir: "a", name: "@s/a", scripts: { check: "c", lint: "l" } },
        { dir: "b", name: "@s/b", scripts: { lint: "l" } },
        { name: "tool", scripts: { lint: "l" } },
        { name: "zip", scripts: { lint: "l" } },
    ];

    it("resolves `projects` selectors: exact names before globs, `*` across a slash, the declaring task dropped", () => {
        expect.hasAssertions();

        const config = {
            tasks: {
                check: {
                    dependsOn: [
                        { projects: ["@s/*", "tool"], target: "lint" },
                        { projects: "t??l", target: "lint" },
                        { projects: ["*"], target: "check" },
                    ],
                },
            },
        };
        const node = expectParity(scoped, config, { target: "check" });

        expect(node.graph.dependencies["@s/a:check"]).toStrictEqual(["@s/a:lint", "@s/b:lint", "tool:lint", "tool:lint"]);
    });

    it("reports a selector that matches nothing as a warning and creates no edge", () => {
        expect.hasAssertions();

        const config = { tasks: { check: { dependsOn: [{ projects: ["missing", "ghost-*", "@s/b"], target: "lint" }] } } };
        const node = expectParity(scoped, config, { target: "check" });

        expect(node.unmatched).toStrictEqual(["missing", "ghost-*"]);
        expect(node.graph.dependencies["@s/a:check"]).toStrictEqual(["@s/b:lint"]);
    });

    it("treats `projects: []` as no edge and `projects: \"\"` as the same project", () => {
        expect.hasAssertions();

        const specs: Spec[] = [{ name: "a", scripts: { build: "b", gen: "g" } }];

        expectParity(specs, { tasks: { build: { dependsOn: [{ projects: [], target: "gen" }] } } }, { target: "build" });

        const node = expectParity(specs, { tasks: { build: { dependsOn: [{ projects: "", target: "gen" }] } } }, { target: "build" });

        expect(node.graph.dependencies["a:build"]).toStrictEqual(["a:gen"]);
    });

    it("lets `dependencies: true` win over `projects`", () => {
        expect.hasAssertions();

        const node = expectParity(chain, { tasks: { build: { dependsOn: [{ dependencies: true, projects: ["c"], target: "build" }] } } }, { target: "build" });

        expect(node.graph.dependencies["a:build"]).toStrictEqual([]);
        expect(node.graph.dependencies["b:build"]).toStrictEqual(["a:build"]);
    });

    it("makes a default with a command a target of every project, a project with no script included", () => {
        expect.hasAssertions();

        const specs: Spec[] = [...chain, { name: "bare" }];
        const config = { tasks: { build: {}, check: { command: "echo check", dependsOn: [{ projects: ["*"], target: "build" }] } } };
        const node = expectParity(specs, config, { target: "check" });

        expect(Object.keys(node.graph.tasks).filter((id) => id.endsWith(":check"))).toHaveLength(4);
        expect(node.graph.dependencies["bare:check"]).toStrictEqual(["a:build", "b:build", "c:build"]);
    });

    it("lets the default command win over the script", () => {
        expect.hasAssertions();

        expectParity(chain, { tasks: { build: { command: "tsc -b" } } }, { target: "build" });
    });

    it("carries cache, outputs and inputs: tokens expanded, `{ auto: true }` kept, `@inherit` dropped", () => {
        expect.hasAssertions();

        const config = {
            tasks: {
                build: {
                    cache: false,
                    dependsOn: ["@inherit", "^build"],
                    inputs: ["src/**", "@inherit", "!src/gen/**"],
                    outputs: ["{projectRoot}/dist", "@inherit", { auto: true }, "{projectName}.log", "{projectRoot}/{projectName}/x"],
                },
            },
        };
        const node = expectParity(chain, config, { target: "build" });

        expect(node.graph.tasks["b:build"]?.outputs).toStrictEqual(["packages/b/dist", { auto: true }, "b.log", "packages/b/b/x"]);
        expect(node.graph.tasks["b:build"]?.cache).toBe(false);
        expect(node.graph.tasks["b:build"]?.declaresInputs).toBe(true);
    });

    it("carries `cache: true` and no inputs", () => {
        expect.hasAssertions();

        const node = expectParity(chain, { tasks: { build: { cache: true, description: "compile" } } }, { target: "build" });

        expect(node.graph.tasks["a:build"]?.declaresInputs).toBe(false);
    });

    it("builds the `task-why` graph: every target of every project, in project and target order", () => {
        expect.hasAssertions();

        const specs: Spec[] = [
            // The order of the scripts is the order of the targets, so the keys are not sorted.
            // eslint-disable-next-line perfectionist/sort-objects
            { dependencies: ["lib"], name: "app", scripts: { test: "t", build: "b" } },
            { name: "lib", scripts: { build: "b", lint: "l" } },
        ];
        const config = {
            tasks: {
                build: { dependsOn: ["^build"] },
                ship: { command: "s", dependsOn: ["build"] },
                test: { dependsOn: ["build"] },
                zeta: { command: "z" },
            },
        };
        const node = expectParity(specs, config, "all");

        expect(Object.keys(node.graph.tasks)).toStrictEqual([
            "app:test",
            "app:build",
            "app:ship",
            "app:zeta",
            "lib:build",
            "lib:lint",
            "lib:ship",
            "lib:zeta",
        ]);
    });

    it("builds the `task-why` graph of scripts a run would refuse: a shell variable and an empty script", () => {
        expect.hasAssertions();

        const specs: Spec[] = [{ name: "a", scripts: { build: "echo ${HOME}", empty: "" } }];

        expectParity(specs, {}, "all");
    });

    it("lists a project that is a dependency and a devDependency once, as the project graph does", () => {
        expect.hasAssertions();

        const specs: Spec[] = [
            { name: "a", scripts: sh("x") },
            { dependencies: ["a"], devDependencies: ["a"], name: "b", peerDependencies: ["a"], scripts: sh("x") },
        ];
        const node = expectParity(specs, caret, { target: "build" });

        expect(node.projectEdges["b"]).toStrictEqual([{ kind: "static", project: "a" }]);
        expect(node.graph.dependencies["b:build"]).toStrictEqual(["a:build"]);
    });

    it("builds the `task-why` graph of a workspace with no config", () => {
        expect.hasAssertions();

        expectParity(diamond, {}, "all");
    });
});

describe("what the configured task graph does not reproduce", () => {
    const cyclic: Spec[] = [
        { dependencies: ["b"], name: "a", scripts: sh("x") },
        { dependencies: ["a"], name: "b", scripts: sh("x") },
    ];

    it("refuses a cycle with a hard edge: Node keeps it", () => {
        expect.hasAssertions();

        const node = expectRefused(cyclic, caret, { target: "build" }, /cycle/);

        expect(hasCycle(node?.graph.dependencies ?? {})).toBe(true);
        expect(node?.brokenCycles).toStrictEqual([]);
    });

    it("refuses a cycle through dev edges only: Node breaks it and warns", () => {
        expect.hasAssertions();

        const specs: Spec[] = [
            { devDependencies: ["b"], name: "a", scripts: sh("x") },
            { devDependencies: ["a"], name: "b", scripts: sh("x") },
        ];
        const node = expectRefused(specs, caret, { target: "build" }, /cycle/);

        expect(node?.brokenCycles.length).toBe(1);
        expect(hasCycle(node?.graph.dependencies ?? {})).toBe(false);
    });

    it("refuses a task that depends on itself", () => {
        expect.hasAssertions();

        const node = expectRefused(chain, { tasks: { build: { dependsOn: ["build"] } } }, { target: "build" }, /cycle/);

        expect(hasCycle(node?.graph.dependencies ?? {})).toBe(true);
    });

    it("does not refuse a cycle between projects when no task depends on another", () => {
        expect.hasAssertions();

        expectParity(cyclic, {}, { target: "build" });
    });

    it("refuses a target no project has: Node has no seed task", () => {
        expect.hasAssertions();

        expect(expectRefused(chain, caret, { target: "deploy" }, /no project has the target/)).toBeUndefined();

        // `task-why` seeds every target there is: a workspace of projects with none seeds nothing.
        expect(Object.keys(expectRefused([{ name: "a" }], {}, "all", /no project has the target/)?.graph.tasks ?? ["seeded"])).toStrictEqual([]);
    });

    it("refuses what the caller did not vouch for", () => {
        expect.hasAssertions();

        expectRefused(chain, caret, { target: "build" }, /inference is neither disabled nor checked/, { inference: "unchecked" });
        expectRefused(chain, caret, { target: "build" }, /project.json or vis.task overlay/, { noProjectFiles: false });

        // `inferTargets: false` is the config's own word, and needs no check.
        const root = createWorkspace(chain);
        const node = nodeGraph(root, { inferTargets: false, ...caret }, { target: "build" }) as NodeResult;

        expect(rustGraph(chain, node, { inferTargets: false, ...caret }, { target: "build" }, { inference: "unchecked" }).refusal ?? undefined).toBeUndefined();
    });

    it.each([
        ["scopedTasks", { scopedTasks: [] }],
        ["taskGroups", { taskGroups: { ci: ["build"] } }],
        ["fileGroups", { fileGroups: { src: ["src/**"] } }],
        ["projectIgnore", { projectIgnore: ["packages/c"] }],
        ["a discover flag", { composer: { discover: true } }],
        ["a key not audited for the graph", { ci: { provider: "github" } }],
        ["inferTargets as an object", { inferTargets: { vite: false } }],
    ] as [string, Record<string, unknown>][])("refuses a top-level config key: %s", (_name, config) => {
        expect.hasAssertions();

        expectRefused(chain, config, { target: "build" }, /config key|inferTargets/);
    });

    it.each(["always", "executor", "options", "splitCompound", "aliases", "type", "preset", "when", "hashMode", "env", "service"])(
        "refuses the target key `%s`",
        (key) => {
            expect.hasAssertions();

            expectRefused(chain, { tasks: { build: { [key]: key === "options" ? {} : "x" } } }, { target: "build" }, /is not read natively/);
        },
    );

    it("refuses a `{ group }` entry, which Node expands from `taskGroups` and rejects when the group is unknown", () => {
        expect.hasAssertions();

        const config = { taskGroups: { ci: ["build"] }, tasks: { build: { dependsOn: [{ group: "ci" }] } } };

        expectRefused(chain, config, { target: "build" }, /config key/);

        const unknown = { tasks: { build: { dependsOn: [{ group: "ci" }] } } };

        expect(() => discoverWorkspace(createWorkspace(chain), unknown as VisConfig)).toThrow(/Unknown taskGroup/);
        expect(
            rustGraph(chain, { projectEdges: {}, projectOrder: ["a"], projectRoots: { a: "packages/a" } } as unknown as NodeResult, unknown, { target: "build" }).refusal,
        ).toMatch(/task group/);
    });

    it.each([
        ["an empty name", ""],
        ["a bare caret", "^"],
        ["a token", "{projectRoot}/gen"],
        ["a glob", "^src/*"],
        ["a file path", "gen/out.ts"],
    ])("refuses a dependsOn entry Node rejects while it loads the workspace: %s", (_name, entry) => {
        expect.hasAssertions();

        const config = { tasks: { build: { dependsOn: [entry] } } };

        expect(() => discoverWorkspace(createWorkspace(chain), config as VisConfig)).toThrow(/dependsOn/);

        const rust = rustGraph(chain, { projectEdges: {}, projectOrder: ["a", "b", "c"], projectRoots: { a: "packages/a", b: "packages/b", c: "packages/c" } } as unknown as NodeResult, config, { target: "build" });

        expect(rust.refusal).toMatch(/dependsOn entry Node rejects/);
    });

    it("refuses an object dependsOn entry without a target, which Node rejects", () => {
        expect.hasAssertions();

        const config = { tasks: { build: { dependsOn: [{ projects: ["a"] }] } } };

        expect(() => discoverWorkspace(createWorkspace(chain), config as VisConfig)).toThrow(/target/);
        expect(rustGraph(chain, { projectEdges: {}, projectOrder: ["a"], projectRoots: { a: "packages/a" } } as unknown as NodeResult, config, { target: "build" }).refusal).toMatch(/Node rejects/);
    });

    it("refuses a script Node expands tokens in, and an empty script", () => {
        expect.hasAssertions();

        expectRefused([{ name: "a", scripts: sh("eslint ${affected.files}") }], {}, { target: "build" }, /`\$\{` token/);
        expectRefused([{ name: "a", scripts: sh("") }], {}, { target: "build" }, /has no command/);
    });

    it("refuses a target name Node resolves through `Object.prototype`: it finds a task there", () => {
        expect.hasAssertions();

        const node = expectRefused(chain, { tasks: { build: { dependsOn: ["constructor"] } } }, { target: "build" }, /not reproducible/);

        // Node treats the inherited `constructor` as a target the project has, and adds the task.
        expect(Object.keys(node?.graph.tasks ?? {})).toContain("a:constructor");
    });

    it("refuses a target name JavaScript lists first: Node reorders the targets", () => {
        expect.hasAssertions();

        const specs: Spec[] = [{ name: "a", scripts: { 12: "x", build: "b" } }];
        const node = expectRefused(specs, {}, "all", /not reproducible/);

        expect(Object.keys(node?.graph.tasks ?? {})).toStrictEqual(["a:12", "a:build"]);
    });

    it("refuses duplicate project names", () => {
        expect.hasAssertions();

        const root = createWorkspace(chain);
        const node = nodeGraph(root, caret, { target: "build" }) as NodeResult;
        const rust = rustGraph(chain, { ...node, projectOrder: ["a", "b", "b"] }, caret, { target: "build" });

        expect(rust.refusal).toMatch(/project name b is used twice/);
    });
});
