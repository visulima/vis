import { describe, expect, it } from "vitest";

import { bumpVersion, cleanRange, satisfiesRange } from "../../../src/release/core/semver";

describe("semver: bumpVersion (RFC §10.1 channel-transition table)", () => {
    it("stable + minor + alpha → opens prerelease line at .0", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "minor", current: "1.2.3", prerelease: "alpha" })).toBe("1.3.0-alpha.0");
    });

    it("stable + patch + alpha → opens prerelease line at .0", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "patch", current: "1.2.3", prerelease: "alpha" })).toBe("1.2.4-alpha.0");
    });

    it("stable + major + alpha → opens prerelease line at .0", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "major", current: "1.2.3", prerelease: "alpha" })).toBe("2.0.0-alpha.0");
    });

    it("alpha + patch + alpha → counter increments", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "patch", current: "1.3.0-alpha.5", prerelease: "alpha" })).toBe("1.3.0-alpha.6");
    });

    it("alpha + none + beta → re-counter against new preid", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "none", current: "1.3.0-alpha.5", prerelease: "beta" })).toBe("1.3.0-beta.0");
    });

    it("beta + none + rc (next channel) → re-counter against rc", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "none", current: "1.3.0-beta.5", prerelease: "rc" })).toBe("1.3.0-rc.0");
    });

    it("rc + none + (no preid) → preid stripped, final stable", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "none", current: "1.3.0-rc.5" })).toBe("1.3.0");
    });

    it("alpha + none + (no preid) → direct merge to main", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "none", current: "1.3.0-alpha.5" })).toBe("1.3.0");
    });

    it("stable + patch (no preid) → straight semver bump", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "patch", current: "1.2.3" })).toBe("1.2.4");
    });

    it("stable + minor (no preid) → straight semver bump", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "minor", current: "1.2.3" })).toBe("1.3.0");
    });

    it("stable + major (no preid) → straight semver bump", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "major", current: "1.2.3" })).toBe("2.0.0");
    });

    it("stable + none + (no preid) → no change", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "none", current: "1.2.3" })).toBe("1.2.3");
    });

    it("escalates within same prerelease line: alpha minor on 1.3.0-alpha.5 + major", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "major", current: "1.3.0-alpha.5", prerelease: "alpha" })).toBe("2.0.0-alpha.0");
    });

    // lunora's channels: `alpha` → prerelease alpha, `main`/`next` → stable, `beta` → prerelease beta.
    it.each([
        ["patch", "1.0.0"],
        ["minor", "1.0.0"],
        ["major", "1.0.0"],
    ] as const)("alpha + %s + (no preid) → graduates to the base version", (bump, expected) => {
        expect.hasAssertions();
        expect(bumpVersion({ bump, current: "1.0.0-alpha.76" })).toBe(expected);
    });

    it.each([
        ["patch", "1.0.0-beta.0"],
        ["minor", "1.0.0-beta.0"],
        ["major", "1.0.0-beta.0"],
    ] as const)("alpha + %s + beta → keeps the base on the new preid", (bump, expected) => {
        expect.hasAssertions();
        expect(bumpVersion({ bump, current: "1.0.0-alpha.76", prerelease: "beta" })).toBe(expected);
    });

    it("beta + patch + (no preid) → graduates to the base version", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "patch", current: "1.3.0-beta.5" })).toBe("1.3.0");
    });

    it("alpha + major + alpha on a major-opened line → counter increments", () => {
        expect.hasAssertions();
        expect(bumpVersion({ bump: "major", current: "1.0.0-alpha.76", prerelease: "alpha" })).toBe("1.0.0-alpha.77");
    });

    it.each([
        ["1.3.0-rc.5", "major", undefined, "2.0.0"],
        ["1.0.1-alpha.3", "minor", undefined, "1.1.0"],
        ["1.3.0-alpha.5", "major", "beta", "2.0.0-beta.0"],
        ["1.2.1-alpha.3", "minor", "beta", "1.3.0-beta.0"],
    ] as const)("%s + %s + %s → bump exceeds the prerelease base", (current, bump, prerelease, expected) => {
        expect.hasAssertions();
        expect(bumpVersion({ bump, current, prerelease })).toBe(expected);
    });

    it("rejects invalid current version", () => {
        expect.hasAssertions();
        expect(() => bumpVersion({ bump: "minor", current: "not-a-version" })).toThrow(/Invalid current version/);
    });
});

describe("semver: cleanRange", () => {
    it("returns null for catalog: refs", () => {
        expect.hasAssertions();
        expect(cleanRange("catalog:")).toBeNull();
        expect(cleanRange("catalog:dev")).toBeNull();
    });

    it("returns null for workspace: shorthands", () => {
        expect.hasAssertions();
        expect(cleanRange("workspace:*")).toBeNull();
        expect(cleanRange("workspace:^")).toBeNull();
        expect(cleanRange("workspace:~")).toBeNull();
    });

    it("strips workspace: prefix from explicit ranges", () => {
        expect.hasAssertions();
        expect(cleanRange("workspace:^1.2.3")).toBe("^1.2.3");
        expect(cleanRange("workspace:~1.2.3")).toBe("~1.2.3");
        expect(cleanRange("workspace:1.2.3")).toBe("1.2.3");
    });

    it("returns null for plain *", () => {
        expect.hasAssertions();
        expect(cleanRange("*")).toBeNull();
    });

    it("extracts spec from npm: alias", () => {
        expect.hasAssertions();
        expect(cleanRange("npm:other-pkg@^1.2.3")).toBe("^1.2.3");
    });

    it("returns plain semver ranges unchanged", () => {
        expect.hasAssertions();
        expect(cleanRange("^1.2.3")).toBe("^1.2.3");
        expect(cleanRange("~1.2.3")).toBe("~1.2.3");
        expect(cleanRange(">=1.2.3")).toBe(">=1.2.3");
    });

    it("returns null for empty string", () => {
        expect.hasAssertions();
        expect(cleanRange("")).toBeNull();
    });
});

describe("semver: satisfiesRange", () => {
    it("returns true when version satisfies range", () => {
        expect.hasAssertions();
        expect(satisfiesRange("1.3.0", "^1.2.0")).toBe(true);
    });

    it("returns false when version is out of range", () => {
        expect.hasAssertions();
        expect(satisfiesRange("2.0.0", "^1.2.0")).toBe(false);
    });

    it("returns true for any version against unparseable range (workspace shorthand)", () => {
        expect.hasAssertions();
        expect(satisfiesRange("99.0.0", "workspace:*")).toBe(true);
        expect(satisfiesRange("99.0.0", "catalog:")).toBe(true);
    });

    it("includePrerelease semantics: prerelease versions can satisfy normal ranges", () => {
        // Without includePrerelease: true, "1.3.0-alpha.0" wouldn't satisfy "^1.2.0".
        // The propagation algorithm needs this to avoid every prerelease bump becoming an out-of-range cascade.
        expect.hasAssertions();
        expect(satisfiesRange("1.3.0-alpha.0", "^1.2.0")).toBe(true);
    });
});
