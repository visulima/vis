import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import runExecute from "../run/handler";
import type { BuildOptions } from "./index";

/** `vis build` is `vis run build`: the target goes first, then the forwarded arguments. */
const execute = async ({ argument, rawUnknown, ...toolbox }: Toolbox<Console, BuildOptions>): Promise<void> => {
    await runExecute({ ...toolbox, argument: ["build", ...(argument ?? []), ...(rawUnknown ?? [])], rawUnknown });
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
