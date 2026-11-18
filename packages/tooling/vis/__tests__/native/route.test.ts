import { describe, expect, it } from "vitest";

import { routesToNative } from "../../bin/route.mjs";

describe("launcher routing (bin/route.mjs)", () => {
    it.each([
        // Help surface: rendered by the binary from the generated manifest.
        [[], true],
        [["--help"], true],
        [["-h"], true],
        [["help"], true],
        [["help", "install"], true],
        [["status", "--help"], true],
        [["status", "-h"], true],
        // Help after a `--` separator belongs to the wrapped command.
        [["run", "build", "--", "--help"], false],
        [["run", "build", "--", "-h"], false],
        // Dynamic completion endpoint is native; every other `complete` shape is not.
        [["complete", "--", "vis", ""], true],
        [["complete", "--help"], false],
        [["complete", "bash"], false],
        [["complete", "bash", "--help"], false],
        // Script generation is a Node command.
        [["completion", "bash"], false],
        [["completion", "--shell=bash"], false],
        // Only `hook run` is native.
        [["hook", "run", "pre-commit"], true],
        [["hook", "install"], false],
        // Natively implemented commands.
        [["--version"], true],
        [["-V"], true],
        [["exec", "tsc"], true],
        [["pm", "list"], true],
        [["why", "left-pad"], true],
        // Everything else stays in-process.
        [["status", "--json"], false],
        [["run", "build"], false],
        [["list"], false],
        [["-v"], false],
    ])("routes `vis %j` to native: %s", (args: string[], expected: boolean) => {
        expect.assertions(1);

        expect(routesToNative(args, "linux")).toBe(expected);
    });

    it.each([[[]], [["--help"]], [["-h"]], [["help", "install"]], [["status", "--help"]]])(
        "keeps the help surface `vis %j` in Node on Windows",
        (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "win32")).toBe(false);
        },
    );

    it("still routes the native commands on Windows", () => {
        expect.assertions(2);

        expect(routesToNative(["--version"], "win32")).toBe(true);
        expect(routesToNative(["hook", "run", "pre-commit"], "win32")).toBe(true);
    });
});
