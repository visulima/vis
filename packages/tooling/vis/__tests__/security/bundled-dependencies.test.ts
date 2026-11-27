import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundledDependencyPaths, formatBundledPath, scanBundledDependencies } from "../../src/security/bundled-dependencies";
import type { InstalledPackage } from "../../src/security/dependency-scan";
import { lockedPackages } from "../../src/security/dependency-scan";
import { bundledDependencyNames } from "../../src/security/manifests";

let root: string;

const write = (relative: string, content: unknown): void => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), typeof content === "string" ? content : JSON.stringify(content));
};

/** A package on disk under `node_modules/&lt;directory>` (a hoisted npm layout; nested paths nest). */
const install = (directory: string, manifest: Record<string, unknown>): void => {
    write(`node_modules/${directory}/package.json`, manifest);
};

const locked = (...packages: [string, string][]): InstalledPackage[] =>
    packages.map(([name, version]) => {
        return { isDev: false, name, version };
    });

const summary = (packages: InstalledPackage[]): string[] => packages.map((pkg) => `${pkg.name}@${pkg.version}${pkg.bundledOnly ? " (bundled only)" : ""}`);

describe(bundledDependencyNames, () => {
    it("reads both spellings, and expands true to the dependencies", () => {
        expect.assertions(5);

        expect(bundledDependencyNames({ bundleDependencies: ["a", "b"] })).toStrictEqual(["a", "b"]);
        expect(bundledDependencyNames({ bundledDependencies: ["a"] })).toStrictEqual(["a"]);
        expect(bundledDependencyNames({ bundleDependencies: true, dependencies: { x: "1", y: "2" } })).toStrictEqual(["x", "y"]);
        expect(bundledDependencyNames({ bundleDependencies: false, dependencies: { x: "1" } })).toBeUndefined();
        expect(bundledDependencyNames({ bundleDependencies: [] })).toBeUndefined();
    });
});

