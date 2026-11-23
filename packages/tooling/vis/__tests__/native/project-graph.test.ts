import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildProjectGraph, discoverWorkspace } from "../../src/config/workspace";

/**
 * Parity for the native project graph (`native/cli/src/graph.rs`). Each `native` fixture under
 * `native/cli/tests/fixtures/graph/` has an `expected.json` with sorted-comparable nodes and edges.
 * Both this test and the Rust unit test compare against that file, so the two sides answer to one list.
 */

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "cli", "tests", "fixtures", "graph");

interface ExpectedGraph {
    delegate?: boolean;
    native?: {
        edges: { source: string; target: string; type: string }[];
        nodes: { name: string; type: string }[];
    };
}

const readExpected = (caseRoot: string): ExpectedGraph =>
    JSON.parse(readFileSync(join(caseRoot, "expected.json"), "utf8")) as ExpectedGraph;

const cases = readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

const nativeCases = cases.flatMap((name): [string, NonNullable<ExpectedGraph["native"]>][] => {
    const expected = readExpected(join(fixtureRoot, name)).native;

    return expected === undefined ? [] : [[name, expected]];
});

describe("native project graph parity", () => {
    it.each(nativeCases)("%s matches the native names and edges", (name, expected) => {
        expect.assertions(2);

        const caseRoot = join(fixtureRoot, name);

        const { packageJsons, workspace } = discoverWorkspace(caseRoot);
        const graph = buildProjectGraph(caseRoot, workspace, packageJsons);

        const nodes = Object.values(graph.nodes)
            .map((node) => {
                return { name: node.name, type: node.type };
            })
            .toSorted((left, right) => left.name.localeCompare(right.name));

        const edges = Object.values(graph.dependencies)
            .flat()
            .map((edge) => {
                return { source: edge.source, target: edge.target, type: edge.type };
            })
            .toSorted((left, right) =>
                `${left.source}\0${left.target}\0${left.type}`.localeCompare(`${right.source}\0${right.target}\0${right.type}`),
            );

        expect(nodes).toStrictEqual(
            [...expected.nodes].toSorted((left, right) => left.name.localeCompare(right.name)),
        );
        expect(edges).toStrictEqual(
            [...expected.edges].toSorted((left, right) =>
                `${left.source}\0${left.target}\0${left.type}`.localeCompare(`${right.source}\0${right.target}\0${right.type}`),
            ),
        );
    });

    it("keeps the delegate fixtures out of the native comparison", () => {
        expect.assertions(2);

        const delegating = cases.filter((name) => readExpected(join(fixtureRoot, name)).delegate === true);

        expect(delegating.length).toBeGreaterThan(0);
        expect(nativeCases.length + delegating.length).toBe(cases.length);
    });
});
