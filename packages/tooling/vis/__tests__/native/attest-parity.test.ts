import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis attest` exists twice: the Node handler (`src/commands/attest/handler.ts`) and the native path
 * (`native/cli/src/attest/`). For every input the native path accepts it must print the same bytes on the same stream, end with the
 * same exit status and leave the same cache files as Node; every input it declines must be handed to Node before anything is
 * printed (see `workspace-parity-harness.ts` for how both are proved).
 *
 * The native path answers two leaves. `vis attest <subject>` answers the run with no ambient OIDC token, where Node hashes the artifact and
 * skips signing. `vis attest verify` checks the locked packages against the registry: the registry is a stub in a separate process
 * that the `.npmrc` of the workspace points both sides at, and the signing keys sit in the key cache of each side's `HOME`
 * (fresh, so neither side asks the network), signed here with real ECDSA P-256 keys. Each side has its own `HOME`, because the
 * caches live in `~/.vis/cache`; the `createdAt` of a fresh cache entry is masked.
 */

const harness = new Harness(["attest"]);

interface Answer {
    body: string;
    status?: number;
}

interface Key {
    id: string;
    privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
    spki: string;
}

const newKey = (id: string): Key => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

    return { id, privateKey, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
};

const GOOD = newKey("sha256-good");
const OTHER = newKey("sha256-other");
const OLD = newKey("sha256-old");
const NOBODY = newKey("sha256-nobody");
const KEYS = [
    { key: GOOD.spki, keyid: GOOD.id, keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256" },
    { expires: "2020-01-01T00:00:00.000Z", key: OLD.spki, keyid: OLD.id },
];

const INTEGRITY = "sha512-AAAA";

const sign = (key: Key, name: string, version: string): { keyid: string; sig: string } => {
    return { keyid: key.id, sig: createSign("SHA256").update(`${name}@${version}:${INTEGRITY}`).sign(key.privateKey, "base64") };
};

const PROVENANCE = { provenance: { predicateType: "https://slsa.dev/provenance/v1" } };

const entry = (name: string, version: string, key?: Key, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    return { dist: { integrity: INTEGRITY, ...(key === undefined ? {} : { signatures: [sign(key, name, version)] }), ...extra }, version };
};

const packument = (name: string, versions: Record<string, Record<string, unknown>>): Answer => {
    return { body: JSON.stringify({ "dist-tags": { latest: Object.keys(versions).at(-1) }, name, versions }) };
};

const ANSWERS: Record<string, Answer> = {
    "/@scope%2fscoped": packument("@scope/scoped", { "1.0.0": entry("@scope/scoped", "1.0.0", GOOD, { attestations: PROVENANCE }) }),
    // Signed with another key's private half, under the id of the registry's key.
    "/bad-sig": packument("bad-sig", { "1.0.0": entry("bad-sig", "1.0.0", { ...OTHER, id: GOOD.id }) }),
    "/broken": { body: "broken", status: 500 },
    "/expired": packument("expired", { "1.0.0": entry("expired", "1.0.0", OLD) }),
    "/no-integrity": packument("no-integrity", { "1.0.0": { dist: { signatures: [sign(GOOD, "no-integrity", "1.0.0")] }, version: "1.0.0" } }),
    "/no-sig": packument("no-sig", { "1.0.0": entry("no-sig", "1.0.0") }),
    "/regressed": packument("regressed", {
        "1.0.0": entry("regressed", "1.0.0", GOOD, { attestations: PROVENANCE }),
        "1.1.0-beta.1": entry("regressed", "1.1.0-beta.1", GOOD, { attestations: PROVENANCE }),
        "2.0.0": entry("regressed", "2.0.0", GOOD),
    }),
    "/signed": packument("signed", { "1.0.0": entry("signed", "1.0.0", GOOD) }),
    "/signed-too": packument("signed-too", { "2.3.4": entry("signed-too", "2.3.4", GOOD, { attestations: PROVENANCE }) }),
    "/unknown-key": packument("unknown-key", { "1.0.0": entry("unknown-key", "1.0.0", NOBODY) }),
};

const STUB = String.raw`
const http = require("node:http");
const answers = JSON.parse(process.env.ANSWERS);
const server = http.createServer((req, res) => {
    const answer = answers[req.url.split("?")[0]];
    if (answer === undefined) { res.statusCode = 404; res.end("{}"); return; }
    res.statusCode = answer.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(answer.body);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\n"));
`;

const lockfile = (packages: [string, string][]): string => {
    const section = packages.map(([name, version]) => `  ${name}@${version}:\n    resolution: {integrity: ${INTEGRITY}}\n`).join("\n");
    const snapshots = packages.map(([name, version]) => `  ${name}@${version}: {}\n`).join("\n");

    return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n  .: {}\n\npackages:\n\n${section}\nsnapshots:\n\n${snapshots}`;
};

let scratch: string;
let stub: ChildProcess;
let base: string;

const makeHome = (): string => {
    const directory = realpathSync(mkdtempSync(join(scratch, "home-")));
    const file = join(directory, ".vis/cache/registry-keys/npmjs.json");

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ createdAt: Date.now(), keys: KEYS, ttlMs: 86_400_000 }));

    return directory;
};

