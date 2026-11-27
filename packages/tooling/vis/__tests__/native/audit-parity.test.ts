import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files, Outcome, Result } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis audit --format json --policies none` exists twice: the Node handler (`src/commands/audit/handler.ts`) and the native
 * path (`native/cli/src/audit/`), which answers only a scan that finds nothing. The binary reads its OSV address from nowhere
 * but its own code, so this suite cannot point it at a stub: every case here is one the binary must hand to Node before it
 * asks OSV, which is proved the way `workspace-parity-harness.ts` proves it (exit 70 without a fallback, nothing printed or
 * written) and then compared with a Node run. What the binary prints when it does answer, and how it handles OSV's answers,
 * is covered by `native/cli/src/audit/tests.rs`: against a stub server, and against what the Node handler printed for the
 * same lockfile, byte for byte, in each colour and terminal setting.
 *
 * Both Node runs (the direct one and the one the binary delegates to) load a preload that answers OSV's request locally and
 * refuses every other `fetch`, so nothing reaches the network. The time in the progress row, the `generatedAt` of the report
 * and the clock of pail are masked.
 */

const harness = new Harness(["audit"]);

/** The preload of the Node runs: OSV finds nothing, any other request fails. */
const PRELOAD = `
globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://api.osv.dev/v1/querybatch" || init?.method !== "POST") {
        throw new Error("unexpected fetch " + String(url));
    }

    const { queries } = JSON.parse(init.body);

    return new Response(JSON.stringify({ results: queries.map(() => ({})) }), { headers: { "content-type": "application/json" }, status: 200 });
};
`;

let scratch: string;
let preload: string;
let wrapper: string;

interface Pkg {
    name: string;
    version: string;
}

const quote = (key: string): string => (key.startsWith("@") || key.includes("(") ? `'${key}'` : key);

/** A lockfile version 9 file with these packages. */
const lockV9 = (packages: Pkg[]): string => {
    const section = packages.map((pkg) => `  ${quote(`${pkg.name}@${pkg.version}`)}:\n    resolution: {integrity: sha512-${Buffer.from(`${pkg.name}@${pkg.version}`).toString("base64")}}`).join("\n\n");
    const snapshots = packages.map((pkg) => `  ${quote(`${pkg.name}@${pkg.version}`)}: {}`).join("\n\n");

    return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\npackages:\n\n${section}\n\nsnapshots:\n\n${snapshots}\n`;
};

const withLock = (lock: string, more: Files = {}): Files => workspaceFiles({ "pnpm-lock.yaml": lock, ...more });

const BASIC: Pkg[] = [{ name: "left-pad", version: "1.3.0" }, { name: "is-odd", version: "3.0.1" }, { name: "@scope/pkg", version: "2.0.0-rc.1" }];

/** The arguments the binary takes. */
const NATIVE_ARGS = ["--format", "json", "--policies", "none"];

/** The cursor moves that redraw the progress row, then a braille spinner frame (U+2800 to U+28FF). */
const REDRAW = "\u001B[2K\u001B[1A\u001B[2K\u001B[G";

const isSpinnerFrame = (line: string): boolean => {
    const code = line.startsWith(REDRAW) ? line.codePointAt(REDRAW.length) : undefined;

    return code !== undefined && code >= 0x28_00 && code <= 0x28_ff;
};

