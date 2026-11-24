import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS, withoutColour } from "./colour-environments";

/**
 * `vis task-why` exists twice: the Node handler (`src/commands/task-why/handler.ts`) and the native path
 * (`native/cli/src/task_why.rs`). The handler builds the task graph of the workspace and walks it; it never hashes a
 * file and never reads the cache. In a workspace of script-only JS projects without a config no target has a
 * `dependsOn`, so every task is a root and the binary prints one fixed text for a task that exists. For every
 * invocation below the two must agree on stdout, stderr and the exit status, and the invocations the native path
 * declines (every error, every workspace whose graph may have an edge, every other shape) must reach Node unchanged.
 * Node needs the built CLI (`dist/bin.js`) and the NAPI addons, the native side needs the `vis` binary, so the suite is
 * skipped when either is missing.
 *
 * Each case builds a workspace in a fresh directory outside the repository, because the binary reads its own location
 * and Node's root search must stop at the copy. Both sides run in an environment built from scratch (no colour
 * variable of the machine leaks in), with `VIS_CLI_TEST` set so that Node prints no random tip or notice.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");

let scratch: string;
// A copy outside the package: a binary inside it reads its own location and hands declined
// invocations to `dist/bin.js` itself, which would make the native path look like it answered.
let nativeBinary: string;
let counter: number;

const write = (root: string, file: string, content: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
};

const manifest = (value: Record<string, unknown>): string => JSON.stringify(value, undefined, 2);

/** The files of a workspace the native path accepts: a pnpm workspace, scripts only, no config, packages that depend on each other. */
const baseFiles = (): Record<string, string> => {
    return {
        "apps/web/package.json": manifest({ bin: "bin.js", dependencies: { "@acme/scoped": "workspace:*", lib: "workspace:*" }, name: "web", scripts: { build: "echo web", dev: "echo dev" }, version: "1.0.0" }),
        "package.json": manifest({ name: "root", private: true }),
        "packages/app/package.json": manifest({
            dependencies: { lib: "workspace:*" },
            devDependencies: { tool: "workspace:*" },
            name: "app",
            scripts: { build: "echo app", "build:ci": "echo ci", lint: "echo lint", test: "echo test" },
            version: "1.0.0",
        }),
        "packages/hooks/package.json": manifest({ name: "hooks", scripts: { build: "echo build", postbuild: "echo post", prebuild: "echo pre" }, version: "1.0.0" }),
        "packages/lib/package.json": manifest({ name: "lib", scripts: { build: "echo lib", test: "echo test" }, version: "1.0.0" }),
        "packages/long/package.json": manifest({ name: "@acme/a-package-with-a-name-that-is-longer-than-the-terminal-is-wide", scripts: { build: "echo long" }, version: "1.0.0" }),
        "packages/scoped/package.json": manifest({ name: "@acme/scoped", scripts: { build: "echo scoped", lint: "echo lint" }, version: "1.0.0" }),
        "packages/tool/package.json": manifest({ name: "tool", version: "1.0.0" }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
    };
};

/** A workspace of the base files with the files of `extra` written over them. */
interface Workspace {
    extra?: Record<string, string>;
    name: string;
}

const PLAIN: Workspace = { name: "plain" };
const WITH_DEPENDS_ON: Workspace = {
    extra: { "packages/app/project.json": manifest({ name: "app", targets: { build: { dependsOn: ["^build"] } } }) },
    name: "project-json-depends-on",
};
const WITH_OVERLAY: Workspace = {
    extra: { "packages/app/vis.task.json": manifest({ tasks: { build: { dependsOn: ["lib:build"] } } }) },
    name: "overlay-depends-on",
};
const WITH_CONFIG: Workspace = { extra: { "vis.config.json": manifest({ tasks: { build: { dependsOn: ["^build"] } } }) }, name: "config-depends-on" };
const WITH_INFERENCE: Workspace = { extra: { "packages/lib/vite.config.ts": "export default {};\n" }, name: "inference-marker" };
const WITH_ROOT_SCRIPTS: Workspace = {
    extra: { "package.json": manifest({ name: "root", private: true, scripts: { build: "pnpm --filter lib build", check: "echo check" } }) },
    name: "root-scripts",
};
const WITH_NPM_MANAGER: Workspace = { extra: { "package.json": manifest({ name: "root", packageManager: "npm@10.0.0", private: true }) }, name: "package-manager-field" };
const WITH_DUPLICATE_NAME: Workspace = { extra: { "packages/other/package.json": manifest({ name: "lib", scripts: { build: "echo other" }, version: "1.0.0" }) }, name: "duplicate-name" };
const WITH_BROKEN_MANIFEST: Workspace = { extra: { "packages/broken/package.json": "{ not json" }, name: "broken-manifest" };
const WITH_PROTOTYPE_NAME: Workspace = { extra: { "packages/proto/package.json": manifest({ name: "constructor", scripts: { build: "echo proto" }, version: "1.0.0" }) }, name: "prototype-name" };
const WITHOUT_LOCKFILE: Workspace = { extra: { "pnpm-lock.yaml": "" }, name: "no-lockfile" };

const workspaceFor = (workspace: Workspace): string => {
    const root = join(scratch, `${workspace.name}-${String(counter++)}`);
    const files = { ...baseFiles(), ...workspace.extra };

    for (const [file, content] of Object.entries(files)) {
        write(root, file, content);
    }

    if (workspace === WITHOUT_LOCKFILE) {
        rmSync(join(root, "pnpm-lock.yaml"));
    }

    return realpathSync(root);
};

/** Names of every file under `root` with its size and mtime, so any write shows up. */
const snapshot = (root: string, relative = ""): string[] => {
    const directory = join(root, relative);

    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory, { withFileTypes: true })
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => {
            const path = join(relative, entry.name);
            const stats = statSync(join(root, path));

            return entry.isDirectory() ? [`${path}/ ${stats.mtimeMs}`, ...snapshot(root, path)] : [`${path} ${stats.size} ${stats.mtimeMs}`];
        });
};

