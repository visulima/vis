/**
 * GitLab CI renderer for `vis sync ci-workflow`.
 *
 * GitLab has no concurrent steps inside a job, so every target is its own job
 * (with `parallel: N` for shards) and jobs of one group run on separate
 * machines at the same time. Each job therefore runs its target with its
 * dependencies included, and runs the toolchain pre-flight itself (no
 * `--skip-toolchain`): there is no earlier step on that machine to do it.
 */

import { VisUserError } from "../../errors/vis-user-error";
import { CI_PACKAGE_MANAGER_COMMANDS } from "../../pm/ci-commands";
import type { Ecosystem } from "./ecosystems";
import type { CiWorkflowPlan } from "./plan";
import { GENERATED_NOTE, visCommand, visInstallCommand, visTargetCommand } from "./plan";
import { yamlEntry, yamlString } from "./yaml";

export const GITLAB_CI_WORKFLOW_PATH = ".gitlab/vis-ci.gitlab-ci.yml";

const jobName = (target: string): string => `vis:${target}`;

/** A YAML single-quoted scalar, which GitLab `rules:if` expressions are usually written in. */
const singleQuoted = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * GitLab `rules:if` for a GitHub-style branch filter: an exact comparison,
 * or a regex when the pattern uses `*` (`*` stays within a path segment,
 * `**` crosses them).
 */
const branchRule = (branch: string): string => {
    if (!branch.includes("*")) {
        return `$CI_COMMIT_BRANCH == ${JSON.stringify(branch)}`;
    }

    const pattern = branch
        .split("**")
        .map((part) => part.split("*").map((literal) => literal.replaceAll(/[$()+.?[\\\]^{|}/]/gu, String.raw`\$&`)).join(String.raw`[^\/]*`))
        .join(".*");

    return `$CI_COMMIT_BRANCH =~ /^${pattern}$/`;
};

/** GitLab only caches paths inside the project directory. */
const cachePath = (cacheDirectory: string | undefined): string => {
    if (cacheDirectory === undefined) {
        return ".vis-cache";
    }

    if (cacheDirectory.startsWith("/") || cacheDirectory.startsWith("..")) {
        throw new VisUserError(`GitLab can only cache paths inside the project; taskRunner.cacheDirectory is "${cacheDirectory}".`);
    }

    return cacheDirectory.replaceAll(/^\.\/|\/$/gu, "");
};

/** Toolchains vis's own pre-flight installs when they are pinned in `toolchain.tools`. */
const isPreflightTool = (name: Ecosystem): name is "go" | "python" | "ruby" | "rust" => name === "go" || name === "python" || name === "ruby" || name === "rust";

/** Package caches moved into the project directory, the only place GitLab caches. */
const ECOSYSTEM_CACHES: ReadonlyMap<string, { path: string; variable: string }> = new Map([
    ["go", { path: ".go-mod", variable: "GOMODCACHE" }],
    ["python", { path: ".pip-cache", variable: "PIP_CACHE_DIR" }],
    ["rust", { path: ".cargo", variable: "CARGO_HOME" }],
]);

/**
 * Detected toolchains a GitLab job cannot get: the jobs run in a plain
 * `node` image (unless `ci.workflow.gitlab.image` replaces it), and vis's
 * pre-flight only installs go, python, ruby and rust, and only when they are
 * pinned in `toolchain.tools`.
 */
export const gitlabMissingToolchains = (plan: CiWorkflowPlan): string[] =>
    // A custom image is the user's answer to exactly this.
    (plan.gitlab.image === undefined ? plan.ecosystems.flatMap(({ name }) => (isPreflightTool(name) && plan.toolchainPins[name] !== undefined ? [] : [name])) : []);

/**
 * Renders `.gitlab/vis-ci.gitlab-ci.yml`, meant to be pulled in with
 * `include: { local: .gitlab/vis-ci.gitlab-ci.yml }`. It declares no
 * `stages:` or `workflow:` of its own so it cannot clobber the including
 * pipeline's; ordering between groups uses `needs:` inside the `test` stage.
 */
