import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import { scopedTarget } from "../../util/target-tool";
import runExecute from "../run/handler";
import type { PreviewOptions } from "./index";

/** `vis preview` is `vis run preview`. Unlike `dev` and `build`, it offers no tool: a preview needs a build first. */
const execute = async ({ argument, options, rawUnknown, workspaceRoot, ...toolbox }: Toolbox<Console, PreviewOptions>): Promise<void> => {
    const target = scopedTarget("preview", options, process.cwd(), workspaceRoot ?? process.cwd());

    await runExecute({ ...toolbox, argument: [target, ...(argument ?? []), ...(rawUnknown ?? [])], options, rawUnknown, workspaceRoot });
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
