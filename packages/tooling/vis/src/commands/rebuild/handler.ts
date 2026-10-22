import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import { VisUserError } from "../../errors/vis-user-error";
import { dispatchSubcommand } from "../../pm/pm-subcommand-dispatch";
import { resolveCommandRuntime, runtimeInstallerBackend } from "../../runtime/command-runtime";

const execute = async ({ logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox): Promise<void> => {
    const cwd = wsRoot ?? process.cwd();
    const runtime = resolveCommandRuntime({ options, visConfig }, cwd);

    // Loaded here, not at module top: pm-runner pulls in the native binding.
    const { resolveInstaller, runPmSubcommand } = await import("../../pm/pm-runner");
    const pm = resolveInstaller(cwd, {
        backend: runtimeInstallerBackend(runtime),
        configBackend: visConfig?.install?.backend,
        configCorepack: visConfig?.install?.corepack,
    });

    // Some package managers have no `rebuild`. Surface that as an error rather than
    // letting the run exit 0 after rebuilding nothing.
    const action = dispatchSubcommand(pm, "rebuild", []);

    if (action.kind === "skip") {
        throw new VisUserError(action.warning);
    }

    const code = runPmSubcommand(pm, "rebuild", [], cwd, logger);

    if (code !== 0) {
        process.exitCode = code;
    }
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
