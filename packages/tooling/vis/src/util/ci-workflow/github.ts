/**
 * GitHub Actions renderer for `vis sync ci-workflow`.
 *
 * Steps run concurrently inside one job via `parallel:`
 * (https://docs.github.com/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsparallel),
 * but they have to be written into the workflow up front:
 *
 *  1. install once,
 *  2. build the dependencies of every target once (`--deps-only`),
 *  3. run each target group as a `parallel:` group (`--skip-deps`).
 *
 * Step 2 is what makes step 3 safe: the concurrent steps share one checkout,
 * so two of them building or cache-restoring the same dependency would race on
 * its outputs. `--deps-only` with the same targets and the same affected
 * selection as the later steps builds exactly the closure they need.
 */

import { VisUserError } from "../../errors/vis-user-error";
import { CI_PACKAGE_MANAGER_COMMANDS } from "../../pm/ci-commands";
import { GITHUB_ACTIONS } from "../github-actions";
import type { CiWorkflowPlan } from "./plan";
import { GENERATED_NOTE, visTargetCommand, yamlString } from "./plan";

/** GitHub runs at most 10 background steps of a job at once; more would queue. */
const MAX_PARALLEL_STEPS = 10;

interface RunStep {
    comment?: string;
    name: string;
    run?: string;
    uses?: string;
    with?: Record<string, boolean | number | string>;
}

type Step = RunStep | { parallel: RunStep[] };

const scalar = (value: boolean | number | string, indent: string): string => {
    if (typeof value !== "string") {
        return String(value);
    }

    return value.includes("\n") ? `|\n${value.replace(/\n$/u, "").split("\n").map((line) => `${indent}${line}`).join("\n")}` : yamlString(value);
};

/** Renders one step as a list item at `indent`. */
const renderStep = (step: Step, indent: string): string => {
    if ("parallel" in step) {
        return `${indent}- parallel:\n${step.parallel.map((child) => renderStep(child, `${indent}      `)).join("")}`;
    }

    const key = `${indent}  `;
    const lines = step.comment === undefined ? [] : step.comment.split("\n").map((line) => `${indent}# ${line}`);

    lines.push(`${indent}- name: ${yamlString(step.name)}`);

    if (step.uses !== undefined) {
        lines.push(`${key}uses: ${yamlString(step.uses)}`);
    }

    if (step.with !== undefined) {
        lines.push(`${key}with:`, ...Object.entries(step.with).map(([name, value]) => `${key}    ${name}: ${scalar(value, `${key}        `)}`));
    }

    if (step.run !== undefined) {
        lines.push(`${key}run: ${scalar(step.run, `${key}    `)}`);
    }

    return `${lines.join("\n")}\n`;
};

const setupSteps = (plan: CiWorkflowPlan): RunStep[] => {
    const pm = CI_PACKAGE_MANAGER_COMMANDS[plan.packageManager];
    const setupNode: RunStep = {
        name: "Setup Node.js",
        uses: GITHUB_ACTIONS.setupNode,
        with: { "node-version": plan.nodeVersion, ...(pm.githubNodeCache === undefined ? {} : { cache: pm.githubNodeCache }) },
    };
    const steps: RunStep[] = [];

    // An action installs the manager before setup-node (which caches through it); shell setup
    // (corepack, npm -g) needs the Node.js that setup-node installs, so it comes after.
    if (pm.githubAction === undefined) {
        steps.push(setupNode, ...(pm.setup.length > 0 ? [{ name: `Setup ${plan.packageManager}`, run: `${pm.setup.join("\n")}\n` }] : []));
    } else {
        steps.push({ name: `Setup ${plan.packageManager}`, uses: pm.githubAction }, setupNode);
    }

    steps.push(
        { name: "Install dependencies", run: pm.install },
        {
            comment: "The vis task cache, so unchanged tasks are restored instead of re-run.",
            name: "Restore vis cache",
            uses: GITHUB_ACTIONS.cache,
            with: {
                key: "vis-${{ runner.os }}-${{ github.sha }}",
                path: plan.cacheDirectory ?? "node_modules/.cache/vis",
                "restore-keys": "vis-${{ runner.os }}-\n",
            },
        },
    );

    return steps;
};

const targetSteps = (plan: CiWorkflowPlan): Step[] =>
    plan.layers.map((layer) => {
        const steps: RunStep[] = layer.flatMap(({ name, shards }) => {
            // No --skip-toolchain: the deps step already installed any pinned tool, so each step
            // only activates it (a pinned Node.js must be on PATH in this process too).
            const flags = ["--skip-deps"];

            if (shards === 1) {
                return [{ name, run: visTargetCommand(plan, name, flags) }];
            }

            return Array.from({ length: shards }, (_, index) => {
                const partition = `${index + 1}/${shards}`;

                return { name: `${name} (${partition})`, run: visTargetCommand(plan, name, [...flags, `--partition=${partition}`]) };
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
    ];

    return `# ${GENERATED_NOTE}
name: "vis ci"

on: # yamllint disable-line rule:truthy
    pull_request:
    push:
        branches:
${plan.branches.map((branch) => `            - ${yamlString(branch)}`).join("\n")}

permissions:
    contents: "read"

concurrency:
    group: "vis-ci-\${{ github.ref }}"
    # Supersede outdated pull request runs, but let every push to a branch finish.
    cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
    ci:
        name: "vis ci"
        runs-on: ${yamlString(plan.runsOn)}
        steps:
${steps.map((step) => renderStep(step, "            ")).join("\n")}`;
};
