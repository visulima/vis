import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Files, Outcome, Result } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis check` (the outdated-dependency check) exists twice: the Node handler (`src/commands/check/handler.ts`) and the
 * native path (`native/cli/src/check/`). For every shape the native path answers, it must print the same bytes on stdout
 * and stderr, end with the same exit status, leave the same files (the 60 second result cache included, its
 * timestamp masked) and ask the registry for the same things as Node; every other shape must be handed to Node before
 * anything is printed or written (see `workspace-parity-harness.ts` for how both are proved).
 *
 * The registry is a stub in a separate process that the `.npmrc` of each workspace points both sides at. It logs the
 * requests it gets, so the two sides' requests are compared too. Every case that answers natively runs `--no-security`
 * (or has nothing outdated), because the OSV query of a run with findings goes to `api.osv.dev`, an address the
 * environment cannot change; the run without the flag is covered by the cases that need no query and by one case that
 * is the same whichever side answers.
 */

const harness = new Harness(["check"]);
const alias = new Harness(["c"]);

const CACHE = "node_modules/.cache/vis/outdated-cache.json";
const ACCEPT = "application/vnd.npm.install-v1+json";

const packument = (latest: string, versions: string[]): { body: string } => {
    return { body: JSON.stringify({ "dist-tags": { latest }, name: "x", versions: Object.fromEntries(versions.map((version) => [version, {}])) }) };
};

const LONG_49 = "a".repeat(49);
const LONG_50 = "b".repeat(50);

const ANSWERS: Record<string, { body: string; headers?: Record<string, string>; status?: number }> = {
    "/@scope/scoped": packument("1.0.1", ["1.0.0", "1.0.1"]),
    "/arraybody": { body: "[]" },
    "/betalatest": packument("2.0.0-beta.1", ["1.0.0", "1.5.0", "2.0.0-beta.1"]),
    "/bom": { body: `${String.fromCodePoint(0xfe_ff)}${JSON.stringify({ "dist-tags": { latest: "1.1.0" }, versions: { "1.0.0": {}, "1.1.0": {} } })}` },
    "/broken": { body: "boom", status: 500 },
    "/buildmeta": packument("1.0.1+b2", ["1.0.0", "1.0.1+b1", "1.0.1+b2"]),
    "/calm": packument("2.0.0", ["1.0.0", "1.1.0", "1.2.0", "2.0.0"]),
    "/devtool": packument("2.1.0", ["2.0.0", "2.0.5", "2.1.0", "3.0.0-beta.1"]),
    "/duplicate": { body: '{"dist-tags":{"latest":"1.1.0"},"versions":{"1.0.0":{},"1.1.0":{}},"versions":{"1.0.0":{},"1.2.0":{}}}' },
    "/emptybody": { body: "" },
    "/exact": packument("1.0.1", ["1.0.0", "1.0.1"]),
    "/htmlbody": { body: "<html></html>" },
    "/ignored": packument("9.0.0", ["1.0.0", "9.0.0"]),
    "/nolatest": { body: JSON.stringify({ versions: { "1.0.0": {}, "1.1.0": {} } }) },
    "/notfound": { body: "{}", status: 404 },
    "/nullbody": { body: "null" },
    "/numberlatest": { body: '{"dist-tags":{"latest":5},"versions":{"1.0.0":{}}}' },
    "/oddversion": { body: JSON.stringify({ "dist-tags": { latest: "1.1" }, versions: Object.fromEntries([["1.0", {}], ["1.1", {}]]) }) },
    "/order": packument("1.3.0", ["1.3.0", "1.1.0", "1.2.0", "1.10.0"]),
    "/pre": packument("1.0.0", ["1.0.0-beta.1", "1.0.0-beta.2", "1.0.0-rc.1", "1.0.0"]),
    "/rangey": packument("2.5.0", ["1.0.0", "1.9.0", "2.0.0", "2.5.0"]),
    "/redirected": { body: "", headers: { location: "/calm" }, status: 302 },
    "/scoped-registry/@scope/scoped": packument("1.0.3", ["1.0.0", "1.0.3"]),
    "/second": packument("2.1.0", ["2.0.0", "2.1.0"]),
    "/uptodate": packument("3.0.0", ["3.0.0"]),
    "/vprefix": packument("v2.0.0", ["v1.0.0", "v2.0.0"]),
    "/xrange": packument("3.0.0", ["1.0.0", "3.0.0"]),
    [`/${LONG_49}`]: packument("1.1.0", ["1.0.0", "1.1.0"]),
    [`/${LONG_50}`]: packument("1.1.0", ["1.0.0", "1.1.0"]),
};

/** The stub: a path picks the answer, and `/__log` and `/__clear` read and reset the requests it got. */
const STUB = String.raw`
const http = require("node:http");
const answers = JSON.parse(process.env.ANSWERS);
let log = [];
const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/__log") { res.end(JSON.stringify(log)); return; }
    if (path === "/__clear") { log = []; res.end("[]"); return; }
    log.push(req.method + " " + path + " accept=" + req.headers.accept);
    const answer = answers[path];
    if (answer === undefined) { res.statusCode = 404; res.end("{}"); return; }
    res.statusCode = answer.status ?? 200;
    for (const [name, value] of Object.entries(answer.headers ?? {})) res.setHeader(name, value);
    res.setHeader("content-type", "application/json");
    res.end(answer.body);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\n"));
