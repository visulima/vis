import { describe, expect, it } from "vitest";

import { applyReleasePlan, prependChangelog, rewriteRangeForVersion, updateRangeForVersion } from "../../../src/release/core/apply-release-plan";
import { DependencyGraph } from "../../../src/release/core/dep-graph";
import type { PlannedRelease, ReleasePlan, WorkspacePackage } from "../../../src/release/types";

const mkPkg = (name: string, version = "1.0.0", deps: Record<string, string> = {}): WorkspacePackage => {
    return {
        dir: `/repo/packages/${name}`,
        manifest: { dependencies: Object.keys(deps).length > 0 ? deps : undefined, name, version },
        manifestPath: `/repo/packages/${name}/package.json`,
        name,
        private: false,
        version,
    };
};

const mkRelease = (name: string, oldV: string, newV: string, type: PlannedRelease["type"] = "minor"): PlannedRelease => {
    return {
        changeFiles: [],
        isCascadeBump: false,
        isDependencyBump: false,
        isGroupBump: false,
        name,
        newVersion: newV,
        oldVersion: oldV,
        reasons: ["EXPLICIT"],
        sources: [],
        type,
    };
};

describe("rewriteRangeForVersion — preserves protocol prefixes (RFC §11.1)", () => {
    it("preserves workspace:^ prefix", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("workspace:^1.0.0", "2.0.0")).toBe("workspace:^2.0.0");
    });

    it("preserves workspace:~ prefix", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("workspace:~1.0.0", "2.0.0")).toBe("workspace:~2.0.0");
    });

    it("preserves workspace:* shorthand", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("workspace:*", "2.0.0")).toBe("workspace:*");
    });

    it("preserves workspace:^ shorthand", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("workspace:^", "2.0.0")).toBe("workspace:^");
    });

    it("preserves workspace:~ shorthand", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("workspace:~", "2.0.0")).toBe("workspace:~");
    });

    it("preserves catalog: refs (catalog updates flow elsewhere)", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("catalog:dev", "2.0.0")).toBe("catalog:dev");
        expect(rewriteRangeForVersion("catalog:", "2.0.0")).toBe("catalog:");
    });

    it("rewrites plain ^ ranges", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("^1.0.0", "2.0.0")).toBe("^2.0.0");
    });

    it("rewrites plain ~ ranges", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("~1.0.0", "2.0.0")).toBe("~2.0.0");
    });

    it("preserves >= and other operators", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion(">=1.0.0", "2.0.0")).toBe(">=2.0.0");
    });

    it("defaults to ^ when no prefix is present", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("1.0.0", "2.0.0")).toBe("^2.0.0");
    });

    it("rewrites npm: alias inner spec", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("npm:other-pkg@^1.0.0", "2.0.0")).toBe("npm:other-pkg@^2.0.0");
    });

    it("preserves * as-is", () => {
        expect.hasAssertions();
        expect(rewriteRangeForVersion("*", "2.0.0")).toBe("*");
    });
});

