import { spawnSync } from "node:child_process";

import type { CommandExecute, Toolbox } from "@visulima/cerebro";

/** Runs the node binary that is running vis, so the same version applies, and exits with its status. */
const execute = async ({ argument, rawUnknown }: Toolbox): Promise<void> => {
    const result = spawnSync(process.execPath, [...(argument ?? []), ...(rawUnknown ?? [])], { cwd: process.cwd(), stdio: "inherit" });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
    }
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