`;

let scratch = "";
let stub: ChildProcess;
let base = "";

const requests = async (): Promise<string[]> => {
    const response = await fetch(`${base}/__log`);
    const log = (await response.json()) as string[];

    return log.toSorted();
};
const clear = async (): Promise<void> => {
    await fetch(`${base}/__clear`);
};

const refusedRegistry = async (): Promise<string> =>
    new Promise((resolve) => {
        const server = createServer();

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };

            server.close(() => {
                resolve(`http://127.0.0.1:${String(port)}/`);
            });
        });
    });

/** `calm` is out of date in two directories, `devtool` as a dev dependency, `app` and `root` are the workspace's own packages. */
const BASE_MANIFEST = {
    dependencies: { "@scope/scoped": "^1.0.0", app: "^1.0.0", calm: "^1.0.0", exact: "1.0.0" },
    devDependencies: { devtool: "~2.0.0", uptodate: "^3.0.0" },
};

const APP = { dependencies: { calm: "^1.1.0", root: "^0.1.0" }, name: "app", version: "1.0.0" };

interface Project {
    app?: Record<string, unknown> | false;
    files?: Files;
    manifest?: Record<string, unknown>;
    npmrc?: string;
}

const workspace = ({ app = APP, files = {}, manifest = BASE_MANIFEST, npmrc = `registry=${base}/\n` }: Project = {}): Files =>
    workspaceFiles({ ".npmrc": npmrc, ...(app === false ? {} : { "packages/app/package.json": json(app) }), ...files }, manifest);

/** The outcome of a run with the timestamp of the cache file masked (and checked to be recent). */
const outcomeOf = (result: Result, root: string): Outcome => {
    const outcome = Harness.outcome(result, root);
    const hex = outcome.tree[CACHE];

    if (hex !== undefined) {
        outcome.tree[CACHE] = Buffer.from(hex, "hex")
            .toString("utf8")
            .replace(/"timestamp": (\d+)/, (_whole, stamp: string) => {
                expect(Math.abs(Date.now() - Number(stamp)), "the cache entry is stamped with the time of the run").toBeLessThan(120_000);

                return '"timestamp": NOW';
            });
    }

    return outcome;
};

interface Parity {
    args: string[];
    ci?: boolean;
    command?: Harness;
    extra?: Record<string, string>;
    files?: Files;
    /** The second of two runs in the same workspace is the one compared: the first fills the cache. */
    twice?: boolean;
}

/** The environment of a run: its own `HOME`, so no `~/.npmrc` of the machine reaches either side. */
const environment = (extra: Record<string, string> = {}): Record<string, string> => {
    return { HOME: join(scratch, "home"), ...extra };
};

