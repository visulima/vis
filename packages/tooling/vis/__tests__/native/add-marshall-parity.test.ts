import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * The marshall check of `vis add` exists twice: the Node handler (`src/commands/add/handler.ts`, `runMarshallPipeline`) and the
 * native path (`native/cli/src/marshall_check/`), which answers the run in which the marshalls find nothing, and hands every
 * other run to Node before anything is printed, run or written.
 *
 * The registry is a stub in a separate process that the `.npmrc` of the project points both sides at. The services the other
 * marshalls ask (the npm stats API, GitHub, DNS) have fixed addresses, so no case reaches them: the caches of
 * `downloads`, `archivedRepo` and `expiredDomains` in each side's `HOME` are seeded fresh, as they are after a first run, and the
 * versions the cases add are exact, so `/latest` of the npm registry is not asked either. Each side has its own `HOME` and
 * project, because the caches live in `~/.vis/cache`; the `createdAt` of a cache entry written during the run is masked.
 *
 * Stub package managers on `PATH` log their arguments, so "the manager ran" is what the log shows. The native run's Node is a stub
 * that prints a marker and fails, so a run that quietly delegated is caught.
 *
 * Needs the native `vis` binary, the built CLI (`dist/bin.js`) and the NAPI addon; skipped otherwise.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const addonPath = join(packageRoot, "index.js");
const marker = "NATIVE-DELEGATED";
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

const addonLoads = (): boolean =>
    existsSync(addonPath) && spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(addonPath).href)});`], { cwd: packageRoot }).status === 0;

const ready = Boolean(binary) && process.platform !== "win32" && existsSync(nodeEntry) && addonLoads();

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();

/** An ISO time `days` before the start of the run, as the registry writes it. */
const ago = (days: number): string => new Date(T0 - days * DAY).toISOString();

const user = (name: string): { email: string; name: string } => {
    return { email: `${name}@example.test`, name };
};

const entry = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    return { _npmUser: user(name), license: "MIT", readme: "# readme", repository: { type: "git", url: "git+https://github.com/o/r.git" }, ...extra };
};

interface Answer {
    body: string;
    status?: number;
}

const packument = (name: string, versions: Record<string, unknown>, time: Record<string, string>, extra: Record<string, unknown> = {}): Answer => {
    return { body: JSON.stringify({ "dist-tags": { latest: Object.keys(versions).at(-1) }, name, time, versions, ...extra }) };
};

const SIGNED = { dist: { attestations: { provenance: { predicateType: "x" } } } };

const ANSWERS: Record<string, Answer> = {
    "/@scope%2fscoped": packument("@scope/scoped", { "1.0.0": entry("amy"), "1.1.0": entry("amy") }, { "1.0.0": ago(100.3), "1.1.0": ago(90.3) }),
    "/broken": { body: "broken", status: 500 },
    "/calm": packument("calm", { "1.0.0": entry("amy"), "1.1.0": entry("amy"), "1.2.0": entry("amy") }, { "1.0.0": ago(100.3), "1.1.0": ago(90.3), "1.2.0": ago(80.3) }),
    "/dropped": packument("dropped", { "1.0.0": entry("amy", SIGNED), "1.1.0": entry("amy") }, { "1.0.0": ago(100.3), "1.1.0": ago(90.3) }),
    "/old": packument("old", { "1.0.0": entry("amy") }, { "1.0.0": ago(900.3) }),
    "/second": packument("second", { "2.0.0": entry("amy"), "2.1.0": entry("amy") }, { "2.0.0": ago(150.3), "2.1.0": ago(120.3) }),
    "/shiny": packument("shiny", { "1.0.0": entry("amy") }, { "1.0.0": ago(3.3) }),
    "/stale": packument("stale", { "1.0.0": entry("amy", { deprecated: "use calm" }) }, { "1.0.0": ago(100.3) }),
    "/young": packument("young", { "1.0.0": entry("amy"), "1.1.0": entry("bob") }, { "1.0.0": ago(1000.3), "1.1.0": ago(2.3) }),
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

const STUBS = ["bun", "npm", "pnpm", "yarn"] as const;

const stubSource = (name: string): string => ["#!/bin/sh", `echo "${name}:$*" >> "$STUB_LOG"`, 'echo "cwd:$PWD" >> "$STUB_LOG"', "exit 0", ""].join("\n");

let scratch = "";
let stub: ChildProcess;
let base = "";
let nativeBinary = "";
let counter = 0;

// A workspace root: outside one Node does not read the `.npmrc`, and asks registry.npmjs.org for every packument.
const PROJECT = { ".npmrc": "", "package.json": JSON.stringify({ name: "app", version: "1.0.0" }), "pnpm-lock.yaml": "lockfileVersion: 9\n", "pnpm-workspace.yaml": "packages: []\n" };

interface Setup {
    bindir: string;
    cwd: string;
    home: string;
}

/** A fresh project, with its own home (the service caches seeded fresh) and a bin directory with a stub for each manager. */
const project = (side: "native" | "node", seed: boolean, files: Record<string, string> = {}): Setup => {
    const root = join(scratch, `${side}-${String(counter).padStart(5, "0")}`);
    const cwd = join(root, "project");
    const bindir = join(root, "bin");
    const home = join(root, "home");

    for (const folder of [cwd, bindir, home]) {
        mkdirSync(folder, { recursive: true });
    }

    for (const [name, content] of Object.entries({ ...PROJECT, ".npmrc": `registry=${base}/\n`, ...files })) {
        mkdirSync(dirname(join(cwd, name)), { recursive: true });
        writeFileSync(join(cwd, name), content);
    }

    for (const name of STUBS) {
        writeFileSync(join(bindir, name), stubSource(name));
        chmodSync(join(bindir, name), 0o755);
    }

    writeFileSync(join(bindir, "node"), `#!/bin/sh\necho ${marker}\nexit 99\n`);
    chmodSync(join(bindir, "node"), 0o755);

    if (seed) {
        const entryText = (extra: Record<string, unknown>): string => JSON.stringify({ createdAt: Date.now(), ttlMs: 86_400_000, ...extra });
        const cache = (path: string, text: string): void => {
            mkdirSync(dirname(join(home, ".vis/cache", path)), { recursive: true });
            writeFileSync(join(home, ".vis/cache", path), text);
        };

        for (const name of ["calm", "dropped", "old", "second", "shiny", "stale", "young", "%40scope%2Fscoped"]) {
            cache(`downloads/${name}.json`, entryText({ downloads: 50_000, observedAt: new Date(T0).toISOString() }));
        }

        cache("archived-repo/o__r.json", entryText({ archived: false }));
        cache(`expired-domains/${createHash("sha256").update("example.test").digest("hex").slice(0, 12)}.json`, entryText({ outcome: "ok" }));
    }

    return { bindir, cwd, home };
};

