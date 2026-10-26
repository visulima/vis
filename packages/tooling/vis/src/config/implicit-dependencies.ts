import type { ProjectGraphDependency, WorkspaceConfiguration } from "@visulima/task-runner";

import { VisUserError } from "../errors/vis-user-error";
import { starGlobToRegExp } from "../util/star-glob";

/**
 * Project names an `implicitDependencies` reference selects. A reference with
 * `*` is a glob over project names; any other reference is a project name,
 * or an npm package name when no project has that name.
 */
const resolveImplicitReference = (reference: string, projectNames: Set<string>, pkgNameToProjectName: Map<string, string>): string[] => {
    if (reference.includes("*")) {
        const matcher = starGlobToRegExp(reference);

        return [...projectNames].filter((name) => matcher.test(name));
    }

    const targetName = projectNames.has(reference) ? reference : pkgNameToProjectName.get(reference);

    return targetName ? [targetName] : [];
};

/**
 * Applies `project.json#implicitDependencies` on top of the edges read from
 * package.json: a bare `name` adds an `implicit` edge that the task graph
 * treats as a hard ordering constraint, and `!name` removes every edge from
 * this project to `name`, whatever its type. A `name` may be a project name,
 * an npm package name, or a `*` glob over project names.
 *
 * A positive entry that selects no project is an error, since the edge can
 * never be honoured. A `!` entry that selects nothing is a no-op: there is
 * no edge to remove.
 */
export const applyImplicitDependencies = (
    workspace: WorkspaceConfiguration,
    dependencies: Record<string, ProjectGraphDependency[]>,
    projectNames: Set<string>,
    pkgNameToProjectName: Map<string, string>,
): void => {
    for (const [name, config] of Object.entries(workspace.projects)) {
        const entries = config.implicitDependencies ?? [];
        const isExclusion = (entry: string): boolean => entry.startsWith("!");

        // Additions first, so a `!` entry removes its edges whatever its position in the list.
        for (const entry of entries.filter((item) => !isExclusion(item))) {
            // An entry that only names this project still matches something, so it is not an error; it just adds no edge.
            const matched = resolveImplicitReference(entry, projectNames, pkgNameToProjectName);

            if (matched.length === 0) {
                throw new VisUserError(`Project "${name}" lists implicit dependency "${entry}", which matches no project or package in this workspace.`);
            }

            const edges = dependencies[name] ?? [];

            for (const target of matched.filter((item) => item !== name)) {
                if (!edges.some((dep) => dep.target === target)) {
                    edges.push({ source: name, target, type: "implicit" });
                }
            }

            dependencies[name] = edges;
        }

        for (const entry of entries.filter((item) => isExclusion(item))) {
            const targets = new Set(resolveImplicitReference(entry.slice(1), projectNames, pkgNameToProjectName).filter((item) => item !== name));

            dependencies[name] = (dependencies[name] ?? []).filter((dep) => !targets.has(dep.target));
        }
    }
};
