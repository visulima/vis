import { describe, expect, it } from "vitest";

import nodeExecute from "../../../src/commands/node/handler";

describe("vis node", () => {
    it("passes its arguments to node and exits with node's status", async () => {
        expect.assertions(1);

        process.exitCode = undefined;

        await nodeExecute({ argument: ["-e", "process.exit(5)"], rawUnknown: [] } as never);

        expect(process.exitCode).toBe(5);

        process.exitCode = undefined;
    });
});
