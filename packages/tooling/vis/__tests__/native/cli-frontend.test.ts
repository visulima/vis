import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = join(packageRoot, "bin", "vis.mjs");
const packageVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version as string;

// Built by `pnpm build:native:cli` locally, or distributed into the binding
// package in CI. When absent (e.g. a PR that didn't build native), skip rather
// than fail — the binary's pure legs are covered by the Rust integration tests.
const binary = resolveNativeBinary(packageRoot);

describe.skipIf(!binary)("vis CLI front-end (native binary + launcher)", () => {
    let temporaryDirectory: string;
    let delegateStub: string;
    let fallbackStub: string;

    beforeAll(() => {
        temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-cli-"));
        delegateStub = join(temporaryDirectory, "delegate.mjs");
        fallbackStub = join(temporaryDirectory, "fallback.mjs");

        writeFileSync(delegateStub, "console.log('DELEGATE:' + process.argv.slice(2).join(',')); process.exit(7);\n");
        // The launcher's own call to the binary is the only thing that sets VIS_NODE, so the
        // marker tells the in-process fall-through apart from a hand-off through the binary.
        writeFileSync(
            fallbackStub,
            "console.log((process.env.VIS_NODE ? 'VIA-BINARY:' : 'FALLBACK:') + process.argv.slice(2).join(',')); process.exit(5);\n",
        );
    });

    const launcherEnvironment = (extra: Record<string, string> = {}) => {
        const inherited: NodeJS.ProcessEnv = { ...process.env };

        // An ambient VIS_NODE (set when the suite runs under a vis hook) would flip the FALLBACK/VIA-BINARY marker.
        delete inherited.VIS_NODE;

        return {
            ...inherited,
            // A terminal size, so help is not handed to Node to look the width up.
            COLUMNS: "80",
            LINES: "24",
            VIS_FALLBACK_ENTRY: fallbackStub,
            VIS_FALLBACK_ENTRY_OVERRIDE: fallbackStub,
            VIS_NATIVE_BIN: binary as string,
            VIS_VERSION: packageVersion,
            ...extra,
        };
    };

    afterAll(() => {
        rmSync(temporaryDirectory, { force: true, recursive: true });
    });

    it("routes a native command through the launcher to the binary", () => {
        expect.assertions(3);

        const result = spawnSync(process.execPath, [launcher, "__native-info"], {
            encoding: "utf8",
            env: launcherEnvironment(),
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("vis native front-end");
        // The launcher injects VIS_VERSION from package.json; the binary echoes it.
        expect(result.stdout).toContain(packageVersion);
    });

    it("routes --version natively, printing the injected package version", () => {
        expect.assertions(2);

        const result = spawnSync(process.execPath, [launcher, "--version"], {
            encoding: "utf8",
            env: launcherEnvironment(),
        });

        expect(result.status).toBe(0);
        // The launcher injects VIS_VERSION from package.json; nothing falls through.
        expect(result.stdout).toBe(`${packageVersion}\n`);
    });

    it("routes __pm-shim natively and rejects an unknown shim", () => {
        expect.assertions(2);

        const result = spawnSync(process.execPath, [launcher, "__pm-shim", "bogus", "install"], {
            encoding: "utf8",
            env: launcherEnvironment(),
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("is not a known package-manager shim");
    });

    it("delegates an unknown command from the binary to Node, forwarding argv and exit code", () => {
        expect.assertions(2);

        const result = spawnSync(binary as string, ["run", "build", "--flag"], {
            encoding: "utf8",
            env: launcherEnvironment({ VIS_FALLBACK_ENTRY: delegateStub, VIS_FALLBACK_ENTRY_OVERRIDE: delegateStub, VIS_NODE: process.execPath }),
        });

        expect(result.stdout).toContain("DELEGATE:run,build,--flag");
        expect(result.status).toBe(7);
    });

    // `dashboard` is a TUI, which stays in Node by design, so this example does not go native later.
    it("falls through to the in-process Node entry for non-native commands", () => {
        expect.assertions(2);

        const result = spawnSync(process.execPath, [launcher, "dashboard", "--json"], {
            encoding: "utf8",
            env: launcherEnvironment(),
        });

        expect(result.stdout).toContain("FALLBACK:dashboard,--json");
        expect(result.status).toBe(5);
    });

    describe("help surface routing", () => {
        const viaLauncher = (...args: string[]) => spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", env: launcherEnvironment() });

        const viaBinary = (...args: string[]) =>
            spawnSync(binary as string, args, { encoding: "utf8", env: launcherEnvironment({ VIS_NODE: process.execPath }) });

        it.each([[["--help"]], [["-h"]], [[]], [["help"]], [["help", "install"]], [["status", "--help"]]])(
            "answers `vis %j` with the native binary's output",
            (args: string[]) => {
                expect.assertions(4);

                const viaNode = viaLauncher(...args);
                const native = viaBinary(...args);

                // Never the in-process stub: the binary answered, and did not hand back to Node.
                expect(viaNode.stdout).not.toMatch(/FALLBACK:|VIA-BINARY:/);
                expect(viaNode.stdout).toBe(native.stdout);
                expect(viaNode.stderr).toBe(native.stderr);
                expect(viaNode.status).toBe(native.status);
            },
        );

        it("prints the command list for `--help`", () => {
            expect.assertions(2);

            const result = viaLauncher("--help");

            expect(result.status).toBe(0);
            expect(result.stdout).toContain(`vis v${packageVersion}`);
        });

        it("leaves help after a `--` separator to the command, in-process", () => {
            expect.assertions(2);

            const result = viaLauncher("status", "--", "--help");

            expect(result.stdout).toContain("FALLBACK:status,--,--help");
            expect(result.status).toBe(5);
        });

        it("answers the dynamic `complete --` endpoint through the binary", () => {
            expect.assertions(2);

            const result = viaLauncher("complete", "--", "vis", "");

            // The binary answers from its manifest; nothing is handed back to the Node entry.
            expect(result.stdout).not.toMatch(/FALLBACK:|VIA-BINARY:/);
            expect(result.status).toBe(0);
        });

        it.each([[["completion", "bash"]], [["complete", "bash"]], [["complete", "--help"]], [["complete", "bash", "--help"]]])(
            "keeps `vis %j` in-process, never routed to the binary",
            (args: string[]) => {
                expect.assertions(2);

                const result = viaLauncher(...args);

                // The binary has no `complete` command (script generation is `vis completion`), so
                // handing these over would only print `Unknown command` instead of Node's answer.
                expect(result.stdout).toBe(`FALLBACK:${args.join(",")}\n`);
                expect(result.status).toBe(5);
            },
        );

        it("falls back to Node for help when no native binary resolves", () => {
            expect.assertions(2);

            // A package copy with no sibling binary and no binding package to resolve.
            const bareRoot = join(temporaryDirectory, "bare-package");

            mkdirSync(bareRoot, { recursive: true });
            cpSync(join(packageRoot, "bin"), join(bareRoot, "bin"), { recursive: true });
            cpSync(join(packageRoot, "package.json"), join(bareRoot, "package.json"));

            const environment: NodeJS.ProcessEnv = launcherEnvironment();

            delete environment.VIS_NATIVE_BIN;
            // pnpm sets NODE_PATH to the workspace's hoisted node_modules, which holds the real platform
            // package: without this the copy resolves it through the Node fallback paths.
            delete environment.NODE_PATH;
            // The published `bin/vis` placeholder, which imports the launcher, is what a user runs.
            const result = spawnSync(process.execPath, [join(bareRoot, "bin", "vis"), "--help"], { encoding: "utf8", env: environment });

            expect(result.stdout).toContain("FALLBACK:--help");
            expect(result.status).toBe(5);
        });
    });
});
