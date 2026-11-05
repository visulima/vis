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
import type { CiWorkflowPlan } from "./plan";
import { GENERATED_NOTE, visTargetCommand, yamlString } from "./plan";

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

    return cacheDirectory.replace(/^\.\/|\/$/gu, "");
};

/**
 * Renders `.gitlab/vis-ci.gitlab-ci.yml`, meant to be pulled in with
 * `include: { local: .gitlab/vis-ci.gitlab-ci.yml }`. It declares no
 * `stages:` or `workflow:` of its own so it cannot clobber the including
 * pipeline's; ordering between groups uses `needs:` inside the `test` stage.
 */
export const renderGitlabCiWorkflow = (plan: CiWorkflowPlan): string => {
    const pm = CI_PACKAGE_MANAGER_COMMANDS[plan.packageManager];
    const branchRules = plan.branches.map((branch) => `        - if: ${singleQuoted(branchRule(branch))}`).join("\n");
    const cacheDirectory = cachePath(plan.cacheDirectory);
    // A configured taskRunner.cacheDirectory wins over the variable, so only set it for the default.
    const cacheVariable =
        plan.cacheDirectory === undefined
            ? `        # Outside node_modules, so a clean install (npm ci) keeps the restored task cache.
        VIS_CACHE_DIRECTORY: "$CI_PROJECT_DIR/${cacheDirectory}"
`
            : "";
    const beforeScript = [...pm.setup, pm.install].map((line) => `        - ${yamlString(line)}`).join("\n");

    let jobs = "";
    let previous: string[] = [];

    for (const layer of plan.layers) {
        for (const { name, shards } of layer) {
            const flags = shards === 1 ? [] : ["--partition=$CI_NODE_INDEX/$CI_NODE_TOTAL"];

            jobs += `
${yamlString(jobName(name))}:
    extends: ".vis-ci-base"
    needs: [${previous.map((job) => yamlString(job)).join(", ")}]
${shards === 1 ? "" : `    parallel: ${shards}\n`}    script:
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
.vis-ci-base:
    stage: "test"
    image: ${yamlString(`node:${plan.nodeVersion}`)}
    variables:
        # Full history, so affected detection can diff against the base.
        GIT_DEPTH: "0"
${cacheVariable}    cache:
        # Per job: jobs of one group finish in any order, and a shared key keeps only the last upload.
        key: "vis-$CI_JOB_NAME_SLUG-$CI_COMMIT_REF_SLUG"
        paths:
            - ${yamlString(`${cacheDirectory}/`)}
    rules:
        - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
${branchRules}
    before_script:
${beforeScript}
${jobs}`;
};
