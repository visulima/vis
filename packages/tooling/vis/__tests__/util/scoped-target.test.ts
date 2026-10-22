import { describe, expect, it } from "vitest";

import { scopedTarget } from "../../src/util/target-tool";

describe(scopedTarget, () => {
    it("selects the package's target when run from inside a package", () => {
        expect.assertions(1);

        expect(scopedTarget("pack", {}, "/repo/packages/lib", "/repo")).toBe("~:pack");
    });

    it("selects the target across the workspace when run from the root", () => {
        expect.assertions(1);

        expect(scopedTarget("pack", {}, "/repo", "/repo")).toBe("pack");
    });

    it("keeps an explicit --filter or --projects selection as given", () => {
        expect.assertions(2);

        expect(scopedTarget("dev", { filter: ["@org/web"] }, "/repo/packages/lib", "/repo")).toBe("dev");
        expect(scopedTarget("dev", { projects: "web" }, "/repo/packages/lib", "/repo")).toBe("dev");
    });
});
