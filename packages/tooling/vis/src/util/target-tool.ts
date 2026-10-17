/**
 * Offer to set up a missing `dev` or `build` target.
 *
 * When no project defines the target, by script or by inference, vis asks which
 * tool to use. The answer is the consent: it installs the tool with `vis add -D`
 * into the chosen project and adds a matching script to its package.json. The
 * script and config file are what make the choice stick: the script runs the
 * tool, and the config lets inference find the target on later runs.
 */

import type { CerebroFs } from "@visulima/cerebro";
import { join, relative } from "@visulima/path";

import { discoverWorkspace, loadVisTaskConfigsForWorkspace } from "../config/workspace";
import { VisUserError } from "../errors/vis-user-error";
import type { ChooseToolDeps, Installer } from "./tool-choice";
import { chooseTool, installDevDependency } from "./tool-choice";
import { pathExists } from "./toolbox-fs";

export interface TargetToolChoice {
    /** Config file the tool's inference needs. Written only when it does not exist yet. */
    config?: { contents: string; file: string };
    /** Shown in the list, e.g. "Vite". */
    label: string;
    /** Installed as devDependencies with `vis add -D`. */
    packages: ReadonlyArray<string>;
    /** Written to package.json under the target's name. */
    script: string;
}

/** A workspace project as far as this flow needs it. */
export interface WorkspaceProject {
    name: string;
    /** Absolute directory of the project. */
    root: string;
    targets: Record<string, unknown> | undefined;
}

export interface TargetToolParams {
    choices: ReadonlyArray<TargetToolChoice>;
    /** `--filter` selectors from the command line. A single exact project name picks where to add the script. */
    filter?: ReadonlyArray<string>;
    fs: CerebroFs;
    logger: Pick<Console, "info">;
    target: "build" | "dev";
    visConfig: Parameters<typeof discoverWorkspace>[1];
    workspaceRoot: string;
}

export interface TargetToolDeps extends ChooseToolDeps {
    /** Installs each package. Defaults to `vis add -D`. */
    install?: Installer;
    /** Lists the workspace projects. Defaults to discovering the workspace. */
    projects?: (root: string, visConfig: TargetToolParams["visConfig"]) => Promise<ReadonlyArray<WorkspaceProject>>;
}

/** Every project in the workspace, with its targets. */
export const discoverProjects = async (root: string, visConfig: TargetToolParams["visConfig"]): Promise<ReadonlyArray<WorkspaceProject>> => {
    const taskConfigs = await loadVisTaskConfigsForWorkspace(root, visConfig);
    const { workspace } = discoverWorkspace(root, visConfig, taskConfigs);

    return Object.entries(workspace.projects).map(([name, project]) => {
        return {
            name,
            root: project.root,
            targets: project.targets,
        };
    });
};

/**
 * Pick the project the script goes into. `--filter` with one exact project name
 * wins. Otherwise the workspace must have exactly one project. Anything else is
 * ambiguous, so the user is asked to say which one.
 */
const chooseProject = (projects: ReadonlyArray<WorkspaceProject>, filter: ReadonlyArray<string>, target: string): WorkspaceProject => {
    if (filter.length > 0) {
        const matches = projects.filter((project) => filter.includes(project.name));

        if (matches.length === 1) {
            return matches[0]!;
        }

        throw new VisUserError(`vis ${target}: --filter ${filter.join(", ")} does not match exactly one project. Pass the package name as it appears in its package.json.`);
    }

    if (projects.length === 1) {
        return projects[0]!;
    }

    throw new VisUserError(`vis ${target}: no project defines a "${target}" target, and the workspace has ${String(projects.length)} projects. Pass --filter <package> to choose where to add it.`);
};

/** Adds `scripts[name] = command`, keeping the file's indentation. */
const addScript = async (fs: CerebroFs, file: string, name: string, command: string): Promise<void> => {
    const text = await fs.readFile(file, "utf8");
    const manifest = JSON.parse(text) as Record<string, unknown> & { scripts?: Record<string, string> };

    manifest.scripts = { ...manifest.scripts, [name]: command };

    const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";

    await fs.writeFile(file, `${JSON.stringify(manifest, undefined, indent)}\n`, "utf8");
};

/**
 * Make sure the workspace can run `target`. Returns `true` when the caller should
 * run it now, and `false` when an install failed (the exit code is already set).
 * Throws when no project can take the script, or when the user cancels.
 */
export const offerTargetTool = async (params: TargetToolParams, deps: TargetToolDeps = {}): Promise<boolean> => {
    const { choices, fs, logger, target, visConfig, workspaceRoot } = params;
    const projects = await (deps.projects ?? discoverProjects)(workspaceRoot, visConfig);

    if (projects.some((project) => project.targets?.[target] !== undefined)) {
        return true;
    }

    const project = chooseProject(projects, params.filter ?? [], target);
    const where = relative(workspaceRoot, join(project.root, "package.json")) || "package.json";
    const choice = await chooseTool(
        `No "${target}" target is configured. Pick a tool: vis will install it and add a "${target}" script to ${where}.`,
        choices.map((option) => {
            return {
                hint: `vis add -D ${option.packages.join(" ")}, then "${target}": "${option.script}"`,
                label: option.label,
                value: option.label,
            };
        }),
        deps,
    );

    if (choice === undefined) {
        throw new VisUserError(`No ${target} tool selected. Add a "${target}" script to your package.json, or install one of the tools listed above.`);
    }

    const picked = choices.find((option) => option.label === choice.value);

    if (picked === undefined) {
        throw new VisUserError(`Unknown ${target} tool: ${choice.value}.`);
    }

    for (const packageName of picked.packages) {
        const code = installDevDependency(packageName, project.root, logger, deps.install);

        if (code !== 0) {
            process.exitCode = code;

            return false;
        }
    }

    await addScript(fs, join(project.root, "package.json"), target, picked.script);
    logger.info(`Added "${target}": "${picked.script}" to ${where}.`);

    if (picked.config !== undefined && !(await pathExists(fs, join(project.root, picked.config.file)))) {
        await fs.writeFile(join(project.root, picked.config.file), picked.config.contents, "utf8");
        logger.info(`Added ${picked.config.file}.`);
    }

    return true;
};
