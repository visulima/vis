import { describe, expect, it } from "vitest";

import { VisUserError } from "../../src/errors/vis-user-error";
import type { CiWorkflowPlan } from "../../src/util/ci-workflow";
import { buildCiWorkflowPlan, collectTargetDependencies, layerTargets, withBuildFirst } from "../../src/util/ci-workflow";
import { renderGithubCiWorkflow } from "../../src/util/ci-workflow/github";
import { renderGitlabCiWorkflow } from "../../src/util/ci-workflow/gitlab";

const plan = (overrides: Partial<CiWorkflowPlan> = {}, shards: Record<string, number> = {}): CiWorkflowPlan => {
    return {
        affected: true,
        branches: ["main"],
        cacheDirectory: undefined,
        layers: [["lint", "build"], ["test"]].map((layer) => layer.map((name) => { return { name, shards: shards[name] ?? 1 }; })),
        nodeVersion: "22",
        packageManager: "pnpm",
        runsOn: "ubuntu-latest",
        ...overrides,
    };
};

describe(collectTargetDependencies, () => {
    it("reads dependsOn from project targets, falling back to task defaults", () => {
        expect.assertions(2);

        const edges = collectTargetDependencies(
            {
                a: { targets: { lint: {}, test: { dependsOn: ["^build", { target: "codegen" }] } } },
                b: { targets: { build: {} } },
            },
            { lint: { dependsOn: ["typecheck"] } },
        );

        expect([...(edges.get("test") ?? [])]).toStrictEqual(["build", "codegen"]);
        expect([...(edges.get("lint") ?? [])]).toStrictEqual(["typecheck"]);
    });
});

describe(withBuildFirst, () => {
    it("orders build before targets dependsOn leaves unordered, keeps declared order, and leaves the input alone", () => {
        expect.assertions(3);

        // codegen is declared to run before build, so it must stay ahead of it.
        const declared = new Map([["build", new Set(["codegen"])]]);
        const targets = ["lint", "codegen", "build", "test"];
        const { edges, ordered } = withBuildFirst(targets, declared);

        expect(ordered).toStrictEqual(["lint", "test"]);
        expect(layerTargets(targets, edges)).toStrictEqual([["codegen"], ["build"], ["lint", "test"]]);
        expect([...declared.keys()]).toStrictEqual(["build"]);
    });
});

describe(layerTargets, () => {
    it("puts independent targets in one group and dependents after them", () => {
        expect.assertions(1);

        const edges = new Map([["test", new Set(["build"])]]);

        expect(layerTargets(["lint", "build", "test"], edges)).toStrictEqual([["lint", "build"], ["test"]]);
    });

    it("follows unlisted targets in between", () => {
        expect.assertions(1);

        // e2e → bundle (unlisted) → build
        const edges = new Map([
            ["bundle", new Set(["build"])],
            ["e2e", new Set(["bundle"])],
        ]);

        expect(layerTargets(["e2e", "build"], edges)).toStrictEqual([["build"], ["e2e"]]);
    });

    it("ignores a target depending on itself through ^target", () => {
        expect.assertions(1);

        expect(layerTargets(["test"], new Map([["test", new Set(["test"])]]))).toStrictEqual([["test"]]);
    });

    it("rejects a cycle between listed targets", () => {
        expect.assertions(1);

        const edges = new Map([
            ["a", new Set(["b"])],
            ["b", new Set(["a"])],
        ]);

        expect(() => layerTargets(["a", "b"], edges)).toThrow(VisUserError);
    });
});

describe(buildCiWorkflowPlan, () => {
    const projects = { app: { targets: { build: { dependsOn: ["^build"] }, lint: {}, test: { dependsOn: ["build"] } } } };
    const build = (settings: Parameters<typeof buildCiWorkflowPlan>[0]["settings"]): ReturnType<typeof buildCiWorkflowPlan> =>
        buildCiWorkflowPlan({ cacheDirectory: undefined, defaultBase: "trunk", packageManager: "pnpm", projects, settings });

    it("defaults the targets, branches and shards", () => {
        expect.assertions(2);

        const { plan: result } = build({ partitions: { test: 2 } });

        expect(result.branches).toStrictEqual(["trunk"]);
        expect(result.layers).toStrictEqual([[{ name: "build", shards: 1 }], [{ name: "lint", shards: 1 }, { name: "test", shards: 2 }]]);
    });

    it.each([
        ["a partition for a target the workflow does not run", { partitions: { tset: 2 } }, "\"tset\" is not one of the workflow's targets"],
        ["a non-integer shard count", { partitions: { test: 1.5 } }, "must be a positive integer"],
        ["partitioning a target that depends on itself in other projects", { partitions: { build: 2 } }, "its shards would depend on each other"],
        ["an empty target list", { targets: [] }, "ci.workflow.targets is empty"],
        ["a target no project defines", { targets: ["e2e"] }, "no project defines \"e2e\""],
    ])("rejects %s", (_, settings, message) => {
        expect.assertions(1);

        expect(() => build(settings)).toThrow(message);
    });
});

