import { describe, expect, it } from "vitest";

import { diffHashDetails } from "../src/report/run-summary-utils";

describe(diffHashDetails, () => {
    it("reports a changed command within the same hash layout", () => {
        expect.assertions(1);

        const diff = diffHashDetails({ command: "b", layout: 2, nodes: {} }, { command: "a", layout: 2, nodes: {} });

        expect(diff.commandChanged).toBe(true);
    });

    it("does not report a changed command across hash layouts", () => {
        expect.assertions(1);

        const diff = diffHashDetails({ command: "b", layout: 2, nodes: {} }, { command: "a", nodes: {} });

        expect(diff.commandChanged).toBe(false);
    });
});