/** The whole environment of a run: nothing is inherited. */
const environment = (setup: Setup, extra: Record<string, string> = {}): Record<string, string> => {
    return { CI: "1", COLUMNS: "80", HOME: setup.home, PATH: `${setup.bindir}:/usr/bin:/bin`, VIS_NO_UPDATE_CHECK: "1", ...extra };
};

interface Run {
    log: string;
    status: number | null;
    stderr: string;
    stdout: string;
}

const normalize = (text: string, setup: Setup): string => text.replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS").replaceAll(dirname(setup.cwd), "<ROOT>");

const capture = (command: string, args: string[], setup: Setup, env: Record<string, string>): Run => {
    const name = randomUUID();
    const out = join(scratch, `${name}.out`);
    const err = join(scratch, `${name}.err`);
    const log = join(scratch, `${name}.log`);
    const outFd = openSync(out, "w");
    const errFd = openSync(err, "w");

    try {
        const { status } = spawnSync(command, args, { cwd: setup.cwd, env: { ...env, STUB_LOG: log }, stdio: ["ignore", outFd, errFd] });

        return {
            log: existsSync(log) ? normalize(readFileSync(log, "utf8"), setup) : "",
            status,
            stderr: normalize(readFileSync(err, "utf8"), setup),
            stdout: normalize(readFileSync(out, "utf8"), setup),
        };
    } finally {
        closeSync(outFd);
        closeSync(errFd);
    }
};

