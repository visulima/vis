import { defineConfig } from "vitest/config";

// Runs `concurrent-throughput.script.ts` only. `pnpm bench:concurrent` is the way in.
export default defineConfig({
    test: {
        environment: "node",
        include: ["__bench__/concurrent-throughput.script.ts"],
        testTimeout: 30 * 60_000,
    },
});
