import { describe, expect, it } from "vitest";

import { resolveWorkspaceRefs } from "../../../src/release/core/version-actions/npm";
import type { PackageManifest } from "../../../src/release/types";

const versioned = new Map<string, PackageManifest>([["@scope/a", { name: "@scope/a", version: "1.0.0-alpha.77" }]]);
const manifest: PackageManifest = {
    dependencies: { "@scope/a": "workspace:^1.0.0-alpha.76" },
    name: "@scope/b",
    peerDependencies: { "@scope/a": "workspace:>=1.0.0-alpha.76 <2.0.0-0" },
    version: "1.0.0",
};

describe(resolveWorkspaceRefs, () => {
    it("publishes a satisfied workspace: range without its prefix under preserve-satisfying", () => {
        expect.hasAssertions();

        const resolved = resolveWorkspaceRefs(manifest, versioned, "preserve-satisfying");

        expect(resolved.peerDependencies).toStrictEqual({ "@scope/a": ">=1.0.0-alpha.76 <2.0.0-0" });
        expect(resolved.dependencies).toStrictEqual({ "@scope/a": "^1.0.0-alpha.77" });
    });

    it("rewrites the range to the new version by default", () => {
        expect.hasAssertions();

        expect(resolveWorkspaceRefs(manifest, versioned, undefined).peerDependencies).toStrictEqual({ "@scope/a": ">=1.0.0-alpha.77" });
    });
});
