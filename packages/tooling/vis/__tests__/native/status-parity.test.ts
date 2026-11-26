/* eslint-disable perfectionist/sort-objects, vitest/expect-expect -- the key order of the fixtures is what the tests are about, and the harness asserts */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis status` exists twice: the Node handler (`src/commands/status/handler.ts`) and the native overview
 * (`native/cli/src/status.rs`). For every input the native path accepts it must print the same text or JSON with the
 * same exit status as Node, and every input it declines must be handed to Node before anything is printed (see
 * `workspace-parity-harness.ts` for how both are proved).
 */

const harness = new Harness(["status"]);

const project = (name: string, extra: Record<string, unknown> = {}): Files => {
    return { [`packages/${name}/package.json`]: json({ name, scripts: { build: "tsc", test: "vitest" }, ...extra }) };
};

const BOM = String.fromCodePoint(0xfe_ff);

/** Two projects: `build` and `test` on one, `build` and `lint` on the other. */
const base = (): Files => {
    return { ...project("a"), ...project("b", { scripts: { build: "tsc", lint: "eslint ." }, dependencies: { a: "workspace:*" } }) };
};

const runs = (files: Record<string, unknown>): Files => Object.fromEntries(Object.entries(files).map(([name, content]) => [`.vis/runs/${name}`, typeof content === "string" ? content : json(content)]));

const task = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    return { taskId: id, cacheStatus: "MISS", target: { project: id.split(":")[0], target: id.split(":")[1] }, ...extra };
};

const [major = "0", minor = "0", patch = "0"] = process.versions.node.split(".");
const RUNNING_NODE = process.versions.node;

/** A `node` that answers `--version` with `body`'s output, in a directory of its own. */
const fakeNode = (root: string, name: string, body: string): string => {
    const directory = join(root, name);

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "node"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(directory, "node"), 0o755);

    return directory;
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis status: native vs Node", () => {
    const paths = { fakes: "", nodes: "" };
    /** The environments of the runs: the running Node's own version printed by a `node` on `PATH`, or no `node` at all. */
    const environments: Record<string, Record<string, string>> = {};

    type Extra = Record<string, string> | (() => Record<string, string>);

    const resolve = (extra: Extra): Record<string, string> => (typeof extra === "function" ? extra() : extra);
    const lazy = (name: string, more: Record<string, string> = {}): Extra => (): Record<string, string> => { return { ...environments[name], ...more }; };

    beforeAll(() => {
        harness.setup("vis-status-parity-");

        paths.fakes = mkdtempSync(join(tmpdir(), "vis-status-node-"));

        const onPath = (directory: string): Record<string, string> => { return { PATH: `${directory}:${process.env["PATH"] ?? ""}` }; };

        environments["node"] = onPath(fakeNode(paths.fakes, "same", `echo v${RUNNING_NODE}`));
        environments["nightly"] = onPath(fakeNode(paths.fakes, "nightly", `echo v${RUNNING_NODE}-nightly20251126`));
        environments["bare"] = onPath(fakeNode(paths.fakes, "bare", `echo ${RUNNING_NODE}`));
        environments["failing"] = onPath(fakeNode(paths.fakes, "failing", "exit 3"));
        environments["hanging"] = onPath(fakeNode(paths.fakes, "hanging", "exec sleep 30"));
        mkdirSync(join(paths.fakes, "empty"));
        // `PATH` holds no `node` at all, so none can be asked.
        environments["absent"] = { PATH: join(paths.fakes, "empty") };
    });

    afterAll(() => {
        harness.teardown();
        rmSync(paths.fakes, { force: true, recursive: true });
    });

    describe.each([[[]], [["--json"]]])("%j", (args: string[]) => {
        // The environments are made in `beforeAll`, after these calls, so a case names one and it is looked up when it runs.
        const native = (name: string, files: Files, extra: Extra = {}): void => {
            it(`${name} matches Node and is answered natively`, () => {
                expect(harness.expectParity(workspaceFiles(files), args, resolve(extra)).stdout).not.toBe("");
            });
        };

        const delegated = (name: string, files: Files, extra: Extra = {}): void => {
            it(`${name} is handed to Node`, () => {
                harness.expectDelegation(workspaceFiles(files), args, resolve(extra));
            });
        };

        native("a workspace with no history", base());
        native("an empty workspace", {});
        native("projects with the same targets", { ...project("a"), ...project("b"), ...project("c") });
        native("a root with scripts and no pins", base());
        native("a root manifest with other fields", { "package.json": json({ name: "root", private: true, version: "1.0.0", scripts: { x: "y" }, workspaces: ["packages/*"] }), ...base() });

        native("a recorded run with cache hits", {
            ...base(),
            ...runs({ "2026-01-01.json": { stats: { cached: 1, total: 2 }, tasks: [] } }),
        });
        native("a rate that is exactly between two integers", { ...base(), ...runs({ "a.json": { stats: { cached: 1, total: 8 } } }) });
        native("a rate that rounds down", { ...base(), ...runs({ "a.json": { stats: { cached: 1, total: 3 } } }) });
        native("a rate of 100%", { ...base(), ...runs({ "a.json": { stats: { cached: 5, total: 5 } } }) });
        native("a rate of 0%", { ...base(), ...runs({ "a.json": { stats: { cached: 0, total: 5 } } }) });
        native("runs without stats, null stats and missing counts", {
            ...base(),
            ...runs({ "a.json": {}, "b.json": { stats: null }, "c.json": { stats: { total: 3 } }, "d.json": { stats: { cached: 3, total: null } }, "e.json": [], "f.json": 5, "g.json": '"text"', "h.json": "true" }),
        });
        native("more than twenty runs, of which the last twenty by name count", {
            ...base(),
            ...runs(Object.fromEntries(Array.from({ length: 23 }, (_, index) => [`${String(index).padStart(2, "0")}-run.json`, { stats: { cached: index, total: 23 } }]))),
        });
        native("file names that sort differently by case and length", {
            ...base(),
            ...runs({ "B.json": { stats: { cached: 1, total: 4 } }, "a.json": { stats: { cached: 3, total: 4 } }, "a10.json": { stats: { cached: 0, total: 4 } }, "a2.json": { stats: { cached: 4, total: 4 } }, "notes.txt": "ignored" }),
        });

        native("flaky tasks across runs", {
            ...base(),
            ...runs({
                "1.json": { stats: { cached: 0, total: 3 }, tasks: [task("a:build"), task("b:test", { exitCode: 1 }), task("a:test", { retryAttempts: 1 }), task("b:build", { cacheStatus: "HIT", exitCode: 1 })] },
                "2.json": { stats: { cached: 1, total: 3 }, tasks: [task("a:build", { exitCode: 2 }), task("b:test"), task("a:test"), task("b:build", { cacheStatus: "REMOTE_HIT", exitCode: 1 })] },
            }),
        });
        native("a null exit code counts as a failure", { ...base(), ...runs({ "1.json": { tasks: [task("a:build", { exitCode: null }), task("a:build")] } }) });
        native("tasks that ran once, passed or were skipped are not flaky", {
            ...base(),
            ...runs({ "1.json": { tasks: [task("a:build", { exitCode: 1 }), task("a:test"), task("a:test"), task("b:lint", { cacheStatus: "SKIPPED", exitCode: 1 }), task("b:lint", { cacheStatus: "SKIPPED", exitCode: 1 })] } }),
        });
        native("a summary whose tasks are not a list", { ...base(), ...runs({ "1.json": { tasks: "none" }, "2.json": { tasks: {} } }) });
        native("only the last summary of the workspace", { ...base(), ".vis/last-summary.json": json({ tasks: [task("a:build", { exitCode: 1 }), task("a:build")] }) });
        native("the last summary beside an empty runs directory", { ...base(), ".vis/runs/notes.txt": "x", ".vis/last-summary.json": json({ tasks: [task("a:build", { exitCode: 1 }), task("a:build")] }) });
        native("runs that win over the last summary", {
            ...base(),
            ...runs({ "1.json": { tasks: [] } }),
            ".vis/last-summary.json": json({ tasks: [task("a:build", { exitCode: 1 }), task("a:build")] }),
        });

        // Pins that need the running Node: the one a `node` on `PATH` prints, which is the running Node's here.
        const pinned = (name: string, files: Files): void => { native(name, files, lazy("node")); };
        const manifest = (fields: Record<string, unknown>): Files => { return { "package.json": json({ name: "root", private: true, ...fields }), ...base() }; };

        pinned("engines.node that is met", manifest({ engines: { node: ">=1" } }));
        pinned("engines.node that is not met", manifest({ engines: { node: ">=99" } }));
        pinned("engines.node with several clauses", manifest({ engines: { node: `>=${major} <${Number(major) + 1}` } }));
        pinned("engines.node as an exact version", manifest({ engines: { node: RUNNING_NODE } }));
        pinned("engines.node as another version", manifest({ engines: { node: "1.2.3" } }));
        pinned("an engines.node range it does not read", manifest({ engines: { node: "^99" } }));
        pinned("an empty engines.node", manifest({ engines: { node: "" } }));
        pinned("engines that is not an object", manifest({ engines: ">=99" }));
        pinned("devEngines.runtime that is met", manifest({ devEngines: { runtime: { name: "node", version: ">=1" } } }));
        pinned("devEngines.runtime that is not met", manifest({ devEngines: { runtime: { name: "node", version: ">=99" } } }));
        pinned("devEngines.runtime that is not met and ignored", manifest({ devEngines: { runtime: { name: "node", version: ">=99", onFail: "ignore" } } }));
        pinned("devEngines.runtime that is not met and an error", manifest({ devEngines: { runtime: { name: "node", version: ">=99", onFail: "error" } } }));
        pinned("devEngines.runtime that is not met and downloaded", manifest({ devEngines: { runtime: { name: "node", version: ">=99", onFail: "download" } } }));
        pinned("devEngines.runtime with an alternative that is met", manifest({ devEngines: { runtime: [{ name: "node", version: ">=99" }, { name: "node", version: ">=1" }] } }));
        pinned("devEngines.runtime with the last alternative ignored", manifest({ devEngines: { runtime: [{ name: "node", version: ">=1" }, { name: "node", version: ">=99", onFail: "ignore" }] } }));
        pinned("devEngines.runtime for another runtime", manifest({ devEngines: { runtime: { name: "bun", version: ">=99" } } }));
        pinned("devEngines that is not an object", manifest({ devEngines: "node" }));
        pinned("every Node pin at once", {
            ...manifest({ engines: { node: ">=99" }, devEngines: { runtime: { name: "node", version: ">=99" } } }),
            ".nvmrc": "1\n",
        });

        pinned("a .nvmrc with the running version", { ".nvmrc": `v${RUNNING_NODE}\n`, ...base() });
        pinned("a .nvmrc with the running major and minor", { ".nvmrc": `${major}.${minor}\n`, ...base() });
        pinned("a .nvmrc with the running major", { ".nvmrc": `${major}\n`, ...base() });
        pinned("a .nvmrc with another minor", { ".nvmrc": `${major}.${Number(minor) + 1}.0\n`, ...base() });
        pinned("a .nvmrc with another major", { ".nvmrc": `${Number(major) + 1}\n`, ...base() });
        pinned("a .nvmrc with an alias", { ".nvmrc": "lts/*\n", ...base() });
        pinned("an empty .nvmrc beside a .node-version that does not match", { ".nvmrc": "\n", ".node-version": "1\n", ...base() });
        pinned("a .nvmrc that wins over a .node-version", { ".nvmrc": `${major}\n`, ".node-version": "1\n", ...base() });
        pinned("a .node-version with another major", { ".node-version": "1.0.0\n", ...base() });
        pinned("a .node-version with the running version", { ".node-version": RUNNING_NODE, ...base() });
        pinned("a .nvmrc that is a directory beside a .node-version", { ".nvmrc/inner.txt": "x", ".node-version": "1\n", ...base() });
        pinned("a .nvmrc with padding", { ".nvmrc": `  v${major}.${minor}.${patch} \t\n\n`, ...base() });

        // The package manager pins need no Node, but the user agent of the run.
        const agent = (value: string): Record<string, string> => { return { npm_config_user_agent: value }; };

        native("a packageManager pin with the matching agent", manifest({ packageManager: "pnpm@9.0.0" }), agent("pnpm/9.0.0 npm/? node/v20.0.0 linux x64"));
        native("a packageManager pin with another version", manifest({ packageManager: "pnpm@9.0.0" }), agent("pnpm/8.15.0 npm/? node/v20.0.0"));
        native("a packageManager pin with another manager", manifest({ packageManager: "pnpm@9.0.0" }), agent("npm/10.0.0 node/v20.0.0"));
        native("a packageManager pin with an integrity suffix", manifest({ packageManager: "pnpm@9.0.0+sha512.abc" }), agent("pnpm/9.0.0"));
        native("a packageManager pin of aube", manifest({ packageManager: "aube@1.0.0" }), agent("pnpm/9.0.0"));
        native("a packageManager pin without a version", manifest({ packageManager: "pnpm" }), agent("pnpm/9.0.0"));
        native("a packageManager pin and no agent", manifest({ packageManager: "pnpm@9.0.0" }));
        native("a packageManager pin and an agent without a version", manifest({ packageManager: "pnpm@9.0.0" }), agent("pnpm"));
        native("a scoped packageManager pin", manifest({ packageManager: "@scope/pm@1.0.0" }), agent("pm/1.0.0"));
        native("an empty packageManager", manifest({ packageManager: "" }), agent("pnpm/9.0.0"));
        native("devEngines.packageManager that is met", manifest({ devEngines: { packageManager: { name: "pnpm", version: ">=9" } } }), agent("pnpm/9.1.0"));
        native("devEngines.packageManager that is not met", manifest({ devEngines: { packageManager: { name: "pnpm", version: ">=10" } } }), agent("pnpm/9.1.0"));
        native("devEngines.packageManager that is not met and an error", manifest({ devEngines: { packageManager: { name: "pnpm", version: ">=10", onFail: "error" } } }), agent("pnpm/9.1.0"));
        native("devEngines.packageManager that is not met and ignored", manifest({ devEngines: { packageManager: { name: "pnpm", version: ">=10", onFail: "ignore" } } }), agent("pnpm/9.1.0"));
        native("devEngines.packageManager for another manager", manifest({ devEngines: { packageManager: { name: "yarn", version: ">=10" } } }), agent("pnpm/9.1.0"));
        native("devEngines.packageManager with alternatives", manifest({ devEngines: { packageManager: [{ name: "yarn", version: ">=10" }, { name: "pnpm", version: ">=10" }, { name: "pnpm", version: ">=9" }] } }), agent("pnpm/9.1.0"));
        native("devEngines.packageManager and no agent", manifest({ devEngines: { packageManager: { name: "pnpm", version: ">=10" } } }));
        native("devEngines.packageManager beside a packageManager pin", manifest({ packageManager: "pnpm@9.1.0", devEngines: { packageManager: { name: "pnpm", version: ">=10" } } }), agent("pnpm/9.1.0"));
        native("a user agent with several slashes", manifest({ packageManager: "a@b" }), agent("a/b/c d/e"));

        // No Node is asked when no pin needs one, so a missing `node` is no obstacle.
        native("a packageManager pin and no node on PATH", manifest({ packageManager: "pnpm@9.0.0" }), lazy("absent", agent("pnpm/9.0.0")));
        native("no pin and no node on PATH", base(), lazy("absent"));
        native("devEngines.runtime for another runtime and no node on PATH", manifest({ devEngines: { runtime: { name: "bun", version: ">=99" } } }), lazy("absent"));

        // A binary the launcher started was told the version of its own Node, so it asks no `node`.
        native("a Node pin and the version the launcher reports", manifest({ engines: { node: ">=99" } }), () => {
            return {
                ...environments["absent"],
                VIS_HANDOFF: "launcher",
                VIS_NODE_VERSION: `v${RUNNING_NODE}`,
            };
        });
        delegated("a Node pin and a launcher version that is a pre-release", manifest({ engines: { node: ">=18" } }), () => {
            return {
                ...environments["absent"],
                VIS_HANDOFF: "launcher",
                VIS_NODE_VERSION: `v${RUNNING_NODE}-nightly1`,
            };
        });

        // The Node a pin needs cannot be learned: hand the run to Node before anything is printed.
        const pin = manifest({ engines: { node: ">=18" } });

        delegated("a Node pin and no node on PATH", pin, lazy("absent"));
        delegated("a Node pin and a node that prints a pre-release", pin, lazy("nightly"));
        delegated("a Node pin and a node that prints no v", pin, lazy("bare"));
        delegated("a Node pin and a node that fails", pin, lazy("failing"));
        delegated("a .nvmrc and no node on PATH", { ".nvmrc": "20\n", ...base() }, lazy("absent"));
        delegated("devEngines.runtime and no node on PATH", manifest({ devEngines: { runtime: { name: "node", version: ">=18" } } }), lazy("absent"));
        delegated("a Node pin and a node that does not answer in time", pin, lazy("hanging"));
        delegated("an engines.node that is a number", manifest({ engines: { node: 18 } }), lazy("node"));
        delegated("an engines.node range that is not ASCII", manifest({ engines: { node: ">=1\u00A0<99" } }), lazy("node"));
        delegated("a .nvmrc that is not ASCII", { ".nvmrc": "20\u00A0\n", ...base() }, lazy("node"));
        delegated("a packageManager that is a number", manifest({ packageManager: 9 }), { ...agent("pnpm/9.0.0") });
        delegated("a user agent that is not plain", manifest({ packageManager: "pnpm@9.0.0" }), agent("pnpm/9.0.0\t1"));
        delegated("a manifest that is not an object", { "package.json": "[]" });
        delegated("a vis.config.ts", { "vis.config.ts": "export default {};\n", ...base() });
        delegated("a project without scripts", { ...base(), ...project("c", { scripts: undefined }) });
        delegated("a project with an inference detector", { ...base(), "packages/a/vite.config.ts": "export default {};\n" });
        delegated("a project.json", { ...base(), "packages/a/project.json": json({ name: "a" }) });
        delegated("a non-ASCII project name", { ...base(), ...project("ünï") });
        delegated("a corrupt run summary", { ...base(), ...runs({ "1.json": "{not json", "2.json": { stats: { cached: 1, total: 2 } } }) });
        delegated("a run summary with a BOM", { ...base(), ...runs({ "1.json": `${BOM}${json({ stats: { cached: 1, total: 2 } })}` }) });
        delegated("a stats count that is a string", { ...base(), ...runs({ "1.json": { stats: { cached: "1", total: 2 } } }) });
        delegated("stats that is a number", { ...base(), ...runs({ "1.json": { stats: 5 } }) });
        delegated("a retry count that is a string", { ...base(), ...runs({ "1.json": { tasks: [task("a:build", { retryAttempts: "2" }), task("a:build")] } }) });
        delegated("a task without a target", { ...base(), ...runs({ "1.json": { tasks: [{ taskId: "a:build", cacheStatus: "MISS" }, { taskId: "a:build", cacheStatus: "MISS" }] } }) });
        delegated("a null summary", { ...base(), ...runs({ "1.json": "null" }) });
        delegated("a run summary that is a directory", { ...base(), ".vis/runs/dir.json/inner.txt": "x" });
        delegated("a runs path that is a file", { ...base(), ".vis/runs": "x" });
        delegated("a non-ASCII run file name", { ...base(), ...runs({ "ü.json": { stats: { cached: 1, total: 2 } } }) });
    });

    it.each([["--json", "--json"], ["extra"], ["--json=true"], ["--format=json"], ["--json", "extra"]])("hands the arguments %j to Node", (...args) => {
        harness.expectDelegation(workspaceFiles(base()), args);
    });

    it("hands a run outside CI to Node", () => {
        harness.expectDelegation(workspaceFiles(base()), ["--json"], {}, false);
    });

    // The text view is painted by the colour library; the binary decides with the same rules as pail.
    it.each(SHORT_COLOUR_ENVIRONMENTS)("in %j the text view matches Node", (colour) => {
        harness.expectParity(workspaceFiles({ ...base(), ...runs({ "1.json": { stats: { cached: 1, total: 2 }, tasks: [task("a:build", { exitCode: 1 }), task("a:build")] } }) }), [], colour);
        harness.expectParity(workspaceFiles(base()), [], colour);
        harness.expectParity(workspaceFiles({ "package.json": json({ name: "root", private: true, engines: { node: ">=99" } }), ...base() }), [], { ...colour, ...environments["node"] });
    });

    it.each(DELEGATED_COLOUR_ENVIRONMENTS)("hands a run with %j to Node", (colour) => {
        harness.expectDelegation(workspaceFiles(base()), [], colour);
    });

    it("answers from a project directory the way Node does", () => {
        const files = workspaceFiles(base());
        const [nodeRoot, nativeRoot] = harness.pair(files);
        const node = harness.runNode(["--json"], `${nodeRoot}/packages/a`);
        const native = harness.runNative(["--json"], `${nativeRoot}/packages/a`);

        expect(native.status, native.stderr).not.toBe(70);
        expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
    });
});