describe("updateRangeForVersion — preserve-satisfying", () => {
    const keep = (range: string, version: string): string => updateRangeForVersion(range, version, "preserve-satisfying", { depName: "@scope/a" });

    it("leaves a bounded range the new version satisfies untouched", () => {
        expect.hasAssertions();
        expect(keep(">=1.0.0-alpha.76 <2.0.0-0", "1.0.0-alpha.253")).toBe(">=1.0.0-alpha.76 <2.0.0-0");
        expect(keep(">=1.0.0-alpha.76 <2.0.0-0", "1.0.0")).toBe(">=1.0.0-alpha.76 <2.0.0-0");
    });

    it("raises the floor of an outgrown range and keeps its ceiling", () => {
        expect.hasAssertions();
        // npm scopes prerelease matching to the floor's [major, minor, patch] tuple.
        expect(keep(">=1.0.0-alpha.76 <2.0.0-0", "1.0.1-alpha.0")).toBe(">=1.0.1-alpha.0 <2.0.0-0");
    });

    it("refuses a version past the ceiling", () => {
        expect.hasAssertions();
        expect(() => keep(">=1.0.0-alpha.76 <2.0.0-0", "2.0.0-alpha.0")).toThrow(
            expect.objectContaining({ code: "DEPENDENCY_RANGE_EXCEEDED", message: expect.stringContaining("@scope/a@2.0.0-alpha.0") }),
        );
        expect(() => keep(">=1.0.0 <2.0.0", "2.0.0")).toThrow(/outside ">=1\.0\.0 <2\.0\.0"/);
    });

    it("bumps exact pins and caret/tilde specs as `rewrite` does", () => {
        expect.hasAssertions();
        expect(keep("1.0.0-alpha.3", "1.0.0-alpha.4")).toBe("^1.0.0-alpha.4");
        expect(keep("^1.0.0", "1.1.0")).toBe("^1.1.0");
        expect(keep("~1.0.0", "1.0.1")).toBe("~1.0.1");
        expect(keep("^1.0.0", "2.0.0")).toBe("^2.0.0");
    });

    it("keeps the workspace: and npm: prefixes", () => {
        expect.hasAssertions();
        expect(keep("workspace:>=1.0.0 <2.0.0", "1.5.0")).toBe("workspace:>=1.0.0 <2.0.0");
        expect(keep("workspace:>=1.0.0-alpha.1 <2.0.0-0", "1.0.1-alpha.0")).toBe("workspace:>=1.0.1-alpha.0 <2.0.0-0");
        expect(keep("workspace:^1.0.0", "1.1.0")).toBe("workspace:^1.1.0");
        expect(keep("workspace:*", "1.1.0")).toBe("workspace:*");
        expect(keep("npm:other@>=1.0.0-alpha.1 <2.0.0-0", "1.0.1-alpha.0")).toBe("npm:other@>=1.0.1-alpha.0 <2.0.0-0");
    });

    it("handles `||` ranges: keeps a satisfied one, re-floors only the alternative that can admit the version", () => {
        expect.hasAssertions();
        expect(keep("^1.0.0 || ^2.0.0", "2.3.0")).toBe("^1.0.0 || ^2.0.0");
        expect(keep("^1.0.0 || >=2.0.0-alpha.0 <3.0.0-0", "2.0.1-alpha.0")).toBe("^1.0.0 || >=2.0.1-alpha.0 <3.0.0-0");
        expect(() => keep("^1.0.0 || ^2.0.0", "3.0.0")).toThrow(/outside/);
    });

    it("rewrites everything under the default mode", () => {
        expect.hasAssertions();
        expect(updateRangeForVersion(">=1.0.0-alpha.76 <2.0.0-0", "1.0.0-alpha.253")).toBe(">=1.0.0-alpha.253");
    });
});

describe("prependChangelog — handles 3 RFC §17.4 cases", () => {
    it("inserts after `# Title` when present (bumpy/changesets convention)", () => {
        expect.hasAssertions();

        const existing = `# Changelog\n\n## 1.0.0\n\nold entry\n`;
        const result = prependChangelog("## 1.1.0\n<sub>2026-05-02</sub>\n\n- new", existing);

        expect(result.startsWith("# Changelog\n")).toBe(true);
        expect(result.indexOf("## 1.1.0")).toBeLessThan(result.indexOf("## 1.0.0"));
    });

    it("inserts at top when file starts with `##` (semantic-release convention)", () => {
        expect.hasAssertions();

        const existing = `## @scope/pkg [1.0.0](compare) (2026-04-01)\n\n### Bug Fixes\n\n* old\n`;
        const result = prependChangelog("## 1.1.0\n<sub>2026-05-02</sub>\n\n- new", existing);

        expect(result.startsWith("## 1.1.0")).toBe(true);
        expect(result).toContain("## @scope/pkg [1.0.0]");
    });

    it("creates `# Changelog` header when file is empty/missing", () => {
        expect.hasAssertions();

        const result = prependChangelog("## 1.0.0\n<sub>2026-05-02</sub>\n\n- first", undefined);

        expect(result.startsWith("# Changelog\n")).toBe(true);
        expect(result).toContain("## 1.0.0");
    });

    it("creates header for empty-string file", () => {
        expect.hasAssertions();

        const result = prependChangelog("## 1.0.0\n<sub>2026-05-02</sub>", "");

        expect(result.startsWith("# Changelog")).toBe(true);
    });
});

