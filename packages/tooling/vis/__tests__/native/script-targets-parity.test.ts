import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { discoverWorkspace } from "../../src/config/workspace";
import { BUILT_IN_DETECTORS } from "../../src/inference";

/**
 * Parity for the native script targets (`native/cli/src/targets.rs`). Each fixture under
 * `native/cli/tests/fixtures/targets/` has an `expected.json`: `{ "native": [...] }` with the
 * project directory, name and script targets, or `{ "delegate": true }` for roots the native path
 * hands to Node. The TypeScript side runs the real discovery and must produce the same targets.
 *
 * Discovery runs with no config. `loadVisConfig` with no file adds only `security` and `update`
 * defaults, which target discovery does not read, and loading it would need the native addon.
 */

const here = dirname(fileURLToPath(import.meta.url));
const nativeRoot = resolve(here, "..", "..", "native", "cli");
const fixtureRoot = join(nativeRoot, "tests", "fixtures", "targets");

interface NativeProject {
    directory: string;
    name: string;
    targets: Record<string, string>;
}

const readExpected = (caseRoot: string): { delegate?: boolean; native?: NativeProject[] } =>
    JSON.parse(readFileSync(join(caseRoot, "expected.json"), "utf8")) as { delegate?: boolean; native?: NativeProject[] };

const cases = readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

const nativeCases = cases.filter((name) => readExpected(join(fixtureRoot, name)).native !== undefined);

/**
 * Detectors whose inference never runs for a JS package (`NON_JS_DETECTORS` in workspace.ts). The
 * native path excludes them from the marker list, so the list must cover exactly the rest.
 */
const NON_JS_DETECTOR_NAMES = ["cargo", "composer", "python", "maven", "go", "gradle", "hex", "swift", "gem", "nuget", "zig", "dart"];

const markers = JSON.parse(readFileSync(join(nativeRoot, "src", "inference-markers.json"), "utf8")) as {
    configFiles: string[];
    dependencies: string[];
};

describe("native script targets: detector markers", () => {
    const jsDetectors = BUILT_IN_DETECTORS.filter((detector) => !NON_JS_DETECTOR_NAMES.includes(detector.name));

    it("names every non-JS detector the registry has", () => {
        expect.hasAssertions();
        expect(BUILT_IN_DETECTORS.filter((detector) => NON_JS_DETECTOR_NAMES.includes(detector.name))).toHaveLength(NON_JS_DETECTOR_NAMES.length);
    });

    it("lists exactly the config files of the JS detectors", () => {
        expect.hasAssertions();
        expect(new Set(markers.configFiles)).toStrictEqual(new Set(jsDetectors.flatMap((detector) => [...detector.configFiles])));
    });

    it("lists exactly the fallback dependencies of the JS detectors", () => {
        expect.hasAssertions();
        expect(new Set(markers.dependencies)).toStrictEqual(
            new Set(jsDetectors.flatMap((detector) => (detector.fallbackDependency === undefined ? [] : [detector.fallbackDependency]))),
        );
    });

    it("has no glob-style config entries, which the native check does not match", () => {
        expect.hasAssertions();
        expect(markers.configFiles.filter((file) => file.startsWith("*."))).toStrictEqual([]);
    });
});

describe("native script targets parity", () => {
    it.each(nativeCases)("%s matches the TypeScript discovery", async (name) => {
        expect.hasAssertions();

        const caseRoot = join(fixtureRoot, name);
        const expected = readExpected(caseRoot).native ?? [];
        const { workspace } = discoverWorkspace(caseRoot);

        const actual = Object.fromEntries(
            Object.entries(workspace.projects).map(([projectName, project]) => [
                projectName,
                {
                    directory: project.root,
                    targets: Object.fromEntries(Object.entries(project.targets ?? {}).map(([targetName, target]) => [targetName, target.command])),
                },
            ]),
        );
        const want = Object.fromEntries(
            expected.map((project) => [project.name, { directory: project.directory, targets: project.targets }]),
        );

        expect(actual).toStrictEqual(want);
    });

    it("keeps the delegate fixtures out of the native comparison", () => {
        expect.hasAssertions();

        const delegating = cases.filter((name) => readExpected(join(fixtureRoot, name)).delegate === true);

        expect(delegating.length).toBeGreaterThan(0);
    });
});
