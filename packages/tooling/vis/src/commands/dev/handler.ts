import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import runExecute from "../run/handler";
import type { DevOptions } from "./index";

/** `vis dev` is `vis run dev`: the target goes first, then the forwarded arguments. */
const execute = async ({ argument, rawUnknown, ...toolbox }: Toolbox<Console, DevOptions>): Promise<void> => {
    await runExecute({ ...toolbox, argument: ["dev", ...(argument ?? []), ...(rawUnknown ?? [])], rawUnknown });
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
