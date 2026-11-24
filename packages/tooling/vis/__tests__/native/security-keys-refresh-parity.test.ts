import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis security keys-refresh --json` exists twice: the Node handler (`src/commands/security/keys-refresh.ts`, through
 * `fetchRegistryKeys`) and the native path (`native/cli/src/keys_refresh.rs`, on the native HTTP client). For every
 * input the native path accepts it must print the same JSON, end with the same exit status and leave the same cache
 * file as Node; every input it declines must be handed to Node before anything is printed or written (see
 * `workspace-parity-harness.ts` for how both are proved).
 *
 * The key endpoint is a stub in a separate process (the runs block this one) that `VIS_NPM_KEYS_URL`, which Node
 * reads too, points both sides at, so nothing reaches the network. Each side gets its own `HOME`, because the
 * cache lives in `~/.vis/cache/registry-keys`; the `createdAt` of a fresh cache entry is masked.
 */

const harness = new Harness(["security", "keys-refresh"]);
const CACHE = ".vis/cache/registry-keys/npmjs.json";

const KEY_A = { expires: null, key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W", keyid: "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA", keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256" };
const KEY_B = { expires: "2025-01-29T00:00:00.000Z", key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFl", keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256" };

/** The stub: a path picks the answer. */
const STUB = String.raw`
const http = require("node:http");
const zlib = require("node:zlib");
const keys = ${JSON.stringify(JSON.stringify({ keys: [KEY_A, KEY_B] }))};
const answers = {
    "/keys": (res) => { res.setHeader("content-type", "application/json"); res.end(keys); },
    "/gzip": (res) => { res.setHeader("content-type", "application/json"); res.setHeader("content-encoding", "gzip"); res.end(zlib.gzipSync(keys)); },
    "/redirect": (res) => { res.statusCode = 302; res.setHeader("location", "/keys"); res.end(); },
    "/loop": (res) => { res.statusCode = 302; res.setHeader("location", "/loop"); res.end(); },
    "/empty": (res) => res.end("{}"),
    "/not-an-array": (res) => res.end('{"keys":"x"}'),
    "/null-keys": (res) => res.end('{"keys":null,"other":[1,2]}'),
    "/pretty": (res) => res.end('{\n  "keys": [\n    { "keyid": "a\\u00e9", "n": 1.50, "list": [1, 2] }\n  ],\n  "extra": true\n}\n'),
    "/escapes": (res) => res.end('{"keys":[{"a":"caf\\u00e9 \\/ \\u0041 \\n \\t \\u0001 \\u007f \\u2028 \\ud83d\\ude00 \\"q\\" \\\\ \\u003c"}]}'),
    "/floats": (res) => res.end('{"keys":[1.0,1e2,1.5e300,0.000001,1e-7,123456789012345680000,1e21,-0,-0.0,9007199254740993,0.1,5e-324,1.7976931348623157e308,12345678901234567890,1E5,2.50,-1.5e-10]}'),
    "/key-order": (res) => res.end('{"keys":[{"b":1,"2":2,"1":3,"a":4,"a":5,"01":6,"4294967295":7,"4294967294":8}]}'),
    "/lone-surrogate": (res) => res.end('{"keys":["\\ud800"]}'),
    "/overflow": (res) => res.end('{"keys":[1e999]}'),
    "/500": (res) => { res.statusCode = 500; res.end("broken"); },
    "/404": (res) => { res.statusCode = 404; res.end("{}"); },
    "/invalid-json": (res) => res.end("{"),
    "/array": (res) => res.end("[]"),
    "/null": (res) => res.end("null"),
    "/html": (res) => res.end("<html></html>"),
    "/bom": (res) => res.end("\ufeff" + keys),
    "/no-content": (res) => { res.statusCode = 204; res.end(); },
};
const server = http.createServer((req, res) => (answers[req.url.split("?")[0]] ?? ((r) => { r.statusCode = 404; r.end(); }))(res));
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\n"));
`;

let scratch: string;
let stub: ChildProcess;
let base: string;

const refusedUrl = async (): Promise<string> =>
    new Promise((resolve) => {
        const server = createServer();

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };

            server.close(() => { resolve(`http://127.0.0.1:${String(port)}/keys`); });
        });
    });

const makeHome = (cache?: string): string => {
    const directory = realpathSync(mkdtempSync(join(scratch, "home-")));

    if (cache !== undefined) {
        mkdirSync(join(directory, dirname(CACHE)), { recursive: true });
        writeFileSync(join(directory, CACHE), cache);
    }

    return directory;
};

