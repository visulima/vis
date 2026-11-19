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
        // Only `advisories bloom status` is native; the other advisories subcommands are not.
        [["advisories", "bloom", "status", "--format", "json"], true],
        [["advisories", "bloom", "sync"], false],
        [["advisories", "status"], false],
        // `ignore` help is answered by the binary; plain runs depend on the environment (below).
        [["ignore", "--help"], true],
        [["ignore-all"], false],
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

    it.each([[[]], [["--help"]], [["-h"]], [["help", "install"]], [["status", "--help"]], [["ignore", "--help"]]])(
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

    describe("`vis ignore` gate (native_context in ignore.rs)", () => {
        const cwd = "/work/app";
        const ciEnvironment = { CI: "1", VIS_MONOREPO_ROOT: cwd, PATH: "/usr/bin" };
        const route = (args: string[], overrides: Partial<{ environment: Record<string, string>; platform: string; cwd: string; interactive: boolean }> = {}) =>
            routesToNative(
                args,
                overrides.platform ?? "linux",
                overrides.environment ?? ciEnvironment,
                overrides.cwd ?? cwd,
                overrides.interactive ?? false,
            );

        it.each([[["ignore"]], [["ignore", "--target=npm", "--write"]], [["ignore", "--json"]], [["ignore", "--target", "slug"]]])(
            "routes `vis %j` to native when the gate can pass",
            (args: string[]) => {
                expect.assertions(1);

                expect(route(args)).toBe(true);
            },
        );

        it.each([
            ["CI is unset", { VIS_MONOREPO_ROOT: cwd }],
            ["CI is 0", { CI: "0", VIS_MONOREPO_ROOT: cwd }],
            ["CI is false", { CI: "false", VIS_MONOREPO_ROOT: cwd }],
            ["VIS_MONOREPO_ROOT is unset", { CI: "1" }],
            ["VIS_MONOREPO_ROOT is empty", { CI: "1", VIS_MONOREPO_ROOT: "" }],
            ["VIS_MONOREPO_ROOT is another directory", { CI: "1", VIS_MONOREPO_ROOT: "/work" }],
            ["FORCE_COLOR is set", { CI: "1", VIS_MONOREPO_ROOT: cwd, FORCE_COLOR: "1" }],
            ["CLICOLOR_FORCE is set", { CI: "1", VIS_MONOREPO_ROOT: cwd, CLICOLOR_FORCE: "1" }],
            ["GITHUB_ACTIONS is set", { CI: "1", VIS_MONOREPO_ROOT: cwd, GITHUB_ACTIONS: "true" }],
            ["TERM is a colour terminal", { CI: "1", VIS_MONOREPO_ROOT: cwd, TERM: "xterm-256color" }],
        ])("delegates `vis ignore` in Node when %s", (_label: string, environment: Record<string, string>) => {
            expect.assertions(1);

            expect(route(["ignore"], { environment })).toBe(false);
        });

        it("routes when TERM is dumb or mono", () => {
            expect.assertions(2);

            expect(route(["ignore"], { environment: { ...ciEnvironment, TERM: "dumb" } })).toBe(true);
            expect(route(["ignore"], { environment: { ...ciEnvironment, TERM: "xterm-mono" } })).toBe(true);
        });

        it("accepts CONTINUOUS_INTEGRATION as a CI context, as the binary does", () => {
            expect.assertions(1);

            expect(route(["ignore"], { environment: { CONTINUOUS_INTEGRATION: "true", VIS_MONOREPO_ROOT: cwd } })).toBe(true);
        });

        it("delegates when stdout or stderr is a terminal", () => {
            expect.assertions(1);

            expect(route(["ignore"], { interactive: true })).toBe(false);
        });

        it("delegates on Windows, where the binary never answers `ignore`", () => {
            expect.assertions(2);

            expect(route(["ignore"], { platform: "win32" })).toBe(false);
            expect(route(["ignore", "--target=npm", "--write"], { platform: "win32" })).toBe(false);
        });
    });
});
