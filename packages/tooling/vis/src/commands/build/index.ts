import type { InferOptions } from "@visulima/cerebro";
import { defineCommand } from "@visulima/cerebro";

import { runOptionDefinitions } from "../run";

const build = defineCommand({
    argument: {
        description: "Extra arguments forwarded to the build target",
        name: "args",
        type: String,
    },
    description: "Run the production build: the package's build script, or the inferred Vite, Rsbuild, Rslib, or Rspack build",
    examples: [
        ["vis build", "Run the build target across the workspace"],
        ["vis build --filter @org/web", "Build only one package"],
        ["vis build -- --mode production", "Forward flags after -- to the build target"],
    ],
    group: "Run & Execute",
    loader: () => import("./handler"),
    name: "build",
    options: runOptionDefinitions,
});

export default build;

export type BuildOptions = InferOptions<typeof runOptionDefinitions>;
