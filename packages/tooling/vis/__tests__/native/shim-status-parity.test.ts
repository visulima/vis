import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis shim status` exists twice: the Node handler (`src/commands/shim/handler.ts`) and the native fast path
 * (`native/cli/src/shim_status.rs`). For the shape the native path accepts it must print the same text with the same
 * exit status as Node, and every shape it declines must be handed to Node before anything is printed (see
 * `workspace-parity-harness.ts` for how both are proved).
 */

const harness = new Harness(["shim", "status"]);

const SHIMS = ["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg"];

const shims = (names: string[]): Files => Object.fromEntries(names.map((name) => [`.vis/shims/${name}`, "#!/bin/sh\n"]));

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis shim status: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-shim-status-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe("accepted shapes", () => {
        it("says the shims are not installed", () => {
            expect.hasAssertions();

            expect(harness.expectParity(workspaceFiles({}), []).stdout).toBe("PM shims: not installed. Run `vis shim install`.\n");
        });

        it("reports installed shims, on PATH or not", () => {
            expect.hasAssertions();

            const files = workspaceFiles(shims(SHIMS));
            const [nodeRoot, nativeRoot] = harness.pair(files);

            for (const onPath of [false, true]) {
                const node = harness.runNode([], nodeRoot, onPath ? { PATH: `${process.env["PATH"]}:${join(nodeRoot, ".vis", "shims")}` } : {});
                const native = harness.runNative([], nativeRoot, onPath ? { PATH: `${process.env["PATH"]}:${join(nativeRoot, ".vis", "shims")}` } : {});

                expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
                expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
                expect(native.stdout).toContain(onPath ? "PATH: active" : "PATH: NOT on PATH");
            }
        });

        it("names the shims that are missing", () => {
            expect.hasAssertions();

            expect(harness.expectParity(workspaceFiles(shims(["npm", "yarn"])), []).stdout).toContain("WARNING: 4 shim(s) missing (npx, pnpm, pnpx, yarnpkg).");

            harness.expectParity(workspaceFiles({ ".vis/shims/.keep": "" }), []);
            harness.expectParity(workspaceFiles(shims(SHIMS.slice(0, 5))), []);
        });

        it("counts a symbolic link to a file and not a broken one", () => {
            expect.hasAssertions();

            harness.expectParity(workspaceFiles({ ".vis/real": "x\n", ".vis/shims/npm": { link: "../real" }, ".vis/shims/npx": { link: "missing" } }), []);
        });

        it("treats a shim directory that is a file as not installed", () => {
            expect.hasAssertions();

            harness.expectParity(workspaceFiles({ ".vis/shims": "x\n" }), []);
        });

        it("reads an empty or unset PATH", () => {
            expect.hasAssertions();

            harness.expectParity(workspaceFiles(shims(SHIMS)), [], { PATH: "" });
        });

        it.each(COLOUR_ENVIRONMENTS)("prints what Node does under %j", (...[environment]: Record<string, string>[]) => {
            expect.hasAssertions();

            harness.expectParity(workspaceFiles(shims(SHIMS.slice(0, 3))), [], environment);
        });
    });

    describe("shapes handed to Node", () => {
        it.each([[["--json"]], [["extra"]]])("`shim status %s` is declined", (args: string[]) => {
            expect.hasAssertions();

            harness.expectDelegation(workspaceFiles(shims(SHIMS)), args);
        });

        it("a run outside CI is declined", () => {
            expect.hasAssertions();

            // Node prints a random, rate-limited tip outside CI; VIS_CLI_TEST keeps it out of the comparison.
            harness.expectDelegation(workspaceFiles(shims(SHIMS)), [], { VIS_CLI_TEST: "1" }, false);
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("%j is declined", (environment) => {
            expect.hasAssertions();

            harness.expectDelegation(workspaceFiles({}), [], environment);
        });

        it.each([{ NODE_ENV: "test" }, { NODE_ENV: "debug" }, { DEBUG: "vis" }, { PAIL_LOG_LEVEL: "debug" }, { CEREBRO_OUTPUT_LEVEL: "4" }])("the output setting %j is declined", (environment) => {
            expect.hasAssertions();

            harness.expectDelegation(workspaceFiles({}), [], environment);
        });

        it("a vis.config is declined", () => {
            expect.hasAssertions();

            harness.expectDelegation({ ...workspaceFiles({}), "vis.config.ts": "export default {};\n" }, []);
        });

        it("a workspace that is not rooted at the working directory is declined", () => {
            expect.hasAssertions();

            const [nodeRoot, nativeRoot] = harness.pair({ ...workspaceFiles({}), "packages/a/package.json": '{"name":"a"}\n' });
            const directory = "packages/a";

            expect(harness.runNative([], join(nativeRoot, directory)).status).toBe(70);
            expect(harness.runNode([], join(nodeRoot, directory)).status).toBe(0);
        });
    });
});

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis shim status under a path with format characters", () => {
    const formatted = new Harness(["shim", "status"]);

    beforeAll(() => {
        formatted.setup("vis-shim-%s-%d-{0}-");
    });

    afterAll(() => {
        formatted.teardown();
    });

    it("prints the path as it is", () => {
        expect.hasAssertions();

        expect(formatted.expectParity(workspaceFiles(shims(SHIMS.slice(0, 2))), []).stdout).toContain("%s-%d-{0}-");
    });
});