/** Both sides run the same call on identical workspaces and must end the same way, files and requests included; the native side answers. */
const parity = async ({ args, ci = true, command = harness, extra, files = workspace(), twice = false }: Parity): Promise<Result> => {
    const [nodeRoot, nativeRoot] = command.pair(files);
    const env = environment(extra);
    const runs = twice ? 2 : 1;
    let node: Result | undefined;
    let native: Result | undefined;
    let nodeRequests: string[] = [];
    let nativeRequests: string[] = [];

    for (let run = 0; run < runs; run += 1) {
        await clear();
        node = command.runNode(args, nodeRoot, env, ci);
        nodeRequests = await requests();
    }

    for (let run = 0; run < runs; run += 1) {
        await clear();
        native = command.runNative(args, nativeRoot, { ...env, VIS_DEBUG_DECLINE: "1" }, ci);
        nativeRequests = await requests();
    }

    expect(native?.status, `native stderr: ${native?.stderr}`).not.toBe(70);
    expect(outcomeOf(native as Result, nativeRoot)).toStrictEqual(outcomeOf(node as Result, nodeRoot));
    expect(nativeRequests).toStrictEqual(nodeRequests);

    return native as Result;
};

interface Delegation {
    args: string[];
    ci?: boolean;
    extra?: Record<string, string>;
    files?: Files;
    /** Node itself would reach out (an AI runner, say), so only the hand-over is checked. */
    nativeOnly?: boolean;
}

/** The native side declines (exit 70 without the Node entry, nothing printed or written) and the delegated run matches Node. */
const delegation = async ({ args, ci = true, extra, files = workspace(), nativeOnly = false }: Delegation): Promise<Result> => {
    const [nodeRoot, nativeRoot] = harness.pair(files);
    const env = environment(extra);
    const probe = harness.materialize("native", files);
    const before = Harness.snapshot(probe);
    const declined = harness.runNative(args, probe, env, ci);

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect(Harness.snapshot(probe), "a declined run must not write a file").toStrictEqual(before);

    if (nativeOnly) {
        return declined;
    }

    const node = harness.runNode(args, nodeRoot, env, ci);
    const delegated = harness.runNative(args, nativeRoot, { ...env, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }, ci);

    expect(outcomeOf(delegated, nativeRoot)).toStrictEqual(outcomeOf(node, nodeRoot));

    return delegated;
};

