import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files, Outcome, Result } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, packageRoot, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis audit --format json --policies none` exists twice: the Node handler (`src/commands/audit/handler.ts`)
 * and the native path (`native/cli/src/audit/`), which answers only a scan whose report is empty (nothing found, or findings the
 * handler drops: OSV's batch answer holds an id, which maps to a severity no `--severity` level lets through). The binary reads its OSV address from nowhere
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

/** The preload of the runs that record what Node prints for a given OSV answer: `OSV_ANSWER` holds the result of each package, in order. */
const ANSWER_PRELOAD = `
globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://api.osv.dev/v1/querybatch" || init?.method !== "POST") {
        throw new Error("unexpected fetch " + String(url));
    }

    const { queries } = JSON.parse(init.body);
    const answer = JSON.parse(process.env.OSV_ANSWER);

    return new Response(JSON.stringify({ results: queries.map((_, index) => answer[index] ?? {}) }), { headers: { "content-type": "application/json" }, status: 200 });
};
`;

let scratch: string;
let preload: string;
let answerPreload: string;
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
const expectHandOver = ({ args = NATIVE_ARGS, extra = {}, files = withLock(lockV9(BASIC)) }: Case): Result => {
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

    return node;
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis audit --format json --policies none: what goes to Node", () => {
    beforeAll(() => {
        harness.setup("vis-audit-parity-");
        scratch = mkdtempSync(join(tmpdir(), "vis-audit-parity-misc-"));
        preload = join(scratch, "osv-preload.mjs");
        wrapper = join(scratch, "node-with-osv-preload");
        writeFileSync(preload, PRELOAD);
        answerPreload = join(scratch, "osv-answer-preload.mjs");
        writeFileSync(answerPreload, ANSWER_PRELOAD);
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

        // The Node scan also reads the packages a locked package ships inside itself and reports a vendored tree it
        // cannot scan; the binary reads the lockfile only, so a run like that is Node's before anything is printed.
        // (That a tree with neither is still answered natively, byte for byte, is in `audit/tests.rs`: this suite
        // cannot point the binary at a stub, so an answered run here would ask the live OSV.)
        it.each([
            ["a locked package that bundles a dependency", { "node_modules/left-pad/node_modules/inner/package.json": json({ name: "inner", version: "2.0.0" }), "node_modules/left-pad/package.json": json({ bundleDependencies: ["inner"], name: "left-pad", version: "1.3.0" }) }],
            ["a bundling package in pnpm's store", { "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/node_modules/inner/package.json": json({ name: "inner", version: "2.0.0" }), "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json": json({ bundledDependencies: ["inner"], name: "left-pad", version: "1.3.0" }) }],
        ])("hands over %s, and Node scans the bundled package", (_name, more) => {
            expect.hasAssertions();

            const node = expectHandOver({ files: withLock(lockV9(BASIC), more) });

            expect(JSON.parse(node.stdout)).toMatchObject({ packages: BASIC.length + 1, unauditable: [] });
        });

        it("hands over a locked package that vendors packages without versions, and Node reports them", () => {
            expect.hasAssertions();

            const node = expectHandOver({
                files: withLock(lockV9(BASIC), {
                    "node_modules/left-pad/dist/compiled/alpha/package.json": json({ name: "alpha" }),
                    "node_modules/left-pad/dist/compiled/beta/index.js": "module.exports = 1;\n",
                    "node_modules/left-pad/package.json": json({ name: "left-pad", version: "1.3.0" }),
                }),
            });

            expect(JSON.parse(node.stdout)).toMatchObject({ packages: BASIC.length, unauditable: [{ count: 2, host: "left-pad@1.3.0", kind: "vendored", location: "dist/compiled" }] });
        });

        it("hands over a workspace that pins its package manager", () => {
            expect.hasAssertions();

            expectHandOver({ files: withLock(lockV9(BASIC), { "package.json": `${JSON.stringify({ name: "root", packageManager: "pnpm@9.0.0", private: true })}\n` }) });
        });
    });

    // What the binary prints for an answer that lists findings is fixed by the files in `native/cli/tests/fixtures/audit/`, which
    // `native/cli/src/audit/tests.rs` compares it with byte for byte. These runs record the same files from the Node handler on the same
    // lockfile and OSV answers, so a change in Node (a finding that reaches the report, the line `Scan completed in …` leaving stdout,
    // another clock or row) fails here instead of leaving the binary answering as Node no longer does. Masked, because they differ
    // between any two Node runs: the clock, the elapsed time, and the workspace root.
    describe("what Node prints for the answers the binary gives itself", () => {
        const fixtures = join(packageRoot, "native", "cli", "tests", "fixtures", "audit");
        const recorded = (name: string): string => readFileSync(join(fixtures, name), "utf8");
        const stamp = { modified: "2024-01-01T00:00:00Z" };
        // Two findings for the first package, none for the second, one for the third: the batch endpoint answers with an id and a timestamp.
        const FOUND = [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc", ...stamp }, { id: "MAL-2024-1", ...stamp }] }, {}, { vulns: [{ id: "CVE-2020-1", ...stamp }] }];
        const FORMATS = ["json"] as const;

        const maskStderr = (text: string): string => text.replaceAll(/· \d+(?:\.\d)?m?s/g, "· <TIME>");
        const maskStdout = (text: string, root: string): string =>
            text
                .replaceAll(root, "{root}")
                .replaceAll(/^\d\d:\d\d:\d\d INFO/gm, "<CLOCK> INFO")
                .replaceAll(/Scan completed in \d+(?:\.\d)?m?s/g, "Scan completed in <TIME>")
                .replaceAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "{now}")
                .replaceAll(/vis-audit-\d{4}-\d\d-\d\d/g, "vis-audit-{date}")
                .replaceAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/g, "{seconds}");

        const runNodeOn = (format: string, answer: unknown[], extra: Record<string, string> = {}, flags: string[] = []): { result: Result; root: string } => {
            const root = harness.materialize("node", workspaceFiles({ "pnpm-lock.yaml": recorded("basic.pnpm-lock.yaml") }));
            const result = spawnSync(process.execPath, ["--import", answerPreload, nodeEntry, "audit", "--format", format, "--policies", "none", ...flags], {
                cwd: root,
                encoding: "utf8",
                env: Harness.environment({ OSV_ANSWER: JSON.stringify(answer), ...extra }),
            });

            return { result, root: realpathSync(root) };
        };

        it.each(FORMATS)("drops what the batch endpoint lists (%s): the report of a clean scan, a row that counts them, and exit 0", (format) => {
            expect.hasAssertions();

            const { result, root } = runNodeOn(format, FOUND);

            expect(result.status, result.stderr).toBe(0);
            expect(maskStdout(result.stdout, root)).toBe(recorded(`found.${format}.stdout`));
            expect(maskStderr(result.stderr)).toBe(recorded("found.plain.stderr"));
        });

        it("prints the clean report of the recorded lockfile for a finding it drops", () => {
            expect.hasAssertions();

            const { result, root } = runNodeOn("json", FOUND);

            // `basic.stdout` is the report of a clean scan with a fixed clock, which `audit/tests.rs` compares the binary with too.
            expect(maskStdout(result.stdout, root).replace("{now}", "2026-01-02T03:04:05.678Z")).toBe(recorded("basic.stdout"));
        });

        it("colours the row with a yellow warning, and writes `!` on a Linux console", () => {
            expect.hasAssertions();

            expect(maskStderr(runNodeOn("json", FOUND, { FORCE_COLOR: "1" }).result.stderr)).toBe(recorded("found.colour.stderr"));
            expect(maskStderr(runNodeOn("json", FOUND, { TERM: "linux" }).result.stderr)).toBe(recorded("found.linux.stderr"));
        });

        // The gates read the findings that reach the report; the ones the batch endpoint lists are not among them. The binary exits 0 for these.
        it.each(["json"] as const)("exits 0 for a dropped finding under every gate (%s)", (format) => {
            expect.hasAssertions();

            const gated = runNodeOn(format, FOUND, {}, ["--exit-code", "--fail-on", "low", "--severity", "critical"]);
            const plain = runNodeOn(format, FOUND);

            expect(gated.result.status, gated.result.stderr).toBe(Number.parseInt(recorded("found.gates.exit"), 10));
            expect(maskStdout(gated.result.stdout, gated.root)).toBe(maskStdout(plain.result.stdout, plain.root));
        });
    });
});
