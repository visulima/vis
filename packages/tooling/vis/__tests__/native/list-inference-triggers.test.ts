import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUILT_IN_DETECTORS } from "../../src/inference";

/**
 * `native/cli/src/inference-triggers.json` lists every file and dependency that can make an inference
 * detector run on a project. The native `vis list` delegates any project with one of them, because the
 * detector may enrich its script targets. This test rebuilds the list from `BUILT_IN_DETECTORS`, so
 * a new detector that is not in the file fails here.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const triggersPath = join(packageRoot, "native", "cli", "src", "inference-triggers.json");

describe("native list inference triggers", () => {
    it("match the built-in detectors", () => {
        expect.assertions(1);

        const configFiles = [...new Set(BUILT_IN_DETECTORS.flatMap((detector) => [...detector.configFiles]))].toSorted();
        const fallbackDependencies = [
            ...new Set(BUILT_IN_DETECTORS.flatMap((detector) => (detector.fallbackDependency === undefined ? [] : [detector.fallbackDependency]))),
        ].toSorted();

        const expected = { configFiles, fallbackDependencies };
        const actual = JSON.parse(readFileSync(triggersPath, "utf8")) as typeof expected;

        expect(actual).toStrictEqual(expected);
    });
});