const home = mkdtempSync(join(tmpdir(), "vis-task-why-home-"));

/** An environment built from scratch: the colour variables of the machine must not leak into either side. */
const environment = (extra: Record<string, string> = {}, ci = true): Record<string, string> => {
    const base: Record<string, string> = { HOME: home, PATH: process.env["PATH"] ?? "", VIS_CLI_TEST: "1", VIS_NO_UPDATE_CHECK: "1" };

    // Lets a checkout that keeps the task-runner addon elsewhere run the Node side.
    if (process.env["NAPI_RS_NATIVE_LIBRARY_PATH"]) {
        base["NAPI_RS_NATIVE_LIBRARY_PATH"] = process.env["NAPI_RS_NATIVE_LIBRARY_PATH"];
    }

    return { ...withoutColour(base), ...(ci ? { CI: "1" } : {}), ...extra };
};

/** Replaces the workspace root, the clock and the process id in the Node runtime's own warnings and in the stack traces, which differ between runs. */
const normalize = (text: string, root: string): string =>
    text
        .replaceAll(root, "<ROOT>")
        .replaceAll(packageRoot, "<PACKAGE>")
        .replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS")
        .replaceAll(/\(node:\d+\)/g, "(node:PID)");

interface Case {
    args: string[];
    /** The native path must decline the call, so the binary has to hand it to Node. */
    delegates?: boolean;
    /** A directory below the workspace root to run in. */
    directory?: string;
    /** Extra environment for both engines. */
    env?: Record<string, string>;
    /** Run outside a CI context. */
    notCi?: boolean;
    workspace?: Workspace;
}

const why = (id: string, rest: Omit<Case, "args"> = {}): Case => {
    return { args: ["task-why", id], ...rest };
};

const declined = (args: string[], rest: Omit<Case, "args" | "delegates"> = {}): Case => {
    return { args, delegates: true, ...rest };
};

