import { isAccessibleSync, readJsonSync } from "@visulima/fs";
import { findMonorepoRootSync } from "@visulima/package";
import { dirname, join } from "@visulima/path";

/** Whether `directory` declares a workspace, through `pnpm-workspace.yaml` or a `workspaces` field. */
const declaresWorkspace = (directory: string): boolean => {
    if (isAccessibleSync(join(directory, "pnpm-workspace.yaml"))) {
        return true;
    }

    if (!isAccessibleSync(join(directory, "package.json"))) {
        return false;
    }

    return (readJsonSync(join(directory, "package.json")) as { workspaces?: unknown }).workspaces !== undefined;
};

/**
 * The workspace root for a command run from `start`: the nearest ancestor that declares a
 * workspace. Only when no ancestor does is `findMonorepoRootSync` used. That finder takes the
 * nearest lockfile as the root, so a package with its own lockfile was mistaken for the root,
 * and a declared workspace without a lockfile was not found.
 * @param start Directory the command was run from.
 * @returns The workspace root, or `undefined` when neither method finds one.
 */
export const findWorkspaceRootSync = (start: string): string | undefined => {
    let directory = start;

    for (;;) {
        if (declaresWorkspace(directory)) {
            return directory;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            break;
        }

        directory = parent;
    }

    try {
        return findMonorepoRootSync(start).path;
    } catch {
        return undefined;
    }
};
