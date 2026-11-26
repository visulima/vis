import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * The root `.gitignore` decides which directories of a workspace are projects, for every command that lists them.
 * The native path matches the lines made of plain names, `*` and `?` itself and hands the rest to Node, so for each
 * `.gitignore` below the two must print the same thing, and the native side must have answered (the harness fails a run
 * that exits 70). The files are written at test time: a fixture-local `.gitignore` would make git drop the directories it names.
 */

const project = (name: string): Files => {
    return { [`${name}/package.json`]: json({ name: name.replaceAll("/", "-"), scripts: { build: "tsc" } }) };
};

const tree = (): Files => {
    return {
        ...project("packages/a"),
        ...project("packages/a-skip"),
        ...project("packages/tmp1"),
        ...project("packages/tmp12"),
        ...project("packages/MixedCase"),
        ...project("packages/build-two"),
        ...project("packages/x/b-skip"),
        ...project("packages/log.d"),
        ...project("packages/Logs"),
        ...project("tools/gen/inner"),
        ...project("tools/keep"),
        "pnpm-workspace.yaml": 'packages:\n  - "packages/**"\n  - "tools/**"\n',
    };
};

const gitignores: [string, string][] = [
    ["a typical build and log list", "# build output\ndist/\nbuild/\n*.log\n*.tsbuildinfo\n.DS_Store\n.env.*\ncoverage\n"],
    ["a wildcard suffix on a name", "*-skip\n"],
    ["a single-character wildcard", "tmp?\n"],
    ["a directory-only wildcard", "tmp?/\n"],
    ["a wildcard that names an ancestor, not the leaf", "x*\n"],
    ["a wildcard directory that holds projects", "/tools/*\n"],
    ["a wildcard in the middle of a path", "tools/*/inner\n"],
    ["a rooted wildcard", "/build-*\n"],
    ["a mixed-case wildcard", "mixed*\nLOGS\n"],
    ["a whitespace-only line and a non-ASCII comment", "   \n\t\n# café\n*-skip\n"],
    ["a wildcard that matches everything", "*\n"],
    ["a lone question mark", "?\n"],
];

const nodeOnly: [string, string][] = [
    ["a negated wildcard", "packages/*\n!packages/a\n"],
    ["a double star", "**/b-skip\n"],
    ["a character class", "packages/[a]\n"],
    ["a windows line ending", "*-skip\r\ntmp?\r\n"],
    ["a trailing space", "*-skip \n"],
];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("workspace .gitignore wildcards: native vs Node", () => {
    const harnesses = [new Harness(["list"]), new Harness(["list"]), new Harness(["status"]), new Harness(["graph"])];
    const [listTable, listJson, status, graph] = harnesses;

    beforeAll(() => {
        for (const harness of harnesses) {
            harness.setup("vis-gitignore-parity-");
        }
    });

    afterAll(() => {
        for (const harness of harnesses) {
            harness.teardown();
        }
    });

    it.each(gitignores)(".gitignore with %s lists the same projects", (_name, ignore) => {
        expect.hasAssertions();

        const files = workspaceFiles({ ...tree(), ".gitignore": ignore });

        listTable?.expectParity(files, []);
        listJson?.expectParity(files, ["--json"]);
        status?.expectParity(files, []);
        graph?.expectParity(files, ["--format=json"]);
    });

    it.each(nodeOnly)(".gitignore with %s goes to Node and matches it", (_name, ignore) => {
        expect.hasAssertions();

        const files = workspaceFiles({ ...tree(), ".gitignore": ignore });

        listTable?.expectDelegation(files, []);
    });
});
