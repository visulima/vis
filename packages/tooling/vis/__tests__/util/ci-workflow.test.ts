import { parse as parseYaml } from "@visulima/yaml";
import { describe, expect, it } from "vitest";

import { VisUserError } from "../../src/errors/vis-user-error";
import type { CiWorkflowPlan } from "../../src/util/ci-workflow";
import { buildCiWorkflowPlan, collectTargetDependencies, layerTargets, withBuildFirst } from "../../src/util/ci-workflow";
import { detectEcosystems } from "../../src/util/ci-workflow/ecosystems";
import { renderGithubCiWorkflow } from "../../src/util/ci-workflow/github";
import { gitlabMissingToolchains, renderGitlabCiWorkflow } from "../../src/util/ci-workflow/gitlab";

const plan = (overrides: Partial<CiWorkflowPlan> = {}, shards: Record<string, number> = {}): CiWorkflowPlan => {
    return {
        affected: true,
        branches: ["main"],
        cacheDirectory: undefined,
        checkDrift: true,
        ecosystems: [],
        github: {},
        gitlab: {},
        layers: [["lint", "build"], ["test"]].map((layer) => layer.map((name) => { return { env: undefined, name, shards: shards[name] ?? 1 }; })),
        nodeVersion: "22",
        packageManager: "pnpm",
        rootFiles: new Set(),
        runsOn: "ubuntu-latest",
        timeoutMinutes: 60,
        toolchainPins: {},
        visVersion: "1.2.3",
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
        buildCiWorkflowPlan({ cacheDirectory: undefined, defaultBase: "trunk", packageManager: "pnpm", projects, settings, visVersion: "1.2.3" });

    it("defaults the targets, branches and shards", () => {
        expect.assertions(2);

        const { plan: result } = build({ partitions: { test: 2 } });

        expect(result.branches).toStrictEqual(["trunk"]);
        expect(result.layers).toStrictEqual([
            [{ env: undefined, name: "build", shards: 1 }],
            [
                { env: undefined, name: "lint", shards: 1 },
                { env: undefined, name: "test", shards: 2 },
            ],
        ]);
    });

    it("keeps the env of a target given in object form", () => {
        expect.assertions(1);

        const { plan: result } = build({ targets: ["lint", { env: { CI_SHARD: "1" }, name: "test" }] });

        expect(result.layers.flat().find(({ name }) => name === "test")?.env).toStrictEqual({ CI_SHARD: "1" });
    });

    it.each([
        ["a partition for a target the workflow does not run", { partitions: { tset: 2 } }, "\"tset\" is not one of the workflow's targets"],
        ["a non-integer shard count", { partitions: { test: 1.5 } }, "must be a positive integer"],
        ["partitioning a target that depends on itself in other projects", { partitions: { build: 2 } }, "its shards would depend on each other"],
        ["an empty target list", { targets: [] }, "ci.workflow.targets is empty"],
        ["a target no project defines", { targets: ["e2e"] }, "no project defines \"e2e\""],
        ["a timeout that is not a positive integer", { timeoutMinutes: 0 }, "timeoutMinutes must be a positive integer"],
        ["a target listed twice", { targets: ["lint", { name: "lint" }] }, "lists \"lint\" more than once"],
        ["a step with both run and uses", { github: { steps: { after: [{ name: "x", run: "true", uses: "a/b@c" }] } } }, "\"x\" needs exactly one of `run` or `uses`"],
        ["a step with neither run nor uses", { github: { steps: { afterSetup: [{ name: "y" }] } } }, "\"y\" needs exactly one of `run` or `uses`"],
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

    it("pins every action to a commit, with the version as a comment", () => {
        expect.assertions(2);

        const uses = renderGithubCiWorkflow(plan()).split("\n").filter((line) => line.includes("uses:"));

        expect(uses.length).toBeGreaterThan(0);
        expect(uses.every((line) => /uses: "[\w.-]+\/[\w.-]+@[\da-f]{40}" # v?\d/u.test(line))).toBe(true);
    });

    it("sets a job timeout and checks the workflow for drift unless turned off", () => {
        expect.assertions(3);

        const yaml = renderGithubCiWorkflow(plan({ timeoutMinutes: 45 }));

        expect(yaml).toContain("        timeout-minutes: 45\n");
        expect(yaml).toContain("run: \"pnpm exec vis sync ci-workflow --check\"");
        expect(renderGithubCiWorkflow(plan({ checkDrift: false }))).not.toContain("sync ci-workflow --check");
    });

    it("installs vis on its own when the workspace has no JS package manager", () => {
        expect.assertions(3);

        const yaml = renderGithubCiWorkflow(plan({ ecosystems: [{ manifests: ["Cargo.toml"], name: "rust" }], packageManager: undefined }));

        expect(yaml).toContain("run: \"npm install --global @visulima/vis@1.2.3\"");
        expect(yaml).toContain("run: \"vis ci test --no-install --skip-deps --if-present\"");
        expect(yaml).not.toContain("Install dependencies");
    });

    it("sets up each detected toolchain, preferring toolchain pins and version files", () => {
        expect.assertions(6);

        const yaml = renderGithubCiWorkflow(
            plan({
                ecosystems: [
                    { manifests: ["services/api/go.mod"], name: "go" },
                    { manifests: ["build.gradle.kts"], name: "gradle" },
                    { manifests: ["pom.xml"], name: "maven" },
                    { manifests: ["tools/pyproject.toml"], name: "python" },
                    { manifests: ["Cargo.toml"], name: "rust" },
                    { manifests: ["Package.swift"], name: "swift" },
                ],
                rootFiles: new Set([".python-version"]),
                toolchainPins: { rust: "1.86.0" },
            }),
        );

        expect(yaml).toContain("go-version-file: \"services/api/go.mod\"");
        // One JDK for both build tools.
        expect(yaml.match(/name: "Setup Java"/gu)).toHaveLength(1);
        expect(yaml).toContain("python-version-file: \".python-version\"");
        expect(yaml).toContain("cache-dependency-path: |\n                      tools/pyproject.toml");
        expect(yaml).toContain("toolchain: \"1.86.0\"");
        // Swift ships on the runner.
        expect(yaml).not.toContain("Swift");
    });

    it("adds the configured env, permissions, services and steps", () => {
        expect.assertions(8);

        const yaml = renderGithubCiWorkflow(
            plan({
                github: {
                    env: { DATABASE_URL: "postgres://postgres@localhost/test", TOKEN: "${{ secrets.TOKEN }}" },
                    permissions: { "id-token": "write" },
                    services: { postgres: { env: { POSTGRES_PASSWORD: "postgres" }, image: "postgres:17", options: "--health-cmd pg_isready", ports: ["5432:5432"] } },
                    steps: {
                        after: [{ if: "always()", name: "Upload coverage", uses: "codecov/codecov-action@abc", with: { files: "coverage/lcov.info" } }],
                        afterSetup: [{ name: "Start services", run: "docker compose up -d", "working-directory": "infra" }],
                    },
                },
                layers: [[{ env: { CI_SHARD: "1" }, name: "test", shards: 1 }]],
            }),
        );

        expect(yaml).toContain("permissions:\n    contents: \"read\"\n    id-token: \"write\"\n");
        expect(yaml).toContain("        env:\n            DATABASE_URL: \"postgres://postgres@localhost/test\"\n            TOKEN: \"${{ secrets.TOKEN }}\"\n");
        expect(yaml).toContain(
            "        services:\n            postgres:\n                env:\n                    POSTGRES_PASSWORD: \"postgres\"\n                image: \"postgres:17\"\n                options: \"--health-cmd pg_isready\"\n                ports:\n                    - \"5432:5432\"\n",
        );
        // After setup and before the drift check and the dependency build.
        expect(yaml.indexOf("Start services")).toBeLessThan(yaml.indexOf("Check the workflow is up to date"));
        expect(yaml).toContain("              working-directory: \"infra\"\n              run: \"docker compose up -d\"");
        // After every target.
        expect(yaml.indexOf("Upload coverage")).toBeGreaterThan(yaml.indexOf("vis ci test"));
        expect(yaml).toContain("              env:\n                  CI_SHARD: \"1\"\n              run: \"pnpm exec vis ci test");
        expect(parseYaml(yaml)).toMatchObject({ jobs: { ci: { services: { postgres: { ports: ["5432:5432"] } } } }, permissions: { "id-token": "write" } });
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

    it("caches package managers inside the project and names toolchains the node image lacks", () => {
        expect.assertions(4);

        const rustAndJava = plan({
            ecosystems: [
                { manifests: ["Cargo.toml"], name: "rust" },
                { manifests: ["pom.xml"], name: "maven" },
            ],
            toolchainPins: { rust: "1.86.0" },
        });
        const yaml = renderGitlabCiWorkflow(rustAndJava);

        expect(yaml).toContain("CARGO_HOME: \"$CI_PROJECT_DIR/.cargo\"");
        expect(yaml).toContain("- \".cargo/\"");
        expect(gitlabMissingToolchains(rustAndJava)).toStrictEqual(["maven"]);
        expect(yaml).toContain("# Not on the node image: maven.");
    });

    it("applies the configured image, variables, scripts, services, tags and per-target variables", () => {
        expect.assertions(7);

        const custom = plan({
            ecosystems: [{ manifests: ["pom.xml"], name: "maven" }],
            gitlab: {
                afterScript: ["echo done"],
                beforeScript: ["./scripts/prepare.sh"],
                image: "registry.example.com/ci/node-java:22",
                services: ["postgres:17", { alias: "cache", name: "redis:7" }],
                tags: ["docker"],
                variables: { POSTGRES_PASSWORD: "postgres" },
            },
            layers: [[{ env: { CI_SHARD: "1" }, name: "test", shards: 1 }]],
        });
        const yaml = renderGitlabCiWorkflow(custom);

        expect(yaml).toContain('    image: "registry.example.com/ci/node-java:22"');
        expect(yaml).toContain('        POSTGRES_PASSWORD: "postgres"');
        expect(yaml).toContain('        - "pnpm install --frozen-lockfile"\n        - "./scripts/prepare.sh"\n');
        expect(yaml).toContain('    tags:\n        - "docker"\n    services:\n        - "postgres:17"\n        - alias: "cache"\n          name: "redis:7"\n    after_script:\n        - "echo done"\n');
        expect(yaml).toContain('    variables:\n        CI_SHARD: "1"\n    script:');
        // The custom image is the answer to missing toolchains.
        expect(gitlabMissingToolchains(custom)).toStrictEqual([]);
        expect(parseYaml(yaml)).toMatchObject({ ".vis-ci-base": { services: ["postgres:17", { alias: "cache", name: "redis:7" }], tags: ["docker"] } });
    });

    it("adds a drift-check job and a job timeout", () => {
        expect.assertions(2);

        const yaml = renderGitlabCiWorkflow(plan());

        expect(yaml).toContain("\"vis:workflow\":\n    extends: \".vis-ci-base\"\n    needs: []\n    script:\n        - \"pnpm exec vis sync ci-workflow --check\"");
        expect(yaml).toContain('    timeout: "60m"');
    });

    it("refuses a cache directory outside the project", () => {
        expect.assertions(1);

        expect(() => renderGitlabCiWorkflow(plan({ cacheDirectory: "/tmp/vis" }))).toThrow("inside the project");
    });
});

describe(detectEcosystems, () => {
    it("finds manifests in the root and project roots, sorted by ecosystem", () => {
        expect.assertions(1);

        expect(
            detectEcosystems([
                { files: ["Cargo.toml", "package.json", "global.json"], path: "." },
                { files: ["go.mod", "go.sum"], path: "services/api" },
                { files: ["Api.csproj"], path: "services/dotnet" },
            ]),
        ).toStrictEqual([
            { manifests: ["global.json", "services/dotnet/Api.csproj"], name: "dotnet" },
            { manifests: ["services/api/go.mod"], name: "go" },
            { manifests: ["Cargo.toml"], name: "rust" },
        ]);
    });
});
