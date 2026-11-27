import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files, Outcome, Result } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis security verify-lockfile` exists twice: the Node handler (`src/commands/security/verify-lockfile.ts`) and the native path
 * (`native/cli/src/security_verify_lockfile.rs`), which answers `--offline [--json]` for a lockfile that passes. With `--offline`
 * both network policies are skipped with an info row each, so the answer is the entry count and whether a dependency edge is exotic.
 * The elapsed time is the wall clock of each run: `durationMs` in JSON and the `(N entries, 12ms)` of the headline are masked,
 * nothing else. Every input the native path declines must be handed to Node before anything is printed (see
 * `workspace-parity-harness.ts` for how that is proved), and the shapes that need the registry are only checked on the binary's half,
 * since Node would ask the network for them.
 */

const harness = new Harness(["security", "verify-lockfile"]);

interface Pkg {
    dependencies?: Record<string, string>;
    name: string;
    optionalDependencies?: Record<string, string>;
    version: string;
}

const quote = (key: string): string => (key.startsWith("@") || key.includes("(") ? `'${key}'` : key);

const dependencyBlock = (field: string, map: Record<string, string> | undefined): string => {
    if (!map) {
        return "";
    }

    const lines = Object.entries(map).map(([name, spec]) => `      ${quote(name)}: ${spec}`);

    return `    ${field}:\n${lines.join("\n")}\n`;
};

/** A lockfile version 9 file with these packages. */
const lock = (packages: Pkg[]): string => {
    const section = packages.map((pkg) => `  ${quote(`${pkg.name}@${pkg.version}`)}:\n    resolution: {integrity: sha512-${Buffer.from(`${pkg.name}@${pkg.version}`).toString("base64")}}`).join("\n\n");
    const snapshots = packages
        .map((pkg) => {
            const own = `${dependencyBlock("dependencies", pkg.dependencies)}${dependencyBlock("optionalDependencies", pkg.optionalDependencies)}`;

            return own === "" ? `  ${quote(`${pkg.name}@${pkg.version}`)}: {}` : `  ${quote(`${pkg.name}@${pkg.version}`)}:\n${own.trimEnd()}`;
        })
        .join("\n\n");

    return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\npackages:\n\n${section}\n\nsnapshots:\n\n${snapshots}\n`;
};

const BASIC: Pkg[] = [{ name: "left-pad", version: "1.3.0" }, { name: "is-odd", version: "3.0.1" }, { name: "@scope/pkg", version: "2.0.0-rc.1" }];

const withLock = (text: string, more: Files = {}): Files => workspaceFiles({ "pnpm-lock.yaml": text, ...more });

const config = (security: unknown): Files => {
    return { "vis.config.ts": `export default { security: ${JSON.stringify(security)} };\n` };
};

/** An outcome with the elapsed time masked: `durationMs` of the JSON report and the `(N entries, 12ms)` of the headline. */
const masked = (outcome: Outcome): Outcome => {
    const timing = (text: string): string => text.replaceAll(/"durationMs": \d+/g, '"durationMs": <MS>').replaceAll(/(?<=entry|entries), (?:\d+ms|\d+\.\ds)\)/g, ", <TIME>)");

    return { ...outcome, stderr: timing(outcome.stderr), stdout: timing(outcome.stdout) };
};

const outcomeOf = (result: Result, root: string): Outcome => masked(Harness.outcome(result, root));

/** Both sides on identical workspaces: the native side must answer, and everything they print and leave must match. */
const both = (files: Files, args: string[] = ["--offline"], extra: Record<string, string> = {}): Result => {
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const node = harness.runNode(args, nodeRoot, extra);
    // `VIS_DEBUG_DECLINE` makes a hand-off name the gate that declined, so a failure here says why.
    const native = harness.runNative(args, nativeRoot, { ...extra, VIS_DEBUG_DECLINE: "1" });

    expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    expect(outcomeOf(native, nativeRoot)).toStrictEqual(outcomeOf(node, nodeRoot));

    return native;
};