describe(scanBundledDependencies, () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-bundled-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("returns the lockfile set untouched when nothing is installed", () => {
        expect.assertions(2);

        const list = locked(["host", "1.0.0"]);
        const scan = scanBundledDependencies(root, list);

        expect(scan.installed).toBe(list);
        expect(scan.unauditable).toStrictEqual([]);
    });

    it("reads the names a package declares as an array, scoped names included", () => {
        expect.assertions(3);

        install("host", { bundleDependencies: ["dep-a", "@scope/dep-b"], name: "host", version: "1.0.0" });
        install("host/node_modules/dep-a", { name: "dep-a", version: "2.0.0" });
        install("host/node_modules/@scope/dep-b", { name: "@scope/dep-b", version: "3.1.4" });

        const scan = scanBundledDependencies(root, locked(["host", "1.0.0"]));

        expect(summary(scan.installed)).toStrictEqual(["host@1.0.0", "dep-a@2.0.0 (bundled only)", "@scope/dep-b@3.1.4 (bundled only)"]);
        expect(scan.bundledCount).toBe(2);
        expect(scan.installed[1]?.bundledIn).toStrictEqual([[{ name: "host", version: "1.0.0" }]]);
    });

    it("reads the packages under a bundling host that nothing declares, nested ones included", () => {
        expect.assertions(3);

        // A package manager packs the whole tree of a bundled dependency; only its top-level names are declared.
        install("host", { bundleDependencies: ["declared"], name: "host", version: "1.0.0" });
        install("host/node_modules/declared", { name: "declared", version: "1.0.0" });
        install("host/node_modules/transitive", { name: "transitive", version: "2.0.0" });
        install("host/node_modules/@scope/also", { name: "@scope/also", version: "3.0.0" });
        install("host/node_modules/declared/node_modules/deep", { name: "deep", version: "4.0.0" });
        write("node_modules/host/node_modules/.bin/tool", "#!/bin/sh\n");

        const scan = scanBundledDependencies(root, locked(["host", "1.0.0"]));

        expect(summary(scan.installed)).toStrictEqual([
            "host@1.0.0",
            "declared@1.0.0 (bundled only)",
            "deep@4.0.0 (bundled only)",
            "@scope/also@3.0.0 (bundled only)",
            "transitive@2.0.0 (bundled only)",
        ]);
        expect(scan.installed.find((pkg) => pkg.name === "deep")?.bundledIn).toStrictEqual([
            [
                { name: "host", version: "1.0.0" },
                { name: "declared", version: "1.0.0" },
            ],
        ]);
        expect(scan.unauditable).toStrictEqual([]);
    });

    it("counts a directory under a bundling host that has no manifest", () => {
        expect.assertions(2);

        install("host", { bundleDependencies: ["a"], name: "host", version: "1.0.0" });
        install("host/node_modules/a", { name: "a", version: "1.0.0" });
        write("node_modules/host/node_modules/leftover/readme.md", "x");

        const scan = scanBundledDependencies(root, locked(["host", "1.0.0"]));

        expect(summary(scan.installed)).toStrictEqual(["host@1.0.0", "a@1.0.0 (bundled only)"]);
        expect(scan.unauditable).toStrictEqual([{ count: 1, host: "host@1.0.0", kind: "bundled-unreadable", location: "node_modules", names: ["leftover"] }]);
    });

    it("leaves the nested copies of a package that declares no bundling to the lockfile", () => {
        expect.assertions(1);

        install("plain", { name: "plain", version: "1.0.0" });
        install("plain/node_modules/nested", { name: "nested", version: "9.0.0" });

        expect(summary(scanBundledDependencies(root, locked(["plain", "1.0.0"])).installed)).toStrictEqual(["plain@1.0.0"]);
    });

    it("treats `bundleDependencies: true` as every declared dependency", () => {
        expect.assertions(1);

        install("host", { bundledDependencies: true, dependencies: { x: "^1.0.0", y: "^1.0.0" }, name: "host", version: "1.0.0" });
        install("host/node_modules/x", { name: "x", version: "1.2.0" });
        install("host/node_modules/y", { name: "y", version: "1.3.0" });

        expect(summary(scanBundledDependencies(root, locked(["host", "1.0.0"])).installed)).toStrictEqual(["host@1.0.0", "x@1.2.0 (bundled only)", "y@1.3.0 (bundled only)"]);
    });

    it("follows a bundled package that bundles another", () => {
        expect.assertions(2);

        install("host", { bundleDependencies: ["mid"], name: "host", version: "1.0.0" });
        install("host/node_modules/mid", { bundleDependencies: ["leaf"], name: "mid", version: "2.0.0" });
        install("host/node_modules/mid/node_modules/leaf", { name: "leaf", version: "3.0.0" });

        const scan = scanBundledDependencies(root, locked(["host", "1.0.0"]));
        const leaf = scan.installed.find((pkg) => pkg.name === "leaf");

        expect(summary(scan.installed)).toStrictEqual(["host@1.0.0", "mid@2.0.0 (bundled only)", "leaf@3.0.0 (bundled only)"]);
        expect(leaf?.bundledIn).toStrictEqual([
            [
                { name: "host", version: "1.0.0" },
                { name: "mid", version: "2.0.0" },
            ],
        ]);
    });

    it("counts a bundled name whose manifest cannot be read, and never skips it silently", () => {
        expect.assertions(2);

        install("host", { bundleDependencies: ["ghost", "no-version", "../escape", "fine"], name: "host", version: "1.0.0" });
        install("host/node_modules/no-version", { name: "no-version" });
        install("host/node_modules/fine", { name: "fine", version: "1.0.0" });
        write("node_modules/host/escape/package.json", { name: "escape", version: "9.9.9" });

        const scan = scanBundledDependencies(root, locked(["host", "1.0.0"]));

        expect(summary(scan.installed)).toStrictEqual(["host@1.0.0", "fine@1.0.0 (bundled only)"]);
        expect(scan.unauditable).toStrictEqual([{ count: 3, host: "host@1.0.0", kind: "bundled-unreadable", location: "node_modules", names: ["../escape", "ghost", "no-version"] }]);
    });

    it("scans a package once when the lockfile lists it too, and keeps the host that ships it", () => {
        expect.assertions(3);

        install("host", { bundleDependencies: ["shared", "other"], name: "host", version: "1.0.0" });
        install("host/node_modules/shared", { name: "shared", version: "1.0.0" });
        install("host/node_modules/other", { name: "other", version: "2.0.0" });
        install("shared", { name: "shared", version: "1.0.0" });

        const scan = scanBundledDependencies(root, locked(["host", "1.0.0"], ["shared", "1.0.0"], ["other", "1.0.0"]));

        expect(summary(scan.installed)).toStrictEqual(["host@1.0.0", "shared@1.0.0", "other@1.0.0", "other@2.0.0 (bundled only)"]);
        expect(scan.installed.find((pkg) => pkg.name === "shared")).toStrictEqual({
            bundledIn: [[{ name: "host", version: "1.0.0" }]],
            isDev: false,
            name: "shared",
            version: "1.0.0",
        });
        expect(scan.bundledCount).toBe(1);
    });

    it("lists a copy once with every host that ships it", () => {
        expect.assertions(2);

        install("one", { bundleDependencies: ["dup"], name: "one", version: "1.0.0" });
        install("one/node_modules/dup", { name: "dup", version: "4.0.0" });
        install("two", { bundleDependencies: ["dup"], name: "two", version: "1.0.0" });
        install("two/node_modules/dup", { name: "dup", version: "4.0.0" });

        const scan = scanBundledDependencies(root, locked(["one", "1.0.0"], ["two", "1.0.0"]));

        expect(scan.bundledCount).toBe(1);
        expect(scan.installed.find((pkg) => pkg.name === "dup")?.bundledIn).toStrictEqual([[{ name: "one", version: "1.0.0" }], [{ name: "two", version: "1.0.0" }]]);
    });

    it("does not read the bundled copies of a host the production set left out", () => {
        expect.assertions(2);

        write("package.json", { dependencies: { prodhost: "1.0.0" }, devDependencies: { devhost: "1.0.0" }, name: "app" });
        write("package-lock.json", {
            lockfileVersion: 3,
            packages: { "": { name: "app" }, "node_modules/devhost": { version: "1.0.0" }, "node_modules/prodhost": { version: "1.0.0" } },
        });

        for (const host of ["prodhost", "devhost"]) {
            install(host, { bundleDependencies: [`${host}-dep`], name: host, version: "1.0.0" });
            install(`${host}/node_modules/${host}-dep`, { name: `${host}-dep`, version: "1.0.0" });
        }

        const prodOnly = scanBundledDependencies(root, lockedPackages(root, "npm", { includeDev: false }));
        const everything = scanBundledDependencies(root, lockedPackages(root, "npm", { includeDev: true }));

        expect(summary(prodOnly.installed)).toStrictEqual(["prodhost@1.0.0", "prodhost-dep@1.0.0 (bundled only)"]);
        expect(summary(everything.installed).toSorted()).toStrictEqual(["devhost-dep@1.0.0 (bundled only)", "devhost@1.0.0", "prodhost-dep@1.0.0 (bundled only)", "prodhost@1.0.0"]);
    });

    it("reads a host from pnpm's store, where its directory is not its name", () => {
        expect.assertions(2);

        write("node_modules/.pnpm/host@1.0.0_peer@2.0.0/node_modules/host/package.json", { bundleDependencies: ["dep"], name: "host", version: "1.0.0" });
        write("node_modules/.pnpm/host@1.0.0_peer@2.0.0/node_modules/host/node_modules/dep/package.json", { name: "dep", version: "5.0.0" });

        const scan = scanBundledDependencies(root, locked(["host", "1.0.0"]));

        expect(summary(scan.installed)).toStrictEqual(["host@1.0.0", "dep@5.0.0 (bundled only)"]);
        expect(scan.unauditable).toStrictEqual([]);
    });

    describe("vendored copies", () => {
        beforeEach(() => {
            install("host", { name: "host", version: "16.3.8" });
            write("node_modules/host/dist/compiled/semver/package.json", { name: "semver", version: "7.6.0" });
            write("node_modules/host/dist/compiled/no-version/package.json", { name: "no-version" });
            write("node_modules/host/dist/compiled/no-manifest/index.js", "module.exports = 1;");
            write("node_modules/host/dist/compiled/@scope/inner/index.js", "module.exports = 2;");
            write("node_modules/host/dist/compiled/loose-file.js", "x");
        });

        it("reports the directories that carry no version and never guesses one", () => {
            expect.assertions(1);

            expect(scanBundledDependencies(root, locked(["host", "16.3.8"])).unauditable).toStrictEqual([{ count: 3, host: "host@16.3.8", kind: "vendored", location: "dist/compiled" }]);
        });

        it("scans a vendored directory whose manifest has a name and a version", () => {
            expect.assertions(1);

            expect(summary(scanBundledDependencies(root, locked(["host", "16.3.8"])).installed)).toStrictEqual(["host@16.3.8", "semver@7.6.0 (bundled only)"]);
        });

        it("reads a `compiled` directory next to the manifest too", () => {
            expect.assertions(1);

            write("node_modules/host/compiled/thing/index.js", "x");

            expect(scanBundledDependencies(root, locked(["host", "16.3.8"])).unauditable.map((entry) => `${entry.location}:${String(entry.count)}`)).toStrictEqual(["compiled:1", "dist/compiled:3"]);
        });
    });
});

