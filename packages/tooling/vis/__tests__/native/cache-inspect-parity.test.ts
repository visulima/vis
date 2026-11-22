import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `vis cache list` and `vis cache size` exist twice: the Node handlers (`src/commands/cache/`) and the
 * native path (`native/cli/src/cache.rs`). Every case below runs both on the same workspace and the same
 * `HOME` and compares stdout, stderr and the exit status.
 *
 * A case marked `native` must be answered by the binary itself: it runs with a Node entry that exits 99, so a
 * delegation cannot pass as parity. A case marked `node` is one the binary declines (pail-framed output, a
 * multi-directory listing, a config it cannot read as data, …): the binary must hand it to Node, and the
 * result through the hand-off must match Node's. Node needs the built CLI (`dist/bin.js`) and the NAPI addon;
 * the suite is skipped when either, or the binary, is missing.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");

let scratch = "";
let nativeBinary = "";
let stubEntry = "";
let home = "";

/** A pnpm workspace root the binary and Node both find from its own directory. */
const makeRoot = (name: string, files: Record<string, string> = {}): string => {
    const root = join(scratch, name);

    mkdirSync(join(root, "packages", "app"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(join(root, "packages", "app", "package.json"), '{"name":"app","version":"1.0.0"}');

    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }

    return root;
};

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** Sets a path's modification time to `secondsAgo` before now, with `fraction` of a second added back. */
const age = (path: string, secondsAgo: number, fraction = 0): void => {
    const time = Date.now() / 1000 - secondsAgo + fraction;

    utimesSync(path, time, time);
};

const populate = (directory: string, entries: Record<string, [number, number[]]>): void => {
    for (const [hash, [secondsAgo, sizes]] of Object.entries(entries)) {
        const entry = join(directory, hash);

        mkdirSync(join(entry, "nested"), { recursive: true });

        for (const [index, size] of sizes.entries()) {
            writeFileSync(join(entry, index % 2 === 0 ? "" : "nested", `file-${String(index)}`), Buffer.alloc(size));
        }

        age(entry, secondsAgo);
    }
};

/** The default cache directory of a workspace, filled with the entries the cases read. */
const fillCache = (root: string): string => {
    const cache = join(root, "node_modules", ".cache", "vis");

    mkdirSync(cache, { recursive: true });
    populate(cache, {
        // Same modification time on two entries: the order between them is the listing's tie-break.
        a1b2c3d4e5f6a7b8: [3 * HOUR + 30 * MINUTE, [3000, 1500, 7]],
        bbbbbbbbbbbbbbbbbbbbbbbbbb: [2 * DAY + 12 * HOUR, [1500]],
        cccccccccccccccc: [7 * MINUTE + 30, [1_048_576, 100]],
        dddddddd: [40 * DAY, [1, 2, 3]],
        eeee: [5 * HOUR + 30 * MINUTE, []],
    });

    const tied = 1_700_000_000;

    for (const hash of ["tie-first", "tie-second"]) {
        populate(cache, { [hash]: [0, [10]] });
        utimesSync(join(cache, hash), tied, tied);
    }

    // A sub-millisecond modification time, a dot-directory, a plain file and the branch container.
    populate(cache, { "fraction-entry": [0, [5]] });
    utimesSync(join(cache, "fraction-entry"), 1_700_000_100.123_456, 1_700_000_100.123_456);
    mkdirSync(join(cache, ".hidden"));
    writeFileSync(join(cache, "plain-file"), "x");
    mkdirSync(join(cache, "branches", "elsewhere", "inner"), { recursive: true });
    writeFileSync(join(cache, "branches", "elsewhere", "inner", "f"), "x");

    // A symlinked entry counts by its target; a symlink inside an entry counts for nothing.
    mkdirSync(join(root, "linked-target"), { recursive: true });
    writeFileSync(join(root, "linked-target", "data"), Buffer.alloc(2048));
    symlinkSync(join(root, "linked-target"), join(cache, "symlinked-entry"));
    symlinkSync(join(root, "linked-target", "data"), join(cache, "a1b2c3d4e5f6a7b8", "link-to-file"));

    // Writing into an entry moves its modification time, so the ages are set last.
    age(join(cache, "a1b2c3d4e5f6a7b8"), 3 * HOUR + 30 * MINUTE);
    age(join(root, "linked-target"), 10 * HOUR);

    return cache;
};

const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd,
        encoding: "utf8",
    });

    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
};