const runNode = (setup: Setup, args: string[], extra: Record<string, string> = {}): Run => capture(process.execPath, [nodeEntry, ...args], setup, environment(setup, extra));

const runNative = (setup: Setup, args: string[], extra: Record<string, string> = {}): Run =>
    capture(nativeBinary, args, setup, { ...environment(setup, extra), VIS_FALLBACK_ENTRY: join(scratch, "no-such-entry.js"), VIS_DEBUG_DECLINE: "1", VIS_NODE: join(setup.bindir, "node"), VIS_VERSION: version });

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

/** The services are off, which both sides read from the environment. */
const SERVICES_OFF = { MARSHALL_DISABLE_ARCHIVED_REPO: "1", MARSHALL_DISABLE_DOWNLOADS: "1", MARSHALL_DISABLE_EXPIRED_DOMAINS: "1" };

interface Case {
    args: string[];
    env?: Record<string, string>;
    label?: string;
    seed?: boolean;
}

describe.skipIf(!ready)("vis add marshall check: native vs Node", () => {
    beforeAll(async () => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-add-marshall-")));
        nativeBinary = join(scratch, "vis");
        // A binary inside the package reads its own location and delegates to `dist/bin.js` itself; a copy outside it keeps the stub in charge.
        writeFileSync(nativeBinary, readFileSync(binary as string), { mode: 0o755 });
        // CI runs the suite with `FORCE_COLOR=3`: the stub gets it here on purpose, so its port reaches `base` as plain digits.
        stub = spawn(process.execPath, ["-e", STUB], { env: { ANSWERS: JSON.stringify(ANSWERS), FORCE_COLOR: "3", PATH: process.env["PATH"] ?? "" }, stdio: ["ignore", "pipe", "inherit"] });
        base = await new Promise<string>((resolvePort) => {
            stub.stdout?.once("data", (chunk: Buffer) => {
                resolvePort(`http://127.0.0.1:${chunk.toString().trim()}`);
            });
        });
    });

    afterAll(() => {
        stub.kill();
        rmSync(scratch, { force: true, recursive: true });
    });

    /** Both sides run the same call and must end the same way, caches included; the native side answers. */
    const expectParity = ({ args, env, seed = true }: Case): Run => {
        const nodeSide = project("node", seed);
        const nativeSide = project("native", seed);

        counter += 1;

        const node = runNode(nodeSide, args, env);
        const native = runNative(nativeSide, args, env);

        expect(native.stdout, `native stderr: ${native.stderr}`).not.toContain(marker);
        expect(native).toStrictEqual(node);
        expect(node.log).toMatch(/^(bun|npm|pnpm|yarn):/m);
        expect(homeState(nativeSide.home)).toStrictEqual(homeState(nodeSide.home));

        return native;
    };

    /** The native side hands the run to Node before the manager runs and before it writes anything. */
    const expectDelegation = ({ args, env, seed = true }: Case): Run => {
        const setup = project("native", seed);
        const before = homeState(setup.home);

        counter += 1;

        const native = runNative(setup, args, env);

        expect(native.stdout).toContain(marker);
        expect(native.log, "the manager must not have run").toBe("");
        expect(homeState(setup.home), "a declined run must not write").toStrictEqual(before);

        return native;
    };

    describe("a run with no finding", () => {
        it.each([
            { args: ["add", "calm@1.2.0"], label: "a calm package, the caches seeded" },
            { args: ["add", "calm@1.2.0", "--no-socket-check"], label: "--no-socket-check" },
            { args: ["add", "-D", "calm@^1.0.0", "second@2.1.0", "-E"], label: "two packages, a range and an exact version" },
            { args: ["add", "@scope/scoped@1.1.0"], label: "a scoped package" },
            { args: ["add", "calm@1.2.0", "calm@1.1.0"], label: "one name twice" },
            { args: ["add", "calm@1.2.0", "--no-marshall-check"], label: "the check turned off" },
        ] satisfies Case[])("answers $label", (parity: Case) => {
            expect.hasAssertions();
            expectParity(parity);
        });

        it("answers with the services off and caches nothing but the packuments", () => {
            expect.hasAssertions();

            const result = expectParity({ args: ["add", "calm@1.2.0"], env: SERVICES_OFF, seed: false });

            expect(result.log).toMatch(/^pnpm:add calm@1\.2\.0 --ignore-scripts$/m);
        });

        it("leaves a package the registry does not know to the manager", () => {
            expect.hasAssertions();
            expectParity({ args: ["add", "ghost@1.0.0"], env: SERVICES_OFF, seed: false });
        });

        it("reads a MARSHALL_DISABLE_* variable the way isTruthyEnv does", () => {
            expect.hasAssertions();

            for (const value of ["1", "true", "yes", " On ", "0", "false", ""]) {
                expectParity({ args: ["add", "calm@1.2.0"], env: { MARSHALL_DISABLE_AUTHOR: value } });
            }
        });

        it("reads and caches every packument even when every marshall is off, as the pipeline does", () => {
            expect.hasAssertions();

            const off = Object.fromEntries(
                ["ARCHIVED_REPO", "AUTHOR", "DEPRECATION", "DOWNLOADS", "EXPIRED_DOMAINS", "METADATA", "NEW_BIN", "PACKAGE_AGE", "PROVENANCE", "S1NGULARITY"].map((name) => [`MARSHALL_DISABLE_${name}`, "1"]),
            );

            expectParity({ args: ["add", "calm@1.2.0", "second@2.1.0"], env: off, seed: false });
        });
    });

    describe("a run with a finding, or one this binary cannot tell", () => {
        it.each([
            { args: ["add", "young@1.1.0"], label: "a version by a new publisher, two days old (author)" },
            { args: ["add", "shiny@1.0.0"], label: "a package three days old (packageAge)" },
            { args: ["add", "old@1.0.0"], label: "a package idle for 900 days (packageAge)" },
            { args: ["add", "stale@1.0.0"], label: "a deprecated version" },
            { args: ["add", "dropped@1.1.0"], label: "a version that dropped its provenance" },
            { args: ["add", "broken@1.0.0"], label: "a registry that fails" },
            { args: ["add", "calm@1.2.0"], env: { MARSHALL_DISABLE_ALL: "1" }, label: "MARSHALL_DISABLE_ALL" },
            { args: ["add", "calm@1.2.0"], env: { MARSHALL_DISABLE_TYPOSQUATS: "1" }, label: "MARSHALL_DISABLE_TYPOSQUATS" },
            { args: ["add", "calm@1.2.0"], env: { MARSHALL_DISABLE_AUTHOR: " 1" }, label: "a value JavaScript and Rust trim differently" },
            { args: ["add", "calm@1.2.0"], env: { HTTPS_PROXY: "http://127.0.0.1:9" }, label: "a proxy in the environment" },
            { args: ["add", "calm@1.2.0"], seed: false, label: "caches that are not there (the services have fixed addresses)" },
        ] satisfies Case[])("hands $label to Node", (delegated: Case) => {
            expect.hasAssertions();
            expectDelegation(delegated);
        });

        it("hands a download count below the threshold to Node", () => {
            expect.hasAssertions();

            const setup = project("native", true);

            writeFileSync(join(setup.home, ".vis/cache/downloads/calm.json"), JSON.stringify({ createdAt: Date.now(), downloads: 5, observedAt: new Date().toISOString(), ttlMs: 86_400_000 }));

            const native = runNative(setup, ["add", "calm@1.2.0"]);

            expect(native.stdout).toContain(marker);
            expect(native.log).toBe("");
        });

        it.each([
            ["archived-repo/o__r.json", { archived: true }],
            ["archived-repo/o__r.json", { archived: false, missing: true }],
            [`expired-domains/${createHash("sha256").update("example.test").digest("hex").slice(0, 12)}.json`, { outcome: "expired" }],
        ])("hands the recorded finding in %s %j to Node", (path: string, entryFields: Record<string, unknown>) => {
            expect.hasAssertions();

            const setup = project("native", true);

            writeFileSync(join(setup.home, ".vis/cache", path), JSON.stringify({ createdAt: Date.now(), ttlMs: 86_400_000, ...entryFields }));

            const native = runNative(setup, ["add", "calm@1.2.0"]);

            expect(native.stdout).toContain(marker);
            expect(native.log).toBe("");
        });
    });
});
