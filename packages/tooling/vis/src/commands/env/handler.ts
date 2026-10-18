import type { CommandExecute, Toolbox } from "@visulima/cerebro";

/** Read-only report of what vis sees from this directory: nothing is installed or changed. */
const execute = async ({ logger, workspaceRoot }: Toolbox): Promise<void> => {
    // Loaded here, not at module top: pm-runner pulls in the native binding.
    const { detectPm } = await import("../../pm/pm-runner");
    const cwd = process.cwd();
    const pm = detectPm(cwd);

    logger.info(`node        ${process.version} (${process.platform} ${process.arch})`);
    logger.info(`directory   ${cwd}`);
    logger.info(`workspace   ${workspaceRoot ?? "not found from this directory"}`);
    logger.info(`pm          ${pm.name}${pm.version ? ` ${pm.version}` : ""}`);
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
