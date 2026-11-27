import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS, withoutColour } from "./colour-environments";

/**
 * `vis task-why` exists twice: the Node handler (`src/commands/task-why/handler.ts`) and the native path
 * (`native/cli/src/task_why.rs`). The handler builds the task graph of the workspace and walks it; it never hashes a
 * file and never reads the cache, and prints ids and edges only (no command, output or cache state). In a workspace
 * of script-only JS projects without a config no target has a `dependsOn`, so every task is a root and the binary
 * prints one fixed text for a task that exists. With a literal `vis.config.ts` the binary builds the configured task
 * graph (`task_config.rs` in `task-runner-core`) and walks it as the handler does; the config shapes the builder
 * refuses, the project files and inference markers it cannot see past, and every error stay in Node. For every
 * invocation below the two must agree on stdout, stderr and the exit status, and the invocations the native path
 * declines (every error, every workspace whose graph the binary cannot reproduce, every other shape) must reach Node
 * unchanged.
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
    /** Directory links to create, by path below the workspace root; the value is the target. */
    links?: Record<string, string>;
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

/** A workspace whose root holds a literal config (`vis.config.ts`, or the `file` given) with these properties (the text between the braces), and the files of `extra`. */
const configured = (name: string, source: string, extra: Record<string, string> = {}, file = "vis.config.ts"): Workspace => {
    return { extra: { [file]: `export default { ${source} };\n`, ...extra }, name };
};

const LITERAL_TASKS = 'tasks: { build: { dependsOn: ["^build"] } }';
// Every file name the Node loader tries, with the same literal: what each prints decides which of them the binary may read.
// A `.cts` or `.cjs` file is CommonJS to Node, where `export default` is a syntax error: it prints a failure and goes on with the defaults.
const configFilesOf = (files: string[]): Workspace[] => files.map((file) => configured(`config-file-${file}`, LITERAL_TASKS, {}, file));
const CONFIG_FILES = configFilesOf(["vis.config.mts", "vis.config.js", "vis.config.mjs"]);
const COMMONJS_CONFIG_FILES = configFilesOf(["vis.config.cts", "vis.config.cjs"]);
const rootOfType = (type: string): Record<string, string> => {
    return { "package.json": manifest({ name: "root", private: true, type }) };
};
const TYPED_CONFIGS = [
    configured("config-ts-type-commonjs", LITERAL_TASKS, rootOfType("commonjs")),
    configured("config-ts-type-module", LITERAL_TASKS, rootOfType("module")),
    configured("config-js-type-module", LITERAL_TASKS, rootOfType("module"), "vis.config.js"),
    configured("config-mjs-type-commonjs", LITERAL_TASKS, rootOfType("commonjs"), "vis.config.mjs"),
];
// A `.js` file under `"type": "commonjs"` is CommonJS, so its `export default` fails to load.
const COMMONJS_TYPED_JS = [configured("config-js-type-commonjs", LITERAL_TASKS, rootOfType("commonjs"), "vis.config.js"), configured("config-js-type-unknown", LITERAL_TASKS, rootOfType("esnext"), "vis.config.js")];
// `defineConfig` is the identity function; the binary unwraps it once `@visulima/vis/config` resolves from the config, as it does in every install.
const DEFINE_CONFIG: Workspace = {
    extra: { "vis.config.ts": `import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ ${LITERAL_TASKS} });\n` },
    links: { "node_modules/@visulima/vis": packageRoot },
    name: "config-define-config",
};
const DEFINE_CONFIG_UNRESOLVED: Workspace = { extra: DEFINE_CONFIG.extra, name: "config-define-config-unresolved" };
const INFERENCE_TRUE_NO_MARKER = configured("config-inference-true", `inferTargets: true, ${LITERAL_TASKS}`);
const INFERENCE_OFF_CARGO = configured("config-inference-off-cargo", `inferTargets: false, ${LITERAL_TASKS}`, { "packages/lib/Cargo.toml": '[package]\nname = "lib"\nversion = "0.1.0"\n' });

