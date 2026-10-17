/**
 * Offer to set up a missing `dev` or `build` target.
 *
 * When no project defines the target, by script or by inference, vis asks which
 * tool to use. The answer is the consent: it installs the tool with `vis add -D`
 * into the nearest package and adds a matching script to that package.json. The
 * script is what makes the choice stick, since inference needs a config file.
 */

import type { CerebroFs } from "@visulima/cerebro";
import { dirname, join, relative } from "@visulima/path";

import { discoverWorkspace, loadVisTaskConfigsForWorkspace } from "../config/workspace";
import { VisUserError } from "../errors/vis-user-error";
import type { ChooseToolDeps, Installer } from "./tool-choice";
import { chooseTool, installDevDependency } from "./tool-choice";
import { pathExists } from "./toolbox-fs";

export interface TargetToolChoice {
    /** Shown in the list, e.g. "Vite". */
    label: string;
    /** Installed as devDependencies with `vis add -D`. */
    packages: ReadonlyArray<string>;
    /** Written to package.json under the target's name. */
    script: string;
}

export interface TargetToolParams {
    choices: ReadonlyArray<TargetToolChoice>;
    cwd: string;
    fs: CerebroFs;
    logger: Pick<Console, "info">;
    target: "build" | "dev";
    visConfig: Parameters<typeof discoverWorkspace>[1];
    workspaceRoot: string;
}

export interface TargetToolDeps extends ChooseToolDeps {
    /** Overrides the workspace check. Defaults to discovering the workspace. */
    definesTarget?: (root: string, visConfig: TargetToolParams["visConfig"], target: string) => Promise<boolean>;
    /** Installs each package. Defaults to `vis add -D`. */
    install?: Installer;
}

/** Whether any project in the workspace already defines `target`, by script or by inference. */
export const workspaceDefinesTarget = async (root: string, visConfig: TargetToolParams["visConfig"], target: string): Promise<boolean> => {
    const taskConfigs = await loadVisTaskConfigsForWorkspace(root, visConfig);
    const { workspace } = discoverWorkspace(root, visConfig, taskConfigs);

    return Object.values(workspace.projects).some((project) => project.targets?.[target] !== undefined);
};

/** The nearest package directory at or below the workspace root, or `undefined` at the root itself. */
const nearestPackageDirectory = async (cwd: string, root: string, fs: CerebroFs): Promise<string | undefined> => {
    let directory = cwd;

    for (;;) {
        // The root's package.json belongs to the workspace, so the script is never added there.
        if (directory === root) {
            return undefined;
        }

        if (await pathExists(fs, join(directory, "package.json"))) {
            return directory;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return undefined;
        }

        directory = parent;
    }
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
 * Throws when there is nowhere to add the script, or when the user cancels.
 */
export const offerTargetTool = async (params: TargetToolParams, deps: TargetToolDeps = {}): Promise<boolean> => {
    const { cwd, fs, logger, target, visConfig, workspaceRoot } = params;

    const definesTarget = deps.definesTarget ?? workspaceDefinesTarget;

    if (await definesTarget(workspaceRoot, visConfig, target)) {
        return true;
    }

    const packageDirectory = await nearestPackageDirectory(cwd, workspaceRoot, fs);

    if (packageDirectory === undefined) {
        throw new VisUserError(`vis ${target}: no package to add a "${target}" script to. Run it from inside a package, or pass --filter to pick one.`);
    }

    const where = relative(workspaceRoot, join(packageDirectory, "package.json")) || "package.json";
    const choice = await chooseTool(
        `No "${target}" target is configured. Pick a tool: vis will install it and add a "${target}" script to ${where}.`,
        params.choices.map((option) => {
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

    const picked = params.choices.find((option) => option.label === choice.value);

    if (picked === undefined) {
        throw new VisUserError(`Unknown ${target} tool: ${choice.value}.`);
    }

    for (const packageName of picked.packages) {
        const code = installDevDependency(packageName, packageDirectory, logger, deps.install);

        if (code !== 0) {
            process.exitCode = code;

            return false;
        }
    }

    await addScript(fs, join(packageDirectory, "package.json"), target, picked.script);
    logger.info(`Added "${target}": "${picked.script}" to ${where}.`);

    return true;
};