interface Run {
    status: number | null;
    stderr: string;
    stdout: string;
}

const environment = (extra: Record<string, string>): Record<string, string> => {
    return { CI: "1", HOME: home, PATH: process.env["PATH"] ?? "", VIS_NO_UPDATE_CHECK: "1", ...extra };
};

const runNode = (cwd: string, args: string[], extra: Record<string, string>): Run =>
    spawnSync(process.execPath, [nodeEntry, ...args], { cwd, encoding: "utf8", env: environment(extra) });

const runNative = (cwd: string, args: string[], extra: Record<string, string>, delegateTo: string): Run =>
    spawnSync(nativeBinary, args, {
        cwd,
        encoding: "utf8",
        env: environment({ VIS_FALLBACK_ENTRY: delegateTo, VIS_NODE: process.execPath, ...extra }),
    });

/** Replaces the scratch directory and the clock pail prints, and masks `ageMs`, which depends on the run. */
const normalize = (text: string): string =>
    text
        .replaceAll(scratch, "<SCRATCH>")
        .replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS")
        .replaceAll(/"ageMs": [\d.]+/g, '"ageMs": <N>');

const ageMsValues = (text: string): number[] => [...text.matchAll(/"ageMs": ([\d.]+)/g)].map((match) => Number(match[1]));

interface Case {
    args: string[];
    /** Where to run, relative to the scratch directory. */
    cwd: string;
    env?: Record<string, string>;
    name: string;
    /** `native`: answered by the binary. `node`: declined, so handed to Node. */
    route: "native" | "node";
}

const cases: Case[] = [];

