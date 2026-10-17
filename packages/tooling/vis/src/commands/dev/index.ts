import type { InferOptions } from "@visulima/cerebro";
import { defineCommand } from "@visulima/cerebro";

import { runOptionDefinitions } from "../run";

const dev = defineCommand({
    argument: {
        description: "Extra arguments forwarded to the dev target",
        name: "args",
        type: String,
    },
    description: "Start the dev server: the package's dev script, or the inferred Vite, Rsbuild, Rslib, or Rspack dev server",
    examples: [
        ["vis dev", "Start the dev target across the workspace"],
        ["vis dev --filter @org/web", "Start only one package's dev target"],
        ["vis dev -- --port 3000", "Forward flags after -- to the dev target"],
    ],
    group: "Run & Execute",
    loader: () => import("./handler"),
    name: "dev",
    options: runOptionDefinitions,
});

export default dev;

export type DevOptions = InferOptions<typeof runOptionDefinitions>;
