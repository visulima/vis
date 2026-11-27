import { describe, expect, it } from "vitest";

import { describeUnauditable } from "../../src/security/unauditable";

describe(describeUnauditable, () => {
    it("says how many vendored packages have no version, and where they are", () => {
        expect.assertions(2);

        expect(describeUnauditable({ count: 126, host: "next@16.3.8", kind: "vendored", location: "dist/compiled" })).toBe("next@16.3.8 vendors 126 packages without versions (dist/compiled)");
        expect(describeUnauditable({ count: 1, host: "x@1.0.0", kind: "vendored", location: "compiled" })).toBe("x@1.0.0 vendors 1 package without versions (compiled)");
    });

    it("names the bundled packages whose manifest cannot be read", () => {
        expect.assertions(1);

        expect(describeUnauditable({ count: 2, host: "npm@11.0.0", kind: "bundled-unreadable", location: "node_modules", names: ["a", "b"] })).toBe("npm@11.0.0 bundles 2 packages whose manifest cannot be read (a, b)");
    });
});
