import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import type { TargetToolChoice, TargetToolDeps } from "../../util/target-tool";
import { offerTargetTool } from "../../util/target-tool";
import runExecute from "../run/handler";
import type { DevOptions } from "./index";

/** Dev servers vis can set up when no project defines a `dev` target. Rslib has no dev server. */
export const DEV_CHOICES: ReadonlyArray<TargetToolChoice> = [
    { label: "Vite", packages: ["vite"], script: "vite" },
    { label: "Rsbuild", packages: ["@rsbuild/core"], script: "rsbuild dev" },
    { label: "Rspack", packages: ["@rspack/cli", "@rspack/core", "@rspack/dev-server"], script: "rspack serve" },
];

/** Offers a dev server when none is configured, then runs the `dev` target like `vis run dev`. */
export const runDev = async (toolbox: Toolbox<Console, DevOptions>, deps: TargetToolDeps = {}): Promise<void> => {
    const { argument, fs, logger, rawUnknown, visConfig, workspaceRoot } = toolbox;
    const ready = await offerTargetTool(
        { choices: DEV_CHOICES, cwd: process.cwd(), fs, logger, target: "dev", visConfig, workspaceRoot: workspaceRoot ?? process.cwd() },
        deps,
    );

    if (!ready) {
        return;
    }

    await runExecute({ ...toolbox, argument: ["dev", ...(argument ?? []), ...(rawUnknown ?? [])], rawUnknown });
};

const execute = (toolbox: Toolbox<Console, DevOptions>): Promise<void> => runDev(toolbox);

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
