import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS, withoutColour } from "./colour-environments";

/**
 * `vis list` exists twice: the Node handler (`src/commands/list/handler.ts`) and the native
 * listing (`native/cli/src/list.rs`). Every fixture under `native/cli/tests/fixtures/list/` runs
 * through both, with the same arguments and CI context, and the stdout, stderr and exit status must
 * match. For the native cases the binary's fallback entry is a stub that prints a marker, so a run
 * that quietly delegated is caught: the marker must be absent exactly when the native path is
 * expected to answer.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(packageRoot, "native", "cli", "tests", "fixtures", "list");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const marker = "NATIVE-DELEGATED";
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

/** The native path answers the plain listing only. Help is rendered by the binary for every fixture. */
const nativeArguments = (args: string[]): boolean =>
    args.length === 0 || (args.length === 1 && (args[0] === "--json" || args[0] === "--format=table" || args[0] === "--format=json"));

/** Fixtures the native path answers, for the CI context. Everything else must delegate. */
const nativeFixtures = new Set(["basic", "bin-null", "empty"]);

const fixtures = [
    "basic",
    "bin-null",
    "empty",
    "delegate-detector-config",
    "delegate-empty-script",
    "delegate-detector-dep",
    "delegate-index-script",
    "delegate-no-lockfile",
    "delegate-reserved-script",
    "delegate-unicode-name",
    "delegate-vis-config",
    "delegate-zero-scripts",
];

const argumentSets: string[][] = [[], ["--json"], ["--format=table"], ["--format=json"], ["--format=ndjson"], ["--deps"], ["--help"]];

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
    spawnSync(process.execPath, [nodeEntry, "list", ...args], {
        cwd: fixture,
        encoding: "utf8",
        env: contextEnvironment(fixture, ci, colour),
    });

// `vis list` computes its root from the working directory and never reads `VIS_MONOREPO_ROOT`. The
// native runs get a stale value on purpose, so a regression that trusted it would show up as a mismatch.
// `root` is the inherited VIS_MONOREPO_ROOT. A delegated run gets the same value as its Node reference
// (Node's `list --deps` reads it), while a native answer keeps the stale parent so it is never trusted.
const runNative = (fixture: string, args: string[], ci: boolean, entry: string, root = dirname(fixture), colour: Record<string, string> = {}) =>
    spawnSync(binary as string, ["list", ...args], {
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

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis list: native vs Node", () => {
    const paths = { fixtures: "", scratch: "", stub: "" };

    beforeAll(() => {
        paths.scratch = mkdtempSync(join(tmpdir(), "vis-list-parity-"));
        paths.stub = join(paths.scratch, "stub.mjs");
        // A fixture without a lockfile would otherwise resolve the repository's own workspace, which
        // other test files change while this one runs, so the Node and native runs would see different trees.
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
        const node = runNode(directory, [], false);
        const native = runNative(directory, [], false, nodeEntry, directory);

        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe(node.stderr);
        expect(native.status).toBe(node.status);
    });

    // The table and the JSON are plain where Node's colour detection turns colour on, so the binary answers them all natively.
    it.each(SHORT_COLOUR_ENVIRONMENTS.flatMap((colour) => ["basic", "empty"].flatMap((fixture) => [[], ["--json"]].map((args) => [colour, fixture, args] as const))))(
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

        expect(runNative(directory, ["--json"], true, paths.stub, directory, colour).stdout).toContain(marker);
        expect(runNative(directory, ["--json"], true, nodeEntry, directory, colour).stdout).toBe(runNode(directory, ["--json"], true, colour).stdout);
    });

    it.each(["basic", "bin-null", "empty"])("%s answers the plain listing natively", (fixture) => {
        expect.assertions(1);

        const native = runNative(join(paths.fixtures, fixture), [], true, paths.stub);

        expect(native.stdout).not.toContain(marker);
    });
});