describe(renderGithubCiWorkflow, () => {
    it("builds dependencies once, then runs each group as a parallel step group", async () => {
        expect.assertions(1);

        await expect(renderGithubCiWorkflow(plan({}, { test: 2 }))).toMatchFileSnapshot("__snapshots__/vis-ci.github.yml");
    });

    it("emits a plain step for a single-target group and uses vis run when not affected", () => {
        expect.assertions(2);

        const yaml = renderGithubCiWorkflow(plan({ affected: false, layers: [[{ name: "test", shards: 1 }]], packageManager: "npm" }));

        expect(yaml).not.toContain("parallel:");
        expect(yaml).toContain("            - name: \"test\"\n              run: \"npx vis run test --skip-deps --if-present\"\n");
    });

    it("sets up a corepack manager after setup-node, and an action-based one before it", () => {
        expect.assertions(2);

        const yarn = renderGithubCiWorkflow(plan({ packageManager: "yarn" }));
        const pnpm = renderGithubCiWorkflow(plan());

        expect(yarn.indexOf("Setup Node.js")).toBeLessThan(yarn.indexOf("corepack enable"));
        expect(pnpm.indexOf("pnpm/action-setup")).toBeLessThan(pnpm.indexOf("Setup Node.js"));
    });

    it("caches the configured task cache directory", () => {
        expect.assertions(1);

        expect(renderGithubCiWorkflow(plan({ cacheDirectory: ".cache/vis" }))).toContain("path: \".cache/vis\"");
    });

    it("refuses a group above GitHub's 10 concurrent steps", () => {
        expect.assertions(1);

        expect(() => renderGithubCiWorkflow(plan({}, { test: 11 }))).toThrow("at most 10");
    });
});

describe(renderGitlabCiWorkflow, () => {
    it("renders an includable GitLab file", async () => {
        expect.assertions(1);

        await expect(renderGitlabCiWorkflow(plan({}, { test: 3 }))).toMatchFileSnapshot("__snapshots__/vis-ci.gitlab-ci.yml");
    });

    it("makes each target a job, orders groups with needs and shards with parallel", () => {
        expect.assertions(5);

        const yaml = renderGitlabCiWorkflow(plan({}, { test: 3 }));

        expect(yaml).toContain("\"vis:lint\":\n    extends: \".vis-ci-base\"\n    needs: []\n");
        expect(yaml).toContain("\"vis:test\":\n    extends: \".vis-ci-base\"\n    needs: [\"vis:lint\", \"vis:build\"]\n    parallel: 3\n");
        expect(yaml).toContain("pnpm exec vis ci test --no-install --partition=$CI_NODE_INDEX/$CI_NODE_TOTAL --if-present");
        // Separate machines: no --deps-only / --skip-deps split.
        expect(yaml).not.toContain("--skip-deps");
        // An include must not override the including pipeline's stages or workflow.
        expect(yaml).not.toMatch(/^(?:stages|workflow):/mu);
    });

    it("turns branch globs into regex rules", () => {
        expect.assertions(2);

        const yaml = renderGitlabCiWorkflow(plan({ branches: ["main", "release/*"] }));

        expect(yaml).toContain("- if: '$CI_COMMIT_BRANCH == \"main\"'");
        expect(yaml).toContain(String.raw`- if: '$CI_COMMIT_BRANCH =~ /^release\/[^\/]*$/'`);
    });

    it("refuses a cache directory outside the project", () => {
        expect.assertions(1);

        expect(() => renderGitlabCiWorkflow(plan({ cacheDirectory: "/tmp/vis" }))).toThrow("inside the project");
    });
});
