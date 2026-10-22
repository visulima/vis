import { defineCommand } from "@visulima/cerebro";

const rebuild = defineCommand({
    description: "Rebuild native dependencies through the detected package manager",
    examples: [
        ["vis rebuild", "Rebuild native dependencies in the current workspace"],
    ],
    group: "Dependencies",
    loader: () => import("./handler"),
    name: "rebuild",
});

export default rebuild;
