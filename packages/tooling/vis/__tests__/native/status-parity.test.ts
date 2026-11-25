/* eslint-disable perfectionist/sort-objects, @stylistic/quote-props -- the key order of the fixtures is what the tests are about */
import { existsSync } from "node:fs";

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

/** Two projects: `build` and `test` on one, `build` and `lint` on the other. */
const base = (): Files => {
    return { ...project("a"), ...project("b", { scripts: { build: "tsc", lint: "eslint ." }, dependencies: { a: "workspace:*" } }) };
};

const runs = (files: Record<string, unknown>): Files => {
    return Object.fromEntries(Object.entries(files).map(([name, content]) => [`.vis/runs/${name}`, typeof content === "string" ? content : json(content)]));
};

const task = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    return { taskId: id, cacheStatus: "MISS", target: { project: id.split(":")[0], target: id.split(":")[1] }, ...extra };
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis status: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-status-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe.each([[[]], [["--json"]]])("%j", (args: string[]) => {
        const native = (name: string, files: Files, extra: Record<string, string> = {}): void => {
            it(`${name} matches Node and is answered natively`, () => {
                expect(harness.expectParity(workspaceFiles(files), args, extra).stdout).not.toBe("");
            });
        };

        const delegated = (name: string, files: Files, extra: Record<string, string> = {}): void => {
            it(`${name} is handed to Node`, () => {
                harness.expectDelegation(workspaceFiles(files), args, extra);
            });
        };

        native("a workspace with no history", base());
        native("an empty workspace", {});
        native("projects with the same targets", { ...project("a"), ...project("b"), ...project("c") });
        native("a root with scripts and no pins", base(), {});
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

        delegated("a root pinning a Node version in engines", { "package.json": json({ name: "root", private: true, engines: { node: ">=18" } }), ...base() });
        delegated("a root with devEngines", { "package.json": json({ name: "root", private: true, devEngines: { runtime: { name: "node", version: ">=18" } } }), ...base() });
        delegated("a .nvmrc", { ".nvmrc": "20\n", ...base() });
        delegated("a .node-version", { ".node-version": "20\n", ...base() });
        delegated("a vis.config.ts", { "vis.config.ts": "export default {};\n", ...base() });
        delegated("a project without scripts", { ...base(), ...project("c", { scripts: undefined }) });
        delegated("a project with an inference detector", { ...base(), "packages/a/vite.config.ts": "export default {};\n" });
        delegated("a project.json", { ...base(), "packages/a/project.json": json({ name: "a" }) });
        delegated("a non-ASCII project name", { ...base(), ...project("ünï") });
        delegated("a corrupt run summary", { ...base(), ...runs({ "1.json": "{not json", "2.json": { stats: { cached: 1, total: 2 } } }) });
        delegated("a run summary with a BOM", { ...base(), ...runs({ "1.json": `﻿${json({ stats: { cached: 1, total: 2 } })}` }) });
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
