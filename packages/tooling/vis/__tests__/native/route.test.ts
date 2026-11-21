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
        // `clean` depends on the environment (below).
        // Natively implemented commands.
        [["--version"], true],
        [["-V"], true],
        [["exec", "tsc"], true],
        [["pm", "list"], true],
        [["why", "left-pad"], true],
        // Everything else stays in-process.
        [["status", "--json"], false],
        [["run", "build"], false],
        [["-v"], false],
    ])("routes `vis %j` to native: %s", (args: string[], expected: boolean) => {
        expect.assertions(1);

        expect(routesToNative(args, "linux")).toBe(expected);
    });

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
    ])("routes the help surface `vis %j` to native on Windows, where the binary enables virtual-terminal processing", (args: string[]) => {
        expect.assertions(1);

        expect(routesToNative(args, "win32")).toBe(true);
    });

    it.each([[["clean"]], [["clean", "--dry-run"]], [["clean", "--lockfile"]]])(
        "keeps `vis %j` in Node when stdout is a terminal",
        (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", process.env, "/work/app", true)).toBe(false);
        },
    );

    it("still routes the native commands on Windows", () => {
        expect.assertions(4);

        // `clean`, `ignore` and `list` answer natively only on unix; elsewhere the binary delegates.
        expect(routesToNative(["--version"], "win32")).toBe(true);
        expect(routesToNative(["clean", "--dry-run"], "win32", process.env, "/work/app", false)).toBe(false);
        expect(routesToNative(["hook", "run", "pre-commit"], "win32")).toBe(true);
        expect(routesToNative(["list"], "win32")).toBe(false);
    });

    describe("`vis list` gate (run in list.rs)", () => {
        const ci = { CI: "1" };

        it.each([[["list"]], [["list", "--json"]], [["list", "--format=table"]], [["list", "--format", "json"]]])(
            "routes plain `vis %j` in CI",
            (args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
            },
        );

        it.each([[["list", "--deps"]], [["list", "--targets"]], [["list", "--format=ndjson"]], [["list", "--json", "--format=table"]], [["list", "extra"]]])(
            "delegates `vis %j`, which the binary would hand to Node anyway",
            (args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(false);
            },
        );

        it("delegates an interactive run, which prints tips to stderr", () => {
            expect.assertions(1);

            expect(routesToNative(["list"], "linux", ci, "/work/app", true)).toBe(false);
        });

        it("delegates outside CI", () => {
            expect.assertions(1);

            expect(routesToNative(["list"], "linux", {}, "/work/app", false)).toBe(false);
        });

        it("keeps `list --help` native on every platform", () => {
            expect.assertions(2);

            expect(routesToNative(["list", "--help"], "linux", {}, "/work/app", false)).toBe(true);
            expect(routesToNative(["list", "--help"], "win32", {}, "/work/app", false)).toBe(true);
        });
    });

    describe("`vis clean` gate (plan in clean.rs)", () => {
        const cwd = "/work/app";
        const ci = { CI: "1" };

        it.each([[["clean"]], [["clean", "--dry-run"]], [["clean", "--lockfile"]], [["clean", "-l", "--dry-run"]]])(
            "routes plain `vis %j` in CI",
            (args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "linux", ci, cwd, false)).toBe(true);
            },
        );

        it.each([[["clean", "--empty-packages"]], [["clean", "--dry-run", "--dry-run"]], [["clean", "--other"]]])(
            "delegates `vis %j`, which the binary would hand to Node anyway",
            (args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "linux", ci, cwd, false)).toBe(false);
            },
        );

        it("delegates outside CI", () => {
            expect.assertions(1);

            expect(routesToNative(["clean"], "linux", {}, cwd, false)).toBe(false);
        });

        it("delegates when a colour variable is set", () => {
            expect.assertions(1);

            expect(routesToNative(["clean"], "linux", { ...ci, FORCE_COLOR: "1" }, cwd, false)).toBe(false);
        });

        it("delegates when stdout or stderr is a terminal", () => {
            expect.assertions(1);

            expect(routesToNative(["clean"], "linux", ci, cwd, true)).toBe(false);
        });

        it("delegates when GITHUB_ACTIONS is set, as the binary's colour gate does", () => {
            expect.assertions(1);

            expect(routesToNative(["clean"], "linux", { ...ci, GITHUB_ACTIONS: "true" }, cwd, false)).toBe(false);
        });

        it("delegates when TERM is a colour terminal, and routes when it is dumb", () => {
            expect.assertions(2);

            expect(routesToNative(["clean"], "linux", { ...ci, TERM: "xterm" }, cwd, false)).toBe(false);
            expect(routesToNative(["clean"], "linux", { ...ci, TERM: "dumb" }, cwd, false)).toBe(true);
        });
    });

    describe("`vis ignore` gate (native_context in ignore.rs)", () => {
        const cwd = "/work/app";
        const ciEnvironment = { CI: "1", PATH: "/usr/bin", VIS_MONOREPO_ROOT: cwd };
        // Directories that hold a root marker. Only `cwd` by default, so the working directory is the root.
        const route = (
            args: string[],
            overrides: Partial<{ cwd: string; environment: Record<string, string>; interactive: boolean; markers: string[]; platform: string }> = {},
        ) => {
            const markedDirectories = new Set(overrides.markers ?? [cwd]);

            return routesToNative(
                args,
                overrides.platform ?? "linux",
                overrides.environment ?? ciEnvironment,
                overrides.cwd ?? cwd,
                overrides.interactive ?? false,
                (directory: string) => markedDirectories.has(directory),
            );
        };

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
            ["VIS_MONOREPO_ROOT is another directory", { CI: "1", VIS_MONOREPO_ROOT: "/work" }],
            ["FORCE_COLOR is set", { CI: "1", FORCE_COLOR: "1", VIS_MONOREPO_ROOT: cwd }],
            ["CLICOLOR_FORCE is set", { CI: "1", CLICOLOR_FORCE: "1", VIS_MONOREPO_ROOT: cwd }],
            ["GITHUB_ACTIONS is set", { CI: "1", GITHUB_ACTIONS: "true", VIS_MONOREPO_ROOT: cwd }],
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
