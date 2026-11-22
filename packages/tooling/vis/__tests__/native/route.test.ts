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

    describe("`vis affected` flag shapes (answer in affected.rs)", () => {
        const ci = { CI: "1" };

        it.each([[["affected", "build", "--sparse-checkout"]], [["affected", "build", "--sparse-checkout", "--base=main", "--no-uncommitted"]]])(
            "routes `vis %j` in CI",
            (args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
            },
        );

        it.each([[["affected", "build"]], [["affected", "build", "--base=main"]], [["affected"]]])("keeps `vis %j` in Node: it forwards to `vis run`", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(false);
        });

        it("keeps `--sparse-checkout` in Node outside CI, on a terminal and on Windows", () => {
            expect.assertions(3);

            const args = ["affected", "build", "--sparse-checkout"];

            expect(routesToNative(args, "linux", {}, "/work/app", false)).toBe(false);
            expect(routesToNative(args, "linux", ci, "/work/app", true)).toBe(false);
            expect(routesToNative(args, "win32", ci, "/work/app", false)).toBe(false);
        });
    });

    describe("`vis clean` flag shapes (plan in clean.rs)", () => {
        const ci = { CI: "1" };

        it("routes `vis clean -l --dry-run` in CI", () => {
            expect.assertions(1);

            expect(routesToNative(["clean", "-l", "--dry-run"], "linux", ci, "/work/app", false)).toBe(true);
        });

        it("delegates `vis clean --empty-packages`", () => {
            expect.assertions(1);

            expect(routesToNative(["clean", "--empty-packages"], "linux", ci, "/work/app", false)).toBe(false);
        });
    });

    describe("`vis secrets` flag shapes (parse in secrets.rs)", () => {
        const ci = { CI: "1" };
        const route = (args: string[], environment: Record<string, string> = ci) => routesToNative(["secrets", ...args], "linux", environment, "/work/app", false);

        it.each([[["--format", "json"]], [["--format=sarif"]], [["--quiet"]], [["--quiet", "--format", "json"]], [["--format", "json", "--baseline", "b.json"]], [["--baseline=b.json", "--quiet"]]])(
            "routes `vis secrets %j` in CI",
            (args: string[]) => {
                expect.assertions(1);

                expect(route(args)).toBe(true);
            },
        );

        it.each([
            [[]],
            [["--format", "text"]],
            [["--format", "csv"]],
            [["--format"]],
            [["--format", "--quiet"]],
            [["--format", "json", "--format", "json"]],
            [["--quiet", "--quiet"]],
            [["--baseline"]],
            [["--format", "json", "--baseline="]],
            [["--format", "json", "--no-redact"]],
            [["--format", "json", "src"]],
            [["--staged"]],
        ])("delegates `vis secrets %j`", (args: string[]) => {
            expect.assertions(1);

            expect(route(args)).toBe(false);
        });

        it.each([[{}], [{ CI: "1", NODE_ENV: "test" }], [{ CI: "1", NODE_ENV: "debug" }], [{ CI: "1", DEBUG: "1" }], [{ CI: "1", PAIL_LOG_LEVEL: "error" }], [{ CEREBRO_OUTPUT_LEVEL: "16", CI: "1" }], [{ CI: "1", FORCE_COLOR: "1" }], [{ CI: "1", TERM: "xterm" }]])(
            "delegates a JSON scan in the environment %j",
            (environment: Record<string, string>) => {
                expect.assertions(1);

                expect(route(["--format", "json"], environment)).toBe(false);
            },
        );

        it("delegates on a terminal and on Windows", () => {
            expect.assertions(2);

            expect(routesToNative(["secrets", "--format", "json"], "linux", ci, "/work/app", true)).toBe(false);
            expect(routesToNative(["secrets", "--format", "json"], "win32", ci, "/work/app", false)).toBe(false);
        });

        it("renders the help surface natively on every platform", () => {
            expect.assertions(2);

            expect(routesToNative(["secrets", "--help"], "linux")).toBe(true);
            expect(routesToNative(["secrets", "--help"], "win32")).toBe(true);
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

    it.each([
        [["cache"], true],
        [["cache", "--help"], true],
        [["cache", "list", "--help"], true],
        // Only the plain shapes are the binary's; any other flag is Node's, which prints the same listing.
        [["cache", "--no-color"], false],
    ])("routes the `cache` group `vis %j` to native: %s", (args: string[], expected: boolean) => {
        expect.assertions(1);

        expect(routesToNative(args, "linux")).toBe(expected);
    });

    describe("`vis cache list|size` gate (cacheMayRunNatively)", () => {
        const ci = { CI: "1" };

        it.each([[["cache", "list"]], [["cache", "list", "--format", "json"]], [["cache", "size", "--type=ai"]], [["cache", "size", "--cache-dir", "x"]]])(
            "routes `vis %j` in a non-interactive CI context",
            (args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
            },
        );

        it.each([
            ["outside CI", "linux", {}, false],
            ["on a terminal", "linux", ci, true],
            ["on Windows", "win32", ci, false],
        ])("keeps `vis cache list` in Node %s", (_label: string, platform: string, environment: Record<string, string>, interactive: boolean) => {
            expect.assertions(1);

            expect(routesToNative(["cache", "list"], platform, environment, "/work/app", interactive)).toBe(false);
        });

        it("leaves the other cache subcommands to Node", () => {
            expect.assertions(1);

            expect(routesToNative(["cache", "clean"], "linux", ci, "/work/app", false)).toBe(false);
        });
    });

    describe("windows console (the binary enables virtual-terminal processing)", () => {
        it.each([
            [["clean", "--help"]],
            [["clean", "-h"]],
            [[]],
            [["--help"]],
            [["-h"]],
            [["help", "install"]],
            [["status", "--help"]],
            [["ignore", "--help"]],
            [["list", "--help"]],
            [["hook", "run", "--help"]],
            [["advisories", "bloom", "status", "--help"]],
            [["cache"]],
            [["cache", "--help"]],
        ])("routes the help surface `vis %j` to native", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "win32")).toBe(true);
        });

        it("still routes the native commands, and delegates the ones that answer natively only on unix", () => {
            expect.assertions(4);

            expect(routesToNative(["--version"], "win32")).toBe(true);
            expect(routesToNative(["clean", "--dry-run"], "win32", process.env, "/work/app", false)).toBe(false);
            expect(routesToNative(["hook", "run", "pre-commit"], "win32")).toBe(true);
            expect(routesToNative(["list"], "win32")).toBe(false);
        });
    });

    it.each([[["clean"]], [["clean", "--dry-run"]], [["clean", "--lockfile"]]])("keeps `vis %j` in Node when stdout is a terminal", (args: string[]) => {
        expect.assertions(1);

        expect(routesToNative(args, "linux", process.env, "/work/app", true)).toBe(false);
    });
});
