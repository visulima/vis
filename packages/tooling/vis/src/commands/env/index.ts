import { defineCommand } from "@visulima/cerebro";

const env = defineCommand({
    description: "Print the Node, platform, package manager, and workspace that vis would use here",
    examples: [["vis env", "Show the environment vis sees from this directory"]],
    group: "System",
    loader: () => import("./handler"),
    name: "env",
});

export default env;
