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

    describe("`vis install` flag shapes (plan in install.rs)", () => {
        const ci = { CI: "1" };

        it.each([[["install"]], [["i"]], [["install", "-D", "--silent"]], [["install", "-F", "app", "--filter=lib"]], [["install", "--no-frozen-lockfile", "--lockfile-only"]]])(
            "routes `vis %j` in CI",
            (args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
            },
        );

        it.each([
            [["install", "react"]],
            [["install", "--ci"]],
            [["install", "--force", "--force"]],
            [["install", "-D", "--prod"]],
            [["install", "--frozen-lockfile", "--no-frozen-lockfile"]],
            [["install", "-F"]],
            [["install", "--filter", "-D"]],
            [["install", "--filter="]],
            [["install", "--cwd", "x"]],
        ])("keeps `vis %j` in Node", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(false);
        });

        it("keeps a plain install in Node outside CI, on a terminal, on Windows and where output settings could change", () => {
            expect.assertions(5);

            expect(routesToNative(["install"], "linux", {}, "/work/app", false)).toBe(false);
            expect(routesToNative(["install"], "linux", ci, "/work/app", true)).toBe(false);
            expect(routesToNative(["install"], "win32", ci, "/work/app", false)).toBe(false);
            expect(routesToNative(["install"], "linux", { ...ci, MARSHALL_DISABLE_ALL: "1" }, "/work/app", false)).toBe(false);
            expect(routesToNative(["install"], "linux", { ...ci, VIS_INSTALLER: "npm" }, "/work/app", false)).toBe(false);
        });
    });

    describe("`vis add` flag shapes (plan in add.rs)", () => {
        const ci = { CI: "1" };
        const flag = "--no-marshall-check";

        it.each([
            [["add", "react", flag]],
            [["add", flag, "react", "@scope/pkg@^1.2.0", "alias@npm:real@1"]],
            [["add", "react", "-D", "lodash", "-E", flag]],
            [["add", "react", flag, "-F", "app", "--filter=lib"]],
            [["add", "react", "-g", "-w", "-O", "-P", "--workspace", "--run-scripts", "--no-socket-check", "--no-typosquat-check", flag]],
            // Without the flag the binary runs the marshall check itself.
            [["add", "react"]],
            [["add", "react@18.2.0", "-D", "@scope/pkg@^1.2.0"]],
        ])("routes `vis %j` in CI", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
        });

        it.each([
            [["add"]],
            [["add", flag]],
            [["add", "-D", flag]],
            [["add", "-F", "app", "react", flag]],
            [["add", "--filter=app", "react", flag]],
            [["add", "react", flag, "-F", "app", "lodash"]],
            [["add", "react", flag, "-F"]],
            [["add", "react", flag, "-D", "-D"]],
            [["add", "react", flag, flag]],
            [["add", "react", flag, "-r"]],
            [["add", "react", flag, "--to", "web"]],
            [["add", "react", flag, "--auto-install-peers"]],
            [["add", "react", flag, "--exact=true"]],
            [["add", "react", flag, "--"]],
            [["add", "./local", flag]],
            [["add", "react@", flag]],
            [["add", "git+https://example.test/a.git", flag]],
        ])("keeps `vis %j` in Node", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(false);
        });

        it("reads the MARSHALL_DISABLE_* variables of the marshalls the check runs, and keeps every other MARSHALL_* variable in Node", () => {
            expect.assertions(6);

            const add = ["add", "react@18.2.0"];

            expect(routesToNative(add, "linux", { ...ci, MARSHALL_DISABLE_AUTHOR: "1", MARSHALL_DISABLE_EXPIRED_DOMAINS: "1" }, "/work/app", false)).toBe(true);
            expect(routesToNative(add, "linux", { ...ci, MARSHALL_DISABLE_NEW_BIN: "0" }, "/work/app", false)).toBe(true);

            for (const variable of ["MARSHALL_DISABLE_ALL", "MARSHALL_DISABLE_TYPOSQUATS", "MARSHALL_DISABLE_SOCKET", "MARSHALL_OTHER"]) {
                expect(routesToNative(add, "linux", { ...ci, [variable]: "1" }, "/work/app", false)).toBe(false);
            }
        });

        it("keeps the check's requests where fetch would go: a proxy or CA setting keeps the add in Node, unless there is no check", () => {
            expect.assertions(3);

            expect(routesToNative(["add", "react"], "linux", { ...ci, HTTPS_PROXY: "http://proxy.test:3128" }, "/work/app", false)).toBe(false);
            expect(routesToNative(["add", "react"], "linux", { ...ci, NODE_EXTRA_CA_CERTS: "/ca.pem" }, "/work/app", false)).toBe(false);
            expect(routesToNative(["add", "react", flag], "linux", { ...ci, HTTPS_PROXY: "http://proxy.test:3128" }, "/work/app", false)).toBe(true);
        });

        it("keeps the add in Node outside CI, on a terminal, on Windows and where output settings could change", () => {
            expect.assertions(6);

            const add = ["add", "react", flag];

            expect(routesToNative(add, "linux", {}, "/work/app", false)).toBe(false);
            expect(routesToNative(add, "linux", ci, "/work/app", true)).toBe(false);
            expect(routesToNative(add, "win32", ci, "/work/app", false)).toBe(false);
            expect(routesToNative(add, "linux", { ...ci, GITHUB_ACTIONS: "true" }, "/work/app", false)).toBe(false);
            expect(routesToNative(add, "linux", { ...ci, MARSHALL_DISABLE_ALL: "1" }, "/work/app", false)).toBe(false);
            expect(routesToNative(add, "linux", { ...ci, VIS_INSTALLER: "npm" }, "/work/app", false)).toBe(false);
        });
    });

    describe("`vis info` / `vis view` flag shapes (plan in info.rs)", () => {
        const ci = { CI: "1", COLUMNS: "80" };

        it.each([
            [["info", "react"]],
            [["view", "react", "version", "--json"]],
            [["info", "--json", "@scope/pkg@^1.2.0", "dist.tarball", "dist-tags.latest"]],
        ])("routes `vis %j` in CI", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
        });

        it.each([
            [["info"]],
            [["info", "--json"]],
            [["info", "react", "--json", "--json"]],
            [["info", "react", "--registry=https://x.test"]],
            [["info", "react", "--"]],
            [["info", "react", "-x"]],
            [["info", "react", "18"]],
            [["info", "react", "true"]],
            [["info", "react", ""]],
            [["info", "-rf"]],
            [["info", "./local"]],
        ])("keeps `vis %j` in Node", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(false);
        });

        it("keeps the view in Node outside CI, on a terminal, on Windows and where output settings could change", () => {
            expect.assertions(6);

            const info = ["info", "react"];

            expect(routesToNative(info, "linux", {}, "/work/app", false)).toBe(false);
            expect(routesToNative(info, "linux", ci, "/work/app", true)).toBe(false);
            expect(routesToNative(info, "win32", ci, "/work/app", false)).toBe(false);
            expect(routesToNative(info, "linux", { ...ci, DEBUG: "*" }, "/work/app", false)).toBe(false);
            expect(routesToNative(info, "linux", { ...ci, VIS_INSTALLER: "npm" }, "/work/app", false)).toBe(false);
            expect(routesToNative(info, "linux", { ...ci, CEREBRO_OUTPUT_LEVEL: "1" }, "/work/app", false)).toBe(false);
        });
    });

    describe("`vis dlx` flag shapes (plan in dlx.rs)", () => {
        it.each([
            [["dlx", "--no-info", "cowsay"]],
            [["dlx", "--no-info", "cowsay", "hi", "--silent", "-y"]],
            [["dlx", "--no-info", "-p", "lolcatjs", "-s", "cowsay"]],
            [["dlx", "--no-info", "-p", "a", "-p", "b", "--shell-mode", "echo hi"]],
            [["dlx", "--no-info", "--offline", "@scope/pkg@^1", "a", "b"]],
            [["dlx", "-c", "echo hi"]],
            [["dlx", "./local.js", "a"]],
            [["dlx", "git+https://example.test/a.git"]],
            [["dlx", "npm:cowsay@1"]],
            [["dlx", "-p", "./local.tgz", "-c", "echo hi"]],
            // The first-run gate is the binary's to decide: it does nothing with `--yes`, in CI and off a terminal, and on a
            // terminal it answers only for a version that was approved.
            [["dlx", "cowsay"]],
            [["dlx", "--yes", "cowsay"]],
            [["dlx", "cowsay", "-y"]],
            [["dlx", "-p", "lolcatjs", "-c", "echo hi"]],
            [["dlx", "-p", "lolcatjs", "-c", "./local.js"]],
        ])("routes `vis %j`, whatever the terminal and CI", (args: string[]) => {
            expect.assertions(3);

            expect(routesToNative(args, "linux", {}, "/work/app", false)).toBe(true);
            expect(routesToNative(args, "linux", { CI: "1" }, "/work/app", true)).toBe(true);
            expect(routesToNative(args, "linux", { COLUMNS: "20", FORCE_COLOR: "1" }, "/work/app", false)).toBe(true);
        });

        it.each([
            // `--info` shows the panel on every run, which Node renders.
            [["dlx", "--info", "cowsay"]],
            // Shapes of the command line.
            [["dlx"]],
            [["dlx", "--no-info"]],
            [["dlx", "--no-info", "cowsay", "--"]],
            [["dlx", "--no-info", "cowsay", "--version"]],
            [["dlx", "--no-info", "cowsay", "-x"]],
            [["dlx", "--no-info", "-sc", "echo"]],
            [["dlx", "--no-info", "cowsay", "-s", "-s"]],
            [["dlx", "--no-info", "-p", "a", "b", "c"]],
            [["dlx", "--no-info", "-p", "a", "cowsay"]],
            [["dlx", "--no-info", "--package=a", "-c", "x"]],
            [["dlx", "--no-info", "-p", "-c", "x"]],
            [["dlx", "--no-info", "cowsay", "--yes=false"]],
        ])("keeps `vis %j` in Node", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", {}, "/work/app", false)).toBe(false);
        });

        it("keeps the dlx in Node on Windows and where the environment changes the installer or Node's output", () => {
            expect.assertions(8);

            const dlx = ["dlx", "--no-info", "cowsay"];

            expect(routesToNative(dlx, "win32", {}, "/work/app", false)).toBe(false);
            expect(routesToNative(dlx, "linux", { VIS_INSTALLER: "npm" }, "/work/app", false)).toBe(false);
            expect(routesToNative(dlx, "linux", { VIS_RUNTIME: "bun" }, "/work/app", false)).toBe(false);
            expect(routesToNative(dlx, "linux", { DEBUG: "*" }, "/work/app", false)).toBe(false);
            expect(routesToNative(dlx, "linux", { CEREBRO_OUTPUT_LEVEL: "1" }, "/work/app", false)).toBe(false);
            expect(routesToNative(dlx, "linux", { FORCE_COLOR: "1", NO_COLOR: "1" }, "/work/app", false)).toBe(false);
            expect(routesToNative(dlx, "linux", { FORCE_COLOR: "1", NODE_DISABLE_COLORS: "1" }, "/work/app", false)).toBe(false);
            expect(routesToNative(["dlx", "--help"], "win32", {}, "/work/app", false)).toBe(true);
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
        const root = "/work/app";
        // `root` holds the only root marker, so a working directory below it is not the workspace root.
        const route = (args: string[], environment: Record<string, string> = ci, cwd = root) =>
            routesToNative(["secrets", ...args], "linux", environment, cwd, false, (directory: string) => directory === root);

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

        it.each([[{}], [{ CI: "1", NODE_ENV: "test" }], [{ CI: "1", NODE_ENV: "debug" }], [{ CI: "1", DEBUG: "1" }], [{ CI: "1", PAIL_LOG_LEVEL: "error" }], [{ CEREBRO_OUTPUT_LEVEL: "16", CI: "1" }], [{ CI: "1", FORCE_COLOR: "1", NO_COLOR: "1" }]])(
            "delegates a JSON scan in the environment %j",
            (environment: Record<string, string>) => {
                expect.assertions(1);

                expect(route(["--format", "json"], environment)).toBe(false);
            },
        );

        it("delegates from a directory below the workspace root, and from one that is not the inherited root", () => {
            expect.assertions(3);

            expect(route(["--format", "json"], ci, `${root}/packages/a`)).toBe(false);
            expect(route(["--format", "json"], { ...ci, VIS_MONOREPO_ROOT: "/work/other" })).toBe(false);
            expect(route(["--format", "json"], { ...ci, VIS_MONOREPO_ROOT: root })).toBe(true);
        });

        it("delegates on a terminal and on Windows", () => {
            expect.assertions(2);

            expect(routesToNative(["secrets", "--format", "json"], "linux", ci, root, true, (directory: string) => directory === root)).toBe(false);
            expect(routesToNative(["secrets", "--format", "json"], "win32", ci, root, false, (directory: string) => directory === root)).toBe(false);
        });

        it("renders the help surface natively on every platform", () => {
            expect.assertions(2);

            expect(routesToNative(["secrets", "--help"], "linux")).toBe(true);
            expect(routesToNative(["secrets", "--help"], "win32")).toBe(true);
        });
    });

    describe("`vis sync ci-workflow` flag shapes (parse in ci_workflow/mod.rs)", () => {
        const ci = { CI: "1" };
        const root = "/work/app";
        const route = (args: string[], environment: Record<string, string> = ci, cwd = root) =>
            routesToNative(["sync", "ci-workflow", ...args], "linux", environment, cwd, false, (directory: string) => directory === root);

        it.each([[[]], [["--check"]], [["--provider=github"]], [["--provider", "github,gitlab"]], [["--provider=github", "--provider=gitlab", "--check"]], [["--check", "--provider", "gitlab"]]])(
            "routes `vis sync ci-workflow %j` in CI",
            (args: string[]) => {
                expect.assertions(1);

                expect(route(args)).toBe(true);
            },
        );

        it.each([[["--check", "--check"]], [["--provider"]], [["--provider="]], [["--provider", "--check"]], [["--format=json"]], [["extra"]], [["--check=false"]]])(
            "delegates `vis sync ci-workflow %j`",
            (args: string[]) => {
                expect.assertions(1);

                expect(route(args)).toBe(false);
            },
        );

        it.each([[{}], [{ CI: "1", NODE_ENV: "test" }], [{ CI: "1", NODE_ENV: "debug" }], [{ CI: "1", DEBUG: "1" }], [{ CI: "1", PAIL_LOG_LEVEL: "error" }], [{ CEREBRO_OUTPUT_LEVEL: "16", CI: "1" }], [{ CI: "1", FORCE_COLOR: "1", NO_COLOR: "1" }]])(
            "delegates in the environment %j",
            (environment: Record<string, string>) => {
                expect.assertions(1);

                expect(route(["--check"], environment)).toBe(false);
            },
        );

        it("delegates from a directory below the workspace root, on a terminal and on Windows, and leaves the other kinds to Node", () => {
            expect.assertions(5);

            expect(route([], ci, `${root}/packages/a`)).toBe(false);
            expect(routesToNative(["sync", "ci-workflow"], "linux", ci, root, true, (directory: string) => directory === root)).toBe(false);
            expect(routesToNative(["sync", "ci-workflow"], "win32", ci, root, false, (directory: string) => directory === root)).toBe(false);
            expect(routesToNative(["sync", "codeowners"], "linux", ci, root, false, (directory: string) => directory === root)).toBe(false);
            expect(routesToNative(["sync", "ci-workflow", "--help"], "win32")).toBe(true);
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
            ["FORCE_COLOR and NO_COLOR are both set", { CI: "1", FORCE_COLOR: "1", NO_COLOR: "1", VIS_MONOREPO_ROOT: cwd }],
            ["a PM2 process runs it without CI set", { CONTINUOUS_INTEGRATION: "1", PM2_HOME: "/home/pm2", pm_id: "0", VIS_MONOREPO_ROOT: cwd }],
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

        it("routes whatever TERM is, since it prints no pail line whose width could change", () => {
            expect.assertions(2);

            expect(route(["ignore"], { environment: { ...ciEnvironment, TERM: "dumb" } })).toBe(true);
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

            expect(routesToNative(["cache", "doctor"], "linux", ci, "/work/app", false)).toBe(false);
        });
    });

    describe("`vis cache clean` gate (cacheCleanMayRunNatively)", () => {
        const ci = { CI: "1" };

        it.each([
            [["cache", "clean"]],
            [["cache", "clean", "--dry-run"]],
            [["cache", "clean", "--force", "--type", "task"]],
            [["cache", "clean", "--type=ai", "--cache-dir", "x"]],
        ])("routes `vis %j` in a non-interactive CI context", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
        });

        it.each([
            [["cache", "clean", "--scope", "all"]],
            [["cache", "clean", "extra"]],
            [["cache", "clean", "--no-color"]],
            [["cache", "clean", "--dry-run=true"]],
        ])("keeps `vis %j` in Node", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(false);
        });

        it.each([
            ["outside CI", "linux", {}, false],
            ["on a terminal", "linux", ci, true],
            ["on Windows", "win32", ci, false],
        ])("keeps `vis cache clean` in Node %s", (_label: string, platform: string, environment: Record<string, string>, interactive: boolean) => {
            expect.assertions(1);

            expect(routesToNative(["cache", "clean"], platform, environment, "/work/app", interactive)).toBe(false);
        });
    });

    describe("`vis cache prune` gate (cachePruneMayRunNatively)", () => {
        const ci = { CI: "1" };

        it.each([
            [["cache", "prune"]],
            [["cache", "prune", "--keep-last", "30"]],
            [["cache", "prune", "--max-age-days=3", "--max-size", "500MB"]],
            [["cache", "prune", "--scope", "all", "--cache-dir", "x"]],
        ])("routes `vis %j` in a non-interactive CI context", (args: string[]) => {
            expect.assertions(1);

            expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(true);
        });

        it.each([[["cache", "prune", "--dry-run"]], [["cache", "prune", "extra"]], [["cache", "prune", "--no-color"]], [["cache", "prune", "--keep-last", "-1"]]])(
            "keeps `vis %j` in Node",
            (args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "linux", ci, "/work/app", false)).toBe(false);
            },
        );

        it.each([
            ["outside CI", "linux", {}, false],
            ["on a terminal", "linux", ci, true],
            ["on Windows", "win32", ci, false],
        ])("keeps `vis cache prune` in Node %s", (_label: string, platform: string, environment: Record<string, string>, interactive: boolean) => {
            expect.assertions(1);

            expect(routesToNative(["cache", "prune"], platform, environment, "/work/app", interactive)).toBe(false);
        });
    });

    // The binary decides pail's colour itself (`piped_colour_level` in term.rs, the same rules as Node's detection) and prints
    // the codes Node prints, so a colour environment no longer keeps a command in Node. What it cannot decide stays there.
    describe("colour environments", () => {
        const cwd = "/work/app";
        const holdsMarker = (directory: string): boolean => directory === cwd;

        // One invocation per command that prints through pail or colours a line (`task-why` prints the same in every colour environment), each in a CI context.
        const COMMANDS: [string, string[], Record<string, string>][] = [
            ["clean", ["clean"], { CI: "1" }],
            ["ignore", ["ignore"], { CI: "1" }],
            ["install", ["install"], { CI: "1" }],
            ["cache clean", ["cache", "clean", "--dry-run"], { CI: "1" }],
            ["cache hash", ["cache", "hash", "app:build"], { CI: "1" }],
            ["cache prune", ["cache", "prune"], { CI: "1" }],
            ["cache why", ["cache", "why", "app:build"], { CI: "1" }],
            ["replay", ["replay"], { CI: "1" }],
            ["secrets", ["secrets", "--format", "json"], { CI: "1" }],
            ["sync ci-workflow", ["sync", "ci-workflow", "--provider=github"], { CI: "1" }],
            ["task-why", ["task-why", "app:build"], { CI: "1" }],
            ["staged", ["staged", "--quiet"], { CI: "1" }],
        ];

        // The commands whose output holds a pail line, whose width pail looks up (`tput`) under `TERM`.
        const PRINTS_PAIL_LINES = new Set(["cache clean", "cache hash", "cache prune", "cache why", "clean", "install", "replay", "secrets"]);

        const ANSWERED: Record<string, string>[] = [
            { GITHUB_ACTIONS: "true" },
            { GITHUB_WORKFLOW: "w" },
            { GITEA_ACTIONS: "true" },
            { CIRCLECI: "true" },
            { GITLAB_CI: "true" },
            { BUILDKITE: "true" },
            { TRAVIS: "true" },
            { APPVEYOR: "true" },
            { DRONE: "true" },
            { TF_BUILD: "True" },
            { TEAMCITY_VERSION: "2024.1.1" },
            { FORCE_COLOR: "0" },
            { FORCE_COLOR: "1" },
            { FORCE_COLOR: "3" },
            { FORCE_COLOR: "true" },
            { NO_COLOR: "1" },
            { TERM: "xterm-256color" },
            { TERM: "xterm" },
            { TERM: "tmux-256color" },
            { TERM: "dumb" },
            { COLORTERM: "truecolor" },
            // `NODE_DISABLE_COLORS` alone is not read by the detection.
            { NODE_DISABLE_COLORS: "1" },
            { TERM_PROGRAM: "vscode" },
            { CLICOLOR_FORCE: "1" },
            // A PM2 process needs `pm_id` as well to count as a terminal.
            { PM2_HOME: "/home/pm2" },
            { FORCE_COLOR: "2", GITHUB_ACTIONS: "true", TERM: "dumb" },
        ];

        const route = (args: string[], environment: Record<string, string>): boolean =>
            routesToNative(args, "linux", environment, cwd, false, holdsMarker);

        it.each(COMMANDS.flatMap(([name, args, base]) => ANSWERED.map((colour) => [name, args, base, colour] as const)))(
            "routes `vis %s` to the binary with %j",
            (_name: string, args: string[], base: Record<string, string>, colour: Record<string, string>) => {
                expect.assertions(1);

                expect(route(args, { ...base, ...colour })).toBe(true);
            },
        );

        it.each(
            COMMANDS.flatMap(([name, args, base]) =>
                [
                    // The Node runtime warns on stderr, with its process id, when both are set.
                    { FORCE_COLOR: "1", NO_COLOR: "1" },
                    { FORCE_COLOR: "0", NO_COLOR: "" },
                    { FORCE_COLOR: "1", NODE_DISABLE_COLORS: "1" },
                ].map((colour) => [name, args, base, colour] as const),
            ),
        )("keeps `vis %s` in Node with %j", (_name: string, args: string[], base: Record<string, string>, colour: Record<string, string>) => {
            expect.assertions(1);

            expect(route(args, { ...base, ...colour })).toBe(false);
        });

        it("keeps a PM2 process in Node unless CI is set, where Node's CI provider checks come before it", () => {
            expect.assertions(2);

            // Node counts a PM2 process as a terminal; its detection only looks at that after the CI providers.
            expect(routesToNative(["clean"], "linux", { CONTINUOUS_INTEGRATION: "1", PM2_HOME: "/home/pm2", pm_id: "0" }, cwd, false, holdsMarker)).toBe(false);
            expect(routesToNative(["clean"], "linux", { CI: "1", PM2_HOME: "/home/pm2", pm_id: "0" }, cwd, false, holdsMarker)).toBe(true);
        });

        // pail asks `tput` for its width under `TERM`, and a wide or unknown entry gives another one than 80. A command without
        // a pail line (ignore, sync ci-workflow) does not care.
        it.each(COMMANDS.flatMap(([name, args, base]) => ["vt100-w", "screen-w", "iTerm.app", "xterm-mono"].map((term) => [name, args, base, term] as const)))(
            "routes `vis %s` with TERM=%s as its pail lines allow",
            (name: string, args: string[], base: Record<string, string>, term: string) => {
                expect.assertions(1);

                expect(route(args, { ...base, TERM: term })).toBe(!PRINTS_PAIL_LINES.has(name));
            },
        );

        it.each(COMMANDS)("keeps `vis %s` with a colour flag in Node, which reads its colour from the arguments", (_name: string, args: string[], base: Record<string, string>) => {
            expect.assertions(4);

            for (const flag of ["--no-color", "--color", "--colors", "--color=256"]) {
                expect(route([...args, flag], { ...base, GITHUB_ACTIONS: "true" })).toBe(false);
            }
        });

        it("still keeps a terminal, a missing CI marker and Windows in Node, whatever the colour environment", () => {
            expect.assertions(3);

            expect(routesToNative(["clean"], "linux", { CI: "1", GITHUB_ACTIONS: "true" }, cwd, true, holdsMarker)).toBe(false);
            expect(routesToNative(["clean"], "linux", { GITHUB_ACTIONS: "true" }, cwd, false, holdsMarker)).toBe(false);
            expect(routesToNative(["clean"], "win32", { CI: "1", GITHUB_ACTIONS: "true" }, cwd, false, holdsMarker)).toBe(false);
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
            expect.assertions(3);

            expect(routesToNative(["--version"], "win32")).toBe(true);
            expect(routesToNative(["clean", "--dry-run"], "win32", process.env, "/work/app", false)).toBe(false);
            expect(routesToNative(["hook", "run", "pre-commit"], "win32")).toBe(true);
        });

        // The binary prints the same bytes as Node for these on Windows (native/cli/tests/windows_node_parity.rs), so the
        // launcher hands them over there exactly as it does elsewhere: in CI, off a terminal, with no output setting.
        describe("the read-only commands that answer natively on Windows too", () => {
            const ci = { CI: "1" };
            // The one directory with a root marker: the binary's root is the working directory.
            const root = String.raw`C:\work\app`;
            const holdsMarker = (directory: string) => directory === root;
            const commands = [
                ["list"],
                ["list", "--json"],
                ["graph"],
                ["graph", "--format", "json"],
                ["graph", "--format=dot", "--depth", "2"],
                ["status"],
                ["status", "--json"],
                ["task-why", "a:build"],
                ["hook", "list"],
                ["hook", "list", "--hooks-dir=.husky"],
                ["deps"],
                ["deps", "--format", "json"],
                ["deps", "--quiet"],
            ];

            it.each(commands)("routes `vis %s` in CI", (...args: string[]) => {
                expect.assertions(1);

                expect(routesToNative(args, "win32", ci, root, false, holdsMarker)).toBe(true);
            });

            it("keeps `vis hook validate` in Node on Windows only: the binary reads file modes and runs `sh -n` on unix", () => {
                expect.assertions(2);

                expect(routesToNative(["hook", "validate"], "win32", ci, root, false, holdsMarker)).toBe(false);
                expect(routesToNative(["hook", "validate"], "linux", ci, "/work/app", false, (directory: string) => directory === "/work/app")).toBe(true);
            });

            it("keeps the other commands that wait for their Windows capture in Node", () => {
                expect.assertions(4);

                for (const args of [["shim", "status"], ["inspect", "left-pad"], ["audit", "--format", "json"], ["optimize"]]) {
                    expect(routesToNative(args, "win32", ci, root, false, holdsMarker)).toBe(false);
                }
            });

            it.each(commands)("keeps `vis %s` in Node outside CI, on a terminal and where the colour or output settings are unusual", (...args: string[]) => {
                expect.assertions(5);

                expect(routesToNative(args, "win32", {}, root, false, holdsMarker)).toBe(false);
                expect(routesToNative(args, "win32", ci, root, true, holdsMarker)).toBe(false);
                expect(routesToNative(args, "win32", { ...ci, FORCE_COLOR: "1", NO_COLOR: "1" }, root, false, holdsMarker)).toBe(false);
                expect(routesToNative(args, "win32", { ...ci, DEBUG: "vis" }, root, false, holdsMarker)).toBe(false);
                expect(routesToNative(args, "win32", { ...ci, NODE_ENV: "test" }, root, false, holdsMarker)).toBe(false);
            });
        });
    });

    describe("`vis run <target>` (answered when every task hits, on Windows too)", () => {
        const ci = { CI: "1" };
        const root = String.raw`C:\work\app`;
        const holdsMarker = (directory: string) => directory === root;
        const cache = () => true;
        const args = ["run", "build"];

        it("routes a plain run from a workspace root that has a task cache, on Windows and elsewhere", () => {
            expect.assertions(2);

            expect(routesToNative(args, "win32", ci, root, false, holdsMarker, cache)).toBe(true);
            expect(routesToNative(args, "linux", ci, "/work/app", false, (directory: string) => directory === "/work/app", cache)).toBe(true);
        });

        it("keeps a run without a task cache in Node: nothing can hit", () => {
            expect.assertions(1);

            expect(routesToNative(args, "win32", ci, root, false, holdsMarker, () => false)).toBe(false);
        });

        it("keeps a run from below the workspace root, and one whose root another process named, in Node on Windows", () => {
            expect.assertions(3);

            expect(routesToNative(args, "win32", ci, String.raw`C:\work\app\packages\a`, false, holdsMarker, cache)).toBe(false);
            expect(routesToNative(args, "win32", { ...ci, VIS_MONOREPO_ROOT: "C:/elsewhere" }, root, false, holdsMarker, cache)).toBe(false);
            expect(routesToNative(args, "win32", { ...ci, VIS_MONOREPO_ROOT: "C:/work/app" }, root, false, holdsMarker, cache)).toBe(false);
        });

        it.each([[["run"]], [["run", "build", "--parallel=2"]], [["run", "build", "test"]], [["run", "--filter", "a"]], [["run", "-x"]]])("keeps `vis %j` in Node on Windows: it is not the one shape", (flags: string[]) => {
            expect.assertions(1);

            expect(routesToNative(flags, "win32", ci, root, false, holdsMarker, cache)).toBe(false);
        });

        it.each([
            ["outside CI", {}],
            ["with CI=0", { CI: "0" }],
            ["with only CONTINUOUS_INTEGRATION", { CONTINUOUS_INTEGRATION: "1" }],
            ["with a colour variable Node warns about", { ...ci, FORCE_COLOR: "1", NO_COLOR: "1" }],
            ["with DEBUG", { ...ci, DEBUG: "vis" }],
            ["with NODE_ENV=test", { ...ci, NODE_ENV: "test" }],
            ["with a remote cache", { ...ci, TURBO_API: "https://cache.example" }],
            ["with VIS_CACHE_DIRECTORY", { ...ci, VIS_CACHE_DIRECTORY: String.raw`C:\cache` }],
            ["with a lower-case cerebro variable, which Windows reads like the upper-case one", { ...ci, cerebro_output_level: "1" }],
        ])("keeps `vis run build` in Node on Windows %s", (_label: string, environment: Record<string, string>) => {
            expect.assertions(1);

            expect(routesToNative(args, "win32", environment, root, false, holdsMarker, cache)).toBe(false);
        });

        it("keeps `vis run build` in Node on a terminal, and reads a lower-case cerebro variable as another variable off Windows", () => {
            expect.assertions(2);

            expect(routesToNative(args, "win32", ci, root, true, holdsMarker, cache)).toBe(false);
            expect(routesToNative(args, "linux", { ...ci, cerebro_output_level: "1" }, "/work/app", false, (directory: string) => directory === "/work/app", cache)).toBe(true);
        });
    });

    it.each([[["clean"]], [["clean", "--dry-run"]], [["clean", "--lockfile"]]])("keeps `vis %j` in Node when stdout is a terminal", (args: string[]) => {
        expect.assertions(1);

        expect(routesToNative(args, "linux", process.env, "/work/app", true)).toBe(false);
    });
});
