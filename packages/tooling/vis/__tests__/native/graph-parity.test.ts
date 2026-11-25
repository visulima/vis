import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS, withoutColour } from "./colour-environments";

/**
 * `vis graph` exists twice: the Node handler (`src/commands/graph/handler.ts`) and the native graph
 * (`native/cli/src/graph_view.rs`). Every fixture under `native/cli/tests/fixtures/graph-view/` runs
 * through both, with the same arguments and CI context, and the stdout, stderr and exit status must
 * match. For the native cases the binary's fallback entry is a stub that prints a marker, so a run
 * that quietly delegated is caught: the marker must be absent exactly when the native path is
 * expected to answer.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(packageRoot, "native", "cli", "tests", "fixtures", "graph-view");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const marker = "NATIVE-DELEGATED";
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

/** The shapes the native path answers: the ASCII tree, DOT and JSON, with a depth. */
const nativeArguments = (args: string[]): boolean => {
    const rest = [...args];
    const seen = new Set<string>();

    while (rest.length > 0) {
        const token = rest.shift() as string;
        const [name, inline] = token.startsWith("--") ? token.split("=") : [token, undefined];
        const kind = name === "--format" || name === "-f" ? "format" : name === "--depth" || name === "-d" ? "depth" : undefined;

        if (kind === undefined || seen.has(kind)) {
            return false;
        }

        seen.add(kind);

        const value = inline ?? rest.shift();

        if (value === undefined || (kind === "format" ? !["ascii", "dot", "json", "tui"].includes(value) : !/^\d+$/.test(value))) {
            return false;
        }
    }

    return true;
};

/** Fixtures the native path answers, for the CI context. Everything else must delegate. */
const nativeFixtures = new Set(["basic", "empty", "libs-only", "multi-pattern"]);

const fixtures = ["basic", "empty", "libs-only", "multi-pattern", "delegate-complex-patterns", "delegate-index-name", "delegate-unicode-name", "delegate-vis-config", "delegate-project-json"];

const argumentSets: string[][] = [
    [],
    ["--format=ascii"],
    ["--format=tui"],
    ["--format", "dot"],
    ["-f", "dot"],
    ["--format=json"],
    ["-f", "json"],
    ["--depth=0"],
    ["--depth", "1"],
    ["-d", "2"],
    ["--depth=100"],
    ["--format=json", "--depth=1"],
    ["--format=banana"],
    ["--depth=-1"],
    ["--depth=abc"],
    ["--depth=1.5"],
    ["extra"],
    ["--help"],
];

// The runner's own colour variables are dropped (a CI runner sets several), and a case adds the one it tests.
const contextEnvironment = (fixture: string, ci: boolean, colour: Record<string, string> = {}): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = {
        ...withoutColour(process.env),
        VIS_CLI_TEST: "1",
        VIS_MONOREPO_ROOT: fixture,
        VIS_NO_UPDATE_CHECK: "1",
    };

    delete env["CI"];
    delete env["CONTINUOUS_INTEGRATION"];
    delete env["VIS_FALLBACK_ENTRY"];
    delete env["VIS_FALLBACK_ENTRY_OVERRIDE"];
    delete env["VIS_VERSION"];

    if (ci) {
        env["CI"] = "1";
    }

    return { ...env, ...colour };
};

const runNode = (fixture: string, args: string[], ci: boolean, colour: Record<string, string> = {}) =>
    spawnSync(process.execPath, [nodeEntry, "graph", ...args], {
        cwd: fixture,
        encoding: "utf8",
        env: contextEnvironment(fixture, ci, colour),
    });

