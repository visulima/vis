import { describe, expect, it } from "vitest";

import { routesToNative } from "../../bin/route.mjs";

describe("launcher routing (bin/route.mjs)", () => {
    // The cases both halves agree on live in native/cli/tests/fixtures/routing.json
    // (__tests__/native/routing-fixture.test.ts); what follows is launcher-only.
    describe("`vis list` flag shapes the binary would hand to Node anyway", () => {
        it.each([[["list", "--targets"]], [["list", "--format=ndjson"]], [["list", "--json", "--format=table"]]])("delegates `vis %j` in CI", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", { CI: "1" }, "/work/app", false)).toBe(false);
        });
    });

    describe("`vis clean` flag shapes (plan in clean.rs)", () => {
        const ci = { CI: "1" };

        it.each([[["clean", "--lockfile"]], [["clean", "-l", "--dry-run"]]])("routes `vis %j` in CI", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
        });

        it("delegates `vis clean --empty-packages`", () => {
            expect.assertions(1);

            expect(routesToNative(["clean", "--empty-packages"], "linux", ci, "/work/app", false)).toBe(false);
        });
    });

    describe("`vis ignore` gate (native_context in ignore.rs)", () => {
        const cwd = "/work/app";
        const ciEnvironment = { CI: "1", PATH: "/usr/bin", VIS_MONOREPO_ROOT: cwd };
        // Directories that hold a root marker. Only `cwd` by default, so the working directory is the root.
        const route = (args: string[], overrides: Partial<{ cwd: string; environment: Record<string, string>; markers: string[] }> = {}) => {
            const markedDirectories = new Set(overrides.markers ?? [cwd]);

            return routesToNative(
                args,
                "linux",
                overrides.environment ?? ciEnvironment,
                overrides.cwd ?? cwd,
                false,
                (directory: string) => markedDirectories.has(directory),
            );
        };

        it.each([
            ["CI is 0", { CI: "0", VIS_MONOREPO_ROOT: cwd }],
            ["CI is false", { CI: "false", VIS_MONOREPO_ROOT: cwd }],
            ["VIS_MONOREPO_ROOT is another directory", { CI: "1", VIS_MONOREPO_ROOT: "/work" }],
            ["CLICOLOR_FORCE is set", { CI: "1", CLICOLOR_FORCE: "1", VIS_MONOREPO_ROOT: cwd }],
            ["TERM is a colour terminal", { CI: "1", TERM: "xterm-256color", VIS_MONOREPO_ROOT: cwd }],
        ])("delegates `vis ignore` in Node when %s", (_label: string, environment: Record<string, string>) => {
            expect.assertions(1);

            expect(route(["ignore"], { environment })).toBe(false);
        });

        it.each([
            ["VIS_MONOREPO_ROOT is unset", { CI: "1" }],
            ["VIS_MONOREPO_ROOT is empty", { CI: "1", VIS_MONOREPO_ROOT: "" }],
        ])("routes `vis ignore` when %s, since the gate computes the root itself", (_label: string, environment: Record<string, string>) => {
            expect.assertions(1);

            expect(route(["ignore"], { environment })).toBe(true);
        });

        it.each([
            ["an ancestor holds a marker", { markers: [cwd, "/work"] }],
            ["the filesystem root holds a marker", { markers: [cwd, "/"] }],
            ["the working directory holds no marker", { markers: ["/work"] }],
            ["no directory holds a marker", { markers: [] }],
        ])("delegates `vis ignore` in Node when %s", (_label: string, overrides: { markers: string[] }) => {
            expect.assertions(1);

            expect(route(["ignore"], overrides)).toBe(false);
        });

        it("routes when TERM is mono", () => {
            expect.assertions(1);

            expect(route(["ignore"], { environment: { ...ciEnvironment, TERM: "xterm-mono" } })).toBe(true);
        });

        it("accepts CONTINUOUS_INTEGRATION as a CI context, as the binary does", () => {
            expect.assertions(1);

            expect(route(["ignore"], { environment: { CONTINUOUS_INTEGRATION: "true", VIS_MONOREPO_ROOT: cwd } })).toBe(true);
        });
    });
});