/** An outcome with the values that differ between runs by design masked. */
const masked = (outcome: Outcome): Outcome => {
    // The progress row ends in `· 12ms`; the table form says `Scan completed in 12ms`. The row is padded to a fixed
    // width that includes the duration, so a duration of another length moves the spaces before the dash: collapse them.
    // A scan that outlasts one spinner tick redraws the row with a spinner frame before the result; whether that happens
    // depends on the machine, so the frame rows are dropped (the redraw of the result row replaces them on screen).
    const timing = (text: string): string =>
        text
            .split("\n")
            .filter((line) => !isSpinnerFrame(line))
            .join("\n")
            .replaceAll(/(?<=[·n]) \d+(?:\.\d)?m?s/g, " <TIME>")
            .replaceAll(/ {2,}(?=— )/g, " ");

    return {
        ...outcome,
        stderr: timing(outcome.stderr),
        stdout: timing(outcome.stdout.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "<NOW>"')),
    };
};

const outcomeOf = (result: Result, root: string): Outcome => masked(Harness.outcome(result, root));

const runNode = (args: string[], cwd: string, extra: Record<string, string>): Result =>
    spawnSync(process.execPath, ["--import", preload, nodeEntry, "audit", ...args], { cwd, encoding: "utf8", env: Harness.environment(extra) });

interface Case {
    args?: string[];
    extra?: Record<string, string>;
    files?: Files;
}

/** The binary hands the run to Node before it asks OSV, and the delegated run prints what Node prints. */
const expectHandOver = ({ args = NATIVE_ARGS, extra = {}, files = withLock(lockV9(BASIC)) }: Case): void => {
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const node = runNode(args, nodeRoot, extra);
    const probeRoot = harness.materialize("native", files);
    const before = Harness.snapshot(probeRoot);
    // `VIS_DEBUG_DECLINE` makes a hand-off name the gate that declined, so a failure here says why.
    const declined = harness.runNative(args, probeRoot, { ...extra, VIS_DEBUG_DECLINE: "1" });

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect(declined.stderr, "the run was declined by a gate, not by a failure").toMatch(/^vis: handing the run to Node: /);
    expect(Harness.snapshot(probeRoot), "a declined run must not touch the files").toStrictEqual(before);

    const delegated = harness.runNative(args, nativeRoot, { ...extra, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: wrapper });

    expect(outcomeOf(delegated, nativeRoot)).toStrictEqual(outcomeOf(node, nodeRoot));
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis audit --format json --policies none: what goes to Node", () => {
    beforeAll(() => {
        harness.setup("vis-audit-parity-");
        scratch = mkdtempSync(join(tmpdir(), "vis-audit-parity-misc-"));
        preload = join(scratch, "osv-preload.mjs");
        wrapper = join(scratch, "node-with-osv-preload");
        writeFileSync(preload, PRELOAD);
        // The binary runs `$VIS_NODE <entry> <args>`; the wrapper puts the preload in front of the entry.
        writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" --import "${preload}" "$@"\n`);
        chmodSync(wrapper, 0o755);
    });

    afterAll(() => {
        harness.teardown();
        rmSync(scratch, { force: true, recursive: true });
    });

    describe("the arguments", () => {
        it.each([
            [[]],
            // The default config runs the `publisherChange` policy, which asks the registry; only `none` skips it.
            [["--format", "json"]],
            [["--format=json"]],
            [["--format", "json", "--policies", "license"]],
            [["--format", "json", "--policies", "all"]],
            [["--format", "json", "--policies", "None"]],
            [["--format", "json", "--policies"]],
            [["--format", "json", "--policies", "none", "--policies", "none"]],
            [["--policies", "none"]],
            [["--format", "table", "--policies", "none"]],
            [["--format", "sarif", "--policies", "none"]],
            [["--format", "json", "--format", "json", "--policies", "none"]],
            [[...NATIVE_ARGS, "--offline"]],
            [[...NATIVE_ARGS, "--prod-only"]],
            [[...NATIVE_ARGS, "--severity", "bogus"]],
            [[...NATIVE_ARGS, "--severity"]],
            [[...NATIVE_ARGS, "--fail-on", "HIGH"]],
            [[...NATIVE_ARGS, "--exit-code=1"]],
            [[...NATIVE_ARGS, "--exit-code", "--exit-code"]],
            [[...NATIVE_ARGS, "--ecosystem", "npm"]],
            [[...NATIVE_ARGS, "--show-fixes"]],
            [[...NATIVE_ARGS, "--backend", "vis"]],
            [[...NATIVE_ARGS, "--cwd", "."]],
            [[...NATIVE_ARGS, "extra"]],
        ])("hands over the arguments %j", (args) => {
            expect.hasAssertions();

            expectHandOver({ args });
        });
    });

    describe("the environment", () => {
        it.each([
            { HTTPS_PROXY: "http://127.0.0.1:9" },
            { HTTP_PROXY: "http://127.0.0.1:9" },
            { ALL_PROXY: "http://127.0.0.1:9" },
            { NODE_EXTRA_CA_CERTS: "/nonexistent/ca.pem" },
            { SSL_CERT_FILE: "/nonexistent/ca.pem" },
            { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
            { VIS_AUDIT_BACKEND: "vis" },
            { VIS_AUDIT_BACKEND: "bogus" },
            { VIS_INSTALLER: "pnpm" },
            { LANG: "da_DK.UTF-8" },
            { NODE_ENV: "test" },
            { DEBUG: "1" },
            { PAIL_LOG_LEVEL: "error" },
            { CEREBRO_OUTPUT_LEVEL: "16" },
        ])("hands over a run with %j", (extra) => {
            expect.hasAssertions();

            expectHandOver({ extra });
        });

        // The Node runtime warns on stderr, with its process id, about `FORCE_COLOR` together with `NO_COLOR`.
        it.each(DELEGATED_COLOUR_ENVIRONMENTS.map((env) => [JSON.stringify(env), env] as const))("leaves the colour environment %s to Node", (_name, extra) => {
            expect.hasAssertions();

            expectHandOver({ extra });
        });

        it.each([["--no-color"], ["--color"]])("leaves %s to Node", (flag) => {
            expect.hasAssertions();

            expectHandOver({ args: [...NATIVE_ARGS, flag] });
        });
    });

    describe("the workspace", () => {
        it("hands over a lockfile with no package", () => {
            expect.hasAssertions();

            expectHandOver({ files: workspaceFiles({}) });
        });

        it("hands over a lockfile the reader does not take exactly", () => {
            expect.hasAssertions();

            expectHandOver({ files: withLock(`${lockV9(BASIC)}\r\n`) });
            expectHandOver({ files: withLock(lockV9([{ name: "café", version: "1.0.0" }])) });
        });

        it("hands over a pnpm-workspace.yaml with an auditConfig", () => {
            expect.hasAssertions();

            expectHandOver({ files: withLock(lockV9(BASIC), { "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\nauditConfig:\n  ignoreCves:\n    - CVE-2021-0001\n' }) });
        });

        it("hands over a workspace with a vis config", () => {
            expect.hasAssertions();

            expectHandOver({ files: withLock(lockV9(BASIC), { "vis.config.ts": "export default { security: { policies: { license: { deny: ['GPL-3.0'] } } } };\n" }) });
        });

        it("hands over a workspace that pins its package manager", () => {
            expect.hasAssertions();

            expectHandOver({ files: withLock(lockV9(BASIC), { "package.json": `${JSON.stringify({ name: "root", packageManager: "pnpm@9.0.0", private: true })}\n` }) });
        });
    });
});
