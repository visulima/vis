import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files } from "./workspace-parity-harness";
import { binary, Harness, json, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis security sync` exists twice: the Node handler (`src/commands/security/sync.ts`, with `syncAllowBuildsToNativeConfig` and
 * `syncMinimumReleaseAgeToNativeConfig`) and the native path (`native/cli/src/security_sync/`). The command makes no request; it
 * rewrites `pnpm-workspace.yaml` and `package.json` and prints pail lines. For every input the native path accepts it must print the
 * same text on the same streams, end with the same exit status and leave the same bytes, and the same file modes, as Node; every
 * input it declines must be handed to Node before anything is printed or written (see `workspace-parity-harness.ts` for how both are proved).
 */

const harness = new Harness(["security", "sync"]);

/** A `vis.config.ts` with the given `security` block. */
const config = (security: unknown): Files => {
    return { "vis.config.ts": `export default { security: ${JSON.stringify(security, null, 4)} };\n` };
};

const policies = (allow?: Record<string, unknown>, firstSeen?: Record<string, unknown>): Files => config({ policies: { ...(allow ? { installScripts: { allow } } : {}), ...(firstSeen ? { firstSeen } : {}) } });

const WORKSPACE = 'packages:\n  - "packages/*"\n';

const workspace = (yaml: string, files: Files = {}, manifest: Record<string, unknown> = {}): Files => workspaceFiles({ "pnpm-workspace.yaml": yaml, ...files }, manifest);

/** The modes of everything under `root`. */
const modes = (root: string): Record<string, number> => {
    const tree: Record<string, number> = {};

    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        const path = join(entry.parentPath, entry.name);

        // eslint-disable-next-line no-bitwise -- the permission bits of the mode
        tree[relative(root, path)] = lstatSync(path).mode & 0o7777;
    }

    return tree;
};

interface Options {
    args?: string[];
    extra?: Record<string, string>;
    /** Modes the files start with, by name. */
    start?: Record<string, number>;
}

/** Runs both sides on identical workspaces; the native side must answer, and everything they leave must match. */
const both = (files: Files, { args = [], extra = {}, start = {} }: Options = {}): ReturnType<Harness["runNative"]> => {
    const [nodeRoot, nativeRoot] = harness.pair(files);

    for (const root of [nodeRoot, nativeRoot]) {
        for (const [name, mode] of Object.entries(start)) {
            chmodSync(join(root, name), mode);
        }
    }

    const node = harness.runNode(args, nodeRoot, extra);
    // `VIS_DEBUG_DECLINE` makes a hand-off name the gate that declined, so a failure here says why.
    const native = harness.runNative(args, nativeRoot, { ...extra, VIS_DEBUG_DECLINE: "1" });

    expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    expect(Harness.outcome(native, nativeRoot)).toStrictEqual(Harness.outcome(node, nodeRoot));
    expect(modes(nativeRoot), "the files keep the modes Node gives them").toStrictEqual(modes(nodeRoot));

    return native;
};

const ALLOW = { "@scope/x": true, esbuild: true, sharp: true };

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis security sync: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-security-sync-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe("a full sync", () => {
        it("pushes the allow list and the age gate into a fresh workspace", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles(policies(ALLOW, { exclude: ["webpack", "@a/b"], minutes: 1440 })));

            expect(result.stdout).toContain("Syncing vis.config security settings to pnpm native config");
            expect(result.stdout).toContain("Updated pnpm-workspace.yaml minimumReleaseAgeExclude (2 entries)");
        });

        it("gives the rewritten files the mode of a new file, not the old one", () => {
            expect.hasAssertions();

            both(workspaceFiles(policies(ALLOW, { minutes: 60 })), { start: { "package.json": 0o640, "pnpm-workspace.yaml": 0o611 } });
        });

        it("replaces a symbolic link to the workspace file with a regular file, like Node", () => {
            expect.hasAssertions();

            both(workspaceFiles({ ...policies(ALLOW, { minutes: 60 }), "pnpm-workspace.yaml": { link: "real.yaml" }, "real.yaml": WORKSPACE }));
        });

        it("sorts the names the way localeCompare does", () => {
            expect.hasAssertions();

            both(workspaceFiles(policies({ "@z/z": true, a: true, A: true, "a-b": true, "a.b": true, "a/b": true, "a:b": true, a_b: true, ab: true, b: true, B: true, "it's": true, z9: false })));
        });
    });

    describe("the flags", () => {
        const files = (): Files => workspaceFiles(policies(ALLOW, { exclude: ["webpack"], minutes: 30 }));

        it.each([[["--skip-allow-builds"]], [["--skip-min-release-age"]], [["--skip-allow-builds", "--skip-min-release-age"]], [["--skip-min-release-age", "--skip-allow-builds"]]])("accepts %j", (args) => {
            expect.hasAssertions();

            both(files(), { args });
        });

        it("has nothing to sync when both are skipped", () => {
            expect.hasAssertions();
            expect(both(files(), { args: ["--skip-allow-builds", "--skip-min-release-age"] }).stdout).toContain("Nothing to sync");
        });
    });

    describe("the config", () => {
        it.each([
            ["no config", {}],
            ["a config without a security block", { "vis.config.ts": "export default {};\n" }],
            ["an empty security block", config({})],
            ["no minutes", policies(ALLOW)],
            ["minutes zero", policies(undefined, { minutes: 0 })],
            ["negative minutes", policies(undefined, { minutes: -5 })],
            ["excludes without minutes", policies(undefined, { exclude: ["a"] })],
            ["an allow list with false entries only", policies({ a: false })],
            ["an empty allow list", policies({})],
            ["a null allow list", config({ policies: { installScripts: { allow: null } } })],
        ] as [string, Files][])("answers for %s", (_name, extra) => {
            expect.hasAssertions();

            both(workspaceFiles(extra));
        });

        it("syncs the defaults when there is no security block, as Node does", () => {
            expect.hasAssertions();

            const result = both(workspaceFiles({}));

            expect(result.stderr).toBe("");
            expect(result.stdout).toContain("minimumReleaseAge not set in vis.config");
        });

        it("skips false allow entries", () => {
            expect.hasAssertions();

            both(workspaceFiles(policies({ a: true, b: false, c: true }, { minutes: 5 })));
        });
    });

    describe("pnpm-workspace.yaml", () => {
        const allowAndAge = policies({ a: true, b: true }, { exclude: ["x", "@y/z"], minutes: 10 });

        it.each([
            ["a file without a trailing newline", WORKSPACE.trimEnd()],
            ["an empty file", ""],
            ["only comments", "# nothing\n"],
            ["blocks to replace", `${WORKSPACE}allowBuilds:\n  old: true\n  b: false\nonlyBuiltDependencies:\n  - old\nminimumReleaseAge: 99\nminimumReleaseAgeExclude:\n  - old\n`],
            ["blocks below other keys", `allowBuilds:\n  a: true\nother: 1\nonlyBuiltDependencies:\n  - a\n  - b\nminimumReleaseAge: 10\nminimumReleaseAgeExclude:\n  - x\n  - '@y/z'\n`],
            ["a blank line inside a block", `${WORKSPACE}allowBuilds:\n  old: true\n\n  more: true\nonlyBuiltDependencies:\n  - old\n\n  - more\n`],
            ["a comment inside a block", `${WORKSPACE}allowBuilds:\n  old: true\n# note\n  more: true\n`],
            ["null blocks", `${WORKSPACE}allowBuilds:\nonlyBuiltDependencies:\nminimumReleaseAgeExclude:\n`],
            ["quoted keys", `allowBuilds:\n  '@scope/x': true\n  "plain": false\n  a-b: true\n`],
            ["trailing blanks after a key", `${WORKSPACE}allowBuilds:   \n  old: true\n`],
            ["a list in the other style", `onlyBuiltDependencies:\n  - zed\n  - '@scope/y'\n`],
            ["unrelated top-level scalars", `${WORKSPACE}shamefullyHoist: true\nstoreDir: ../store\n`],
        ] as [string, string][])("rewrites %s", (_name, yaml) => {
            expect.hasAssertions();

            both(workspace(yaml, allowAndAge));
        });

        it("has nothing to add when everything is there", () => {
            expect.hasAssertions();

            const aligned = `${WORKSPACE}allowBuilds:\n  a: true\n  b: true\nonlyBuiltDependencies:\n  - a\n  - b\nminimumReleaseAge: 10\nminimumReleaseAgeExclude:\n  - x\n  - '@y/z'\n`;
            const result = both(workspace(aligned, allowAndAge, { pnpm: { onlyBuiltDependencies: ["a", "b"] } }));

            expect(result.stdout).toContain("All 2 allowBuilds entries already present");
        });

        it("rewrites the age line of a spelling the allow grammar would not read", () => {
            expect.hasAssertions();

            both(workspace(`${WORKSPACE}minimumReleaseAge : 5 # minutes\nminimumReleaseAgeExclude:\n  - old\n\tmore\n`, policies(ALLOW, { minutes: 7 })), { args: ["--skip-allow-builds"] });
        });
    });

    describe("package.json", () => {
        const allowOnly = policies({ a: true, b: true });

        it.each([
            ["four-space indent", `${JSON.stringify({ name: "root", private: true }, null, 4)}\n`],
            ["a pnpm key with other settings", json({ name: "root", pnpm: { onlyBuiltDependencies: ["z"], overrides: { x: "1" } }, version: "1.0.0" })],
            ["a pnpm key without the list", json({ name: "root", pnpm: { overrides: { x: "1" } } })],
            ["a list that is not an array", json({ name: "root", pnpm: { onlyBuiltDependencies: "a" } })],
            ["a list that already has the names", json({ name: "root", pnpm: { onlyBuiltDependencies: ["b", "a", "b"] } })],
            ["no trailing newline", JSON.stringify({ name: "root" })],
            ["unicode in other fields", json({ description: `caf\u00E9 ${String.fromCodePoint(0x20_28)} \u{1F600}`, name: "root" })],
        ] as [string, string][])("merges into %s", (_name, manifest) => {
            expect.hasAssertions();

            both({ ...workspaceFiles(allowOnly), "package.json": manifest });
        });

        it("is left alone when there is none", () => {
            expect.hasAssertions();

            const files = workspaceFiles(allowOnly);

            delete files["package.json"];
            both(files);
        });
    });

    describe("what the environment decides", () => {
        const files = (): Files => workspaceFiles(policies(ALLOW, { minutes: 5 }));

        // A narrow `COLUMNS` wraps the longer lines, which the native path leaves to Node (see below).
        it.each([...SHORT_COLOUR_ENVIRONMENTS.filter((extra) => extra["COLUMNS"] === undefined), { FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }, { CI: "true", FORCE_COLOR: "3", GITHUB_ACTIONS: "true", TERM: "xterm-256color" }])("prints the same under %j", (extra) => {
            expect.hasAssertions();

            both(files(), { extra });
        });

        it.each(DELEGATED_COLOUR_ENVIRONMENTS)("hands the run to Node under %j", (extra) => {
            expect.hasAssertions();

            harness.expectDelegation(files(), [], extra);
        });

        it("hands a run outside CI to Node", () => {
            expect.hasAssertions();

            harness.expectDelegation(files(), [], {}, false);
        });

        it.each([{ COLUMNS: "40" }, { COLUMNS: "60" }])("hands the run to Node when a line would wrap under %j", (extra) => {
            expect.hasAssertions();

            harness.expectDelegation(files(), [], extra);
        });

        it.each([{ NODE_ENV: "test" }, { DEBUG: "1" }, { PAIL_LOG_LEVEL: "error" }, { LANG: "da_DK.UTF-8" }])("hands the run to Node under %j", (extra) => {
            expect.hasAssertions();

            harness.expectDelegation(files(), [], extra);
        });
    });

    describe("what the native path leaves to Node", () => {
        const files = (): Files => workspaceFiles(policies(ALLOW, { minutes: 5 }));

        it.each([
            [["--cwd", "."]],
            [["--skip-allow-builds=true"]],
            [["--skip-allow-builds", "--skip-allow-builds"]],
            [["--no-skip-allow-builds"]],
            [["extra"]],
        ])("declines the arguments %j", (args) => {
            expect.hasAssertions();

            harness.expectDelegation(files(), args);
        });

        it.each([
            ["a config Node evaluates", { "vis.config.ts": "export default { security: { policies: { firstSeen: { minutes: Number('5') } } } };\n" }],
            ["a truthy allow value that is not true", policies({ a: "yes" }, { minutes: 5 })],
            ["a number as an allow value", policies({ a: 1 })],
            ["a name with a dollar sign", policies({ "a$&": true })],
            ["a name outside ASCII", policies({ café: true })],
            ["an exclude with a dollar sign", policies(undefined, { exclude: ["a$1"], minutes: 5 })],
            ["a fractional minute count", policies(undefined, { minutes: 1.5 })],
            ["minutes as text", policies(undefined, { minutes: "10" })],
            ["a security value that is not an object", config(false)],
            ["a json config, which Node does not load", { "vis.config.json": "{}" }],
            ["a config that only Node reads", { "vis.config.ts": "export default { runtime: 'node', security: {} };\n" }],
        ] as [string, Files][])("declines %s", (_name, extra) => {
            expect.hasAssertions();

            harness.expectDelegation(workspaceFiles(extra), []);
        });

        it.each([
            ["windows line ends", WORKSPACE.replaceAll("\n", "\r\n")],
            ["a tab", `${WORKSPACE}x: 1\n\ty: 2\n`],
            ["an inline comment", `${WORKSPACE}allowBuilds:\n  a: true # why\n`],
            ["a nested map", `${WORKSPACE}catalog:\n  react:\n    version: 1\n`],
            ["text outside ASCII", `${WORKSPACE}# café\n`],
            ["an allowBuilds list", `${WORKSPACE}allowBuilds:\n  - a\n`],
            ["a flow value", `${WORKSPACE}onlyBuiltDependencies: [a]\n`],
            ["an integer-like key", `${WORKSPACE}allowBuilds:\n  123: true\n`],
        ] as [string, string][])("declines a workspace file with %s when it must read it", (_name, yaml) => {
            expect.hasAssertions();

            harness.expectDelegation(workspace(yaml, policies(ALLOW, { minutes: 5 })), []);
        });

        it("reads a workspace file outside the grammar when it only has to set the age", () => {
            expect.hasAssertions();

            both(workspace(`${WORKSPACE}catalog:\n  react:\n    version: 1\n`, policies(undefined, { minutes: 5 })));
        });

        it.each([
            ["a package.json that is not an object", "[]\n"],
            ["a package.json that does not parse", "{\n"],
            ["a package.json with a fraction", '{"name":"x","n":1.5}\n'],
            ["a pnpm key that is not an object", '{"name":"x","pnpm":"a"}\n'],
            ["a list with a number", '{"name":"x","pnpm":{"onlyBuiltDependencies":[1]}}\n'],
        ] as [string, string][])("declines %s", (_name, manifest) => {
            expect.hasAssertions();

            harness.expectDelegation({ ...workspaceFiles(policies(ALLOW)), "package.json": manifest }, []);
        });

        it("declines a workspace that is not pnpm", () => {
            expect.hasAssertions();

            harness.expectDelegation({ "package-lock.json": "{}\n", "package.json": json({ name: "root" }), ...policies(ALLOW) }, []);
        });
    });
});
