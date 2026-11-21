import { describe, expect, it } from "vitest";

import type { CiWorkflowProvider } from "../../src/config/types/ci";
import type { ResolveCiWorkflowProvidersOptions } from "../../src/util/ci-workflow/providers";
import { resolveCiWorkflowProviders } from "../../src/util/ci-workflow/providers";

const resolve = async (overrides: Partial<ResolveCiWorkflowProvidersOptions> & { files?: string[]; remote?: CiWorkflowProvider }): ReturnType<typeof resolveCiWorkflowProviders> => {
    const { files = [], remote, ...options } = overrides;

    return resolveCiWorkflowProviders({
        configured: undefined,
        detectRemote: async () => remote,
        exists: async (path) => files.includes(path),
        flag: undefined,
        prompt: undefined,
        ...options,
    });
};

describe(resolveCiWorkflowProviders, () => {
    it("prefers --provider, then ci.workflow.providers, over anything detected", async () => {
        expect.assertions(2);

        await expect(resolve({ configured: ["github"], files: [".gitlab-ci.yml"], flag: ["gitlab"] })).resolves.toStrictEqual({
            providers: ["gitlab"],
            reason: "--provider",
        });
        await expect(resolve({ configured: ["github"], files: [".gitlab-ci.yml"] })).resolves.toStrictEqual({
            providers: ["github"],
            reason: "ci.workflow.providers",
        });
    });

    it.each([
        [[".github/workflows"], ["github"], "found .github/workflows"],
        [[".gitlab-ci.yml"], ["gitlab"], "found .gitlab-ci.yml"],
        [[".github/workflows", ".gitlab-ci.yml"], ["github", "gitlab"], "found .github/workflows and .gitlab-ci.yml"],
        // The generated include alone still counts, so --check stays stable after the first run.
        [[".gitlab/vis-ci.gitlab-ci.yml"], ["gitlab"], "found .gitlab-ci.yml"],
    ])("detects %j from the CI files, before the remote", async (files, providers, reason) => {
        expect.assertions(1);

        await expect(resolve({ files, remote: "github" })).resolves.toStrictEqual({ providers, reason });
    });

    it("falls back to the git remote", async () => {
        expect.assertions(1);

        await expect(resolve({ remote: "gitlab" })).resolves.toStrictEqual({ providers: ["gitlab"], reason: "the git remote points at GitLab" });
    });

    it("asks only when nothing else decides", async () => {
        expect.assertions(1);

        await expect(resolve({ prompt: async () => ["github", "gitlab"] })).resolves.toStrictEqual({ providers: ["github", "gitlab"], reason: "your choice" });
    });

    it("fails with the way out when it cannot ask", async () => {
        expect.assertions(1);

        await expect(resolve({})).rejects.toThrow("Pass --provider=github or --provider=gitlab, or set ci.workflow.providers");
    });
});
