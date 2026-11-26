import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUILT_IN_DETECTORS } from "../../src/inference";

/**
 * The native `vis list`, `affected`, `status` and script targets delegate any project that an inference detector
 * could enrich. One check decides that (`inference_applies` in `native/cli/src/targets.rs`): the JS detectors'
 * files and dependencies in `inference-markers.json` (checked by `script-targets-parity.test.ts`) and the non-JS
 * manifests `NON_JS_MARKERS` and `NON_JS_SUFFIXES` in `workspace.rs`. This test checks that the non-JS list
 * names every config file of every detector the markers do not, so a new detector fails here.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nativeSource = join(packageRoot, "native", "cli", "src");

const rustStrings = (source: string, constant: string): string[] => {
    const body = new RegExp(String.raw`const ${constant}: &\[&str\] = &\[([^\]]*)\];`, "u").exec(source)?.[1] ?? "";

    return [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1] as string);
};

describe("native inference registry", () => {
    it("covers every config file of the built-in detectors", () => {
        expect.assertions(3);

        const markers = JSON.parse(readFileSync(join(nativeSource, "inference-markers.json"), "utf8")) as { configFiles: string[]; dependencies: string[] };
        const workspace = readFileSync(join(nativeSource, "workspace.rs"), "utf8");
        const nonJsFiles = new Set(rustStrings(workspace, "NON_JS_MARKERS"));
        const nonJsSuffixes = rustStrings(workspace, "NON_JS_SUFFIXES");
        const covered = (file: string): boolean =>
            markers.configFiles.includes(file) || nonJsFiles.has(file) || nonJsSuffixes.some((suffix) => file.startsWith("*") && file.endsWith(suffix));
        const configFiles = [...new Set(BUILT_IN_DETECTORS.flatMap((detector) => [...detector.configFiles]))].toSorted();

        const fallbackDependencies = BUILT_IN_DETECTORS.flatMap((detector) => (detector.fallbackDependency === undefined ? [] : [detector.fallbackDependency]));

        expect(configFiles.filter((file) => !covered(file))).toStrictEqual([]);
        expect(fallbackDependencies.filter((name) => !markers.dependencies.includes(name))).toStrictEqual([]);
        expect(nonJsSuffixes.length).toBeGreaterThan(0);
    });
});
