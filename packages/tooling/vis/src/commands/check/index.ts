import type { InferOptions } from "@visulima/cerebro";
import { defineCommand } from "@visulima/cerebro";

const checkOptionDefinitions = {
    fix: {
        defaultValue: false,
        description: "Apply lint fixes and formatting in place instead of only reporting",
        type: Boolean,
    },
    since: {
        description: "Only check files changed vs the given git ref (branch, tag, sha)",
        type: String,
    },
    staged: {
        defaultValue: false,
        description: "Only check files currently staged in the git index",
        type: Boolean,
    },
} as const;

const check = defineCommand({
    argument: {
        description: "Files to check (checks the whole workspace if omitted)",
        name: "files",
        type: String,
    },
    description: "Run every lint, format, and type check across the workspace",
    examples: [
        ["vis check", "Lint, check formatting, and type-check the workspace"],
        ["vis check --fix", "Apply lint fixes and formatting in place"],
        ["vis check src/foo.ts", "Check a specific file"],
        ["vis check --staged", "Only check files staged in the git index"],
        ["vis check --since main", "Only check files changed vs the main branch"],
    ],
    group: "Lint & Format",
    loader: () => import("./handler"),
    name: "check",
    options: checkOptionDefinitions,
});

export default check;

export type CheckOptions = InferOptions<typeof checkOptionDefinitions>;
