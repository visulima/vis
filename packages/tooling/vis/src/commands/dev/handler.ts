import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import type { TargetToolChoice, TargetToolDeps } from "../../util/target-tool";
import { offerTargetTool } from "../../util/target-tool";
import runExecute from "../run/handler";
import type { DevOptions } from "./index";

/** Dev servers vis can set up when no project defines a `dev` target. Rslib has no dev server. */
export const DEV_CHOICES: ReadonlyArray<TargetToolChoice> = [
    {
        files: [{ contents: "import { defineConfig } from \"vite\";\n\nexport default defineConfig({});\n", file: "vite.config.mts" }, { contents: "<!doctype html>\n<html>\n  <head>\n    <meta charset=\"UTF-8\" />\n    <title>App</title>\n  </head>\n  <body></body>\n</html>\n", file: "index.html" }],
        label: "Vite",
        packages: ["vite"],
        script: "vite",
    },
    {
        files: [{ contents: "import { defineConfig } from \"@rsbuild/core\";\n\nexport default defineConfig({});\n", file: "rsbuild.config.mts" }, { contents: "export {};\n", file: "src/index.ts" }],
        label: "Rsbuild",
        packages: ["@rsbuild/core"],
        script: "rsbuild dev",
    },
    {
        files: [{ contents: "export default {};\n", file: "rspack.config.mjs" }, { contents: "export {};\n", file: "src/index.js" }],
        label: "Rspack",
        packages: ["@rspack/cli", "@rspack/core", "@rspack/dev-server"],
        script: "rspack serve",
    },
];

/** Offers a dev server when none is configured, then runs the `dev` target like `vis run dev`. */
export const runDev = async (toolbox: Toolbox<Console, DevOptions>, deps: TargetToolDeps = {}): Promise<void> => {
    const { argument, fs, logger, options, rawUnknown, visConfig, workspaceRoot } = toolbox;
    const ready = await offerTargetTool(
        { choices: DEV_CHOICES, filter: options.filter, fs, logger, target: "dev", visConfig, workspaceRoot: workspaceRoot ?? process.cwd() },
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
