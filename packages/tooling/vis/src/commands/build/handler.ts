import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import type { TargetToolChoice, TargetToolDeps } from "../../util/target-tool";
import { offerTargetTool } from "../../util/target-tool";
import runExecute from "../run/handler";
import type { BuildOptions } from "./index";

/** Bundlers vis can set up when no project defines a `build` target. */
export const BUILD_CHOICES: ReadonlyArray<TargetToolChoice> = [
    { label: "Vite", packages: ["vite"], script: "vite build" },
    { label: "Rsbuild", packages: ["@rsbuild/core"], script: "rsbuild build" },
    { label: "Rslib", packages: ["@rslib/core"], script: "rslib build" },
    { label: "Rspack", packages: ["@rspack/cli", "@rspack/core"], script: "rspack build" },
];

/** Offers a bundler when none is configured, then runs the `build` target like `vis run build`. */
export const runBuild = async (toolbox: Toolbox<Console, BuildOptions>, deps: TargetToolDeps = {}): Promise<void> => {
    const { argument, fs, logger, rawUnknown, visConfig, workspaceRoot } = toolbox;
    const ready = await offerTargetTool(
        { choices: BUILD_CHOICES, cwd: process.cwd(), fs, logger, target: "build", visConfig, workspaceRoot: workspaceRoot ?? process.cwd() },
        deps,
    );

    if (!ready) {
        return;
    }

    await runExecute({ ...toolbox, argument: ["build", ...(argument ?? []), ...(rawUnknown ?? [])], rawUnknown });
};

const execute = (toolbox: Toolbox<Console, BuildOptions>): Promise<void> => runBuild(toolbox);

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
