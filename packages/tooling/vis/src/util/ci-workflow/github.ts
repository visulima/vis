/**
 * GitHub Actions renderer for `vis sync ci-workflow`.
 *
 * Steps run concurrently inside one job via `parallel:`
 * (https://docs.github.com/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsparallel),
 * but they have to be written into the workflow up front:
 *
 *  1. install once (Node.js and the JS packages, or vis on its own, plus one
 *     setup step per detected non-JS toolchain),
 *  2. build the dependencies of every target once (`--deps-only`),
 *  3. run each target group as a `parallel:` group (`--skip-deps`).
 *
 * Step 2 is what makes step 3 safe: the concurrent steps share one checkout,
 * so two of them building or cache-restoring the same dependency would race on
 * its outputs. `--deps-only` with the same targets and the same affected
 * selection as the later steps builds exactly the closure they need.
 */

import type { CiGithubStep } from "../../config/types/ci";
import { VisUserError } from "../../errors/vis-user-error";
import { CI_PACKAGE_MANAGER_COMMANDS } from "../../pm/ci-commands";
import type { GithubAction } from "../github-actions";
import { GITHUB_ACTIONS } from "../github-actions";
import type { DetectedEcosystem } from "./ecosystems";
import type { CiWorkflowPlan } from "./plan";
import { GENERATED_NOTE, visCommand, visInstallCommand, visTargetCommand } from "./plan";
import { yamlEntry, yamlString } from "./yaml";

/** GitHub runs at most 10 background steps of a job at once; more would queue. */
const MAX_PARALLEL_STEPS = 10;

/** A generated step (pinned `GithubAction`) or one from `ci.workflow.github.steps` (a `uses` string). */
interface RunStep extends Omit<CiGithubStep, "uses"> {
    comment?: string;
    uses?: GithubAction | string;
}

type Step = RunStep | { parallel: RunStep[] };

/** Renders one step as a list item at `indent`, keys in the order GitHub's docs use. */
const renderStep = (step: Step, indent: string): string => {
    if ("parallel" in step) {
        return `${indent}- parallel:\n${step.parallel.map((child) => renderStep(child, `${indent}      `)).join("")}`;
    }

    const key = `${indent}  `;
    const { comment, env, name, run, uses, with: inputs, ...rest } = step;
    const lines = comment === undefined ? [] : comment.split("\n").map((line) => `${indent}# ${line}`);

    lines.push(`${indent}- name: ${yamlString(name)}`);

    if (rest.if !== undefined) {
        lines.push(...yamlEntry("if", rest.if, key));
    }

    if (typeof uses === "string") {
        lines.push(...yamlEntry("uses", uses, key));
    } else if (uses !== undefined) {
        lines.push(`${key}uses: ${yamlString(`${uses.name}@${uses.sha}`)} # ${uses.version}`);
    }

    for (const [entry, value] of [
        ["with", inputs],
        ["env", env],
        ["working-directory", rest["working-directory"]],
        ["shell", rest.shell],
        ["run", run],
        ["continue-on-error", rest["continue-on-error"]],
        ["timeout-minutes", rest["timeout-minutes"]],
    ] as const) {
        if (value !== undefined) {
            lines.push(...yamlEntry(entry, value, key));
        }
    }

    return `${lines.join("\n")}\n`;
};

