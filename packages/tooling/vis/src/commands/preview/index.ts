import type { InferOptions } from "@visulima/cerebro";
import { defineCommand } from "@visulima/cerebro";

import { runOptionDefinitions } from "../run";

const preview = defineCommand({
    argument: {
        description: "Extra arguments forwarded to the preview target",
        name: "args",
        type: String,
    },
    description: "Serve the production build: the package's preview script, or the inferred Vite, Rsbuild, or Rspack preview",
    examples: [
        ["vis preview", "Serve the built output across the workspace"],
        ["vis preview --filter @org/web", "Serve one package's build output"],
        ["vis preview -- --port 4173", "Forward flags after -- to the preview target"],
    ],
    group: "Run & Execute",
    loader: () => import("./handler"),
    name: "preview",
    options: runOptionDefinitions,
});

export default preview;

export type PreviewOptions = InferOptions<typeof runOptionDefinitions>;
