import type { CiWorkflowProvider } from "../../config/types/ci";
import type { GeneratedFile } from "../generated-files";
import { renderGithubCiWorkflow } from "./github";
import { GITLAB_CI_WORKFLOW_PATH, renderGitlabCiWorkflow } from "./gitlab";
import type { CiWorkflowPlan } from "./plan";

export type { CiWorkflowPlan } from "./plan";
export { buildCiWorkflowPlan, collectTargetDependencies, layerTargets, withBuildFirst } from "./plan";

/** The file each provider gets and how it is rendered. */
const CI_WORKFLOW_RENDERERS: Record<CiWorkflowProvider, { path: string; render: (plan: CiWorkflowPlan) => string }> = {
    github: { path: ".github/workflows/vis-ci.yml", render: renderGithubCiWorkflow },
    gitlab: { path: GITLAB_CI_WORKFLOW_PATH, render: renderGitlabCiWorkflow },
};

export const isCiWorkflowProvider = (value: string): value is CiWorkflowProvider => Object.hasOwn(CI_WORKFLOW_RENDERERS, value);

export const renderCiWorkflows = (plan: CiWorkflowPlan, providers: ReadonlyArray<CiWorkflowProvider>): GeneratedFile[] =>
    providers.map((provider) => {
        return { content: CI_WORKFLOW_RENDERERS[provider].render(plan), path: CI_WORKFLOW_RENDERERS[provider].path };
    });
