import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import runExecute from "../run/handler";
import type { PreviewOptions } from "./index";

/** `vis preview` is `vis run preview`. Unlike `dev` and `build`, it offers no tool: a preview needs a build first. */
const execute = async ({ argument, rawUnknown, ...toolbox }: Toolbox<Console, PreviewOptions>): Promise<void> => {
    await runExecute({ ...toolbox, argument: ["preview", ...(argument ?? []), ...(rawUnknown ?? [])], rawUnknown });
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