export const renderGitlabCiWorkflow = (plan: CiWorkflowPlan): string => {
    const branchRules = plan.branches.map((branch) => `        - if: ${singleQuoted(branchRule(branch))}`).join("\n");
    const cacheDirectory = cachePath(plan.cacheDirectory);
    const ecosystemCaches = plan.ecosystems.flatMap(({ name }) => {
        const cache = ECOSYSTEM_CACHES.get(name);

        return cache === undefined ? [] : [cache];
    });
    const variables = [
        "        # Full history, so affected detection can diff against the base.",
        '        GIT_DEPTH: "0"',
        // A configured taskRunner.cacheDirectory wins over the variable, so only set it for the default.
        ...(plan.cacheDirectory === undefined
            ? ["        # Outside node_modules, so a clean install (npm ci) keeps the restored task cache.", `        VIS_CACHE_DIRECTORY: "$CI_PROJECT_DIR/${cacheDirectory}"`]
            : []),
        ...ecosystemCaches.map(({ path, variable }) => `        ${variable}: "$CI_PROJECT_DIR/${path}"`),
        ...Object.entries(plan.gitlab.variables ?? {}).flatMap(([name, value]) => yamlEntry(name, value, "        ")),
    ].join("\n");
    const cachePaths = [cacheDirectory, ...ecosystemCaches.map(({ path }) => path)].map((path) => `            - ${yamlString(`${path}/`)}`).join("\n");
    const install
        = plan.packageManager === undefined
            ? [visInstallCommand(plan)]
            : [...CI_PACKAGE_MANAGER_COMMANDS[plan.packageManager].setup, CI_PACKAGE_MANAGER_COMMANDS[plan.packageManager].install];
    const beforeScript = [...install, ...(plan.gitlab.beforeScript ?? [])].map((line) => `        - ${yamlString(line)}`).join("\n");
    const { afterScript, services, tags } = plan.gitlab;
    const baseExtras = [
        ...(tags === undefined ? [] : yamlEntry("tags", tags, "    ")),
        ...(services === undefined ? [] : yamlEntry("services", services, "    ")),
        ...(afterScript === undefined ? [] : yamlEntry("after_script", afterScript, "    ")),
    ];
    const missing = gitlabMissingToolchains(plan);
    const missingNote
        = missing.length === 0
            ? ""
            : `#
# Not on the node image: ${missing.join(", ")}. Pin go, python, ruby or rust in
# toolchain.tools (vis.config.ts) so vis installs them, or set \`image:\` on
# .vis-ci-base in your .gitlab-ci.yml to one that has them.
`;

    let jobs = plan.checkDrift
        ? `
"vis:workflow":
    extends: ".vis-ci-base"
    needs: []
    script:
        - ${yamlString(`${visCommand(plan)} sync ci-workflow --check`)}
`
        : "";
    let previous: string[] = [];

    for (const layer of plan.layers) {
        for (const { env, name, shards } of layer) {
            const flags = shards === 1 ? [] : ["--partition=$CI_NODE_INDEX/$CI_NODE_TOTAL"];

            jobs += `
${yamlString(jobName(name))}:
    extends: ".vis-ci-base"
    needs: [${previous.map((job) => yamlString(job)).join(", ")}]
${shards === 1 ? "" : `    parallel: ${shards}\n`}${env === undefined ? "" : `${yamlEntry("variables", env, "    ").join("\n")}\n`}    script:
        - ${yamlString(visTargetCommand(plan, name, flags))}
`;
        }

        previous = layer.map(({ name }) => jobName(name));
    }

    return `# ${GENERATED_NOTE}
#
# Include it from .gitlab-ci.yml:
#   include:
#     - local: "${GITLAB_CI_WORKFLOW_PATH}"
#
# Every target is its own job, so jobs in a group run on separate machines at
# the same time; a partitioned target fans out with \`parallel: N\`.
${missingNote}.vis-ci-base:
    stage: "test"
    image: ${yamlString(plan.gitlab.image ?? `node:${plan.nodeVersion}`)}
    timeout: "${plan.timeoutMinutes}m"
    variables:
${variables}
    cache:
        # Per job: jobs of one group finish in any order, and a shared key keeps only the last upload.
        key: "vis-$CI_JOB_NAME_SLUG-$CI_COMMIT_REF_SLUG"
        paths:
${cachePaths}
    rules:
        - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
${branchRules}
    before_script:
${beforeScript}
${baseExtras.map((line) => `${line}\n`).join("")}${jobs}`;
};
