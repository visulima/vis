import type { Command, Toolbox } from "@visulima/cerebro";
import completionCommand from "@visulima/cerebro/command/completion";

import { VisUserError } from "../../errors/vis-user-error";

const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

type Shell = (typeof SHELLS)[number];

const readEnv = (env: Record<string, string | undefined>, name: string, camelName: string): string | undefined => env[name] ?? env[camelName];

const detectShell = (env: Record<string, string | undefined>): Shell | undefined => {
    const shellPath = readEnv(env, "STARSHIP_SHELL", "starshipShell") ?? readEnv(env, "SHELL", "shell");

    if (shellPath) {
        const lower = shellPath.toLowerCase();

        return SHELLS.find((shell) => shell !== "powershell" && lower.includes(shell));
    }

    if (readEnv(env, "PSModulePath", "psModulePath") || readEnv(env, "PROMPT", "prompt")?.includes("PS")) {
        return "powershell";
    }

    return readEnv(env, "ComSpec", "comSpec")?.toLowerCase().includes("cmd.exe") ? "bash" : undefined;
};

/**
 * The generated scripts call back into `&lt;executable> complete -- &lt;words>` on every &lt;TAB>.
 * cerebro's own command passes `node vis` as that executable, which is not a command a
 * shell can run once the script is sourced, so this one passes the bare `vis` that the
 * installed bin (the native binary) answers.
 */
const execute = async ({ env, logger, options, runtime }: Toolbox): Promise<void> => {
    const cliName = runtime.getCliName();
    const shell = (options as { shell?: string }).shell ?? detectShell(env as Record<string, string | undefined>);

    if (!shell) {
        logger.error("Could not detect current shell");
        logger.info(`Usage: ${cliName} completion --shell=<${SHELLS.join("|")}>`);

        return;
    }

    if (!SHELLS.includes(shell as Shell)) {
        throw new VisUserError(`Invalid shell type: ${shell}. Valid shells are: ${SHELLS.join(", ")}`);
    }

    const { default: tab } = await import("@bomb.sh/tab");

    tab.setup(cliName, cliName, shell);
};

// Everything but `execute` (name, options, env, description) is cerebro's, so `vis completion --help` is unchanged.
const completion: Command = { ...completionCommand, execute };

export default completion;