describe("applyReleasePlan — produces structured AppliedPlan", () => {
    it("emits writes for each released package's manifest + changelog", async () => {
        expect.hasAssertions();

        const a = mkPkg("a", "1.0.0");
        const graph = new DependencyGraph([a]);

        const plan: ReleasePlan = {
            consumedChangeFiles: [],
            releases: [mkRelease("a", "1.0.0", "1.1.0")],
            warnings: [],
        };

        const applied = await applyReleasePlan(plan, graph);

        // Two writes per release: package.json + CHANGELOG.md
        expect(applied.writes).toHaveLength(2);
        expect(applied.writes[0]?.path).toBe(a.manifestPath);
        expect(applied.writes[1]?.path).toBe("/repo/packages/a/CHANGELOG.md");
        expect(applied.writes[0]?.content).toContain("\"version\": \"1.1.0\"");
    });

    it("rewrites internal-dep ranges in dependent's manifest", async () => {
        expect.hasAssertions();

        const a = mkPkg("a", "1.0.0");
        const b = mkPkg("b", "2.0.0", { a: "^1.0.0" });
        const graph = new DependencyGraph([a, b]);

        const plan: ReleasePlan = {
            consumedChangeFiles: [],
            releases: [mkRelease("a", "1.0.0", "1.1.0"), mkRelease("b", "2.0.0", "2.0.1", "patch")],
            warnings: [],
        };

        const applied = await applyReleasePlan(plan, graph);

        const bManifestWrite = applied.writes.find((w) => w.path === b.manifestPath);

        expect(bManifestWrite).toBeDefined();
        expect(bManifestWrite?.content).toContain("\"a\": \"^1.1.0\"");
    });

    it("preserves workspace: prefix when rewriting", async () => {
        expect.hasAssertions();

        const a = mkPkg("a", "1.0.0");
        const b = mkPkg("b", "2.0.0", { a: "workspace:^1.0.0" });
        const graph = new DependencyGraph([a, b]);

        const plan: ReleasePlan = {
            consumedChangeFiles: [],
            releases: [mkRelease("a", "1.0.0", "1.1.0"), mkRelease("b", "2.0.0", "2.0.1", "patch")],
            warnings: [],
        };

        const applied = await applyReleasePlan(plan, graph);
        const bManifestWrite = applied.writes.find((w) => w.path === b.manifestPath);

        expect(bManifestWrite?.content).toContain("\"a\": \"workspace:^1.1.0\"");
    });

    it("preserve-satisfying keeps satisfied ranges across every dependency field", async () => {
        expect.hasAssertions();

        const a = mkPkg("a", "1.0.0-alpha.76");
        const b: WorkspacePackage = {
            ...mkPkg("b", "1.0.0-alpha.10"),
            manifest: {
                dependencies: { a: ">=1.0.0-alpha.51 <2.0.0-0" },
                devDependencies: { a: "1.0.0-alpha.76" },
                name: "b",
                optionalDependencies: { a: "^1.0.0-alpha.76" },
                peerDependencies: { a: ">=1.0.0-alpha.76 <2.0.0-0" },
                version: "1.0.0-alpha.10",
            },
        };
        const graph = new DependencyGraph([a, b]);
        const plan: ReleasePlan = {
            consumedChangeFiles: [],
            releases: [mkRelease("a", "1.0.0-alpha.76", "1.0.0-alpha.77"), mkRelease("b", "1.0.0-alpha.10", "1.0.0-alpha.11", "patch")],
            warnings: [],
        };

        const applied = await applyReleasePlan(plan, graph, { internalDependencyRanges: "preserve-satisfying" });
        const manifest = JSON.parse(applied.writes.find((w) => w.path === b.manifestPath)?.content ?? "{}");

        expect(manifest.dependencies).toStrictEqual({ a: ">=1.0.0-alpha.51 <2.0.0-0" });
        expect(manifest.peerDependencies).toStrictEqual({ a: ">=1.0.0-alpha.76 <2.0.0-0" });
        expect(manifest.devDependencies).toStrictEqual({ a: "^1.0.0-alpha.77" });
        expect(manifest.optionalDependencies).toStrictEqual({ a: "^1.0.0-alpha.77" });
    });

    it("preserve-satisfying fails before producing any write when a ceiling is exceeded", async () => {
        expect.hasAssertions();

        const a = mkPkg("a", "1.5.0");
        const b = mkPkg("b", "1.0.0", { a: ">=1.0.0 <2.0.0" });
        const graph = new DependencyGraph([a, b]);
        const plan: ReleasePlan = {
            consumedChangeFiles: [],
            releases: [mkRelease("a", "1.5.0", "2.0.0", "major"), mkRelease("b", "1.0.0", "1.0.1", "patch")],
            warnings: [],
        };

        await expect(applyReleasePlan(plan, graph, { internalDependencyRanges: "preserve-satisfying" })).rejects.toThrow(
            expect.objectContaining({ code: "DEPENDENCY_RANGE_EXCEEDED", packageName: "b" }),
        );
    });

    it("propagates change-file deletions into the deletions list", async () => {
        expect.hasAssertions();

        const a = mkPkg("a", "1.0.0");
        const graph = new DependencyGraph([a]);

        const plan: ReleasePlan = {
            consumedChangeFiles: [{ body: "", id: "abc", path: ".vis/release/abc.md", payload: { bumps: { a: "minor" } } }],
            releases: [mkRelease("a", "1.0.0", "1.1.0")],
            warnings: [],
        };

        const applied = await applyReleasePlan(plan, graph);

        expect(applied.deletions).toStrictEqual([".vis/release/abc.md"]);
    });
});
