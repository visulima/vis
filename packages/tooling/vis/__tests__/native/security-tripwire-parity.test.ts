import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis security tripwire` exists twice: the Node handler (`src/commands/security/tripwire.ts`) and the native path
 * (`native/cli/src/security_tripwire.rs`), which answers the runs that only read `package.json`: `--status`, the "already
 * installed" answer of the bare command, and `--remove` when the package is not listed. For every input the native path accepts it
 * must print the same text on the same streams, end with the same exit status and leave the same bytes as Node; every input it
 * declines (a run that would install the package, one that would rewrite `package.json`) must be handed to Node before anything is
 * printed or written (see `workspace-parity-harness.ts` for how both are proved).
 */

const harness = new Harness(["security", "tripwire"]);

/** A directory with a `pnpm` that does nothing and succeeds: a run that reaches the installer must not reach Corepack or the registry. */
let stubs: string;

/** `extra` with the stub package manager first on `PATH`. */
const stubbed = (extra: Record<string, string> = {}): Record<string, string> => {
    return { ...extra, PATH: `${stubs}:${process.env["PATH"] ?? ""}` };
};

/** The binary declines, and the run it hands over prints what Node prints, with the package manager stubbed on both sides. */
const delegated = (files: Files, args: string[], extra: Record<string, string> = {}, ci = true): ReturnType<Harness["expectDelegation"]> => harness.expectDelegation(files, args, stubbed(extra), ci);

const PACKAGE = "@lavamoat/preinstall-always-fail";

const manifest = (extra: Record<string, unknown> = {}): Files => {
    return { "package.json": `${JSON.stringify({ name: "root", private: true, ...extra }, null, 2)}\n` };
};

const raw = (text: string | Buffer): Files => {
    return { "package.json": text };
};

const both = (files: Files, args: string[], extra: Record<string, string> = {}): ReturnType<Harness["runNative"]> => {
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const node = harness.runNode(args, nodeRoot, extra);
    // `VIS_DEBUG_DECLINE` makes a hand-off name the gate that declined, so a failure here says why.
    const native = harness.runNative(args, nativeRoot, { ...extra, VIS_DEBUG_DECLINE: "1" });

    expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));

    return native;
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis security tripwire: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-security-tripwire-parity-");
        stubs = mkdtempSync(join(tmpdir(), "vis-tripwire-stubs-"));
        writeFileSync(join(stubs, "pnpm"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(stubs, "pnpm"), 0o755);
    });

    afterAll(() => {
        harness.teardown();
        rmSync(stubs, { force: true, recursive: true });
    });

    describe("--status", () => {
        it("reports an installed tripwire", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles(manifest({ devDependencies: { [PACKAGE]: "^2.0.0" } })), ["--status"]);

            expect(result.stdout).toContain(`Preinstall tripwire is installed (${PACKAGE}).`);
            expect(result.status).toBe(0);
        });

        it("reports a tripwire in dependencies", () => {
            expect.hasAssertions();

            both(workspaceFiles(manifest({ dependencies: { [PACKAGE]: "2.0.0" } })), ["--status"]);
        });

        it("reports a missing tripwire on stderr", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles(manifest()), ["--status"]);

            expect(result.stderr).toContain("Preinstall tripwire is not installed.");
            expect(result.stdout).toContain("Run 'vis security tripwire' to add");
        });

        it("fails without a package.json", () => {
            expect.hasAssertions();

            const files = workspaceFiles({});

            delete files["package.json"];

            const result = both(files, ["--status"]);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain("No package.json found at the workspace root.");
        });

        it.each([
            ["an empty string", { devDependencies: { [PACKAGE]: "" } }],
            ["zero", { devDependencies: { [PACKAGE]: 0 } }],
            ["null", { devDependencies: { [PACKAGE]: null } }],
            ["false", { devDependencies: { [PACKAGE]: false } }],
            ["true", { devDependencies: { [PACKAGE]: true } }],
            ["an array", { devDependencies: { [PACKAGE]: [] } }],
            ["a block that is a string", { devDependencies: PACKAGE }],
            ["a block that is an array", { devDependencies: [PACKAGE] }],
            ["a null block", { dependencies: null, devDependencies: null }],
            ["a falsy dev entry beside a truthy one", { dependencies: { [PACKAGE]: "1" }, devDependencies: { [PACKAGE]: "" } }],
            ["another package", { devDependencies: { other: "1" } }],
            ["a peer dependency only", { peerDependencies: { [PACKAGE]: "1" } }],
        ] as [string, Record<string, unknown>][])("reads %s as JavaScript does", (_name, extra) => {
            expect.hasAssertions();

            both(workspaceFiles(manifest(extra)), ["--status"]);
        });

        it.each([
            ["an array at the top", "[]\n"],
            ["null", "null\n"],
            ["a string", '"text"\n'],
            ["an empty object", "{}\n"],
            ["a byte-order mark", `\uFEFF${JSON.stringify({ devDependencies: { [PACKAGE]: "1" } })}\n`],
            ["no trailing newline", JSON.stringify({ devDependencies: { [PACKAGE]: "1" } })],
            ["a repeated key, the last one wins", `{"devDependencies":{"${PACKAGE}":""},"devDependencies":{"${PACKAGE}":"1"}}\n`],
            ["a __proto__ key", `{"__proto__":{"devDependencies":{"${PACKAGE}":"1"}},"name":"x"}\n`],
            ["unicode in other fields", JSON.stringify({ description: "café \u{1F600} \u2028", name: "x" })],
        ] as [string, string][])("reads a package.json with %s", (_name, text) => {
            expect.hasAssertions();

            both(workspaceFiles(raw(text)), ["--status"]);
        });

        it("treats a package.json that is a directory as not installed", () => {
            expect.hasAssertions();

            const files = workspaceFiles({});

            delete files["package.json"];
            both({ ...files, "package.json/keep": "x" }, ["--status"]);
        });
    });

    describe("without a flag", () => {
        it("says the tripwire is already installed", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles(manifest({ devDependencies: { [PACKAGE]: "^2.0.0" } })), []);

            expect(result.stdout).toContain(`${PACKAGE} is already installed.`);
        });

        it("reads a truthy value in dependencies", () => {
            expect.hasAssertions();

            both(workspaceFiles(manifest({ dependencies: { [PACKAGE]: "1" } })), []);
        });
    });

    describe("--remove", () => {
        it("says the package was not present", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles(manifest({ devDependencies: { other: "1" } })), ["--remove"]);

            expect(result.stdout).toContain(`${PACKAGE} was not present in package.json.`);
        });

        it("says so for a missing package.json", () => {
            expect.hasAssertions();

            const files = workspaceFiles({});

            delete files["package.json"];
            both(files, ["--remove"]);
        });

        it.each([
            ["an array at the top", "[]\n"],
            ["null", "null\n"],
            ["a string block", `{"devDependencies":"${PACKAGE}"}\n`],
            ["a package that is only a peer dependency", `{"peerDependencies":{"${PACKAGE}":"1"}}\n`],
        ] as [string, string][])("leaves the file alone for %s", (_name, text) => {
            expect.hasAssertions();

            both(workspaceFiles(raw(text)), ["--remove"]);
        });
    });

    describe("what the environment decides", () => {
        const files = (): Files => workspaceFiles(manifest());

        it.each([...SHORT_COLOUR_ENVIRONMENTS, { FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }, { CI: "true", FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }])("prints the same under %j", (extra) => {
            expect.hasAssertions();

            both(files(), ["--status"], extra);
        });

        it.each([{ COLUMNS: "45" }, { COLUMNS: "60" }, { COLUMNS: "100" }])("wraps the long line like pail under %j", (extra) => {
            expect.hasAssertions();

            both(files(), ["--status"], extra);
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("hands the run to Node under %j", (extra) => {
            expect.hasAssertions();

            delegated(files(), ["--status"], extra);
        });

        it("hands a run outside CI to Node", () => {
            expect.hasAssertions();

            delegated(files(), ["--status"], {}, false);
        });

        it.each([{ NODE_ENV: "test" }, { DEBUG: "1" }, { PAIL_LOG_LEVEL: "error" }])("hands the run to Node under %j", (extra) => {
            expect.hasAssertions();

            delegated(files(), ["--status"], extra);
        });
    });

    describe("what the native path leaves to Node", () => {
        it.each([[["--status", "--remove"]], [["--status", "--status"]], [["--status=true"]], [["--no-status"]], [["extra"]], [["--"]], [["--cwd", "."]]])("declines the arguments %j", (args) => {
            expect.hasAssertions();

            delegated(workspaceFiles(manifest()), args);
        });

        it("declines a run that would install the package, before anything is printed or written", () => {
            expect.hasAssertions();

            // Node would run the package manager here, so only the binary's half is run: it hands the run over and touches nothing.
            const probe = harness.materialize("native", workspaceFiles(manifest()));
            const before = Harness.snapshot(probe);
            const declined = harness.runNative([], probe, { VIS_DEBUG_DECLINE: "1" });

            expect(declined.status).toBe(70);
            expect(declined.stdout).toBe("");
            expect(declined.stderr).toContain("the package is not installed, so the run installs it");
            expect(Harness.snapshot(probe)).toStrictEqual(before);
        });

        it.each([
            ["a dev dependency", { devDependencies: { [PACKAGE]: "1" } }],
            ["a dependency", { dependencies: { [PACKAGE]: "" } }],
            ["a listed package with a null value", { devDependencies: { [PACKAGE]: null } }],
        ] as [string, Record<string, unknown>][])("declines --remove for %s, which rewrites package.json", (_name, extra) => {
            expect.hasAssertions();

            delegated(workspaceFiles(manifest(extra)), ["--remove"]);
        });

        it.each([
            ["a config Node evaluates", { "vis.config.ts": "export default { security: { policies: { firstSeen: { minutes: Number('5') } } } };\n" }],
            ["a json config, which Node does not load", { "vis.config.json": "{}" }],
            ["a config that only Node reads", { "vis.config.ts": "export default { runtime: 'node', security: {} };\n" }],
        ] as [string, Files][])("declines %s", (_name, extra) => {
            expect.hasAssertions();

            delegated(workspaceFiles({ ...manifest(), ...extra }), ["--status"]);
        });

        it.each([
            ["a file that does not parse", "{\n"],
            ["a number outside a double", '{"n":1e999}\n'],
            ["an empty file", ""],
            ["a lone surrogate escape", '{"s":"\\ud800"}\n'],
            ["bytes that are not UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
        ] as [string, Buffer | string][])("declines a package.json with %s, which Node may read", (_name, content) => {
            expect.hasAssertions();

            delegated(workspaceFiles(raw(content)), ["--status"]);
        });

        it("declines a workspace that is not pnpm", () => {
            expect.hasAssertions();

            const files = workspaceFiles(manifest());

            delete files["pnpm-workspace.yaml"];
            delete files["pnpm-lock.yaml"];
            delegated({ ...files, "package-lock.json": "{}\n" }, ["--status"]);
        });
    });
});