/** The cache file of a home with a fresh `createdAt` masked, or undefined. */
const cacheOf = (home: string): { raw: string; value: unknown } | undefined => {
    const file = join(home, CACHE);

    if (!existsSync(file)) {
        return undefined;
    }

    const raw = readFileSync(file, "utf8");
    const masked = raw.replace(/"createdAt":(\d+)/, (whole, stamp: string) => (Math.abs(Date.now() - Number(stamp)) < 120_000 ? '"createdAt":"NOW"' : whole));

    try {
        return { raw: masked, value: JSON.parse(masked) };
    } catch {
        return { raw: masked, value: undefined };
    }
};

/** Everything under a home but the cache file, which is compared by meaning with `createdAt` masked. */
const homeState = (home: string): { cache: unknown; others: Record<string, string> } => {
    return { cache: cacheOf(home)?.value, others: Object.fromEntries(Object.entries(Harness.snapshot(home)).filter(([name]) => name !== CACHE)) };
};

interface Case {
    args?: string[];
    /** The cache file the home starts with. */
    cache?: string;
    /** Whether the bytes of the cache file must match too, not only their meaning. */
    exactCache?: boolean;
    extra?: Record<string, string>;
    /** True when the native side must answer; false when it must hand the run to Node. */
    native: boolean;
    url: string;
}