/** The binary declines before printing or writing anything, and the delegated run prints what Node prints. */
const handedOver = (files: Files, args: string[] = ["--offline"], extra: Record<string, string> = {}, ci = true): Result => {
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const node = harness.runNode(args, nodeRoot, extra, ci);
    const probe = harness.materialize("native", files);
    const before = Harness.snapshot(probe);
    const declined = harness.runNative(args, probe, { ...extra, VIS_DEBUG_DECLINE: "1" }, ci);

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect(declined.stderr, "the run was declined by a gate, not by a failure").toMatch(/^vis: handing the run to Node: /);
    expect(Harness.snapshot(probe), "a declined run must not touch the files").toStrictEqual(before);

    const delegated = harness.runNative(args, nativeRoot, { ...extra, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }, ci);

    expect(outcomeOf(delegated, nativeRoot)).toStrictEqual(outcomeOf(node, nodeRoot));

    return delegated;
};

/** Only the binary's half, for a shape whose Node run would ask the registry. */
const declinedOnly = (files: Files, args: string[], extra: Record<string, string> = {}): void => {
    const probe = harness.materialize("native", files);
    const before = Harness.snapshot(probe);
    const declined = harness.runNative(args, probe, { ...extra, VIS_DEBUG_DECLINE: "1" });

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect(declined.stderr).toMatch(/^vis: handing the run to Node: /);
    expect(Harness.snapshot(probe), "a declined run must not touch the files").toStrictEqual(before);
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis security verify-lockfile --offline: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-verify-lockfile-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe("a lockfile that passes", () => {
        it("prints the headline", () => {
            expect.hasAssertions();

            const result = both(withLock(lock(BASIC)));

            expect(result.stdout).toContain("✓ Lockfile passes supply-chain policies (3 entries,");
            expect(result.status).toBe(0);
        });

        it("prints the report as JSON", () => {
            expect.hasAssertions();

            const result = both(withLock(lock(BASIC)), ["--offline", "--json"]);

            expect(result.stdout).toContain('"status": "pass"');
            expect(result.stdout).toContain('"entryCount": 3');
        });

        it("takes the flags in either order", () => {
            expect.hasAssertions();

            both(withLock(lock(BASIC)), ["--json", "--offline"]);
        });

        it("says `entry` for a lockfile of one package", () => {
            expect.hasAssertions();

            const result = both(withLock(lock([{ name: "left-pad", version: "1.3.0" }])));

            expect(result.stdout).toContain("(1 entry,");
        });

        it("counts a version once however often the lockfile lists it, and each version of a name", () => {
            expect.hasAssertions();

            both(
                withLock(
                    lock([
                        { name: "left-pad", version: "1.3.0" },
                        { name: "left-pad", version: "1.3.0" },
                        { name: "left-pad", version: "2.0.0" },
                        { name: "react", version: "18.2.0" },
                        { name: "react-dom", version: "18.2.0(react@18.2.0)" },
                    ]),
                ),
                ["--offline", "--json"],
            );
        });

        it("reads the dependency edges that are not exotic", () => {
            expect.hasAssertions();

            both(
                withLock(
                    lock([
                        { dependencies: { "left-pad": "1.3.0", react: "18.2.0(peer@1.0.0)" }, name: "a", optionalDependencies: { fsevents: "2.3.3", local: "file:../local", "npm-alias": "npm:left-pad@1.0.0" }, version: "1.0.0" },
                        { name: "left-pad", version: "1.3.0" },
                        { name: "react", version: "18.2.0" },
                    ]),
                ),
            );
        });

        it("counts a large lockfile", () => {
            expect.hasAssertions();

            const packages = Array.from({ length: 1500 }, (_, index) => {
                return { name: `pkg-${String(index)}`, version: `1.${String(index)}.0` };
            });
            const result = both(withLock(lock(packages)), ["--offline", "--json"]);

            expect(result.stdout).toContain('"entryCount": 1500');
        });

        it("ignores a peer dependency map, which the exotic scan does not read", () => {
            expect.hasAssertions();

            // Not part of the field set the scan reads: only `dependencies` and `optionalDependencies`.
            both(withLock(`${lock(BASIC)}\n`.replace("  left-pad@1.3.0: {}", "  left-pad@1.3.0:\n    peerDependencies:\n      x: github:owner/repo")));
        });
    });

    describe("the config", () => {
        it.each([
            ["a config without a security block", { "vis.config.ts": "export default {};\n" }],
            ["an empty security block", config({})],
            ["policies without the two that decide", config({ policies: { installScripts: { allow: { esbuild: true } } } })],
            ["a null policies block", config({ policies: null })],
            ["other security settings", config({ allowBins: { vite: true }, pinVersions: true })],
        ] as [string, Files][])("answers for %s", (_name, extra) => {
            expect.hasAssertions();

            both(withLock(lock(BASIC), extra));
        });

        it.each([
            ["blockExoticSubdeps", config({ blockExoticSubdeps: true })],
            ["blockExoticSubdeps off", config({ blockExoticSubdeps: false })],
            ["an allow list for exotic subdependencies", config({ exoticSubdepsAllow: ["foo"] })],
            ["a firstSeen policy", config({ policies: { firstSeen: { minutes: 60 } } })],
            ["a publisherChange policy", config({ policies: { publisherChange: { mode: "no-downgrade" } } })],
            ["every check off", config({ blockExoticSubdeps: false, policies: { publisherChange: { mode: "off" } } })],
            ["a security value that is not an object", config(false)],
            ["a policies value that is not an object", config({ policies: "all" })],
            ["a config Node evaluates", { "vis.config.ts": "export default { security: { blockExoticSubdeps: Boolean(1) } };\n" }],
            ["a json config, which Node does not load", { "vis.config.json": "{}" }],
            ["a config that only Node reads", { "vis.config.ts": "export default { runtime: 'node', security: {} };\n" }],
        ] as [string, Files][])("hands the run to Node for %s", (_name, extra) => {
            expect.hasAssertions();

            handedOver(withLock(lock(BASIC), extra));
        });
    });

    describe("what the environment decides", () => {
        const files = (): Files => withLock(lock(BASIC));

        // A narrow `COLUMNS` wraps the headline, which the native path leaves to Node (below).
        it.each([...SHORT_COLOUR_ENVIRONMENTS.filter((extra) => extra["COLUMNS"] === undefined), { FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }, { CI: "true", FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }])("prints the same under %j", (extra) => {
            expect.hasAssertions();

            both(files(), ["--offline"], extra);
        });

        it.each([{ COLUMNS: "70" }, { COLUMNS: "100" }])("prints the same under %j", (extra) => {
            expect.hasAssertions();

            both(files(), ["--offline"], extra);
        });

        it.each([{ COLUMNS: "40" }, { COLUMNS: "60" }])("hands the run to Node when the headline would wrap under %j", (extra) => {
            expect.hasAssertions();

            handedOver(files(), ["--offline"], extra);
        });

        it("prints the JSON report whatever the layout", () => {
            expect.hasAssertions();

            both(files(), ["--offline", "--json"], { COLUMNS: "40" });
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("hands the run to Node under %j", (extra) => {
            expect.hasAssertions();

            handedOver(files(), ["--offline"], extra);
        });

        it("hands a run outside CI to Node", () => {
            expect.hasAssertions();

            handedOver(files(), ["--offline"], {}, false);
        });

        it.each([{ NODE_ENV: "test" }, { DEBUG: "1" }, { PAIL_LOG_LEVEL: "error" }])("hands the run to Node under %j", (extra) => {
            expect.hasAssertions();

            handedOver(files(), ["--offline"], extra);
        });
    });

    describe("what the native path leaves to Node", () => {
        const files = (): Files => withLock(lock(BASIC));

        // Without `--offline` Node asks the registry about every package, so only the binary's half runs.
        it.each([[[]], [["--json"]], [["--offline", "--offline"]], [["--offline=true"]], [["--no-offline"]], [["--offline", "extra"]], [["--offline", "--json", "--json"]], [["--offline", "--cwd", "."]], [["--"]]])("declines the arguments %j", (args) => {
            expect.hasAssertions();

            declinedOnly(files(), args);
        });

        it.each([
            ["a git dependency", { dependencies: { foo: "git+https://example.com/foo.git#abc" }, name: "a", version: "1.0.0" }],
            ["a hosted shorthand", { dependencies: { foo: "github:owner/foo" }, name: "a", version: "1.0.0" }],
            ["a bare owner/repo", { dependencies: { foo: "owner/foo#main" }, name: "a", version: "1.0.0" }],
            ["a remote tarball", { name: "a", optionalDependencies: { foo: "https://example.com/foo.tgz" }, version: "1.0.0" }],
        ] as [string, Pkg][])("hands a run with %s to Node, which fails and lists it", (_name, pkg) => {
            expect.hasAssertions();

            // Node fails the run and lists the edge: a native "pass" here would be a false attestation.
            expect(handedOver(withLock(lock([...BASIC, pkg]))).status).toBe(1);
            expect(handedOver(withLock(lock([...BASIC, pkg])), ["--offline", "--json"]).status).toBe(1);
        });

        // Two snapshot keys that differ only by a peer suffix read as one `name@version`, whichever lists the exotic edge.
        it.each([
            ["the clean variant first", false],
            ["the exotic variant first", true],
        ] as [string, boolean][])("never passes a lockfile whose peer-suffixed variants hide an exotic edge, with %s", (_name, exoticFirst) => {
            expect.hasAssertions();

            const clean = "  a@1.0.0(peer@1.0.0):\n    dependencies:\n      left-pad: 1.3.0\n";
            const exotic = "  a@1.0.0(peer@2.0.0):\n    dependencies:\n      foo: github:owner/foo\n";
            const snapshots = exoticFirst ? `${exotic}\n${clean}` : `${clean}\n${exotic}`;
            const text = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\npackages:\n\n  a@1.0.0:\n    resolution: {integrity: sha512-aGVsbG8=}\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-aGVsbG8=}\n\nsnapshots:\n\n${snapshots}\n  left-pad@1.3.0: {}\n`;

            // Node reads both variants as one entry and fails the run; the binary hands the run over rather than print a pass.
            expect(handedOver(withLock(text)).status).toBe(1);
        });

        it("hands a lockfile with no package to Node", () => {
            expect.hasAssertions();

            handedOver(workspaceFiles({}));
        });

        it("hands a missing lockfile to Node", () => {
            expect.hasAssertions();

            const missing = withLock(lock(BASIC));

            delete missing["pnpm-lock.yaml"];
            handedOver(missing);
        });

        it.each([
            ["windows line ends", lock(BASIC).replaceAll("\n", "\r\n")],
            ["a byte-order mark", `\uFEFF${lock(BASIC)}`],
            ["a non-breaking space", lock(BASIC).replace("autoInstallPeers", "autoInstallPeers\u00A0")],
        ] as [string, string][])("hands a lockfile with %s to Node", (_name, text) => {
            expect.hasAssertions();

            handedOver(withLock(text));
        });

        it("hands a dependency specifier outside ASCII to Node", () => {
            expect.hasAssertions();

            handedOver(withLock(lock([{ dependencies: { foo: "café" }, name: "a", version: "1.0.0" }, ...BASIC])));
        });

        it("hands a package.json that pins the package manager to Node", () => {
            expect.hasAssertions();

            handedOver(withLock(lock(BASIC), { "package.json": '{"name":"root","private":true,"packageManager":"pnpm@9.0.0"}\n' }));
        });

        it("hands a workspace that is not pnpm to Node", () => {
            expect.hasAssertions();

            const npm = withLock(lock(BASIC));

            delete npm["pnpm-lock.yaml"];
            delete npm["pnpm-workspace.yaml"];
            handedOver({ ...npm, "package-lock.json": JSON.stringify({ lockfileVersion: 3, name: "root", packages: { "": { name: "root" } } }) });
        });
    });
});
