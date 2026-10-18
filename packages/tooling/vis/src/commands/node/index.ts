import { defineCommand } from "@visulima/cerebro";

const node = defineCommand({
    argument: {
        description: "Arguments passed to node (a script path, or flags such as -e)",
        name: "args",
        type: String,
    },
    description: "Run node in the current directory, with its arguments passed through",
    examples: [
        ["vis node script.mjs", "Run a script with the node that runs vis"],
        ["vis node -e \"console.log(process.version)\"", "Evaluate an expression"],
    ],
    group: "Run & Execute",
    loader: () => import("./handler"),
    name: "node",
});

export default node;