// `vis graph` computes its root from the working directory and never reads `VIS_MONOREPO_ROOT`. The native runs get
// a stale value on purpose, so a regression that trusted it would show up as a mismatch. A delegated run gets the
// same value as its Node reference.
const runNative = (fixture: string, args: string[], ci: boolean, entry: string, root = dirname(fixture), colour: Record<string, string> = {}) =>
    spawnSync(binary as string, ["graph", ...args], {
        cwd: fixture,
        encoding: "utf8",
        // A binary in a platform package (what CI runs) keeps the entry and version the launcher
        // passes; one inside the vis package (a dev copy) takes the override instead. Set both.
        env: {
            ...contextEnvironment(fixture, ci, colour),
            VIS_FALLBACK_ENTRY: entry,
            VIS_FALLBACK_ENTRY_OVERRIDE: entry,
            VIS_MONOREPO_ROOT: root,
            VIS_NODE: process.execPath,
            VIS_VERSION: version,
        },
    });

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis graph: native vs Node", () => {
    const paths = { fixtures: "", scratch: "", stub: "" };

    beforeAll(() => {
        paths.scratch = mkdtempSync(join(tmpdir(), "vis-graph-parity-"));
        paths.stub = join(paths.scratch, "stub.mjs");
        // Copied out of the repository, so the root search finds the fixture and nothing above it.
        paths.fixtures = join(paths.scratch, "fixtures");

        cpSync(fixtureRoot, paths.fixtures, { recursive: true });

        writeFileSync(paths.stub, `console.log("${marker}");\nprocess.exit(99);\n`);
    });

    afterAll(() => {
        rmSync(paths.scratch, { force: true, recursive: true });
    });

    it.each(fixtures.flatMap((fixture) => argumentSets.map((args) => [fixture, args] as const)))(
        "%s %j matches Node in CI",
        (fixture, args) => {
            expect.assertions(4);

            const directory = join(paths.fixtures, fixture);
            const expectDelegated = !args.includes("--help") && !(nativeFixtures.has(fixture) && nativeArguments(args));
            const node = runNode(directory, args, true);

            // The stub probe shows which path answers: the marker appears only on delegation.
            const probe = runNative(directory, args, true, paths.stub);

            expect(probe.stdout.includes(marker)).toBe(expectDelegated);

            const native = runNative(directory, args, true, nodeEntry, expectDelegated ? directory : dirname(directory));

            expect(native.stdout).toBe(node.stdout);
            expect(native.stderr).toBe(node.stderr);
            expect(native.status).toBe(node.status);
        },
    );

    it.each(fixtures)("%s delegates outside CI and matches Node", (fixture) => {
        expect.assertions(3);

        const directory = join(paths.fixtures, fixture);
        const node = runNode(directory, ["--format=json"], false);
        const native = runNative(directory, ["--format=json"], false, nodeEntry, directory);

        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe(node.stderr);
        expect(native.status).toBe(node.status);
    });

    // Node's root search starts at the working directory and does not read `VIS_MONOREPO_ROOT`, so a run from inside a
    // project, with an inherited root naming another workspace, finds the same graph.
    it.each(["basic", "multi-pattern"])("%s from a project directory matches Node", (fixture) => {
        expect.assertions(4);

        const root = join(paths.fixtures, fixture);
        const directory = join(root, fixture === "basic" ? "packages/a-dir" : "packages/m-pkg");
        const node = runNode(directory, ["--format=json"], true);
        const native = runNative(directory, ["--format=json"], true, paths.stub, join(paths.fixtures, "libs-only"));

        expect(native.stdout).not.toContain(marker);
        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe(node.stderr);
        expect(native.status).toBe(node.status);
    });

    // The HTML viewer stamps the time into its page, so its bytes differ between any two runs: only the hand-off is compared.
    it.each([["--format=html"], ["--format=json", "--output=graph.json"]])("hands %j to Node", (...args) => {
        expect.assertions(1);

        expect(runNative(join(paths.fixtures, "basic"), args, true, paths.stub).stdout).toContain(marker);
    });

    // The ASCII tree carries colour codes where the colour detection says so; the binary decides with the same rules.
    it.each(SHORT_COLOUR_ENVIRONMENTS.flatMap((colour) => ["basic", "empty"].flatMap((fixture) => [[], ["--depth=1"], ["--format=json"], ["--format=dot"]].map((args) => [colour, fixture, args] as const))))(
        "in %j, %s %j matches Node and is answered natively",
        (colour, fixture, args) => {
            expect.assertions(4);

            const directory = join(paths.fixtures, fixture);
            const node = runNode(directory, [...args], true, colour);
            const native = runNative(directory, [...args], true, paths.stub, dirname(directory), colour);

            expect(native.stdout).not.toContain(marker);
            expect(native.stdout).toBe(node.stdout);
            expect(native.stderr).toBe(node.stderr);
            expect(native.status).toBe(node.status);
        },
    );

    // The Node runtime warns on stderr, with its process id, when `FORCE_COLOR` and `NO_COLOR` are both set: Node's.
    it.each(DELEGATED_COLOUR_ENVIRONMENTS)("hands a run with %j to Node", (colour) => {
        expect.assertions(2);

        const directory = join(paths.fixtures, "basic");

        expect(runNative(directory, ["--format=json"], true, paths.stub, directory, colour).stdout).toContain(marker);
        expect(runNative(directory, ["--format=json"], true, nodeEntry, directory, colour).stdout).toBe(runNode(directory, ["--format=json"], true, colour).stdout);
    });
});
