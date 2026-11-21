/** CI providers `vis sync ci-workflow` can render a workflow for. */
export type CiWorkflowProvider = "github" | "gitlab";

/** A step added to the generated GitHub workflow. Exactly one of `run` and `uses` is required. */
export interface CiGithubStep {
    "continue-on-error"?: boolean;
    env?: Record<string, string>;
    /** A GitHub expression, e.g. `always()` or `github.event_name == 'push'`. */
    if?: string;
    name: string;
    run?: string;
    shell?: string;
    "timeout-minutes"?: number;
    /** An action reference. Pin it to a commit SHA (`owner/action@&lt;sha>`), as the generated steps are. */
    uses?: string;
    with?: Record<string, boolean | number | string>;
    "working-directory"?: string;
}

/** A service container for the GitHub job (`jobs.&lt;id>.services`). */
export interface CiGithubService {
    credentials?: { password: string; username: string };
    env?: Record<string, string>;
    image: string;
    /** Docker `create` options, e.g. `--health-cmd pg_isready`. */
    options?: string;
    ports?: (number | string)[];
    volumes?: string[];
}

/** Additions to the generated GitHub Actions workflow. */
export interface CiGithubWorkflowConfig {
    /** Job-level environment variables, available to every step. Use `${{ secrets.NAME }}` for secrets. */
    env?: Record<string, string>;

    /**
     * Permissions added to the workflow's default `contents: read`, e.g.
     * `{ "id-token": "write" }` for OIDC.
     */
    permissions?: Record<string, "none" | "read" | "write">;

    /** Service containers the job needs, keyed by service name (also its hostname). */
    services?: Record<string, CiGithubService>;

    steps?: {
        /** Steps after all targets ran, e.g. a coverage upload (add `if: always()` to run them after a failure). */
        after?: CiGithubStep[];
        /** Steps after the toolchains are installed and before anything runs, e.g. starting `docker compose`. */
        afterSetup?: CiGithubStep[];
    };
}

/** A service container for every GitLab job (`services:`). */
export type CiGitlabService = string | { alias?: string; command?: string[]; name: string; variables?: Record<string, string> };

/** Additions to the generated GitLab CI file. They apply to every job. */
export interface CiGitlabWorkflowConfig {
    /** Commands after each job's script, e.g. collecting reports. */
    afterScript?: string[];
    /** Commands after the install and before each job's script. */
    beforeScript?: string[];
    /** Image for every job instead of `node:&lt;nodeVersion>`. It must have Node.js, which vis runs on. */
    image?: string;
    services?: CiGitlabService[];
    /** Runner tags that pick which runners take the jobs. */
    tags?: string[];
    /** Variables for every job. Use masked CI/CD variables for secrets. */
    variables?: Record<string, string>;
}

/** A target with settings of its own. */
export interface CiWorkflowTargetConfig {
    /** Environment variables for this target's step (GitHub) or job (GitLab). */
    env?: Record<string, string>;
    name: string;
}

/**
 * Settings for the CI workflow that `vis sync ci-workflow` generates.
 *
 * On GitHub the workflow is a single job: it builds the dependencies of every
 * listed target once (`vis ci … --deps-only`), then runs the targets as
 * GitHub Actions `parallel:` step groups (`--skip-deps`). On GitLab each
 * target becomes its own job, and a partitioned target uses `parallel: N`.
 */
export interface CiWorkflowConfig {
    /**
     * Run only the projects affected by the change (`vis ci`). Set to `false`
     * to run every project (`vis run`).
     * @default true
     */
    affected?: boolean;

    /**
     * Branches whose pushes run the workflow, besides pull/merge requests.
     * Defaults to `[defaultBase ?? "main"]`.
     */
    branches?: string[];

    /**
     * Run `build` before every other listed target that `dependsOn` does not
     * already order relative to it. Most workspaces never declare that
     * `test` or `typecheck` needs the dependencies' `dist`, because a
     * sequential CI job built first anyway; running them in parallel with
     * `build` would race. Set to `false` when your `dependsOn` is complete.
     * @default true
     */
    buildFirst?: boolean;

    /**
     * Run `vis sync ci-workflow --check` in the workflow, so CI fails when the
     * committed workflow no longer matches this config.
     * @default true
     */
    checkDrift?: boolean;

    /** Additions to the GitHub Actions workflow: env, permissions, services and extra steps. */
    github?: CiGithubWorkflowConfig;

    /** Additions to the GitLab CI file: image, variables, scripts, services and runner tags. */
    gitlab?: CiGitlabWorkflowConfig;

    /**
     * Node.js version installed by the workflow. Defaults to
     * `toolchain.tools.node`, then `"22"`.
     */
    nodeVersion?: string;

    /**
     * Split a target's tasks into N shards that run at the same time
     * (`--partition=k/N`), e.g. `{ test: 3 }`. On GitHub each shard is a step
     * in the same `parallel:` group, so a group holds at most 10 steps.
     */
    partitions?: Record<string, number>;

    /**
     * Which providers to generate a workflow for. Detected when unset: from
     * the CI files in the repository, then the CI environment or git remote.
     */
    providers?: CiWorkflowProvider[];

    /**
     * GitHub runner label.
     * @default "ubuntu-latest"
     */
    runsOn?: string;

    /**
     * Targets to run. A target that depends on another listed target (through
     * `dependsOn`, directly or via unlisted targets) runs in a later group;
     * the rest run at the same time. Defaults to whichever of lint,
     * typecheck, lint:types, build and test exist in the workspace. Use the
     * object form to give a target environment variables.
     */
    targets?: (CiWorkflowTargetConfig | string)[];

    /**
     * Minutes before the CI job is cancelled (`timeout-minutes` on GitHub,
     * `timeout` on GitLab).
     * @default 60
     */
    timeoutMinutes?: number;
}

export interface CiConfig {
    /** The workflow generated by `vis sync ci-workflow`. */
    workflow?: CiWorkflowConfig;
}