/** `lib` with a `gen` script, for the cases whose chain depends on the order of the targets. */
const LIB_WITH_GEN = { "packages/lib/package.json": manifest({ name: "lib", scripts: { build: "echo lib", gen: "echo gen", test: "echo test" }, version: "1.0.0" }) };
/** `lib` with scripts in an order that is not alphabetical. */
// eslint-disable-next-line perfectionist/sort-objects -- the order of the scripts in the file is what the case is about
const LIB_WITH_ORDERED_SCRIPTS = { "packages/lib/package.json": manifest({ name: "lib", scripts: { zed: "echo z", abe: "echo a", gen: "echo gen", build: "echo lib" }, version: "1.0.0" }) };

const CARET = configured("config-caret", 'tasks: { build: { dependsOn: ["^build"] } }');
const CARET_AND_SAME: Workspace = configured("config-caret-and-same", 'tasks: { test: { dependsOn: ["build", "^test"] }, build: { dependsOn: ["^build"] } }');
const DUPLICATE_EDGE = configured("config-duplicate-edge", 'tasks: { build: { dependsOn: ["^build", { target: "build", dependencies: true }] } }');
const OBJECT_FORMS = configured("config-object-forms", 'tasks: { build: { dependsOn: [{ target: "build", dependencies: true }] }, test: { dependsOn: [{ target: "build" }] } }');
const PROJECT_SELECTORS = configured("config-project-selectors", 'tasks: { test: { dependsOn: [{ target: "build", projects: ["lib", "@acme/*", "ghost"] }, { target: "lint", projects: "t??l" }] } }');
const UNMATCHED_SELECTOR = configured("config-unmatched-selector", 'tasks: { build: { dependsOn: [{ target: "gen", projects: ["ghost", "nope-*"] }, { target: "build", projects: [] }] } }');
const COMMAND_DEFAULT = configured("config-command-default", 'tasks: { check: { command: "echo check", dependsOn: ["build"] }, build: { command: "echo other" } }');
const COMMAND_ORDER = configured("config-command-order", 'tasks: { zeta: { command: "echo z", dependsOn: ["gen"] }, alpha: { command: "echo a", dependsOn: ["gen"] } }', LIB_WITH_GEN);
const SCRIPT_ORDER = configured("config-script-order", 'tasks: { abe: { dependsOn: ["gen"] }, zed: { dependsOn: ["gen"] } }', LIB_WITH_ORDERED_SCRIPTS);
const CARRIED_FIELDS = configured(
    "config-carried-fields",
    'tasks: { build: { cache: false, dependsOn: ["^build"], description: "builds", inputs: ["src/**"], outputs: ["{projectRoot}/dist/**", "{projectName}.log", { auto: true }] }, test: { cache: true, outputs: ["coverage"] } }',
);
const SELF_EMPTY = configured("config-empty", "");
const INFERENCE_OFF = configured("config-inference-off", 'inferTargets: false, tasks: { build: { dependsOn: ["^build"] } }', { "packages/lib/vite.config.ts": "export default {};\n" });
const INFERENCE_OFF_DEPENDENCY = configured("config-inference-off-dependency", 'inferTargets: false, tasks: { build: { dependsOn: ["^build"] } }', {
    "packages/lib/package.json": manifest({ devDependencies: { vitest: "1.0.0" }, name: "lib", scripts: { build: "echo lib", test: "echo test" }, version: "1.0.0" }),
});
const INFERENCE_ON_MARKER = configured("config-inference-marker", 'tasks: { build: { dependsOn: ["^build"] } }', { "packages/lib/vite.config.ts": "export default {};\n" });
const INFERENCE_ON_DEPENDENCY = configured("config-inference-dependency", 'tasks: { build: { dependsOn: ["^build"] } }', {
    "packages/lib/package.json": manifest({ devDependencies: { typescript: "5.0.0" }, name: "lib", scripts: { build: "echo lib", test: "echo test" }, version: "1.0.0" }),
});
const INFERENCE_EXPLICIT_TRUE = configured("config-inference-true-marker", 'inferTargets: true, tasks: { build: { dependsOn: ["^build"] } }', { "packages/lib/vite.config.ts": "export default {};\n" });
const REFUSED_TARGET_KEY = configured("config-refused-target-key", 'tasks: { build: { dependsOn: ["^build"], options: { watch: true } } }');
const REFUSED_CONFIG_KEY = configured("config-refused-config-key", 'fileGroups: { src: ["src/**"] }, tasks: { build: { dependsOn: ["^build"] } }');
const REFUSED_GROUP = configured("config-refused-group", 'tasks: { build: { dependsOn: [{ group: "ci" }] } }');
const REFUSED_EXTENDS = configured("config-refused-extends", 'extends: ["./other.ts"], tasks: { build: { dependsOn: ["^build"] } }');
const REFUSED_TOKEN_NAME = configured("config-refused-index-key", 'tasks: { 1: { command: "echo one" } }');
const REJECTED_DEPENDS_ON = configured("config-rejected-depends-on", 'tasks: { build: { dependsOn: ["src/**"] } }');
const CYCLE = configured("config-cycle", 'tasks: { lint: { dependsOn: ["test"] }, test: { dependsOn: ["lint"] } }');
const DYNAMIC_CONFIG: Workspace = { extra: { "vis.config.ts": 'const target = ["^", "build"].join("");\nexport default { tasks: { build: { dependsOn: [target] } } };\n' }, name: "config-dynamic" };
const CONFIG_AND_JSON: Workspace = { extra: { "vis.config.json": manifest({ tasks: { build: { dependsOn: ["^build"] } } }), "vis.config.ts": 'export default { tasks: { build: { dependsOn: ["^build"] } } };\n' }, name: "config-and-json" };
const CONFIG_WITH_PROJECT_JSON = configured("config-project-json", 'tasks: { build: { dependsOn: ["^build"] } }', {
    "packages/lib/project.json": manifest({ name: "lib", targets: { build: { dependsOn: ["^build", "gen"] } } }),
});
const CONFIG_WITH_OVERLAY = configured("config-overlay", 'tasks: { build: { dependsOn: ["^build"] } }', {
    "packages/app/vis.task.ts": 'export default { tasks: { build: { dependsOn: ["lib:test"] } } };\n',
});
const CONFIG_WITH_ROOT_PROJECT_JSON = configured("config-root-project-json", 'tasks: { build: { dependsOn: ["^build"] } }', { "project.json": manifest({ name: "root" }) });
const CONFIG_WITH_COLON_NAME = configured("config-colon-project-name", 'tasks: { build: { dependsOn: ["^build"] } }', {
    "packages/colon/package.json": manifest({ name: "co:lon", scripts: { build: "echo colon" }, version: "1.0.0" }),
});
const CONFIG_WITH_ODD_SCRIPT = configured("config-odd-script-name", 'tasks: { build: { dependsOn: ["^build"] } }', {
    "packages/lib/package.json": manifest({ name: "lib", scripts: { "100%": "echo odd", build: "echo lib" }, version: "1.0.0" }),
});
const CONFIG_WITH_ROOT_SCRIPTS = configured("config-root-scripts", 'tasks: { build: { dependsOn: ["^build"] } }', {
    "package.json": manifest({ name: "root", private: true, scripts: { build: "pnpm --filter lib build", check: "echo check" } }),
});
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

    for (const [link, target] of Object.entries(workspace.links ?? {})) {
        mkdirSync(dirname(join(root, link)), { recursive: true });
        symlinkSync(target, join(root, link), "dir");
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

            // A linked `node_modules` entry is the package itself, which is not the workspace's to change and not worth walking.
            if (entry.name === "node_modules") {
                return [`${path}/ ${stats.mtimeMs}`];
            }

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

    // A literal `vis.config.ts`: the binary builds the configured graph. `^build` links a task to the same target of the projects its project depends on.
    ...["app:build", "lib:build", "web:build", "hooks:build", "@acme/scoped:build", "@acme/scoped:lint", "web:dev"].map((id) => why(id, { workspace: CARET })),
    // A same-project edge next to a caret one, over two targets.
    ...["app:test", "app:build", "lib:test", "lib:build", "web:build"].map((id) => why(id, { workspace: CARET_AND_SAME })),
    // An entry that resolves twice is listed twice under "depends on" and once under "depended on by".
    ...["app:build", "lib:build", "web:build"].map((id) => why(id, { workspace: DUPLICATE_EDGE })),
    // The object forms of `dependsOn`: `{ target, dependencies }` is `^target`, `{ target }` is the same project.
    ...["app:build", "lib:build", "app:test", "lib:test"].map((id) => why(id, { workspace: OBJECT_FORMS })),
    // `projects`: an exact name, a glob over the names (`*` crosses `/`), and a selector that matches nothing, which is no edge and prints nothing.
    ...["app:test", "lib:build", "lib:test", "@acme/scoped:build"].map((id) => why(id, { workspace: PROJECT_SELECTORS })),
    ...["app:build", "lib:build", "web:build"].map((id) => why(id, { workspace: UNMATCHED_SELECTOR })),
    // A default with a `command` is a target of every project, a script-less one included, and its command wins over the script's.
    ...["tool:check", "tool:build", "app:check", "app:build", "lib:check", "lib:build", "web:check"].map((id) => why(id, { workspace: COMMAND_DEFAULT })),
    // Order: the targets a `command` adds come in the order of the `tasks` keys (zeta first, which sorting would turn around), and the scripts in the order of the file.
    ...["lib:gen", "lib:zeta", "lib:alpha", "app:zeta", "tool:alpha"].map((id) => why(id, { workspace: COMMAND_ORDER })),
    ...["lib:gen", "lib:zed", "lib:abe"].map((id) => why(id, { workspace: SCRIPT_ORDER })),
    // `cache`, `outputs` (with tokens and `{ auto }`), `inputs` and `description` are read and change nothing `task-why` prints.
    ...["app:build", "lib:build", "app:test", "lib:test"].map((id) => why(id, { workspace: CARRIED_FIELDS })),
    ...["app:build", "web:dev", "@acme/scoped:lint"].map((id) => why(id, { workspace: SELF_EMPTY })),
    // Inference: `inferTargets: false` makes a marker, or a fallback dependency, irrelevant.
    ...["lib:build", "app:build"].map((id) => why(id, { workspace: INFERENCE_OFF })),
    ...["lib:test", "app:build"].map((id) => why(id, { workspace: INFERENCE_OFF_DEPENDENCY })),
    // `inferTargets: true` with nothing to infer is the same graph.
    ...["app:build", "lib:build"].map((id) => why(id, { workspace: INFERENCE_TRUE_NO_MARKER })),
    // The config file names, `defineConfig`, and the one whose module does not resolve (Node cannot load it: its error is Node's).
    ...CONFIG_FILES.map((workspace) => why("app:build", { workspace })),
    ...COMMONJS_CONFIG_FILES.map((workspace) => declined(["task-why", "app:build"], { workspace })),
    // The `type` of the root `package.json` decides how Node reads a `.js` file.
    ...TYPED_CONFIGS.map((workspace) => why("app:build", { workspace })),
    ...COMMONJS_TYPED_JS.map((workspace) => declined(["task-why", "app:build"], { workspace })),
    why("app:build", { workspace: DEFINE_CONFIG }),
    declined(["task-why", "app:build"], { workspace: DEFINE_CONFIG_UNRESOLVED }),
    // A manifest of another ecosystem next to `package.json` is not excused by `inferTargets: false`.
    declined(["task-why", "lib:build"], { workspace: INFERENCE_OFF_CARGO }),
    // A project the config applies to next to a root script: the root is not a project, so its scripts are no targets.
    why("web:build", { workspace: CONFIG_WITH_ROOT_SCRIPTS }),
    // The output is the same in every colour environment and width, with a config too.
    ...COLOUR_ENVIRONMENTS.map((env) => why("lib:build", { env, workspace: CARET })),
    why("@acme/scoped:build", { env: { COLUMNS: "20" }, workspace: CARET }),
    why("app:build", { env: { NODE_ENV: "production" }, workspace: CARET }),

    // What the binary leaves to Node with a config: any marker while inference is on (a config file, a fallback dependency, `inferTargets: true`).
    declined(["task-why", "lib:build"], { workspace: INFERENCE_ON_MARKER }),
    declined(["task-why", "app:build"], { workspace: INFERENCE_ON_MARKER }),
    declined(["task-why", "lib:build"], { workspace: INFERENCE_ON_DEPENDENCY }),
    declined(["task-why", "lib:build"], { workspace: INFERENCE_EXPLICIT_TRUE }),
    // A key the builder does not read, at either level, and a `dependsOn` entry it does not resolve.
    declined(["task-why", "app:build"], { workspace: REFUSED_TARGET_KEY }),
    declined(["task-why", "app:build"], { workspace: REFUSED_CONFIG_KEY }),
    declined(["task-why", "app:build"], { workspace: REFUSED_GROUP }),
    declined(["task-why", "app:build"], { workspace: REFUSED_EXTENDS }),
    // A `tasks` key JavaScript would list first, whatever the file says.
    declined(["task-why", "app:1"], { workspace: REFUSED_TOKEN_NAME }),
    // What Node rejects while it loads the workspace, and a cycle.
    declined(["task-why", "app:build"], { workspace: REJECTED_DEPENDS_ON }),
    declined(["task-why", "app:lint"], { workspace: CYCLE }),
    // A config that is not a literal, one that has a `.json` twin, and every file that overlays a project or makes the root one.
    declined(["task-why", "app:build"], { workspace: DYNAMIC_CONFIG }),
    declined(["task-why", "app:build"], { workspace: CONFIG_AND_JSON }),
    declined(["task-why", "lib:build"], { workspace: CONFIG_WITH_PROJECT_JSON }),
    declined(["task-why", "app:build"], { workspace: CONFIG_WITH_PROJECT_JSON }),
    declined(["task-why", "app:build"], { workspace: CONFIG_WITH_OVERLAY }),
    declined(["task-why", "app:build"], { workspace: CONFIG_WITH_ROOT_PROJECT_JSON }),
    // A name the output cannot print the way the logger does, or that makes two ids collide.
    declined(["task-why", "lib:build"], { workspace: CONFIG_WITH_COLON_NAME }),
    declined(["task-why", "lib:build"], { workspace: CONFIG_WITH_ODD_SCRIPT }),
    // An unknown project or target is Node's error, with a config too.
    ...["app:missing", "missing:build", "tool:build", "constructor:build", "app:toString", "root:build"].map((id) => declined(["task-why", id], { workspace: CARET })),
    // `tool` has no script and the config adds no target to it, while a `command` default would (see `config-command-default`).
    declined(["task-why", "tool:test"], { workspace: PROJECT_SELECTORS }),
    declined(["task-why", "root:check"], { workspace: CONFIG_WITH_ROOT_SCRIPTS }),
    declined(["task-why", "app:build:ci"], { workspace: CARET }),
    // The context rules hold with a config: outside CI, a settings variable, and a working directory below the root go to Node.
    declined(["task-why", "app:build"], { notCi: true, workspace: CARET }),
    declined(["task-why", "app:build"], { env: { NODE_ENV: "test" }, workspace: CARET }),
    declined(["task-why", "app:build"], { env: { DEBUG: "1" }, workspace: CARET }),
    declined(["task-why", "app:build"], { directory: "packages/app", workspace: CARET }),
    ...DELEGATED_COLOUR_ENVIRONMENTS.map((env) => declined(["task-why", "app:build"], { env, workspace: CARET })),
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
        const vars = environment(env ?? {}, notCi !== true);

        return { args, cwd, root, vars };
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
