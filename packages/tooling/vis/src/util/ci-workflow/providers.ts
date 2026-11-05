import type { CiWorkflowProvider } from "../../config/types/ci";
import { VisUserError } from "../../errors/vis-user-error";

export interface CiWorkflowProviderChoice {
    providers: CiWorkflowProvider[];
    /** Why these providers, for the log line (`found .gitlab-ci.yml`). */
    reason: string;
}

export interface ResolveCiWorkflowProvidersOptions {
    /** `ci.workflow.providers` from vis.config.ts. */
    configured: CiWorkflowProvider[] | undefined;
    /** The forge the CI environment or git remote points at, if known. */
    detectRemote: () => Promise<CiWorkflowProvider | undefined>;
    /** Whether a workspace-relative path exists. */
    exists: (path: string) => Promise<boolean>;
    /** Parsed `--provider` values, already validated. */
    flag: CiWorkflowProvider[] | undefined;
    /** Asks the user; `undefined` when there is no one to ask (CI, no TTY, `--check`). */
    prompt: (() => Promise<CiWorkflowProvider[]>) | undefined;
}

/**
 * Which providers `vis sync ci-workflow` generates for. The first source that
 * answers wins: `--provider`, then `ci.workflow.providers`, then the CI files
 * already in the repository, then the CI environment or git remote, and only
 * then a prompt. Existing files come before the remote so that, once a
 * workflow is generated, every later run and `--check` resolves to the same
 * providers.
 */
export const resolveCiWorkflowProviders = async ({ configured, detectRemote, exists, flag, prompt }: ResolveCiWorkflowProvidersOptions): Promise<CiWorkflowProviderChoice> => {
    if (flag !== undefined) {
        return { providers: flag, reason: "--provider" };
    }

    if (configured !== undefined) {
        return { providers: configured, reason: "ci.workflow.providers" };
    }

    const found: { file: string; provider: CiWorkflowProvider }[] = [];

    if (await exists(".github/workflows")) {
        found.push({ file: ".github/workflows", provider: "github" });
    }

    if ((await exists(".gitlab-ci.yml")) || (await exists(".gitlab/vis-ci.gitlab-ci.yml"))) {
        found.push({ file: ".gitlab-ci.yml", provider: "gitlab" });
    }

    if (found.length > 0) {
        return { providers: found.map(({ provider }) => provider), reason: `found ${found.map(({ file }) => file).join(" and ")}` };
    }

    const remote = await detectRemote();

    if (remote !== undefined) {
        return { providers: [remote], reason: `the git remote points at ${remote === "github" ? "GitHub" : "GitLab"}` };
    }

    if (prompt === undefined) {
        throw new VisUserError(
            "Could not tell which CI provider this repository uses (no .github/workflows, no .gitlab-ci.yml, no GitHub or GitLab remote). Pass --provider=github or --provider=gitlab, or set ci.workflow.providers in vis.config.ts.",
        );
    }

    return { providers: await prompt(), reason: "your choice" };
};
