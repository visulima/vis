import type { InferOptions } from "@visulima/cerebro";
import { defineCommand } from "@visulima/cerebro";

const testOptionDefinitions = {
    watch: {
        defaultValue: false,
        description: "Keep Vitest running and re-run tests on change (Vitest's default watch mode)",
        type: Boolean,
    },
} as const;

const test = defineCommand({
    argument: {
        description: "Test file paths or filters, forwarded to Vitest",
        name: "files",
        type: String,
    },
    description: "Run the workspace tests with Vitest, no test script required",
    examples: [
        ["vis test", "Run all tests once with Vitest"],
        ["vis test --watch", "Re-run tests on change"],
        ["vis test src/foo.test.ts", "Run a single test file"],
        ["vis test -- --reporter=dot", "Forward flags after -- to Vitest"],
    ],
    group: "Run & Execute",
    loader: () => import("./handler"),
    name: "test",
    options: testOptionDefinitions,
});

export default test;

export type TestOptions = InferOptions<typeof testOptionDefinitions>;
