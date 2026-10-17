/**
 * Pick one of several tools for a command that needs one and finds none.
 *
 * The choice is the consent: the question says what will be installed. Outside
 * an interactive terminal nothing is chosen for the user; the caller gets an
 * error that lists every option.
 */

import { spawnSync } from "node:child_process";

import { VisUserError } from "../errors/vis-user-error";
import { isInteractive as isInteractiveTerminal } from "./interactive";
import { defaultReadline } from "./prompt";

export interface ToolChoice {
    /** What picking this option does, e.g. the install command. */
    hint: string;
    /** Shown in the list, e.g. "Vitest". */
    label: string;
    /** Returned to the caller when this option is picked. */
    value: string;
}

export interface ChooseToolDeps {
    /** Override the interactivity check. */
    isInteractive?: () => boolean;
    /** Override the line reader. */
    readline?: (question: string) => Promise<string>;
}

/** Installs `packageName` as a devDependency in `cwd`. Returns the process exit code. */
export type Installer = (packageName: string, cwd: string) => number;

/**
 * Ask the user to pick one option. Returns the chosen option, or `undefined` when
 * the user cancels (empty input, `q`, or a number out of range). Throws outside an
 * interactive terminal, listing every option, so a CI run fails instead of guessing.
 */
export const chooseTool = async (question: string, choices: ReadonlyArray<ToolChoice>, deps: ChooseToolDeps = {}): Promise<ToolChoice | undefined> => {
    const interactive = deps.isInteractive ?? isInteractiveTerminal;

    if (!interactive()) {
        const options = choices.map((choice) => `  ${choice.label}: ${choice.hint}`).join("\n");

        throw new VisUserError(`${question}\n${options}\nRun this in an interactive terminal to pick one.`);
    }

    const readline = deps.readline ?? defaultReadline;
    const list = choices.map((choice, index) => `  ${String(index + 1)}) ${choice.label}  (${choice.hint})`).join("\n");
    const response = await readline(`${question}\n${list}\nEnter a number, or press Enter to cancel: `);
    const answer = response.trim().toLowerCase();

    if (answer === "" || answer === "q") {
        return undefined;
    }

    const index = Number(answer) - 1;

    if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
        return undefined;
    }

    return choices[index];
};

/**
 * Install `packageName` with `vis add -D`, so workspace root handling, catalogs,
 * and supply-chain checks apply. Runs vis as a subprocess, the same way the run
 * services do. Returns the exit code, and never runs a tool after a failed install.
 */
export const installDevDependency = (packageName: string, cwd: string, logger: Pick<Console, "info">, install: Installer = spawnVisAdd): number => {
    logger.info(`Installing ${packageName} as a devDependency with \`vis add -D\`.`);

    return install(packageName, cwd);
};

const spawnVisAdd: Installer = (packageName, cwd) => {
    const result = spawnSync(process.execPath, [process.argv[1]!, "add", "-D", packageName], { cwd, stdio: "inherit" });

    if (result.error) {
        throw result.error;
    }

    return result.status ?? 1;
};