const both = (name: string, cwd: string, route: "native" | "node", args: string[], env?: Record<string, string>): void => {
    cases.push({ args, cwd, env, name: `${name}: vis ${args.join(" ")}`, route });
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis cache list / size: native vs Node", () => {
    beforeAll(() => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-cache-parity-")));
        mkdirSync(join(scratch, "bin"));
        nativeBinary = join(scratch, "bin", "vis");
        copyFileSync(binary as string, nativeBinary);
        stubEntry = join(scratch, "stub.mjs");
        writeFileSync(stubEntry, 'console.log("NATIVE-DELEGATED");\nprocess.exit(99);\n');

        // The per-user stores, under a HOME of their own.
        home = join(scratch, "home");

        const stores = join(home, ".vis", "cache");
        const files: [string, string, number, number][] = [
            ["ai", "one.json", 120, 2 * DAY],
            ["ai", "two.json", 4000, 5 * HOUR],
            ["ai", "ignored.txt", 99, 1],
            ["socket-security", "s1.json", 2048, 3 * DAY],
            ["deps-dev/versions", "v1.json", 300, 6 * HOUR],
            ["deps-dev/projects", "p1.json", 400, 2 * HOUR],
            ["deps-dev/advisories", "a1.json", 500, 9 * HOUR],
            ["snyk/issues", "i1.json", 1_500_000, 4 * DAY],
        ];

        for (const [store, file, size, secondsAgo] of files) {
            mkdirSync(join(stores, store), { recursive: true });
            writeFileSync(join(stores, store, file), Buffer.alloc(size));
            age(join(stores, store, file), secondsAgo, 0.25);
        }

        // 1. A plain workspace with a populated cache.
        fillCache(makeRoot("plain"));

        // 2. A workspace with an empty cache directory, and one without any.
        mkdirSync(join(makeRoot("empty"), "node_modules", ".cache", "vis"), { recursive: true });
        makeRoot("missing");

        // 3. Configs that are literals.
        fillCache(makeRoot("config-dir", { "vis.config.ts": 'export default { taskRunner: { cacheDirectory: "custom-cache" } };\n' }));
        populate(join(makeRoot("config-dir-2"), "custom-cache"), { a11111111111111b: [DAY, [4096]] });
        writeFileSync(join(scratch, "config-dir-2", "vis.config.ts"), 'export default { taskRunner: { cacheDirectory: "custom-cache" } };\n');
        populate(join(makeRoot("config-dir-3", { "vis.config.mjs": 'export default { taskRunner: { cacheDirectory: "../outside-cache" } };\n' }), "..", "outside-cache"), {
            b22222222222222c: [DAY, [1000]],
        });
        fillCache(makeRoot("config-shared-off", { "vis.config.ts": "export default { sharedWorktreeCache: false };\n" }));

        // 4. Configs that are not literals stay with Node.
        fillCache(makeRoot("config-dynamic", { "vis.config.ts": 'export default { taskRunner: { cacheDirectory: ["a", "b"].join("-") } };\n' }));
        fillCache(makeRoot("config-json", { "vis.config.json": '{ "taskRunner": { "cacheDirectory": "custom-cache" } }\n' }));
        fillCache(makeRoot("config-security", { "vis.config.ts": "export default { security: { blockExoticSubdeps: true } };\n" }));

        // 5. Branch scoping, with a git branch: entries only under the branch, and entries in both places.
        for (const name of ["branch-only", "branch-and-unscoped"]) {
            const root = makeRoot(name, { ".gitignore": "node_modules\n", "vis.config.ts": "export default { branchScopedCache: true };\n" });

            git(root, "init", "-b", "feature/x+y");
            git(root, "add", "-f", "package.json", "vis.config.ts", ".gitignore");
            git(root, "commit", "-m", "init");
            populate(join(root, "node_modules", ".cache", "vis", "branches", "feature-x-y"), {
                c99999999999999d: [HOUR * 5, [2000, 2000]],
                d88888888888888e: [DAY * 2, [100]],
            });
        }

        populate(join(scratch, "branch-and-unscoped", "node_modules", ".cache", "vis"), { e77777777777777f: [DAY * 3, [1234]] });

        // A branch scope in a repository without a commit has no branch name, so the plain directory is read.
        const unborn = makeRoot("branch-unborn", { "vis.config.ts": "export default { branchScopedCache: true };\n" });

        git(unborn, "init", "-b", "main");
        fillCache(unborn);

        // 6. A primary checkout and a linked worktree of it: the shared cache lives in the primary one.
        const primary = makeRoot("worktree-main", { ".gitignore": "node_modules\n" });

        git(primary, "init", "-b", "main");
        git(primary, "add", "-f", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/app/package.json", ".gitignore");
        git(primary, "commit", "-m", "init");
        git(primary, "worktree", "add", "-b", "linked", join(scratch, "worktree-linked"));
        populate(join(primary, "node_modules", ".cache", "vis"), { a66666666666666b: [HOUR * 3, [1000]], f55555555555555a: [DAY, [3000]] });
        populate(join(scratch, "worktree-linked", "node_modules", ".cache", "vis"), { b44444444444444c: [HOUR * 8, [500]] });

        // The cases. `routes` names what the binary does with the two table forms: the JSON forms are always native
        // for `size`, and for `list` unless several directories are read.
        type Route = "native" | "node";

        const everyShape = (name: string, cwd: string, routes: { json?: Route; listTable: Route; sizeTable: Route }, extra: string[] = [], env?: Record<string, string>): void => {
            both(name, cwd, routes.listTable, ["cache", "list", ...extra], env);
            both(name, cwd, routes.json ?? "native", ["cache", "list", "--format", "json", ...extra], env);
            both(name, cwd, routes.sizeTable, ["cache", "size", ...extra], env);
            both(name, cwd, routes.json ?? "native", ["cache", "size", "--format=json", ...extra], env);
        };

        const ok = { listTable: "native", sizeTable: "native" } as const;
        const declined = { listTable: "node", sizeTable: "node" } as const;
        const nodes = { json: "node", listTable: "node", sizeTable: "node" } as const;

        everyShape("plain", "plain", ok);
        everyShape("plain from a package directory", "plain/packages/app", ok);
        everyShape("empty cache", "empty", { listTable: "node", sizeTable: "native" });
        everyShape("missing cache", "missing", declined);

        for (const type of ["task", "ai", "socket", "deps-dev", "snyk", "all"]) {
            both(`type ${type}`, "plain", "native", ["cache", "size", `--type=${type}`]);
            both(`type ${type}`, "plain", "native", ["cache", "size", "--type", type, "--format", "json"]);
        }

        both("an empty cache, one store", "empty", "native", ["cache", "size", "--type=ai"]);
        both("an empty cache", "empty", "native", ["cache", "size", "--type", "task", "--format", "json"]);
        both("a missing cache", "missing", "node", ["cache", "size", "--type", "task"]);

        // Directory resolution: the flag, a relative flag, the environment variable and the three scopes.
        everyShape("--cache-dir (absolute, no entries)", "plain", { listTable: "node", sizeTable: "native" }, ["--cache-dir", join(scratch, "plain", "linked-target")]);
        both("--cache-dir (relative)", "plain/packages/app", "native", ["cache", "list", "--format=json", "--cache-dir", "node_modules/.cache/vis"]);
        both("--cache-dir (relative)", "plain", "native", ["cache", "size", "--type=task", "--cache-dir=./node_modules/../node_modules/.cache/vis"]);
        both("--cache-dir (absolute, unnormalized)", "plain", "native", [
            "cache",
            "list",
            "--format=json",
            `--cache-dir=${join(scratch, "plain", "packages", "..", "node_modules", ".cache", "vis")}`,
        ]);
        both("--cache-dir (missing)", "plain", "native", ["cache", "list", "--format", "json", "--cache-dir", "does-not-exist"]);
        both("--cache-dir (missing)", "plain", "node", ["cache", "list", "--cache-dir", "does-not-exist"]);
        both("VIS_CACHE_DIRECTORY", "plain", "native", ["cache", "list"], { VIS_CACHE_DIRECTORY: "node_modules/.cache/vis" });
        both("VIS_CACHE_DIRECTORY", "plain", "native", ["cache", "size", "--type", "task", "--format", "json"], {
            VIS_CACHE_DIRECTORY: join(scratch, "config-dir", "node_modules", ".cache", "vis"),
        });
        both("--cache-dir beats the environment variable", "plain", "native", ["cache", "list", "--format", "json", "--cache-dir", "linked-target"], {
            VIS_CACHE_DIRECTORY: "nowhere",
        });

        for (const scope of ["shared", "worktree", "all"]) {
            both(`scope ${scope}`, "plain", "native", ["cache", "size", "--format", "json", "--scope", scope]);
        }

        // Configs.
        everyShape("config taskRunner.cacheDirectory (missing)", "config-dir", declined);
        everyShape("config taskRunner.cacheDirectory", "config-dir-2", ok);
        everyShape("config taskRunner.cacheDirectory outside the workspace", "config-dir-3", ok);
        everyShape("config sharedWorktreeCache: false", "config-shared-off", ok);
        everyShape("config, the flag beats the config (nothing at the flag)", "config-dir-2", declined, ["--cache-dir", "node_modules/.cache/vis"]);
        everyShape("dynamic config", "config-dynamic", nodes);
        everyShape("json config", "config-json", nodes);
        everyShape("config with a Node-only key", "config-security", nodes);

        // Branch scoping.
        everyShape("branch scope, branch entries only", "branch-only", ok);
        both("branch scope, branch and unscoped entries (two directories)", "branch-and-unscoped", "node", ["cache", "list"]);
        both("branch scope, branch and unscoped entries (two directories)", "branch-and-unscoped", "node", ["cache", "list", "--format", "json"]);
        both("branch scope, branch and unscoped entries (two directories)", "branch-and-unscoped", "node", ["cache", "size"]);
        both("branch scope, branch and unscoped entries (two directories)", "branch-and-unscoped", "native", ["cache", "size", "--format", "json"]);
        both("branch scope, branch and unscoped entries (two directories)", "branch-and-unscoped", "native", ["cache", "size", "--type=ai"]);
        both("branch scope, scope all (both scopes read the same directory)", "branch-only", "native", ["cache", "list", "--format", "json", "--scope", "all"]);
        everyShape("branch scope without a branch name", "branch-unborn", ok);

        // Linked worktrees.
        for (const scope of ["shared", "worktree", "all"]) {
            for (const format of ["json", "table"]) {
                // Scope `all` reads two directories: `list` then prints a pail header, and the `size` table too.
                const several = scope === "all";

                both(`linked worktree, scope ${scope}`, "worktree-linked", several ? "node" : "native", ["cache", "list", "--format", format, "--scope", scope]);
                both(`linked worktree, scope ${scope}`, "worktree-linked", several && format === "table" ? "node" : "native", [
                    "cache",
                    "size",
                    "--type=task",
                    "--format",
                    format,
                    "--scope",
                    scope,
                ]);
            }
        }

        both("primary worktree, scope all", "worktree-main", "native", ["cache", "size", "--type", "task", "--scope=all"]);

        // Shapes the binary leaves to Node.
        both("unknown scope", "plain", "node", ["cache", "list", "--scope", "bogus"]);
        both("unknown format", "plain", "node", ["cache", "list", "--format", "yaml"]);
        both("unknown type", "plain", "node", ["cache", "size", "--type=nope"]);
        both("repeated flag", "plain", "node", ["cache", "list", "--format", "json", "--format", "table"]);
        both("a global flag", "plain", "node", ["cache", "list", "--format", "json", "--no-color"]);
    });

    it("has cases", () => {
        expect(cases.length).toBeGreaterThan(0);
    });

    it("answers every shape the way Node does", () => {
        // Cases are registered in `beforeAll`, so they run from one test to keep the fixtures in place.
        const failures: string[] = [];

        for (const { args, cwd, env = {}, name, route } of cases) {
            const directory = join(scratch, cwd);
            const node = runNode(directory, args, env);
            const via = runNative(directory, args, env, route === "native" ? stubEntry : nodeEntry);

            if (route === "native" && via.status === 99) {
                failures.push(`${name}: expected a native answer, the binary delegated`);

                continue;
            }

            if (route === "node") {
                const declined = runNative(directory, args, env, stubEntry);

                if (declined.status !== 99) {
                    failures.push(`${name}: expected the binary to delegate, it answered (status ${String(declined.status)})`);
                }
            }

            if (via.status !== node.status) {
                failures.push(`${name}: status ${String(via.status)} vs Node ${String(node.status)}`);
            }

            if (normalize(via.stdout) !== normalize(node.stdout)) {
                failures.push(`${name}: stdout differs\n--- native\n${normalize(via.stdout)}\n--- node\n${normalize(node.stdout)}`);
            }

            if (normalize(via.stderr) !== normalize(node.stderr)) {
                failures.push(`${name}: stderr differs\n--- native\n${normalize(via.stderr)}\n--- node\n${normalize(node.stderr)}`);
            }

            const [nativeAges, nodeAges] = [ageMsValues(via.stdout), ageMsValues(node.stdout)];

            nativeAges.forEach((value, index) => {
                // The runs are seconds apart, and the value is a time difference.
                if (Math.abs(value - (nodeAges[index] ?? Number.NaN)) > 60_000) {
                    failures.push(`${name}: ageMs ${String(value)} vs Node ${String(nodeAges[index])}`);
                }
            });
        }

        expect(failures).toStrictEqual([]);
    }, 600_000);

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });
});
