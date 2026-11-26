import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis inspect &lt;package> --json` exists twice: the Node handler (`src/commands/inspect/handler.ts`) and the native path
 * (`native/cli/src/inspect/`), which runs the marshalls that read the registry's packument (`author`, `provenance`,
 * `s1ngularity`, `newBin`, `metadata`), `downloads` (the registry's download API), `archivedRepo` (GitHub) and `signatures`, which
 * reads the registry's keys from `VIS_NPM_KEYS_URL` (a variable both sides honour, so the stub serves it) and verifies with ECDSA. For every input the native path accepts it must print the same JSON on the same
 * stream, end with the same exit status and leave the same packument cache as Node; every input it declines must be handed
 * to Node before anything is printed or written (see `workspace-parity-harness.ts` for how both are proved).
 *
 * The registry is a stub in a separate process (the runs block this one) that the `.npmrc` of the workspace points both
 * sides at, so nothing reaches the network. Each side gets its own `HOME`, because the cache lives in
 * `~/.vis/cache/packuments`; the `createdAt` of a fresh cache entry is masked. The marshalls that ask other services
 * (`expiredDomains`, `archivedRepo`, `downloads`) are switched off with `MARSHALL_DISABLE_*`, which both sides read. A run that
 * needs `downloads` answers from the cache file both sides read (the download API's address is a constant, so no run can
 * point either side at a stub); what each side does with an answer of the API is proved by `downloads answers` below, with
 * Node's `fetch` replaced and the binary's side by the unit tests in `native/cli/src/inspect/tests.rs`, which assert the same text.
 */

const harness = new Harness(["inspect"]);
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();

/** An ISO time `days` before the start of the run, as the registry writes it. */
const ago = (days: number): string => new Date(T0 - days * DAY).toISOString();

const user = (name: string): { email: string; name: string } => {
    return { email: `${name}@example.test`, name };
};

const version = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    return { _npmUser: user(name), license: "MIT", readme: "# readme", repository: { type: "git", url: "git+https://github.com/o/r.git" }, ...extra };
};

const packument = (name: string, versions: Record<string, unknown>, time: Record<string, string> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    return { "dist-tags": { latest: Object.keys(versions).at(-1) }, name, time, versions, ...extra };
};

const BOM = String.fromCodePoint(0xFE_FF);
/** A readme with an accented letter, the line separator U+2028, an astral character, a quote and a backslash. */
const README = `caf\u00E9 ${String.fromCodePoint(0x20_28)} ${String.fromCodePoint(0x1_F6_00)} "q" \\`;

/** Registry signing keys made for the run: the key a signature must verify against, an expired one, one that expires far ahead, and a stranger. */
const signingKey = (): { privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]; spki: string } => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

    return { privateKey, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
};
const KEY_ONE = signingKey();
const KEY_STRANGER = signingKey();
const registryKey = (keyid: string, key = KEY_ONE, expires?: string): Record<string, unknown> => {
    return { key: key.spki, keyid, keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256", ...(expires === undefined ? {} : { expires }) };
};
/** `SHA256:null` has `"expires": null`, as npm's current key does. */
const KEYS = [registryKey("SHA256:one"), registryKey("SHA256:old", KEY_ONE, "2020-01-01T00:00:00.000Z"), registryKey("SHA256:later", KEY_ONE, "2999-01-01T00:00:00.000Z"), { ...registryKey("SHA256:null"), expires: null }];
const sign = (name: string, integrity: string, key = KEY_ONE): string => createSign("SHA256").update(`${name}@1.0.0:${integrity}`).end().sign(key.privateKey, "base64");
const signedPackage = (name: string, signatures: { keyid: string; sig?: string }[], integrity: string | false = "sha512-integrity"): Record<string, unknown> => packument(name, { "1.0.0": version("amy", { dist: { ...(integrity === false ? {} : { integrity }), signatures } }) }, { "1.0.0": ago(50.3) });
const keyed = (name: string, keyid = "SHA256:one", key = KEY_ONE): { keyid: string; sig: string } => {
    return { keyid, sig: sign(name, "sha512-integrity", key) };
};

const SIGNED = { dist: { attestations: { provenance: { predicateType: "x" } }, tarball: "https://registry.example.test/p.tgz", unpackedSize: 12_345 } };

interface Answer {
    body: string;
    gzip?: boolean;
    headers?: Record<string, string>;
    status?: number;
}

const json = (value: unknown): Answer => {
    return { body: JSON.stringify(value) };
};

/** Every package the cases use, by registry path. A time is relative to `T0`: the two runs are seconds apart, so each sits mid-bucket. */
const ANSWERS: Record<string, Answer> = {
    "/@scope%2fbins": json(packument("@scope/bins", { "1.0.0": version("amy"), "1.1.0": version("amy", { bin: "cli.js" }) })),
    "/array": { body: "[]" },
    "/bare": json(packument("bare", { "1.0.0": { _npmUser: user("amy") } })),
    "/bins": json(
        packument("bins", {
            "1.0.0": version("amy", { bin: { bins: "cli.js" } }),
            "1.1.0": version("amy", { bin: { bins: "cli.js", helper: "h.js", other: "o.js" } }),
            "1.2.0": version("amy", { bin: "cli.js" }),
        }),
    ),
    "/bom": { body: `${BOM}${JSON.stringify(packument("bom", { "1.0.0": version("amy") }))}` },
    "/calm": json(packument("calm", { "1.0.0": version("amy"), "1.1.0": version("amy"), "1.2.0": version("amy") }, { "1.0.0": ago(100.3), "1.1.0": ago(90.3), "1.2.0": ago(80.3) })),
    "/dangling": json(packument("dangling", { "1.0.0": version("amy") }, {}, { "dist-tags": { latest: "9.9.9" } })),
    "/dormant": json(packument("dormant", { "1.0.0": version("amy"), "1.1.0": version("amy") }, { "1.0.0": ago(200.4), "1.1.0": ago(100.3) })),
    "/empty": json({ name: "empty", versions: {} }),
    "/gzipped": { body: JSON.stringify(packument("gzipped", { "1.0.0": version("amy") }, { "1.0.0": ago(50.3) })), gzip: true },
    "/hooks": json(
        packument("hooks", {
            "1.0.0": version("amy", { ...SIGNED, scripts: { install: "node a.js", test: "x" } }),
            "1.1.0": version("amy", { scripts: { install: "node b.js", postinstall: "node c.js", preinstall: "" } }),
        }),
    ),
    // The registry's signing keys, at addresses `VIS_NPM_KEYS_URL` names.
    "/keys/empty": { body: "{}" },
    "/keys/not-json": { body: "<html></html>" },
    "/keys/ok": json({ keys: KEYS }),
    "/keys/server-error": { body: "broken", status: 500 },
    "/loose-tag": json(packument("loose-tag", { "1.0.0": version("amy") }, {}, { "dist-tags": { latest: "v1.0.0" } })),
    "/loose-version": json(packument("loose-version", { "1.0": version("amy"), "1.0.0": version("amy") }, { "1.0.0": ago(50.3) })),
    "/meta": json(packument("meta", { "1.0.0": { _npmUser: user("amy"), license: { type: " " }, readme: "ERROR: No README data found!", repository: { url: "nonsense" } } })),
    "/no-versions": json({ name: "no-versions" }),
    "/not-json": { body: "<html></html>" },
    "/null-dist": json(packument("null-dist", { "1.0.0": { dist: null } })),
    "/null-entry": json(packument("null-entry", { "1.0.0": null })),
    "/null-repository": json(packument("null-repository", { "1.0.0": { repository: null } })),
    "/null-user": json(packument("null-user", { "1.0.0": { _npmUser: null } }, { "1.0.0": ago(50.3) })),
    // Integer-like keys and a repeated key, which JSON.parse and JSON.stringify order and merge their own way.
    "/odd-keys": {
        body: '{"name":"odd-keys","extra":{"b":1,"2":2},"versions":{"1.1.0":{"license":"MIT","readme":"r","repository":{"url":"https://github.com/o/r"},"scripts":{"b":1,"2":2,"1":3,"a":4,"a":5}},"1.0.0":{"license":"MIT","readme":"r","repository":{"url":"https://github.com/o/r"},"dist":{"size":1,"fileCount":3,"unpackedSize":-1,"integrity":5}}},"dist-tags":{"latest":"1.1.0"},"time":{}}',
    },
    "/odd-time": json(packument("odd-time", { "1.0.0": version("amy") }, { "1.0.0": "2024-01-01" })),
    "/odd-url": json(packument("odd-url", { "1.0.0": version("amy", { repository: { url: "https://xn--a.example/x" } }) })),
    "/one-hook": json(packument("one-hook", { "1.0.0": version("amy", SIGNED), "1.1.0": version("amy", { scripts: { postinstall: "x" } }) })),
    // The versions are written newest first, so the first key is not the lowest version.
    "/order": {
        body: `{"dist-tags":{"latest":"1.1.0"},"name":"order","time":{"1.0.0":"${ago(1000.3)}","1.1.0":"${ago(1000.3)}","2.0.0":"${ago(900.3)}","2.1.0":"${ago(30.3)}"},"versions":{"2.1.0":${JSON.stringify(version("bob"))},"1.1.0":${JSON.stringify(version("amy"))},"1.0.0":${JSON.stringify(version("amy"))},"2.0.0":${JSON.stringify(version("amy"))}}}`,
    },
    "/pretty": { body: `${JSON.stringify(packument("pretty", { "1.0.0": version("amy", { readme: README }) }, { "1.0.0": ago(50.3) }), undefined, 4)}\n` },
    "/private": json(packument("private", { "1.0.0": { private: true } })),
    "/proto": { body: `{"name":"proto","versions":{"constructor":${JSON.stringify(version("amy"))},"1.0.0":${JSON.stringify(version("amy"))}}}` },
    "/proto-bin": json(packument("proto-bin", { "1.0.0": version("amy"), "1.1.0": version("amy", { bin: { toString: "x.js" } }) })),
    "/provenance": json(packument("provenance", { "1.0.0": version("amy", SIGNED), "1.1.0": version("amy", SIGNED), "1.2.0": version("amy"), "1.2.0-beta.1": version("amy") })),
    "/redirect": { body: "", headers: { location: "/calm" }, status: 302 },
    // What goes to Node.
    "/server-error": { body: "broken", status: 500 },
    "/sig-bad": json(signedPackage("sig-bad", [keyed("sig-bad", "SHA256:one", KEY_STRANGER)])),
    "/sig-expired": json(signedPackage("sig-expired", [keyed("sig-expired", "SHA256:old")])),
    "/sig-future": json(signedPackage("sig-future", [keyed("sig-future", "SHA256:later")])),
    "/sig-good": json(signedPackage("sig-good", [keyed("sig-good")])),
    "/sig-malformed": json(signedPackage("sig-malformed", [{ keyid: "SHA256:one", sig: "not base64!" }])),
    "/sig-no-integrity": json(signedPackage("sig-no-integrity", [{ keyid: "SHA256:one", sig: "x" }], false)),
    "/sig-none": json(signedPackage("sig-none", [])),
    "/sig-null-expiry": json(signedPackage("sig-null-expiry", [keyed("sig-null-expiry", "SHA256:null")])),
    "/sig-two": json(signedPackage("sig-two", [keyed("sig-two"), { keyid: "SHA256:unlisted", sig: "x" }])),
    "/tagless": json({ name: "tagless", versions: { "1.0.0": version("amy"), "2.0.0": version("amy") } }),
    // Repository URLs in the shapes `URL.canParse` judges the same way in every version of Node.
    "/urls": json(
        packument("urls", {
            "1.0.0": version("amy", { repository: { url: "git+ssh://git@github.com/o/r.git" } }),
            "1.1.0": version("amy", { repository: { url: "ssh://git@github.com:o/r.git" } }),
            "1.2.0": version("amy", { repository: { url: "git://github.com/o/r.git" } }),
            "1.3.0": version("amy", { repository: { url: "https://example.test:99999/x" } }),
            "1.4.0": version("amy", { repository: "o/r" }),
            "1.5.0": version("amy", { repository: { url: "git@github.com:o/r.git" } }),
            "1.6.0": version("amy", { repository: { url: "github.com/o/r" } }),
            "1.7.0": version("amy", { repository: { url: "github:o/r" } }),
        }),
    ),
    "/young": json(
        packument(
            "young",
            { "1.0.0": version("amy"), "1.1.0": version("amy"), "1.2.0": version("bob"), "1.3.0": version("amy") },
            { "1.0.0": ago(1000.3), "1.1.0": ago(900.3), "1.2.0": ago(2.37), "1.3.0": ago(20.31) },
            { "dist-tags": { latest: "1.3.0", stale: "1.2.0" } },
        ),
    ),
};

const STUB = String.raw`
const http = require("node:http");
const zlib = require("node:zlib");
const answers = JSON.parse(process.env.ANSWERS);
const server = http.createServer((req, res) => {
    const answer = answers[req.url.split("?")[0]];
    if (answer === undefined) { res.statusCode = 404; res.end("{}"); return; }
    res.statusCode = answer.status ?? 200;
    for (const [name, value] of Object.entries(answer.headers ?? {})) res.setHeader(name, value);
    res.setHeader("content-type", "application/json");
    if (answer.gzip) { res.setHeader("content-encoding", "gzip"); res.end(zlib.gzipSync(answer.body)); return; }
    res.end(answer.body);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\n"));
`;

let scratch: string;
let stub: ChildProcess;
let base: string;

const makeHome = (cache?: { name: string; text: string }, files: Record<string, string> = {}): string => {
    const directory = realpathSync(mkdtempSync(join(scratch, "home-")));

    if (cache !== undefined) {
        mkdirSync(join(directory, ".vis/cache/packuments"), { recursive: true });
        writeFileSync(join(directory, ".vis/cache/packuments", `${encodeURIComponent(cache.name)}.json`), cache.text);
    }

    for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(directory, name)), { recursive: true });
        writeFileSync(join(directory, name), text);
    }

    return directory;
};

/**
 * The cache files that let Node run the marshalls that ask other services without asking them: the download count of
 * `calm`, the state of its repository, and the maintainer domain of every package here. The fixed 24 hours of their
 * entries outlast the run.
 */
const serviceCaches = (): Record<string, string> => {
    const entry = (extra: Record<string, unknown>): string => JSON.stringify({ createdAt: Date.now(), ttlMs: 86_400_000, ...extra });

    return {
        ".vis/cache/archived-repo/o__r.json": entry({ archived: false }),
        ".vis/cache/downloads/calm.json": entry({ downloads: 50_000, observedAt: new Date().toISOString() }),
        [`.vis/cache/expired-domains/${createHash("sha256").update("example.test").digest("hex").slice(0, 12)}.json`]: entry({ outcome: "ok" }),
    };
};

/** Every file under a home, with the `createdAt` of a cache entry written during this run masked. */
const homeState = (home: string): Record<string, string> => {
    const files: Record<string, string> = {};

    for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            const path = join(entry.parentPath, entry.name);

            files[relative(home, path)] = readFileSync(path, "utf8").replace(/"createdAt":(\d+)/, (whole, stamp: string) => (Math.abs(Date.now() - Number(stamp)) < 120_000 ? '"createdAt":"NOW"' : whole));
        }
    }

    return files;
};

interface Case {
    args: string[];
    /** The cache entry the homes start with. */
    cache?: { name: string; text: string };
    /** Extra variables for both sides. */
    extra?: Record<string, string>;
    /** Files the homes start with, by path below the home. */
    files?: Record<string, string>;
    /** True when the native side must answer; false when it must hand the run to Node. */
    native: boolean;
    /** The `.npmrc` of the workspace; the stub's registry by default. */
    npmrc?: string;
}

const OFF = { MARSHALL_DISABLE_ARCHIVED_REPO: "1", MARSHALL_DISABLE_DOWNLOADS: "1", MARSHALL_DISABLE_EXPIRED_DOMAINS: "1" };

/** Runs both sides; returns what the side that answered printed. */
const run = ({ args, cache, extra = {}, files: homeFiles, native, npmrc }: Case): { status: number | null; stderr: string; stdout: string } => {
    const files = workspaceFiles({ ".npmrc": npmrc ?? `registry=${base}/\n` });
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const environment = (home: string, more: Record<string, string> = {}): Record<string, string> => {
        return { HOME: home, ...OFF, ...extra, ...more };
    };
    const nodeHome = makeHome(cache, homeFiles);
    const nativeHome = makeHome(cache, homeFiles);
    const node = harness.runNode(args, nodeRoot, environment(nodeHome));

    if (native) {
        // `VIS_DEBUG_DECLINE` makes a hand-off name the gate that declined, so a failure here says why.
        const answered = harness.runNative(args, nativeRoot, environment(nativeHome, { VIS_DEBUG_DECLINE: "1" }));

        expect(answered.status, `native stderr: ${answered.stderr}`).not.toBe(70);
        expect(Harness.outcome(answered, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
        expect(homeState(nativeHome)).toStrictEqual(homeState(nodeHome));

        return answered;
    }

    const probeRoot = harness.materialize("native", files);
    const probeHome = makeHome(cache, homeFiles);
    const before = { files: Harness.snapshot(probeRoot), home: homeState(probeHome) };
    const declined = harness.runNative(args, probeRoot, environment(probeHome));

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect({ files: Harness.snapshot(probeRoot), home: homeState(probeHome) }, "a declined run must not touch anything").toStrictEqual(before);

    const delegated = harness.runNative(args, nativeRoot, environment(nativeHome, { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }));

    expect(Harness.outcome(delegated, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
    expect(homeState(nativeHome)).toStrictEqual(homeState(nodeHome));

    return delegated;
};

const report = (stdout: string): { errors: { marshall: string; message: string }[]; summary: { errorCount: number; warningCount: number }; warnings: { marshall: string; message: string }[] } => JSON.parse(stdout) as never;

const NATIVE_FIVE = "author,provenance,s1ngularity,newBin,metadata";

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis inspect --json: native vs Node", () => {
    beforeAll(async () => {
        harness.setup("vis-inspect-parity-");
        scratch = mkdtempSync(join(tmpdir(), "vis-inspect-homes-"));

        // CI runs the suite with `FORCE_COLOR=3`, which makes Node colour a number written with `console.log` even into a pipe, so the stub
        // gets that variable here on purpose: its port must reach `base` as plain digits whatever the colour settings are.
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

    it("reaches the stub at a plain URL even when the runner forces colour", () => {
        expect.hasAssertions();
        expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    describe("a report that is clean", () => {
        it("prints the empty report and writes the cache the way Node does", () => {
            expect.hasAssertions();

            const result = run({ args: ["calm", "--json"], native: true });

            expect(result.stdout).toBe('{\n  "errors": [],\n  "findings": [],\n  "summary": {\n    "errorCount": 0,\n    "warningCount": 0\n  },\n  "warnings": []\n}\n');
        });

        it.each(["calm", "gzipped", "pretty", "odd-keys", "order", "tagless", "dangling"])("runs the five marshalls on %s", (name) => {
            expect.hasAssertions();

            run({ args: [name, "--json", "--only", NATIVE_FIVE], native: true });
        });
    });

    describe("what the marshalls report", () => {
        it("reports a young version and a new publisher", () => {
            expect.hasAssertions();

            const { errors } = report(run({ args: ["young@1.2.0", "--json", "--only", "author"], native: true }).stdout);

            expect(errors.map((finding) => finding.message)).toStrictEqual(["published 2.4 days ago (error threshold: 7)", "first publish by bob@example.test on a 1000-day-old package"]);
        });

        it("reports a recent version as a warning and a dormant maintainer as an error", () => {
            expect.hasAssertions();

            const result = report(run({ args: ["young", "--json", "--only", "author"], native: true }).stdout);

            expect(result.warnings.map((finding) => finding.message)).toStrictEqual(["published 20.3 days ago (warn threshold: 30)"]);
            expect(result.errors.map((finding) => finding.message)).toStrictEqual(["previous release by amy@example.test was 900 days ago (error threshold: 274)"]);
        });

        it("reports a gap that is only a warning", () => {
            expect.hasAssertions();

            expect(report(run({ args: ["dormant", "--json", "--only", "author"], native: true }).stdout).warnings).toHaveLength(1);
        });

        it("reads the first key, not the lowest version, as the first release", () => {
            expect.hasAssertions();

            run({ args: ["order@2.1.0", "--json", "--only", "author"], native: true });
        });

        it("reports a dropped provenance attestation", () => {
            expect.hasAssertions();

            expect(report(run({ args: ["provenance@1.2.0", "--json", "--only", "provenance"], native: true }).stdout).summary.errorCount).toBe(1);
        });

        it.each(["hooks", "one-hook"])("reports install hooks that come with a dropped attestation (%s)", (name) => {
            expect.hasAssertions();

            expect(report(run({ args: [name, "--json", "--only", "s1ngularity,provenance"], native: true }).stdout).summary.errorCount).toBe(2);
        });

        it.each(["bins", "bins@1.1.0", "@scope/bins"])("reports a new bin (%s)", (name) => {
            expect.hasAssertions();

            run({ args: [name, "--json", "--only", "newBin"], native: true });
        });

        it.each(["meta", "bare", "private"])("reports the metadata of %s", (name) => {
            expect.hasAssertions();

            run({ args: [name, "--json", "--only", "metadata"], native: true });
        });

        it.each(["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0"])("judges the repository URL of urls@%s", (spec) => {
            expect.hasAssertions();

            run({ args: [`urls@${spec}`, "--json", "--only", "metadata"], native: true });
        });

        it("runs every marshall in the order of the handler", () => {
            expect.hasAssertions();

            run({ args: ["young", "--json", "--only", NATIVE_FIVE], native: true });
        });
    });

    describe("the flags in another order", () => {
        it.each([["--json", "--only", "author", "calm"], ["--strict", "calm", "--only", "author,metadata", "--json"], ["--only", "author", "--json", "young@1.2.0"]])("reads %j", (...args) => {
            expect.hasAssertions();

            run({ args, native: true });
        });
    });

    // A CI runner sets `FORCE_COLOR=3`, `GITHUB_ACTIONS` and a `TERM`; pail then colours its header, which only the error lines carry.
    describe("in the colour environment of a CI runner", () => {
        const colour = { FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" };

        it("prints a report with findings", () => {
            expect.hasAssertions();

            expect(run({ args: ["young", "--json", "--only", NATIVE_FIVE], extra: colour, native: true }).stdout).not.toContain("\u001B");
        });

        it("prints the error line of a missing version in colour", () => {
            expect.hasAssertions();

            const result = run({ args: ["empty@1.0.0", "--json", "--only", "author"], extra: colour, native: true });

            expect(result.stderr).toContain("\u001B[");
            expect(result.stderr).toContain("Could not resolve empty@1.0.0 to a published version.");
        });

        it("hands over the text report", () => {
            expect.hasAssertions();

            run({ args: ["calm", "--only", "author"], extra: colour, native: false });
        });

        it("hands over a colour flag", () => {
            expect.hasAssertions();

            run({ args: ["calm", "--json", "--no-color", "--only", "author"], extra: colour, native: false });
        });
    });

    describe("the specs", () => {
        it.each(["young@latest", "young@stale", "young@1.0.0", "young@1.3.0", "calm@"])("resolves %s", (spec) => {
            expect.hasAssertions();

            run({ args: [spec, "--json", "--only", "author,metadata"], native: true });
        });
    });

    describe("the exit status", () => {
        it("is 1 for an error and with --strict for a warning", () => {
            expect.hasAssertions();

            expect(run({ args: ["young@1.2.0", "--json", "--only", "author"], native: true }).status).toBe(1);
            expect(run({ args: ["bare", "--json", "--only", "metadata"], native: true }).status).toBe(0);
            expect(run({ args: ["bare", "--json", "--strict", "--only", "metadata"], native: true }).status).toBe(1);
            expect(run({ args: ["calm", "--strict", "--json", "--only", NATIVE_FIVE], native: true }).status).toBe(0);
        });
    });

    describe("a package or a version that is not there", () => {
        it.each([{}, { FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }, { COLUMNS: "60" }])("answers a 404 with an error line and status 2 (%j)", (extra) => {
            expect.hasAssertions();

            const result = run({ args: ["not-published", "--json", "--only", "author"], extra, native: true });

            expect([result.status, result.stdout]).toStrictEqual([2, ""]);
            expect(result.stderr).toContain("Package not-published not found in the registry.");
        });

        it.each([["empty", "empty@1.0.0"], ["no-versions", "no-versions"]])("answers a package without versions (%s)", (name, spec) => {
            expect.hasAssertions();

            const result = run({ args: [spec, "--json", "--only", "author"], native: true });

            expect(result.status).toBe(2);
            expect(result.stderr).toContain(`Could not resolve ${name}@`);
        });
    });

    describe("the cache", () => {
        const fresh = (name: string, packumentBody: unknown, createdAt = Date.now() - 60_000, cacheVersion = 3): { name: string; text: string } => {
            return { name, text: JSON.stringify({ cacheVersion, createdAt, packument: packumentBody, ttlMs: 1_800_000 }) };
        };

        it("answers from a fresh entry without asking the registry", () => {
            expect.hasAssertions();

            // The stub has no `/cached`, so a request would be a 404.
            const result = run({ args: ["cached", "--json", "--only", "author,metadata"], cache: fresh("cached", { name: "cached", versions: { "1.0.0": { _npmUser: user("amy") } } }), native: true });

            expect(report(result.stdout).warnings).toHaveLength(1);
        });

        it("fetches again over an expired entry and replaces it", () => {
            expect.hasAssertions();

            run({ args: ["calm", "--json", "--only", NATIVE_FIVE], cache: fresh("calm", { name: "old", versions: {} }, Date.now() - 1_900_000), native: true });
        });

        it("fetches again over an entry of another cache version and replaces it", () => {
            expect.hasAssertions();

            run({ args: ["calm", "--json", "--only", NATIVE_FIVE], cache: fresh("calm", { name: "old", versions: {} }, Date.now(), 2), native: true });
        });

        it("drops a stale entry of a package the registry does not know", () => {
            expect.hasAssertions();

            run({ args: ["not-published", "--json", "--only", "author"], cache: fresh("not-published", {}, Date.now() - 1_900_000), native: true });
        });

        it.each([["not json"], ["[]"], [JSON.stringify({ cacheVersion: 3, packument: { versions: {} }, ttlMs: 1 })], [JSON.stringify({ cacheVersion: 3, createdAt: Date.now(), ttlMs: 1_800_000 })]])("hands over a cache file of %j", (text) => {
            expect.hasAssertions();

            run({ args: ["calm", "--json", "--only", "author"], cache: { name: "calm", text }, native: false });
        });
    });

    describe("the marshalls that are switched off", () => {
        it("runs a default report when the marshalls that ask services are off", () => {
            expect.hasAssertions();

            run({ args: ["young", "--json"], native: true });
        });

        it("leaves a marshall out that the environment disables", () => {
            expect.hasAssertions();

            const result = report(run({ args: ["young", "--json", "--only", "author,metadata"], extra: { MARSHALL_DISABLE_AUTHOR: "yes" }, native: true }).stdout);

            expect(result.summary.errorCount).toBe(0);
        });

        it("runs nothing when every marshall is off", () => {
            expect.hasAssertions();

            run({ args: ["young", "--json"], extra: { MARSHALL_DISABLE_ALL: "true" }, native: true });
        });
    });

    describe("the downloads marshall", () => {
        const count = (downloads: number): Record<string, string> => {
            return { ".vis/cache/downloads/calm.json": JSON.stringify({ createdAt: Date.now(), downloads, observedAt: new Date().toISOString(), ttlMs: 86_400_000 }) };
        };

        it.each([[0], [5], [19], [20], [9999], [10_000], [3_000_000]])("reports a cached count of %i the way Node does", (downloads) => {
            expect.hasAssertions();

            const result = report(run({ args: ["calm", "--json", "--only", "downloads"], extra: { MARSHALL_DISABLE_DOWNLOADS: "0" }, files: count(downloads), native: true }).stdout);

            expect(result.summary.errorCount).toBe(downloads < 20 ? 1 : 0);
            expect(result.summary.warningCount).toBe(downloads >= 20 && downloads < 10_000 ? 1 : 0);
        });

        it.each([['"7"'], ["5.5"], ["-1"]])("hands over a cached count of %s, which Node writes differently", (downloads) => {
            expect.hasAssertions();

            const entry = `{"createdAt":${Date.now()},"downloads":${downloads},"observedAt":"2024-01-01T00:00:00.000Z","ttlMs":86400000}`;

            run({ args: ["calm", "--json", "--only", "downloads"], extra: { MARSHALL_DISABLE_DOWNLOADS: "0" }, files: { ".vis/cache/downloads/calm.json": entry }, native: false });
        });

        it("reads the cache file of a scoped package under its encoded name", () => {
            expect.hasAssertions();

            const entry = JSON.stringify({ createdAt: Date.now(), downloads: 12, observedAt: new Date().toISOString(), ttlMs: 86_400_000 });
            const result = report(run({ args: ["@scope/bins", "--json", "--only", "downloads"], extra: { MARSHALL_DISABLE_DOWNLOADS: "0" }, files: { ".vis/cache/downloads/%40scope%2Fbins.json": entry }, native: true }).stdout);

            expect(result.errors.map((finding) => finding.message)).toStrictEqual(["Only 12 downloads in the past month."]);
        });

        it("runs after metadata and with the exit status Node gives", () => {
            expect.hasAssertions();

            const result = run({ args: ["young", "--json", "--only", "metadata,downloads,author"], extra: { MARSHALL_DISABLE_DOWNLOADS: "0" }, files: { ".vis/cache/downloads/young.json": count(5)[".vis/cache/downloads/calm.json"] as string }, native: true });

            expect(result.status).toBe(1);
        });
    });

    describe("the archivedRepo marshall", () => {
        const cached = (body: string): Record<string, string> => {
            return { ".vis/cache/archived-repo/o__r.json": `{"createdAt":${Date.now()},"ttlMs":86400000,${body}}` };
        };
        const ON = { MARSHALL_DISABLE_ARCHIVED_REPO: "0" };

        it.each([
            ['"archived":true,"archivedAt":"2024-01-02T03:04:05Z"', "Source repo o/r is archived (since 2024-01-02T03:04:05Z)."],
            ['"archived":true', "Source repo o/r is archived."],
            ['"archived":false,"missing":true', "Source repo o/r returned 404 from GitHub."],
        ])("reports the cached state %s the way Node does", (body, message) => {
            expect.hasAssertions();

            const result = report(run({ args: ["calm", "--json", "--only", "archivedRepo"], extra: ON, files: cached(body), native: true }).stdout);

            expect(result.warnings.map((finding) => finding.message)).toStrictEqual([message]);
        });

        it.each(['"archived":false', '"archived":false,"missing":false'])("reports nothing for the cached state %s", (body) => {
            expect.hasAssertions();

            expect(report(run({ args: ["calm", "--json", "--only", "archivedRepo"], extra: ON, files: cached(body), native: true }).stdout).warnings).toHaveLength(0);
        });

        it.each(["urls@1.0.0", "urls@1.1.0", "urls@1.2.0", "urls@1.3.0", "urls@1.4.0", "urls@1.5.0", "urls@1.6.0", "urls@1.7.0", "odd-url", "dangling", "null-repository"])("reads the repository of %s the way Node does", (name) => {
            expect.hasAssertions();

            run({ args: [name, "--json", "--only", "archivedRepo"], extra: ON, files: cached('"archived":true'), native: true });
        });

        it.each(['"archived":true,"archivedAt":5', '"archived":true,"archivedAt":{}'])("hands over the cached state %s, which Node prints through JavaScript", (body) => {
            expect.hasAssertions();

            run({ args: ["calm", "--json", "--only", "archivedRepo"], extra: ON, files: cached(body), native: false });
        });

        it("does not look at GITHUB_TOKEN when the cache answers", () => {
            expect.hasAssertions();

            // The cached state answers, so no request carries the token.
            run({ args: ["calm", "--json", "--only", "archivedRepo"], extra: { ...ON, GITHUB_TOKEN: "a b" }, files: cached('"archived":true'), native: true });
        });
    });

    describe("what the marshalls that ask other services print", () => {
        const directory = (): string => realpathSync(mkdtempSync(join(scratch, "services-")));
        const PRELOAD = String.raw`
const original = globalThis.fetch;
const answers = JSON.parse(process.env.SERVICE_ANSWERS);
globalThis.fetch = async (url, options) => {
    const text = String(url);
    for (const [prefix, answer] of Object.entries(answers)) {
        if (text.startsWith(prefix)) {
            require("node:fs").appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ headers: options?.headers ?? null, url: text }) + "\n");
            if (answer.fail) throw new TypeError("fetch failed");
            return new Response(answer.body, { headers: answer.headers ?? {}, status: answer.status });
        }
    }
    return original(url, options);
};
`;

        /** Node on the stub registry with the web services answering `answers`; what it prints, and the cache entries it wrote with the clock masked. */
        const nodeWith = (
            name: string,
            only: string,
            answers: Record<string, { body?: string; fail?: boolean; status?: number }>,
            extra: Record<string, string> = {},
        ): { cache: Record<string, string>; requests: { headers: Record<string, string> | null; url: string }[]; status: number | null; stdout: string } => {
            const scratchDirectory = directory();
            const preload = join(scratchDirectory, "preload.cjs");
            const log = join(scratchDirectory, "requests.log");
            const home = makeHome();
            const [nodeRoot] = harness.pair(workspaceFiles({ ".npmrc": `registry=${base}/\n` }));

            writeFileSync(preload, PRELOAD);

            const result = spawnSync(process.execPath, ["--require", preload, nodeEntry, "inspect", name, "--json", "--only", only], {
                cwd: nodeRoot,
                encoding: "utf8",
                env: Harness.environment({ HOME: home, MARSHALL_DISABLE_ARCHIVED_REPO: "0", MARSHALL_DISABLE_DOWNLOADS: "0", REQUEST_LOG: log, SERVICE_ANSWERS: JSON.stringify(answers), ...extra }),
            });
            const cache: Record<string, string> = {};

            for (const [file, text] of Object.entries(homeState(home))) {
                if (!file.includes("packuments")) {
                    cache[file] = text.replace(/"observedAt":"[^"]+"/, '"observedAt":"NOW"');
                }
            }

            const requests = existsSync(log)
                ? readFileSync(log, "utf8")
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as { headers: Record<string, string> | null; url: string })
                : [];

            return { cache, requests, status: result.status, stdout: result.stdout };
        };
        const API = "https://api.npmjs.org/downloads/point/last-month/";
        const written = (downloads: number): Record<string, string> => {
            return { ".vis/cache/downloads/calm.json": `{"createdAt":"NOW","downloads":${downloads},"observedAt":"NOW","ttlMs":86400000}` };
        };
        const finding = (marshall: string, severity: string, message: string): string => `{\n      "marshall": "${marshall}",\n      "message": "${message}",\n      "packageName": "calm",\n      "severity": "${severity}"\n    }`;
        const reportOf = (severity: string, message: string, marshall = "downloads"): string => {
            const one = finding(marshall, severity, message);
            const list = (key: string, own: boolean): string => `  "${key}": ${own ? `[\n    ${one}\n  ]` : "[]"}`;

            return `{\n${list("errors", severity === "error")},\n${list("findings", true)},\n  "summary": {\n    "errorCount": ${severity === "error" ? 1 : 0},\n    "warningCount": ${severity === "warning" ? 1 : 0}\n  },\n${list("warnings", severity === "warning")}\n}\n`;
        };

        it.each([
            [5, "error", "Only 5 downloads in the past month."],
            [19, "error", "Only 19 downloads in the past month."],
            [20, "warning", "Only 20 downloads in the past month."],
            [9999, "warning", "Only 9999 downloads in the past month."],
        ])("downloads answers a count of %i", (downloads, severity, message) => {
            expect.hasAssertions();

            const result = nodeWith("calm", "downloads", { [API]: { body: JSON.stringify({ downloads }), status: 200 } });

            expect(result.stdout).toBe(reportOf(severity, message));
            expect(result.cache).toStrictEqual(written(downloads));
        });

        it("downloads answers a large count with no finding and caches it", () => {
            expect.hasAssertions();

            const result = nodeWith("calm", "downloads", { [API]: { body: '{"downloads":10000}', status: 200 } });

            expect(result.stdout).toContain('"findings": []');
            expect(result.cache).toStrictEqual(written(10_000));
        });

        it.each([
            [404, '{"error":"not found"}'],
            [429, "{}"],
            [500, "oops"],
            [200, "{}"],
            [200, '{"downloads":"5"}'],
            [200, "null"],
            [200, "[]"],
            [200, "not json"],
        ])("downloads answers a %i with %j as no data and caches nothing", (status, body) => {
            expect.hasAssertions();

            const result = nodeWith("calm", "downloads", { [API]: { body, status } });

            expect(result.stdout).toBe(reportOf("warning", "npm stats API returned no monthly download data."));
            expect(result.cache).toStrictEqual({});
        });

        const GITHUB = "https://api.github.com/repos/o/r";
        const archived = (extra: string): Record<string, string> => {
            return { ".vis/cache/archived-repo/o__r.json": `{"createdAt":"NOW","ttlMs":86400000,${extra}}` };
        };

        it.each([
            [200, '{"archived":true,"archived_at":"2024-01-02T03:04:05Z"}', "Source repo o/r is archived (since 2024-01-02T03:04:05Z).", '"archived":true,"archivedAt":"2024-01-02T03:04:05Z"'],
            [200, '{"archived":true,"archived_at":null}', "Source repo o/r is archived.", '"archived":true'],
            [404, '{"message":"Not Found"}', "Source repo o/r returned 404 from GitHub.", '"archived":false,"missing":true'],
        ])("archivedRepo answers a %i with %j", (status, body, message, cached) => {
            expect.hasAssertions();

            const result = nodeWith("calm", "archivedRepo", { [GITHUB]: { body, status } });

            expect(result.stdout).toBe(reportOf("warning", message, "archivedRepo"));
            expect(result.cache).toStrictEqual(archived(cached));
        });

        it.each([
            [200, '{"archived":false}', '"archived":false'],
            [200, '{"archived":"yes"}', '"archived":false'],
            [200, "{}", '"archived":false'],
            [200, "[]", '"archived":false'],
            [200, '{"archived":false,"archived_at":"x"}', '"archived":false,"archivedAt":"x"'],
        ])("archivedRepo answers a %i with %j as no finding and caches it", (status, body, cached) => {
            expect.hasAssertions();

            const result = nodeWith("calm", "archivedRepo", { [GITHUB]: { body, status } });

            expect(result.stdout).toContain('"findings": []');
            expect(result.cache).toStrictEqual(archived(cached));
        });

        it.each([
            [403, "{}"],
            [429, "{}"],
            [500, "oops"],
            [200, "null"],
            [200, "not json"],
        ])("archivedRepo answers a %i with %j as no finding and caches nothing", (status, body) => {
            expect.hasAssertions();

            const result = nodeWith("calm", "archivedRepo", { [GITHUB]: { body, status } });

            expect(result.stdout).toContain('"findings": []');
            expect(result.cache).toStrictEqual({});
        });

        it("archivedRepo sends the headers the binary sends, and the token when GITHUB_TOKEN is set", () => {
            expect.hasAssertions();

            const plain = nodeWith("calm", "archivedRepo", { [GITHUB]: { body: "{}", status: 200 } });

            expect(plain.requests).toStrictEqual([{ headers: { Accept: "application/vnd.github+json", "User-Agent": "visulima-vis-marshall" }, url: GITHUB }]);

            const token = nodeWith("calm", "archivedRepo", { [GITHUB]: { body: "{}", status: 200 } }, { GITHUB_TOKEN: "ghp_Token-1" });

            expect(token.requests[0]?.headers).toStrictEqual({ Accept: "application/vnd.github+json", Authorization: "Bearer ghp_Token-1", "User-Agent": "visulima-vis-marshall" });
            expect(nodeWith("calm", "archivedRepo", { [GITHUB]: { body: "{}", status: 200 } }, { GITHUB_TOKEN: "" }).requests[0]?.headers).toStrictEqual({ Accept: "application/vnd.github+json", "User-Agent": "visulima-vis-marshall" });
        });
    });

    describe("the signatures marshall", () => {
        const keys = (path: string): Record<string, string> => {
            return { VIS_NPM_KEYS_URL: `${base}${path}` };
        };
        const only = ["--json", "--only", "signatures"];

        it.each([
            ["sig-good", "no finding"],
            ["sig-future", "no finding"],
            ["sig-null-expiry", "a key with a null expiry"],
            ["sig-two", "an unrecognized keyid"],
            ["sig-expired", "an expired key"],
            ["sig-none", "a missing signature"],
            ["sig-no-integrity", "a missing integrity"],
        ])("reports %s (%s) the way Node does", (name) => {
            expect.hasAssertions();

            run({ args: [name, ...only], extra: keys("/keys/ok"), native: true });
        });

        it("reports the findings and the exit status Node gives", () => {
            expect.hasAssertions();

            const result = run({ args: ["sig-two", ...only], extra: keys("/keys/ok"), native: true });

            expect(result.status).toBe(1);
            expect(report(result.stdout).errors.map((finding) => finding.message)).toStrictEqual(["Package sig-two@1.0.0 was signed with an unrecognized keyid (SHA256:unlisted)."]);
            expect(report(run({ args: ["sig-expired", ...only], extra: keys("/keys/ok"), native: true }).stdout).warnings.map((finding) => finding.message)).toStrictEqual([
                "Package sig-expired@1.0.0 was signed with an expired key (SHA256:old, expired 2020-01-01T00:00:00.000Z).",
            ]);
        });

        it.each(["/keys/server-error", "/keys/empty"])("answers the keys address %s the way Node does", (path) => {
            expect.hasAssertions();

            run({ args: ["sig-good", ...only], extra: keys(path), native: true });
        });

        it("uses the cached keys, and the old ones when the registry refuses", () => {
            expect.hasAssertions();

            const entry = (createdAt: number, ttlMs: number): Record<string, string> => {
                return { ".vis/cache/registry-keys/npmjs.json": JSON.stringify({ createdAt, keys: KEYS, ttlMs }) };
            };

            run({ args: ["sig-good", ...only], extra: keys("/keys/server-error"), files: entry(Date.now(), 86_400_000), native: true });
            run({ args: ["sig-good", ...only], extra: keys("/keys/server-error"), files: entry(1, 5), native: true });
            run({ args: ["sig-good", ...only], extra: keys("/keys/ok"), files: entry(1, 5), native: true });
        });

        it.each(["sig-bad", "sig-malformed"])("hands over %s, which Node reports as an invalid signature", (name) => {
            expect.hasAssertions();

            const result = run({ args: [name, ...only], extra: keys("/keys/ok"), native: false });

            expect(result.status).toBe(1);
            expect(report(result.stdout).errors.map((finding) => finding.message)).toStrictEqual([`Package ${name}@1.0.0 signature did not verify against SHA256:one.`]);
        });

        it("hands over a keys answer that is not JSON", () => {
            expect.hasAssertions();

            run({ args: ["sig-good", ...only], extra: keys("/keys/not-json"), native: false });
        });

        it("hands over a keys address that is not a plain URL", () => {
            expect.hasAssertions();

            run({ args: ["sig-good", ...only], extra: { VIS_NPM_KEYS_URL: "http://127.0.0.1:80/keys" }, native: false });
        });
    });

    describe("what goes to Node", () => {
        it.each([
            ["the text report", ["calm"]],
            ["the text report with the flags", ["calm", "--strict", "--only", "author"]],
            ["the text report of a package with findings", ["young", "--only", "author,metadata"]],
            ["a range", ["calm@^1", "--json", "--only", "author"]],
            ["a version the registry does not list", ["calm@9.9.9", "--json", "--only", "author"]],
            ["an unknown marshall", ["calm", "--json", "--only", "nope"]],
            ["no package", ["--json"]],
            ["two packages", ["calm", "young", "--json", "--only", "author"]],
            ["a repeated flag", ["calm", "--json", "--json", "--only", "author"]],
            ["another flag", ["calm", "--json", "--cwd", ".", "--only", "author"]],
            ["a flag with a value", ["calm", "--json=true", "--only", "author"]],
            ["a name that is not lower case", ["Calm", "--json", "--only", "author"]],
        ])("hands over %s", (_label, args) => {
            expect.hasAssertions();

            run({ args, native: false });
        });

        // Node answers these from the cache files of the services, so nothing reaches the network.
        it.each([
            ["every marshall", ["calm", "--json"]],
            ["expiredDomains", ["calm", "--json", "--only", "expiredDomains"]],
        ])("hands over a run that needs a marshall that asks a service (%s)", (_label, args) => {
            expect.hasAssertions();

            run({ args, extra: { MARSHALL_DISABLE_ARCHIVED_REPO: "0", MARSHALL_DISABLE_DOWNLOADS: "0", MARSHALL_DISABLE_EXPIRED_DOMAINS: "0" }, files: serviceCaches(), native: false });
        });

        it.each(["server-error", "not-json", "array", "bom", "redirect"])("hands over the answer of %s", (name) => {
            expect.hasAssertions();

            run({ args: [name, "--json", "--only", NATIVE_FIVE], native: false });
        });

        it.each(["proto", "null-dist", "null-entry", "loose-version", "odd-time", "null-user", "null-repository", "odd-url", "proto-bin", "loose-tag"])("hands over the packument %s", (name) => {
            expect.hasAssertions();

            run({ args: [name, "--json", "--only", NATIVE_FIVE], native: false });
        });

        it("hands over a registry that needs a credential", () => {
            expect.hasAssertions();

            const host = base.replace("http://", "");

            run({ args: ["calm", "--json", "--only", "author"], native: false, npmrc: `registry=${base}/\n//${host}/:_authToken=secret\n` });
        });

        it("hands over an .npmrc that refers to the environment", () => {
            expect.hasAssertions();

            run({ args: ["calm", "--json", "--only", "author"], extra: { REGISTRY: `${base}/` }, native: false, npmrc: "registry=${REGISTRY}\n" });
        });

        it.each([{ HTTPS_PROXY: "http://127.0.0.1:9" }, { ALL_PROXY: "http://127.0.0.1:9" }, { NODE_EXTRA_CA_CERTS: "/nonexistent/ca.pem" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }])("hands over a run with %j", (extra) => {
            expect.hasAssertions();

            run({ args: ["calm", "--json", "--only", "author"], extra, native: false });
        });
    });
});