/** The workspace-relative directory of a manifest path (`.` for the root). */
const directoryOf = (manifest: string): string => (manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/")) : ".");

/**
 * The setup step for one non-JS toolchain. Versions come from `toolchain.tools`
 * in vis.config.ts first, then the ecosystem's own version file, then a
 * current default; each action's own cache is used where it has one.
 */
const ecosystemStep = (plan: CiWorkflowPlan, { manifests, name }: DetectedEcosystem): RunStep | undefined => {
    const pins = plan.toolchainPins;
    const has = (file: string): boolean => plan.rootFiles.has(file);

    switch (name) {
        case "dart": {
            return { name: "Setup Dart", uses: GITHUB_ACTIONS.setupDart, with: { sdk: "stable" } };
        }
        case "dotnet": {
            return { name: "Setup .NET", uses: GITHUB_ACTIONS.setupDotnet, with: has("global.json") ? { "global-json-file": "global.json" } : { "dotnet-version": "8.0.x" } };
        }
        case "elixir": {
            return {
                name: "Setup Elixir",
                uses: GITHUB_ACTIONS.setupBeam,
                with: has(".tool-versions") ? { "version-file": ".tool-versions", "version-type": "strict" } : { "elixir-version": "1.18", "otp-version": "27" },
            };
        }
        case "go": {
            const goMod = manifests.find((manifest) => manifest.endsWith("go.mod")) ?? "go.mod";

            return {
                name: "Setup Go",
                uses: GITHUB_ACTIONS.setupGo,
                with: { "cache-dependency-path": "**/go.sum", ...(pins.go === undefined ? { "go-version-file": goMod } : { "go-version": pins.go }) },
            };
        }
        case "gradle":
        case "maven": {
            // One JDK serves both build tools, so setupSteps keeps only the first of these.
            return { name: "Setup Java", uses: GITHUB_ACTIONS.setupJava, with: { cache: name, distribution: "temurin", "java-version": "21" } };
        }
        case "php": {
            return { name: "Setup PHP", uses: GITHUB_ACTIONS.setupPhp, with: { ...(has(".php-version") ? { "php-version-file": ".php-version" } : { "php-version": "8.3" }), tools: "composer" } };
        }
        case "python": {
            const dependencyFiles = manifests.filter((manifest) => /(?:pyproject\.toml|requirements\.txt)$/u.test(manifest));
            const version: Record<string, string>
                = pins.python === undefined ? (has(".python-version") ? { "python-version-file": ".python-version" } : { "python-version": "3.x" }) : { "python-version": pins.python };

            return {
                name: "Setup Python",
                uses: GITHUB_ACTIONS.setupPython,
                // pip caching needs a dependency file to key on; a setup.py-only project has none.
                with: { ...version, ...(dependencyFiles.length > 0 ? { cache: "pip", "cache-dependency-path": `${dependencyFiles.join("\n")}\n` } : {}) },
            };
        }
        case "ruby": {
            const gemfile = manifests.find((manifest) => manifest.endsWith("Gemfile"));

            return {
                name: "Setup Ruby",
                uses: GITHUB_ACTIONS.setupRuby,
                with: {
                    // Without a version, setup-ruby reads .ruby-version / .tool-versions.
                    ...(pins.ruby === undefined ? (has(".ruby-version") || has(".tool-versions") ? {} : { "ruby-version": "3.4" }) : { "ruby-version": pins.ruby }),
                    ...(gemfile === undefined ? {} : { "bundler-cache": true, "working-directory": directoryOf(gemfile) }),
                },
            };
        }
        case "rust": {
            // Without a toolchain input, the action reads rust-toolchain(.toml); it caches cargo itself.
            return { name: "Setup Rust", uses: GITHUB_ACTIONS.setupRust, ...(pins.rust === undefined ? {} : { with: { toolchain: pins.rust } }) };
        }
        case "zig": {
            // setup-zig reads the minimum version from build.zig.zon.
            return { name: "Setup Zig", uses: GITHUB_ACTIONS.setupZig };
        }
        // Swift ships on the GitHub-hosted runners.
        default: {
            return undefined;
        }
    }
};

const setupSteps = (plan: CiWorkflowPlan): RunStep[] => {
    const steps: RunStep[] = [];
    const setupNode = (cache: string | undefined): RunStep => {
        return { name: "Setup Node.js", uses: GITHUB_ACTIONS.setupNode, with: { "node-version": plan.nodeVersion, ...(cache === undefined ? {} : { cache }) } };
    };

    if (plan.packageManager === undefined) {
        steps.push(setupNode(undefined), { name: "Install vis", run: visInstallCommand(plan) });
    } else {
        const pm = CI_PACKAGE_MANAGER_COMMANDS[plan.packageManager];

        // An action installs the manager before setup-node (which caches through it); shell setup
        // (corepack, npm -g) needs the Node.js that setup-node installs, so it comes after.
        if (pm.githubAction === undefined) {
            steps.push(setupNode(pm.githubNodeCache), ...(pm.setup.length > 0 ? [{ name: `Setup ${plan.packageManager}`, run: `${pm.setup.join("\n")}\n` }] : []));
        } else {
            steps.push({ name: `Setup ${plan.packageManager}`, uses: pm.githubAction }, setupNode(pm.githubNodeCache));
        }

        steps.push({ name: "Install dependencies", run: pm.install });
    }

    const seen = new Set<string>();

    for (const ecosystem of plan.ecosystems) {
        const step = ecosystemStep(plan, ecosystem);

        if (step !== undefined && !seen.has(step.name)) {
            seen.add(step.name);
            steps.push(step);
        }
    }

    steps.push({
        comment: "The vis task cache, so unchanged tasks are restored instead of re-run.",
        name: "Restore vis cache",
        uses: GITHUB_ACTIONS.cache,
        with: {
            key: "vis-${{ runner.os }}-${{ github.sha }}",
            path: plan.cacheDirectory ?? "node_modules/.cache/vis",
            "restore-keys": "vis-${{ runner.os }}-\n",
        },
    });

    steps.push(...(plan.github.steps?.afterSetup ?? []));

    if (plan.checkDrift) {
        steps.push({
            comment: "Fails when vis.config.ts or the workspace changed without regenerating this file.",
            name: "Check the workflow is up to date",
            run: `${visCommand(plan)} sync ci-workflow --check`,
        });
    }

    return steps;
};

const targetSteps = (plan: CiWorkflowPlan): Step[] =>
    plan.layers.map((layer) => {
        const steps: RunStep[] = layer.flatMap(({ env, name, shards }) => {
            // No --skip-toolchain: the deps step already installed any pinned tool, so each step
            // only activates it (a pinned Node.js must be on PATH in this process too).
            const flags = ["--skip-deps"];

            if (shards === 1) {
                return [{ env, name, run: visTargetCommand(plan, name, flags) }];
            }

            return Array.from({ length: shards }, (_, index) => {
                const partition = `${index + 1}/${shards}`;

                return { env, name: `${name} (${partition})`, run: visTargetCommand(plan, name, [...flags, `--partition=${partition}`]) };
            });
        });

        if (steps.length > MAX_PARALLEL_STEPS) {
            throw new VisUserError(
                `The group ${layer.map(({ name }) => name).join(", ")} needs ${steps.length} parallel steps, but GitHub runs at most ${MAX_PARALLEL_STEPS} at once. Lower ci.workflow.partitions.`,
            );
        }

        const [only] = steps;

        return steps.length === 1 && only ? only : { parallel: steps };
    });

/** Renders `.github/workflows/vis-ci.yml`. */
export const renderGithubCiWorkflow = (plan: CiWorkflowPlan): string => {
    const steps: Step[] = [
        {
            comment: "Full history, so affected detection can diff against the base.",
            name: "Checkout",
            uses: GITHUB_ACTIONS.checkout,
            with: { "fetch-depth": 0, "persist-credentials": false },
        },
        ...setupSteps(plan),
        {
            comment: "Builds what the targets below depend on once, so the parallel steps\nnever build or restore the same outputs at the same time.",
            name: "Build dependencies",
            run: `${plan.layers
                .flat()
                .map(({ name }) => visTargetCommand(plan, name, ["--deps-only"]))
                .join("\n")}\n`,
        },
        ...targetSteps(plan),
        ...(plan.github.steps?.after ?? []),
    ];
    const { env, permissions, services } = plan.github;
    const jobExtras = [
        ...(env === undefined ? [] : yamlEntry("env", env, "        ")),
        ...(services === undefined ? [] : yamlEntry("services", services, "        ")),
    ];

    return `# ${GENERATED_NOTE}
name: "vis ci"

on: # yamllint disable-line rule:truthy
    pull_request:
    push:
        branches:
${plan.branches.map((branch) => `            - ${yamlString(branch)}`).join("\n")}

${yamlEntry("permissions", { contents: "read", ...permissions }, "").join("\n")}

concurrency:
    group: "vis-ci-\${{ github.ref }}"
    # Supersede outdated pull request runs, but let every push to a branch finish.
    cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
    ci:
        name: "vis ci"
        runs-on: ${yamlString(plan.runsOn)}
        timeout-minutes: ${plan.timeoutMinutes}
${jobExtras.map((line) => `${line}\n`).join("")}        steps:
${steps.map((step) => renderStep(step, "            ")).join("\n")}`;
};