const cases: Case[] = [
    // Every task that exists in the plain workspace, each of them a root with nothing upstream.
    ...["app:build", "app:lint", "app:test", "lib:build", "lib:test", "@acme/scoped:build", "@acme/scoped:lint", "web:build", "web:dev", "hooks:prebuild", "hooks:build", "hooks:postbuild"].map((id) => why(id)),
    // A target that has a colon of its own: the handler splits at the first colon and finds the task by its whole id.
    declined(["task-why", "app:build:ci"]),
    declined(["task-why", "lib:build:ci"]),
    // The `task-why` output is the same in every colour environment and width, and under the test marker of the suite.
    ...COLOUR_ENVIRONMENTS.map((env) => why("app:build", { env })),
    why("@acme/scoped:build", { env: { COLUMNS: "20" } }),
    why("app:build", { env: { COLUMNS: "200" } }),
    why("@acme/a-package-with-a-name-that-is-longer-than-the-terminal-is-wide:build", { env: { COLUMNS: "40" } }),
    why("@acme/a-package-with-a-name-that-is-longer-than-the-terminal-is-wide:build", { env: { COLUMNS: "60", GITHUB_ACTIONS: "true" } }),
    why("app:build", { env: { NODE_ENV: "production" } }),
    // Node prints a warning with its process id when both are set, so that run is Node's.
    ...DELEGATED_COLOUR_ENVIRONMENTS.map((env) => declined(["task-why", "app:build"], { env })),
    // Errors: Node prints a stack trace on stderr and exits 1; the binary never prints one.
    declined(["task-why", "app:missing"]),
    declined(["task-why", "missing:build"]),
    declined(["task-why", "tool:build"]),
    declined(["task-why", "app"]),
    declined(["task-why", ":build"]),
    declined(["task-why", "app:"]),
    declined(["task-why", "a:b:c"]),
    declined(["task-why"]),
    declined(["task-why", "constructor:build"]),
    declined(["task-why", "toString:build"]),
    declined(["task-why", "app:toString"]),
    declined(["task-why", "root:build"]),
    // Shapes the binary does not take.
    declined(["task-why", "app:build", "lib:build"]),
    declined(["task-why", "app:build", "--json"]),
    declined(["task-why", "--json", "app:build"]),
    declined(["task-why", "--task-id", "app:build"]),
    declined(["task-why", "-x:build"]),
    declined(["task-why", "app:build", "--no-color"]),
    declined(["task-why", "app:build", "--color"], { env: { GITHUB_ACTIONS: "true" } }),
    declined(["task-why", "äpp:build"]),
    declined(["task-why", "app:build "]),
    declined(["task-why", ""]),
    // The context: outside CI Node may print notices, and a settings variable changes what it logs.
    declined(["task-why", "app:build"], { notCi: true }),
    declined(["task-why", "app:build"], { env: { DEBUG: "1" } }),
    declined(["task-why", "app:build"], { env: { PAIL_LOG_LEVEL: "error" } }),
    declined(["task-why", "app:build"], { env: { NODE_ENV: "test" } }),
    declined(["task-why", "app:build"], { env: { CEREBRO_OUTPUT_LEVEL: "16" } }),
    declined(["task-why", "app:build"], { directory: "packages/app" }),
    // A workspace whose graph can have an edge, or that the binary cannot read exactly: Node prints the chain, or its own answer.
    declined(["task-why", "app:build"], { workspace: WITH_DEPENDS_ON }),
    declined(["task-why", "lib:build"], { workspace: WITH_DEPENDS_ON }),
    declined(["task-why", "app:build"], { workspace: WITH_OVERLAY }),
    declined(["task-why", "lib:build"], { workspace: WITH_OVERLAY }),
    declined(["task-why", "app:build"], { workspace: WITH_CONFIG }),
    declined(["task-why", "lib:build"], { workspace: WITH_CONFIG }),
    declined(["task-why", "lib:build"], { workspace: WITH_INFERENCE }),
    declined(["task-why", "root:build"], { workspace: WITH_ROOT_SCRIPTS }),
    declined(["task-why", "root:check"], { workspace: WITH_ROOT_SCRIPTS }),
    declined(["task-why", "lib:build"], { workspace: WITH_DUPLICATE_NAME }),
    declined(["task-why", "lib:build"], { workspace: WITH_BROKEN_MANIFEST }),
    declined(["task-why", "constructor:build"], { workspace: WITH_PROTOTYPE_NAME }),
    declined(["task-why", "app:build"], { workspace: WITHOUT_LOCKFILE }),
    // The `packageManager` field changes nothing the command reads.
    why("app:build", { workspace: WITH_NPM_MANAGER }),
    // A project other than the root, in a workspace whose root has scripts of its own.
    why("web:build", { workspace: WITH_ROOT_SCRIPTS }),
];

