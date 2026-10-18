import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import type { TargetToolChoice, TargetToolDeps } from "../../util/target-tool";
import { offerTargetTool } from "../../util/target-tool";
import runExecute from "../run/handler";
import type { PackOptions } from "./index";

/** Library builders vis can set up when no project defines a `pack` target. */
export const PACK_CHOICES: ReadonlyArray<TargetToolChoice> = [
    {
        files: [
            {
                contents: "import { defineConfig } from \"@rslib/core\";\n\nexport default defineConfig({ lib: [{ format: \"esm\" }] });\n",
                file: "rslib.config.mts",
            },
            { contents: "export {};\n", file: "src/index.ts" },
        ],
        label: "Rslib",
        packages: ["@rslib/core", "typescript"],
        script: "rslib build",
    },
    {
        files: [
            {
                contents: "import { defineConfig } from \"@visulima/packem/config\";\nimport transformer from \"@visulima/packem/transformer/esbuild\";\n\nexport default defineConfig({ emitESM: true, entries: [\"src/index.ts\"], runtime: \"node\", transformer });\n",
                file: "packem.config.ts",
            },
            { contents: "export {};\n", file: "src/index.ts" },
        ],
        label: "packem",
        packages: ["@visulima/packem", "esbuild", "typescript"],
        script: "packem build",
    },
];

/** Offers a library builder when none is configured, then runs the `pack` target like `vis run pack`. */
export const runPack = async (toolbox: Toolbox<Console, PackOptions>, deps: TargetToolDeps = {}): Promise<void> => {
    const { argument, fs, logger, options, rawUnknown, visConfig, workspaceRoot } = toolbox;
    const ready = await offerTargetTool(
        { choices: PACK_CHOICES, filter: options.filter, fs, logger, target: "pack", visConfig, workspaceRoot: workspaceRoot ?? process.cwd() },
        deps,
    );

    if (!ready) {
        return;
    }

    await runExecute({ ...toolbox, argument: ["pack", ...(argument ?? []), ...(rawUnknown ?? [])], rawUnknown });
};

const execute = (toolbox: Toolbox<Console, PackOptions>): Promise<void> => runPack(toolbox);

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