describe(formatBundledPath, () => {
    it("joins the hosts and the package with an arrow", () => {
        expect.assertions(1);

        expect(formatBundledPath([{ name: "host", version: "1.0.0" }, { name: "mid", version: "2.0.0" }], "leaf", "3.0.0")).toBe("host@1.0.0 > mid@2.0.0 > leaf@3.0.0");
    });
});

describe(bundledDependencyPaths, () => {
    const host = { name: "host", version: "1.0.0" };
    const rootNode = { name: "app-dep", version: "0.1.0" };

    it("ends the paths to the host with the bundled copy", () => {
        expect.assertions(1);

        const paths = bundledDependencyPaths({ bundledIn: [[host]], name: "dep", version: "2.0.0" }, [], () => [[rootNode, host]]);

        expect(paths).toStrictEqual([[rootNode, host, { name: "dep", version: "2.0.0" }]]);
    });

    it("shows the chain alone when the host has no path in the lockfile graph", () => {
        expect.assertions(1);

        const mid = { name: "mid", version: "2.0.0" };

        expect(bundledDependencyPaths({ bundledIn: [[host, mid]], name: "leaf", version: "3.0.0" }, [], () => [])).toStrictEqual([[host, mid, { name: "leaf", version: "3.0.0" }]]);
    });

    it("keeps lockfile paths and the host path for a package that is both", () => {
        expect.assertions(1);

        const own = [[rootNode, { name: "shared", version: "1.0.0" }]];
        const paths = bundledDependencyPaths({ bundledIn: [[host]], name: "shared", version: "1.0.0" }, own, () => [[rootNode, host]]);

        expect(paths).toStrictEqual([...own, [rootNode, host, { name: "shared", version: "1.0.0" }]]);
    });

    it("leaves a package that is not bundled with its lockfile paths", () => {
        expect.assertions(1);

        const own = [[rootNode, { name: "plain", version: "1.0.0" }]];

        expect(bundledDependencyPaths({ name: "plain", version: "1.0.0" }, own, () => [])).toStrictEqual(own);
    });
});