/** Every file under a home, with the `createdAt` of a cache entry written during this run masked. */
const homeState = (home: string): Record<string, string> => {
    const files: Record<string, string> = {};

    for (const item of readdirSync(home, { recursive: true, withFileTypes: true })) {
        if (item.isFile()) {
            const path = join(item.parentPath, item.name);

            files[relative(home, path)] = readFileSync(path, "utf8").replace(/"createdAt":(\d+)/, (whole, stamp: string) => (Math.abs(Date.now() - Number(stamp)) < 120_000 ? '"createdAt":"NOW"' : whole));
        }
    }

    return files;
};

interface Case {
    args: string[];
    /** Extra files of the workspace. */
    files?: Record<string, string>;
    /** True when the native side must answer; false when it must hand the run to Node. */
    native: boolean;
    packages?: [string, string][];
    /** True when a declined run has filled the caches Node then finds warm. */
    warm?: boolean;
}

const run = ({ args, files: extra = {}, native, packages = [], warm = false }: Case): { status: number | null; stderr: string; stdout: string } => {
    const files = workspaceFiles({ ".npmrc": `registry=${base}/\n`, ...(packages.length > 0 ? { "pnpm-lock.yaml": lockfile(packages) } : {}), ...extra });
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const nodeHome = makeHome();
    const nativeHome = makeHome();
    const node = harness.runNode(args, nodeRoot, { HOME: nodeHome });

    if (native) {
        const answered = harness.runNative(args, nativeRoot, { HOME: nativeHome, VIS_DEBUG_DECLINE: "1" });

        expect(answered.status, `native stderr: ${answered.stderr}`).not.toBe(70);
        expect(Harness.outcome(answered, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
        expect(homeState(nativeHome)).toStrictEqual(homeState(nodeHome));

        return answered;
    }

    const probeRoot = harness.materialize("native", files);
    const probeHome = makeHome();
    const before = { files: Harness.snapshot(probeRoot), home: homeState(probeHome) };
    const declined = harness.runNative(args, probeRoot, { HOME: probeHome });

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");

    // A table of findings is drawn by Node, which finds the packuments this run fetched in the cache; the other declines write nothing.
    if (!warm) {
        expect({ files: Harness.snapshot(probeRoot), home: homeState(probeHome) }, "a declined run must not touch anything").toStrictEqual(before);
    }

    const delegated = harness.runNative(args, nativeRoot, { HOME: nativeHome, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

    expect(Harness.outcome(delegated, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
    expect(homeState(nativeHome)).toStrictEqual(homeState(nodeHome));

    return delegated;
};

const CLEAN: [string, string][] = [["signed", "1.0.0"], ["@scope/scoped", "1.0.0"], ["signed-too", "2.3.4"]];
const FINDINGS: [string, string][] = [
    ...CLEAN,
    ["regressed", "2.0.0"],
    ["no-sig", "1.0.0"],
    ["no-integrity", "1.0.0"],
    ["unknown-key", "1.0.0"],
    ["expired", "1.0.0"],
    ["bad-sig", "1.0.0"],
];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis attest: native vs Node", () => {
    beforeAll(async () => {
        harness.setup("vis-attest-parity-");
        scratch = mkdtempSync(join(tmpdir(), "vis-attest-homes-"));
        // CI runs the suite with `FORCE_COLOR=3`: the stub gets it here on purpose, so its port reaches `base` as plain digits.
        stub = spawn(process.execPath, ["-e", STUB], { env: Harness.environment({ ANSWERS: JSON.stringify(ANSWERS), FORCE_COLOR: "3" }), stdio: ["ignore", "pipe", "inherit"] });
        base = await new Promise<string>((resolve) => {
            stub.stdout?.once("data", (chunk: Buffer) => {
                resolve(`http://127.0.0.1:${chunk.toString().trim()}`);
            });
        });
    });

    afterAll(() => {
        stub.kill();
        harness.teardown();
        rmSync(scratch, { force: true, recursive: true });
    });

    describe("attest verify", () => {
        it("prints the JSON report of a clean tree", () => {
            expect.hasAssertions();

            const result = run({ args: ["verify", "--format", "json"], native: true, packages: CLEAN });

            expect(result.stdout).toBe('{\n  "findings": [],\n  "ok": true\n}\n');
            expect(result.status).toBe(0);
        });

        it("prints the line of a clean tree in the table format", () => {
            expect.hasAssertions();

            expect(run({ args: ["verify"], native: true, packages: CLEAN }).stdout).toContain("No provenance regressions or signature problems across 3 locked packages.");
        });

        it("reports every kind of finding and fails", () => {
            expect.hasAssertions();

            const result = run({ args: ["verify", "--format", "json"], native: true, packages: FINDINGS });
            const codes = (JSON.parse(result.stdout) as { findings: { code: string }[] }).findings.map((finding) => finding.code);

            expect(codes).toStrictEqual(["provenance-regression", "missing-signature", "missing-signature", "unknown-keyid", "expired-key", "invalid-signature"]);
            expect(result.status).toBe(1);
        });

        it("prints a line per finding in NDJSON", () => {
            expect.hasAssertions();

            const result = run({ args: ["verify", "--format=ndjson"], native: true, packages: FINDINGS });

            expect(result.stdout.trim().split("\n")).toHaveLength(6);
            expect(result.status).toBe(1);
        });

        it("fails only on errors with --fail-on error", () => {
            expect.hasAssertions();

            const warnings: [string, string][] = [["signed", "1.0.0"], ["regressed", "2.0.0"], ["no-sig", "1.0.0"]];
            const result = run({ args: ["verify", "--format", "json", "--fail-on", "error"], native: true, packages: warnings });

            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
            expect(run({ args: ["verify", "--format", "json", "--fail-on=error"], native: true, packages: FINDINGS }).status).toBe(1);
        });

        it("skips the allowlisted packages without asking the registry for them", () => {
            expect.hasAssertions();

            const result = run({ args: ["verify", "--format", "json", "--allowlist", " no-sig, regressed,,bad-sig,expired,no-integrity,unknown-key "], native: true, packages: FINDINGS });

            expect(JSON.parse(result.stdout)).toStrictEqual({ findings: [], ok: true });
        });

        it("counts a package the registry does not know as clean", () => {
            expect.hasAssertions();

            run({ args: ["verify", "--format", "json"], native: true, packages: [...CLEAN, ["ghost", "1.0.0"]] });
        });

        it("hands the table of findings to Node, which finds the cache warm", () => {
            expect.hasAssertions();

            run({ args: ["verify"], native: false, packages: FINDINGS, warm: true });
        });

        it.each([
            [["verify", "--prod-only"]],
            [["verify", "--format", "xml"]],
            [["verify", "--fail-on", "info"]],
            [["verify", "extra"]],
        ])("hands `attest %j` to Node", (args: string[]) => {
            expect.hasAssertions();

            run({ args, native: false, packages: CLEAN });
        });

        it("hands a failing registry to Node", () => {
            expect.hasAssertions();

            run({ args: ["verify", "--format", "json"], native: false, packages: [...CLEAN, ["broken", "1.0.0"]] });
        });
    });

    describe("attest <subject>", () => {
        const artifact = { "dist/app.tgz": "artifact bytes", "dist/café.tgz": "x" };

        it("warns that signing is skipped", () => {
            expect.hasAssertions();

            const result = run({ args: ["dist/app.tgz"], files: artifact, native: true });

            expect(result.stderr).toContain("No ambient OIDC token");
            expect(result.status).toBe(0);
        });

        it("prints the skip document with --format json", () => {
            expect.hasAssertions();

            const result = run({ args: ["dist/app.tgz", "--format", "json"], files: artifact, native: true });

            expect(JSON.parse(result.stdout)).toStrictEqual({ ok: false, reason: "no-ambient-oidc", sha256: createHash("sha256").update("artifact bytes").digest("hex"), skipped: true, subject: "app.tgz" });
        });

        it.each([
            [["--format=ndjson", "dist/app.tgz"]],
            [["dist/app.tgz", "--output", "out.sigstore", "--predicate", "slsaProvenance", "--format", "table"]],
            [["--format", "json", "dist/app.tgz", "--output=out.sigstore"]],
        ])("answers `attest %j`", (args: string[]) => {
            expect.hasAssertions();

            run({ args, files: artifact, native: true });
        });

        it.each([
            [["dist/missing.tgz"]],
            [["dist"]],
            [["./dist/app.tgz"]],
            [["dist/../dist/app.tgz"]],
            [["dist/café.tgz"]],
            [["dist/app.tgz", "--format", "xml"]],
            [["dist/app.tgz", "--predicate", "other"]],
            [["dist/app.tgz", "--require-signing"]],
        ])("hands `attest %j` to Node", (args: string[]) => {
            expect.hasAssertions();

            run({ args, files: artifact, native: false });
        });
    });
});
