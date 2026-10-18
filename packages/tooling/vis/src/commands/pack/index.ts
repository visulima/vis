import type { InferOptions } from "@visulima/cerebro";
import { defineCommand } from "@visulima/cerebro";

import { runOptionDefinitions } from "../run";

const pack = defineCommand({
    argument: {
        description: "Extra arguments forwarded to the pack target",
        name: "args",
        type: String,
    },
    description: "Build a library for publishing: the package's pack script, or the inferred Rslib or packem build",
    examples: [
        ["vis pack", "Build every library that has a pack target"],
        ["vis pack --filter @org/utils", "Build one package"],
        ["vis pack -- --sourcemap", "Forward flags after -- to the pack target"],
    ],
    group: "Run & Execute",
    loader: () => import("./handler"),
    name: "pack",
    options: runOptionDefinitions,
});

export default pack;

export type PackOptions = InferOptions<typeof runOptionDefinitions>;
