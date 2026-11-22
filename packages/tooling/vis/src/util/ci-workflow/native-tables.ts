import { CI_PACKAGE_MANAGER_COMMANDS } from "../../pm/ci-commands";
import { GITHUB_ACTIONS } from "../github-actions";

/**
 * The data the native `vis sync ci-workflow` (`native/cli/src/ci_workflow/`) renders from: the action
 * pins and the package-manager command table. `native/cli/src/ci-tables.json` is this value, and
 * `__tests__/native/ci-tables.test.ts` fails when the two differ, so the two renderers cannot drift apart.
 */
export const buildNativeCiTables = (): {
    actions: Record<string, { name: string; sha: string; version: string }>;
    packageManagers: Record<string, { exec: string; githubAction?: string; githubNodeCache?: string; install: string; setup: string[] }>;
} => {
    const actionKeys = new Map(Object.entries(GITHUB_ACTIONS).map(([key, action]) => [action, key]));

    return {
        actions: Object.fromEntries(Object.entries(GITHUB_ACTIONS).map(([key, { name, sha, version }]) => [key, { name, sha, version }])),
        packageManagers: Object.fromEntries(
            Object.entries(CI_PACKAGE_MANAGER_COMMANDS).map(([manager, { exec, githubAction, githubNodeCache, install, setup }]) => [
                manager,
                { exec, githubAction: githubAction === undefined ? undefined : actionKeys.get(githubAction), githubNodeCache, install, setup },
            ]),
        ),
    };
};

/** The text of `native/cli/src/ci-tables.json`. */
export const renderNativeCiTables = (): string => `${JSON.stringify(buildNativeCiTables(), undefined, 4)}\n`;