/**
 * Whether the Node side can run at all: the handler needs the task-runner addon, and without it every case would fail
 * instead of being skipped.
 */
const nodeAddonLoads = (): boolean => {
    if (!binary || !existsSync(nodeEntry)) {
        return false;
    }

    const probe = mkdtempSync(join(tmpdir(), "vis-task-why-probe-"));

    writeFileSync(join(probe, "package.json"), '{"name":"probe"}');

    try {
        const { stderr } = spawnSync(process.execPath, [nodeEntry, "cache", "hash", "probe:probe"], { cwd: probe, encoding: "utf8", env: environment() });

        return !stderr.includes("native addon could not be loaded");
    } finally {
        rmSync(probe, { force: true, recursive: true });
    }
};

describe.skipIf(process.platform === "win32" || !nodeAddonLoads())("vis task-why: native vs Node", () => {
    beforeAll(() => {
        counter = 0;
        scratch = mkdtempSync(join(tmpdir(), "vis-task-why-parity-"));
        nativeBinary = join(scratch, "bin", "vis");

        mkdirSync(join(scratch, "bin"));
        copyFileSync(binary as string, nativeBinary);
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
        rmSync(home, { force: true, recursive: true });
    });

    const prepare = ({ args, directory, env, notCi, workspace }: Case) => {
        const root = workspaceFor(workspace ?? PLAIN);
        const cwd = directory === undefined ? root : join(root, directory);
        const extra = env ?? {};
        const vars = environment(extra, notCi !== true);

        return { args, cwd, extra, root, vars };
    };

    const label = (entry: Case): string => `${JSON.stringify(entry.args)} (${entry.workspace?.name ?? "plain"}${entry.directory ? `, in ${entry.directory}` : ""}${entry.notCi ? ", not CI" : ""}${entry.env ? `, ${JSON.stringify(entry.env)}` : ""})`;

    it.each(cases.filter((entry) => !entry.delegates).map((entry) => [label(entry), entry] as const))(
        "prints what Node prints, without delegating: %s",
        (_label: string, entry: Case) => {
            expect.assertions(5);

            const { args, cwd, root, vars } = prepare(entry);
            const node = spawnSync(process.execPath, [nodeEntry, ...args], { cwd, encoding: "utf8", env: vars });
            const before = snapshot(root);
            // No VIS_FALLBACK_ENTRY: a declined invocation would exit 70 here instead of passing.
            const native = spawnSync(nativeBinary, args, { cwd, encoding: "utf8", env: vars });

            expect(native.status).toBe(node.status);
            expect(normalize(native.stdout, root)).toBe(normalize(node.stdout, root));
            expect(normalize(native.stderr, root)).toBe(normalize(node.stderr, root));
            // The answer is a task of the graph, not an error.
            expect(node.status).toBe(0);
            // The command reads the workspace and writes nothing.
            expect(snapshot(root)).toStrictEqual(before);
        },
    );

    it.each(cases.filter((entry) => entry.delegates).map((entry) => [label(entry), entry] as const))("hands the call to Node, which prints it: %s", (_label: string, entry: Case) => {
        expect.assertions(4);

        const { args, cwd, root, vars } = prepare(entry);
        const node = spawnSync(process.execPath, [nodeEntry, ...args], { cwd, encoding: "utf8", env: vars });
        // Without a fallback entry a declined call cannot reach Node and fails with exit 70.
        const bare = spawnSync(nativeBinary, args, { cwd, encoding: "utf8", env: vars });
        const native = spawnSync(nativeBinary, args, { cwd, encoding: "utf8", env: { ...vars, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath } });

        expect(bare.status).toBe(70);
        expect(native.status).toBe(node.status);
        expect(normalize(native.stdout, root)).toBe(normalize(node.stdout, root));
        expect(normalize(native.stderr, root)).toBe(normalize(node.stderr, root));
    });
});