const NO_SECURITY = ["--no-security"];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis check: native vs Node", () => {
    beforeAll(async () => {
        harness.setup("vis-check-parity-");
        alias.setup("vis-check-parity-alias-");
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-check-parity-home-")));
        // A home with nothing in it, for the runs that read no `~/.npmrc`.
        mkdirSync(join(scratch, "home"));
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
        alias.teardown();
        rmSync(scratch, { force: true, recursive: true });
    });

    it("reaches the stub at a plain URL even when the runner forces colour", () => {
        expect.hasAssertions();
        expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    describe("the three formats, with the workspace's own packages left out", () => {
        it.each([
            { args: [...NO_SECURITY, "--format", "minimal"], label: "minimal" },
            { args: [...NO_SECURITY, "--format", "json"], label: "json" },
            { args: [...NO_SECURITY, "--format", "table"], label: "table" },
            { args: NO_SECURITY, label: "the default format, a table" },
            { args: [...NO_SECURITY, "--format", "json", "--target", "latest"], label: "json with the latest versions" },
        ])("answers $label", async ({ args }) => {
            expect.hasAssertions();

            const native = await parity({ args });

            expect(native.stdout).toContain("Checking 6 catalog dependencies against npm registry...");
        });

        it("answers through the alias `c`", async () => {
            expect.hasAssertions();

            const native = await parity({ args: [...NO_SECURITY, "--format", "minimal"], command: alias });

            expect(native.stdout).toContain("calm  ^1.0.0 → ^1.2.0");
        });

        it("asks the registry once for each name, for the abbreviated metadata", async () => {
            expect.hasAssertions();

            await clear();

            const files = workspace();
            const [, nativeRoot] = harness.pair(files);

            harness.runNative([...NO_SECURITY, "--format", "minimal"], nativeRoot, environment());

            await expect(requests()).resolves.toStrictEqual([`GET /@scope/scoped accept=${ACCEPT}`, `GET /calm accept=${ACCEPT}`, `GET /devtool accept=${ACCEPT}`, `GET /uptodate accept=${ACCEPT}`]);
        });
    });

    describe("the exit code", () => {
        it.each([
            { args: [...NO_SECURITY, "--exit-code", "--format", "minimal"], status: 1 },
            { args: [...NO_SECURITY, "--exit-code", "--format", "json"], status: 1 },
            { args: [...NO_SECURITY, "--exit-code"], status: 1 },
            { args: [...NO_SECURITY, "--exit-code", "uptodate"], status: 0 },
            { args: [...NO_SECURITY, "--exit-code", "--exclude", "*"], status: 0 },
        ])("ends with $status for $args", async ({ args, status }) => {
            expect.hasAssertions();

            const native = await parity({ args });

            expect(native.status).toBe(status);
        });
    });

    describe("the filters", () => {
        it.each([
            { args: [...NO_SECURITY, "--include", "calm", "--format", "minimal"], label: "--include" },
            { args: [...NO_SECURITY, "--exclude", "calm", "--format", "minimal"], label: "--exclude" },
            { args: [...NO_SECURITY, "--include", "@scope/*", "--exclude", "x", "--format", "minimal"], label: "a scope glob and an exclusion that matches nothing" },
            { args: [...NO_SECURITY, "--exclude", "calm", "--exclude", "@scope/*", "--format", "minimal"], label: "two exclusions" },
            { args: [...NO_SECURITY, "--include", "calm", "--include", "devtool", "--format", "minimal"], label: "two inclusions" },
            { args: [...NO_SECURITY, "calm", "devtool", "--format", "minimal"], label: "package patterns" },
            { args: [...NO_SECURITY, "--format", "minimal", "calm"], label: "a package pattern after the flags" },
            { args: [...NO_SECURITY, "--include", "ca?m", "--format", "minimal"], label: "a ? pattern" },
            { args: [...NO_SECURITY, "--include", "*o*", "--exclude", "dev*", "--format", "minimal"], label: "star patterns" },
            { args: [...NO_SECURITY, "--exclude", "*", "--format", "json"], label: "everything excluded" },
            { args: ["--exclude", "*"], label: "everything excluded, security on" },
            { args: ["uptodate"], label: "a package that is up to date, security on" },
        ])("answers $label", async ({ args }) => {
            expect.hasAssertions();

            await parity({ args });
        });
    });

    describe("the dependency fields", () => {
        const manifest = { ...BASE_MANIFEST, optionalDependencies: { second: "^2.0.0" }, peerDependencies: { exact: "^1.0.0" } };

        it.each([
            { args: [...NO_SECURITY, "--dev", "--format", "minimal"], label: "--dev" },
            { args: [...NO_SECURITY, "-D", "--format", "json"], label: "-D" },
            { args: [...NO_SECURITY, "--prod", "--format", "minimal"], label: "--prod" },
            { args: [...NO_SECURITY, "-P", "--format", "table"], label: "-P" },
            { args: [...NO_SECURITY, "--format", "minimal"], label: "the default fields, optional dependencies included" },
            { args: [...NO_SECURITY, "--peer", "--format", "minimal"], label: "--peer" },
        ])("answers $label", async ({ args }) => {
            expect.hasAssertions();

            await parity({ args, files: workspace({ manifest }) });
        });

        it("names the workspace's own packages in no catalog", async () => {
            expect.hasAssertions();

            const native = await parity({ args: [...NO_SECURITY, "--format", "json"] });

            expect(native.stdout).not.toContain('"packageName": "app"');
            expect(native.stdout).not.toContain('"packageName": "root"');
        });
    });

    describe("the target", () => {
        it.each([
            { args: [...NO_SECURITY, "--target", "latest", "--format", "minimal"], label: "--target latest" },
            { args: [...NO_SECURITY, "--target", "minor", "--format", "minimal"], label: "--target minor" },
            { args: [...NO_SECURITY, "--target", "patch", "--format", "minimal"], label: "--target patch" },
            { args: [...NO_SECURITY, "-t", "patch", "--format", "json"], label: "-t patch" },
            { args: [...NO_SECURITY, "--prerelease", "--target", "latest", "--format", "minimal"], label: "--prerelease" },
        ])("answers $label", async ({ args }) => {
            expect.hasAssertions();

            await parity({ args });
        });
    });

    describe("ranges and answers of every kind", () => {
        const manifest = {
            dependencies: {
                betalatest: "^1.0.0",
                buildmeta: "^1.0.0",
                gitdep: "git+https://example.test/r.git",
                latesttag: "latest",
                nolatest: "^1.0.0",
                npmalias: "npm:other@^1.0.0",
                order: "~1.0.0",
                pre: "^1.0.0-beta.1",
                rangey: ">=1.0.0 <2.0.0",
                star: "*",
                vprefix: "^1.0.0",
                workspaced: "workspace:^1.0.0",
                xrange: "1.x",
            },
        };

        it.each([
            { args: [...NO_SECURITY, "--format", "minimal"], label: "the default target" },
            { args: [...NO_SECURITY, "--format", "json"], label: "json" },
            { args: [...NO_SECURITY, "--format", "minimal", "--target", "latest"], label: "the latest target" },
            { args: [...NO_SECURITY, "--format", "minimal", "--target", "latest", "--prerelease"], label: "prereleases" },
            { args: [...NO_SECURITY, "--format", "minimal", "--target", "patch"], label: "the patch target" },
            { args: [...NO_SECURITY, "--format", "table"], label: "a table" },
        ])("answers $label", async ({ args }) => {
            expect.hasAssertions();

            await parity({ args, files: workspace({ app: false, manifest }) });
        });
    });

    describe("a run with nothing to look up or nothing outdated", () => {
        it("says there is no catalog", async () => {
            expect.hasAssertions();

            const native = await parity({ args: NO_SECURITY, files: workspace({ app: false, manifest: {} }) });

            expect(native.stdout).toBe("No catalogs found.\n");
        });

        it("says everything is up to date, security on, without a request to OSV", async () => {
            expect.hasAssertions();

            const native = await parity({ args: ["uptodate"] });

            expect(native.stdout).toContain("All catalog dependencies are up to date.");
        });

        it("skips a workspace: range", async () => {
            expect.hasAssertions();

            await parity({ args: [...NO_SECURITY, "--format", "minimal"], files: workspace({ manifest: { dependencies: { calm: "^1.0.0", ignored: "workspace:*" } } }) });
        });
    });

    describe("a package that cannot be fetched", () => {
        it.each([
            { name: "notfound", why: "a 404" },
            { name: "broken", why: "a 500" },
            { name: "htmlbody", why: "an HTML page" },
            { name: "nullbody", why: "null" },
            { name: "emptybody", why: "an empty body" },
            { name: "arraybody", why: "an array" },
            { name: "unknown", why: "a name the registry does not know" },
        ])("goes on without it for $why", async ({ name }) => {
            expect.hasAssertions();

            const files = workspace({ manifest: { dependencies: { calm: "^1.0.0", [name]: "^1.0.0" } } });

            for (const format of ["minimal", "table"]) {
                await parity({ args: [...NO_SECURITY, "--format", format], files });
            }

            await parity({ args: [...NO_SECURITY, "--format", "json", "--exit-code"], files });
        });

        // Node lists the names in the order the requests ended, which depends on how long each took; with one failure there is one order.
        it("hands a run with two failures to Node, which orders them by when their requests ended", async () => {
            expect.hasAssertions();

            await delegation({
                args: [...NO_SECURITY, "--format", "minimal"],
                files: workspace({ manifest: { dependencies: { broken: "^1.0.0", calm: "^1.0.0", notfound: "^1.0.0" } } }),
                nativeOnly: true,
            });
        });

        it("reports the failure even when nothing else is outdated", async () => {
            expect.hasAssertions();

            const native = await parity({ args: NO_SECURITY, files: workspace({ app: false, manifest: { dependencies: { notfound: "^1.0.0" } } }) });

            expect(native.stderr).toBe("Failed to fetch: notfound\n");
            expect(native.stdout).toContain("All catalog dependencies are up to date.");
        });

        it("goes on when the registry refuses the connection", async () => {
            expect.hasAssertions();

            const native = await parity({ args: [...NO_SECURITY, "--format", "minimal"], files: workspace({ app: false, manifest: { dependencies: { calm: "^1.0.0" } }, npmrc: `registry=${await refusedRegistry()}\n` }) });

            expect(native.stderr).toBe("Failed to fetch: calm\n");
        });
    });

    describe("the registry named by an .npmrc", () => {
        it("asks the registry of a scope", async () => {
            expect.hasAssertions();

            const native = await parity({
                args: [...NO_SECURITY, "--format", "minimal"],
                files: workspace({ manifest: BASE_MANIFEST, npmrc: `registry=${base}/\n@scope:registry=${base}/scoped-registry/\n` }),
            });

            expect(native.stdout).toContain("@scope/scoped  ^1.0.0 → ^1.0.3");
        });

        it("reads a registry written without the closing slash", async () => {
            expect.hasAssertions();

            await parity({ args: [...NO_SECURITY, "--format", "minimal"], files: workspace({ npmrc: `registry=${base}\n` }) });
        });

        it("reads the registry of the user's .npmrc when the project names none", async () => {
            expect.hasAssertions();

            const home = realpathSync(mkdtempSync(join(scratch, "user-")));

            writeFileSync(join(home, ".npmrc"), `registry=${base}/\n`);

            await parity({ args: [...NO_SECURITY, "--format", "minimal"], extra: { HOME: home }, files: workspace({ npmrc: "# nothing here\n" }) });
        });

        it("lets the project's registry win over the user's", async () => {
            expect.hasAssertions();

            const home = realpathSync(mkdtempSync(join(scratch, "user-")));

            writeFileSync(join(home, ".npmrc"), "registry=http://127.0.0.1:1/\n");

            await parity({ args: [...NO_SECURITY, "--format", "minimal"], extra: { HOME: home } });
        });
    });

    describe("the result cache", () => {
        it("writes the file Node writes", async () => {
            expect.hasAssertions();

            const native = await parity({ args: [...NO_SECURITY, "--format", "minimal"] });

            expect(native.status).toBe(0);
        });

        it("answers a second run from the cache, without a request", async () => {
            expect.hasAssertions();

            const native = await parity({ args: [...NO_SECURITY, "--format", "table"], twice: true });

            expect(native.stdout).not.toContain("Checking 1/");
            expect(native.stdout).toContain("Found 4 outdated");
        });

        it("replays a failed fetch from the cache", async () => {
            expect.hasAssertions();

            const native = await parity({ args: [...NO_SECURITY, "--format", "minimal"], files: workspace({ manifest: { dependencies: { calm: "^1.0.0", notfound: "^1.0.0" } } }), twice: true });

            expect(native.stderr).toBe("Failed to fetch: notfound\n");
        });

        it.each(["node", "native"] as const)("reads the cache a run of %s wrote, as the other side does", async (first) => {
            expect.hasAssertions();

            const args = [...NO_SECURITY, "--format", "json"];
            const files = workspace();
            const [alone, mixed] = harness.pair(files);
            const env = environment();
            const second = first === "node" ? "native" : "node";
            const run = (side: string, root: string): Result => (side === "node" ? harness.runNode(args, root, env) : harness.runNative(args, root, { ...env, VIS_DEBUG_DECLINE: "1" }));

            run("node", alone);

            const expected = run("node", alone);

            run(first, mixed);
            await clear();

            const result = run(second, mixed);

            expect(result.status, result.stderr).not.toBe(70);
            expect(outcomeOf(result, mixed)).toStrictEqual(outcomeOf(expected, alone));
            await expect(requests(), "the second run is answered by the cache").resolves.toStrictEqual([]);
        });

        it("does not read a cache of another run", async () => {
            expect.hasAssertions();

            const files = workspace();
            const [alone, mixed] = harness.pair(files);
            const env = environment();

            harness.runNode([...NO_SECURITY, "--format", "minimal", "--target", "latest"], mixed, env);

            const expected = harness.runNode([...NO_SECURITY, "--format", "minimal"], alone, env);
            const native = harness.runNative([...NO_SECURITY, "--format", "minimal"], mixed, { ...env, VIS_DEBUG_DECLINE: "1" });

            expect(native.status, native.stderr).not.toBe(70);
            expect(outcomeOf(native, mixed).stdout).toBe(outcomeOf(expected, alone).stdout);
        });
    });

    describe("the widest table the terminal holds", () => {
        const wide = (name: string): Files => workspace({ app: false, manifest: { dependencies: { [name]: "^1.0.0" } } });

        it("draws a table of 80 columns", async () => {
            expect.hasAssertions();

            const native = await parity({ args: NO_SECURITY, files: wide(LONG_49) });

            expect(native.stdout).toContain("┌");
        });

        it("hands a table of 81 columns to Node", async () => {
            expect.hasAssertions();

            await delegation({ args: NO_SECURITY, files: wide(LONG_50) });
        });

        it("still prints minimal lines and JSON for the long name", async () => {
            expect.hasAssertions();

            await parity({ args: [...NO_SECURITY, "--format", "minimal"], files: wide(LONG_50) });
            await parity({ args: [...NO_SECURITY, "--format", "json"], files: wide(LONG_50) });
        });
    });

    describe("a run with security on and something outdated", () => {
        // The OSV query goes to a fixed address. Whether the binary can reach it and gets an empty answer (it prints), or not (it hands the run to
        // Node, which asks too), the bytes are the same; so this runs the binary with the Node entry to fall back on.
        it("prints what Node prints, whichever side the OSV answer lets finish the run", () => {
            expect.hasAssertions();

            const files = workspace({ app: false, manifest: { dependencies: { "vis-fixture-no-such-package": "^1.0.0" } }, npmrc: `registry=${base}/\n` });
            const [nodeRoot, nativeRoot] = harness.pair(files);
            const node = harness.runNode(["--format", "minimal"], nodeRoot, environment());
            const native = harness.runNative(["--format", "minimal"], nativeRoot, environment({ VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }));

            expect(outcomeOf(native, nativeRoot)).toStrictEqual(outcomeOf(node, nodeRoot));
        });
    });

    describe("a shape that is Node's", () => {
        it.each([
            { args: [...NO_SECURITY, "--ai", "--exclude", "*"], label: "--ai", nativeOnly: true },
            { args: [...NO_SECURITY, "--ai-type", "security"], label: "--ai-type" },
            { args: ["--security-config"], label: "--security-config" },
            { args: ["--sync"], label: "--sync without --security-config" },
            { args: [...NO_SECURITY, "--include-internal", "--format", "minimal"], label: "--include-internal, which Node ignores" },
            { args: [...NO_SECURITY, "--format=json"], label: "a flag written with =" },
            { args: [...NO_SECURITY, "--target=patch", "--format", "minimal"], label: "--target=patch" },
            { args: [...NO_SECURITY, "--exit-code=false", "--format", "minimal"], label: "--exit-code=false" },
            { args: [...NO_SECURITY, "--format", "xml"], label: "a format Node draws as a table" },
            { args: [...NO_SECURITY, "--target", "bad"], label: "an unknown target" },
            { args: [...NO_SECURITY, "--dev", "--prod"], label: "--dev with --prod" },
            { args: [...NO_SECURITY, "--exit-code", "--exit-code", "--format", "minimal"], label: "a repeated flag" },
            { args: [...NO_SECURITY, "--target", "minor", "--target", "patch", "--format", "minimal"], label: "a repeated option" },
            { args: [...NO_SECURITY, "--exclude", "calm", "devtool", "--format", "minimal"], label: "a word after the value of --exclude" },
            { args: [...NO_SECURITY, "--include", "", "--format", "minimal"], label: "an empty pattern" },
            { args: [...NO_SECURITY, "--unknown", "--format", "minimal"], label: "an option the command does not have" },
        ])("hands $label to Node", async ({ args, nativeOnly }) => {
            expect.hasAssertions();

            await delegation({ args, nativeOnly });
        });

        it("hands a run that is no CI run to Node", async () => {
            expect.hasAssertions();

            await delegation({ args: [...NO_SECURITY, "--format", "minimal"], ci: false });
        });
    });

    describe("an environment Node reads differently", () => {
        it.each([
            { extra: { HTTPS_PROXY: "http://127.0.0.1:1" }, label: "a proxy" },
            { extra: { NODE_OPTIONS: "--max-old-space-size=512" }, label: "a Node option" },
            { extra: { NODE_EXTRA_CA_CERTS: "/nonexistent/ca.pem" }, label: "a CA file" },
            { extra: { FORCE_COLOR: "1" }, label: "a forced colour" },
            { extra: { GITHUB_ACTIONS: "true", TERM: "xterm-256color" }, label: "a CI that paints" },
            { extra: { TERM: "xterm-256color" }, label: "a known terminal" },
            { extra: { MARSHALL_DISABLE_ALL: "1" }, label: "a marshall switch" },
            { extra: { CACHE_DIR: "/nonexistent/vis-cache" }, label: "a moved cache" },
            { extra: { NODE_ENV: "test" }, label: "an output setting" },
        ])("hands $label to Node", async ({ extra }) => {
            expect.hasAssertions();

            await delegation({ args: [...NO_SECURITY, "--format", "minimal"], extra });
        });
    });

    describe("a workspace Node reads differently", () => {
        it.each([
            { files: workspace({ files: { "vis.config.ts": 'export default { update: { target: "patch" } };\n' } }), label: "a config with update defaults" },
            { files: workspace({ files: { "vis.config.ts": "export default { plugins: [] };\n" } }), label: "a config with plugins" },
            { files: workspace({ files: { "vis.config.ts": "export default { security: {} };\n" } }), label: "a config with security settings" },
            { files: workspace({ files: { "packages/app/package.json": json({ dependencies: { calm: "catalog:" }, name: "app", version: "1.0.0" }), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\ncatalog:\n  calm: ^1.0.0\n' } }), label: "catalogs in pnpm-workspace.yaml" },
            { files: workspace({ manifest: { catalog: { calm: "^1.0.0" }, dependencies: { calm: "catalog:" } } }), label: "catalogs in the manifest" },
            { files: workspace({ npmrc: `registry=${base}/\n//127.0.0.1/:_authToken=abc\n` }), label: "a registry credential" },
            { files: workspace({ npmrc: "registry=${NO_SUCH_REGISTRY:-http://127.0.0.1:1/}\n" }), label: "an environment reference in the registry" },
            { files: workspace({ npmrc: "registry=http://127.0.0.1:80/\n" }), label: "a registry on a port fetch refuses" },
            { files: workspace({ manifest: { dependencies: { calm: 1 } } }), label: "a range that is not text" },
            { files: workspace({ manifest: { dependencies: { calm: "^1.0.0", réact: "^1.0.0" } } }), label: "a dependency name that is not ASCII" },
            { files: workspace({ manifest: { dependencies: { calm: "^1.0.0", redirected: "^1.0.0" } } }), label: "a registry answer that redirects" },
            { files: workspace({ manifest: { dependencies: { bom: "^1.0.0", calm: "^1.0.0" } } }), label: "an answer with a byte-order mark" },
            { files: workspace({ manifest: { dependencies: { calm: "^1.0.0", duplicate: "^1.0.0" } } }), label: "an answer with a repeated key" },
            { files: workspace({ manifest: { dependencies: { calm: "^1.0.0", numberlatest: "^1.0.0" } } }), label: "a latest tag that is not text" },
            { files: workspace({ manifest: { dependencies: { calm: "^1.0.0", oddversion: "^1.0.0" } } }), label: "a version that is not a plain semver" },
        ])("hands $label to Node", async ({ files }) => {
            expect.hasAssertions();

            await delegation({ args: [...NO_SECURITY, "--format", "minimal"], files });
        });
    });
});