/** Runs both sides; returns what the side that answered printed. */
const run = ({ args = ["--json"], cache, exactCache = false, extra = {}, native, url }: Case): string => {
    const files = workspaceFiles({});
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const environment = (home: string, more: Record<string, string> = {}): Record<string, string> => { return { HOME: home, VIS_NPM_KEYS_URL: url, ...extra, ...more }; };
    const nodeHome = makeHome(cache);
    const nativeHome = makeHome(cache);
    const node = harness.runNode(args, nodeRoot, environment(nodeHome));

    if (native) {
        // `VIS_DEBUG_DECLINE` makes a hand-off name the gate that declined, so a failure here says why.
        const answered = harness.runNative(args, nativeRoot, environment(nativeHome, { VIS_DEBUG_DECLINE: "1" }));

        expect(answered.status, `native stderr: ${answered.stderr} (VIS_NPM_KEYS_URL=${url})`).not.toBe(70);
        expect(Harness.outcome(answered, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
        expect(homeState(nativeHome)).toStrictEqual(homeState(nodeHome));

        if (exactCache) {
            expect(cacheOf(nativeHome)?.raw).toBe(cacheOf(nodeHome)?.raw);
        }

        return answered.stdout;
    }

    const probeRoot = harness.materialize("native", files);
    const probeHome = makeHome(cache);
    const before = { files: Harness.snapshot(probeRoot), home: homeState(probeHome) };
    const declined = harness.runNative(args, probeRoot, environment(probeHome));

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect({ files: Harness.snapshot(probeRoot), home: homeState(probeHome) }, "a declined run must not touch anything").toStrictEqual(before);

    const delegated = harness.runNative(args, nativeRoot, environment(nativeHome, { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }));

    expect(Harness.outcome(delegated, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
    expect(homeState(nativeHome)).toStrictEqual(homeState(nodeHome));

    return delegated.stdout;
};

const OLD_CACHE = JSON.stringify({ createdAt: 1, keys: [{ keyid: "old-1" }, { keyid: "old-2" }, { keyid: "old-3" }], ttlMs: 86_400_000 });

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis security keys-refresh --json: native vs Node", () => {
    beforeAll(async () => {
        harness.setup("vis-keys-refresh-parity-");
        scratch = mkdtempSync(join(tmpdir(), "vis-keys-refresh-homes-"));
        // CI runs the suite with `FORCE_COLOR=3`, which makes Node colour a number written with `console.log` even into a pipe, so the stub
        // gets that variable here on purpose: its port must reach `base` as plain digits whatever the colour settings are.
        stub = spawn(process.execPath, ["-e", STUB], { env: Harness.environment({ FORCE_COLOR: "3" }), stdio: ["ignore", "pipe", "inherit"] });
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

    describe("a refresh that works", () => {
        it("fetches the keys and writes the cache the way Node does", () => {
            expect.hasAssertions();

            const stdout = run({ exactCache: true, native: true, url: `${base}/keys` });

            expect(stdout).toBe('{\n  "cleared": false,\n  "fromCache": false,\n  "keyCount": 2,\n  "refetched": true,\n  "stale": false\n}\n');
        });

        it("replaces an older cache", () => {
            expect.hasAssertions();

            expect(run({ cache: OLD_CACHE, exactCache: true, native: true, url: `${base}/keys` })).toContain('"keyCount": 2');
        });

        it.each([["/gzip", 2], ["/empty", 0], ["/not-an-array", 0], ["/null-keys", 0], ["/pretty", 1]])("reads the answer of %s", (path, count) => {
            expect.hasAssertions();

            expect(run({ native: true, url: `${base}${path}` })).toContain(`"keyCount": ${String(count)}`);
        });

        // The cache holds `JSON.stringify(keys)`: compact, strings escaped the way JavaScript escapes them, numbers
        // printed the way JavaScript prints them, object keys in JavaScript's order. The bytes must match, not only the meaning.
        it.each(["/pretty", "/escapes", "/floats", "/key-order"])("writes the cache of %s byte for byte", (path) => {
            expect.hasAssertions();

            run({ exactCache: true, native: true, url: `${base}${path}` });
        });

        // Node's limit is a fixed 15 seconds, so the timeout variables of the native client do not change the answer.
        it.each([{ VIS_HTTP_TIMEOUT: "1" }, { VIS_HTTP_CONNECT_TIMEOUT: "1" }])("answers the same with %j in the environment", (extra) => {
            expect.hasAssertions();

            run({ exactCache: true, extra, native: true, url: `${base}/keys` });
        });

        it("ignores a query string in the URL like the stub does", () => {
            expect.hasAssertions();

            expect(run({ native: true, url: `${base}/keys?x=1` })).toContain('"refetched": true');
        });
    });

    describe("a refresh that fails", () => {
        it.each(["/500", "/404"])("reports fetch-failed for %s without a cache", (path) => {
            expect.hasAssertions();

            expect(run({ native: true, url: `${base}${path}` })).toContain('"error": "fetch-failed"');
        });

        it.each(["/500", "/404"])("falls back to the old keys for %s", (path) => {
            expect.hasAssertions();

            expect(run({ cache: OLD_CACHE, native: true, url: `${base}${path}` })).toContain('"keyCount": 3');
        });

        it("reports a refused connection like a failed fetch", async () => {
            expect.hasAssertions();

            const url = await refusedUrl();

            expect(run({ native: true, url })).toContain('"error": "fetch-failed"');
            expect(run({ cache: OLD_CACHE, native: true, url })).toContain('"stale": true');
        });
    });

    describe("--clear", () => {
        it.each([["--json", "--clear"], ["--clear", "--json"]])("drops the cache with %s %s", (...args) => {
            expect.hasAssertions();

            expect(run({ args, cache: OLD_CACHE, native: true, url: `${base}/keys` })).toContain('"cleared": true');
            expect(run({ args, native: true, url: `${base}/keys` })).toContain('"cleared": false');
        });
    });

    describe("what goes to Node", () => {
        it.each(["/invalid-json", "/array", "/null", "/html", "/bom", "/no-content", "/redirect", "/loop", "/lone-surrogate", "/overflow"])("hands over the answer of %s", (path) => {
            expect.hasAssertions();

            run({ native: false, url: `${base}${path}` });
            run({ cache: OLD_CACHE, native: false, url: `${base}${path}` });
        });

        it.each([["not json"], ["{}"], ['{"keys":"x"}'], ["[]"], [""]])("hands over a cache file of %j", (cache) => {
            expect.hasAssertions();

            run({ cache, native: false, url: `${base}/keys` });
        });

        it.each([[["--clear"]], [[]], [["--json", "--json"]], [["--json", "--cwd", "."]]])("hands over the arguments %j", (args) => {
            expect.hasAssertions();

            run({ args, cache: OLD_CACHE, native: false, url: `${base}/keys` });
        });

        it("hands over a URL with credentials", () => {
            expect.hasAssertions();

            run({ native: false, url: base.replace("//", "//user:secret@") });
        });

        it.each([{ HTTPS_PROXY: "http://127.0.0.1:9" }, { HTTP_PROXY: "http://127.0.0.1:9" }, { ALL_PROXY: "http://127.0.0.1:9" }, { NODE_EXTRA_CA_CERTS: "/nonexistent/ca.pem" }, { SSL_CERT_FILE: "/nonexistent/ca.pem" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }])("hands over a run with %j", (extra) => {
            expect.hasAssertions();

            run({ extra, native: false, url: `${base}/keys` });
        });
    });
});
