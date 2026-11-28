import type { Files } from "./workspace-parity-harness";
import { json } from "./workspace-parity-harness";

/**
 * The workspaces with a `vis.config` that `vis graph` (`graph-parity.test.ts`) and `vis status` (`status-parity.test.ts`)
 * run on. Each case says, per command, whether the binary may answer it (`true`) or must hand it to Node before it prints
 * anything (`false`); both suites run every case through Node and through the binary and compare stdout, stderr and the
 * exit status, so a case that is answered natively and differs from Node fails, and so does one that is delegated when
 * the table says it is answered.
 *
 * The keys that may be answered natively are the ones `native/cli/src/config_workspace.rs` lists: a key without a case
 * here is not in that set.
 */

export interface ConfigCase {
    /** The files of the workspace, written over the base ones. */
    files: Files;
    /** Whether `vis graph` may answer the workspace natively. */
    graph: boolean;
    name: string;
    /** Whether `vis status` may answer the workspace natively. */
    status: boolean;
}

/** Projects with edges, an application, scripts, nested and repeated directory names, and a project that has no script. */
const baseProjects = (): Files => {
    return {
        "packages/app/package.json": json({ bin: "cli.js", dependencies: { lib: "workspace:*" }, devDependencies: { util: "workspace:*" }, name: "app", scripts: { build: "tsc", dev: "node ." }, version: "1.0.0" }),
        "packages/legacy/package.json": json({ dependencies: { util: "workspace:*" }, name: "legacy", scripts: { legacy: "echo old" }, version: "1.0.0" }),
        "packages/lib/package.json": json({ dependencies: { util: "workspace:*" }, name: "lib", scripts: { build: "tsc", test: "vitest" }, version: "1.0.0" }),
        "packages/util/package.json": json({ name: "util", scripts: { build: "tsc", lint: "eslint ." }, version: "1.0.0" }),
        "packages/x/legacy/package.json": json({ name: "nested-legacy", scripts: { nested: "echo nested" }, version: "1.0.0" }),
        "tools/gen/package.json": json({ dependencies: { lib: "workspace:*" }, name: "gen", scripts: { gen: "node gen.js" }, version: "1.0.0" }),
    };
};

const WORKSPACE = 'packages:\n  - "packages/**"\n  - "tools/*"\n';

/** The files of a workspace of `baseProjects` with the `extra` files and the config source written over them. */
const workspace = (extra: Files = {}): Files => {
    return {
        "package.json": json({ name: "root", private: true }),
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
        "pnpm-workspace.yaml": WORKSPACE,
        ...baseProjects(),
        ...extra,
    };
};

const config = (body: string, extra: Files = {}, file = "vis.config.ts"): Files => workspace({ [file]: `export default { ${body} };\n`, ...extra });

const both = (name: string, files: Files): ConfigCase => {
    return { files, graph: true, name, status: true };
};

const neither = (name: string, files: Files): ConfigCase => {
    return { files, graph: false, name, status: false };
};

const rootOfType = (type: string): Files => {
    return { "package.json": json({ name: "root", private: true, type }) };
};

// The keys nothing on the path of the two commands reads, each with a value of the shape its type has.
const INERT_KEYS: [string, string][] = [
    ["affectedIgnore", '["dist/**"]'],
    ["ai", '{ provider: "claude" }'],
    ["branchScopedCache", "true"],
    ["codeowners", "{}"],
    ["defaultBase", '"main"'],
    ["generator", "{}"],
    ["mcpPromote", "{ enabled: false }"],
    ["namedInputs", '{ src: ["src/**"] }'],
    ["preflight", "{}"],
    ["sharedWorktreeCache", "true"],
    ["sponsor", "{ enabled: false }"],
    ["strictEnv", "true"],
    ["tui", "{ autoExit: true }"],
];

// Keys that change how the config loads, which hooks run, or which targets exist, or that were never shown to be harmless.
const REFUSED_KEYS: [string, string][] = [
    ["fileGroups", '{ src: ["src/**"] }'],
    ["taskGroups", '{ ci: ["build"] }'],
    ["scopedTasks", "[{ tasks: { build: { cache: false } } }]"],
    ["plugins", "[]"],
    ["install", '{ backend: "pnpm" }'],
    ["security", "{}"],
    ["runtime", '"node"'],
    ["extends", '"./base.ts"'],
    ["update", '{ target: "minor" }'],
    ["toolchain", "{}"],
    ["versionConstraint", '">=0.0.1"'],
    ["taskRunner", "{ parallel: 2 }"],
    ["lint", "{}"],
    ["fmt", "{}"],
    ["staged", "{}"],
];

const DISCOVER_KEYS = ["composer", "dart", "gem", "go", "gradle", "hex", "maven", "nuget", "python", "swift", "zig"];

export const CONFIG_CASES: ConfigCase[] = [
    both("an empty config", config("")),
    both("a config with $schema", config('$schema: "./node_modules/@visulima/vis/schemas/vis-config.schema.json"')),
    ...INERT_KEYS.map(([key, value]) => both(`the harmless key ${key}`, config(`${key}: ${value}`))),
    both("several harmless keys at once", config('sponsor: { enabled: false }, defaultBase: "main", strictEnv: true, tui: { autoExit: 5 }')),
    ...REFUSED_KEYS.map(([key, value]) => neither(`the refused key ${key}`, config(`${key}: ${value}`, key === "extends" ? { "base.ts": "export default {};\n" } : {}))),
    neither("a refused key beside a harmless one", config('sponsor: { enabled: false }, fileGroups: { src: ["src/**"] }')),
    neither("a key nobody has shown to be harmless", config("somethingNew: 1")),
    // `constraints` is read by `status` (its violations are counted) and by nothing the graph prints.
    { files: config("constraints: { rules: [] }"), graph: true, name: "constraints", status: false },

    // `tasks` and `inferTargets` change the targets, which `status` counts and the graph does not print.
    both("tasks with a dependsOn", config('tasks: { build: { dependsOn: ["^build"] } }')),
    both("tasks that bring a command", config('tasks: { check: { command: "echo check", dependsOn: ["build"] }, build: { cache: false } }')),
    both("tasks with outputs, inputs and a description", config('tasks: { build: { outputs: ["dist/**", { auto: true }], inputs: ["src/**"], description: "builds" } }')),
    both("inferTargets: false", config("inferTargets: false")),
    both("inferTargets: true", config("inferTargets: true")),
    neither("inferTargets as an object", config("inferTargets: { vite: false }")),
    neither("tasks with a task group", config('tasks: { build: { dependsOn: [{ group: "ci" }] } }')),
    neither("tasks with a dependsOn Node rejects", config('tasks: { build: { dependsOn: ["src/**"] } }')),
    neither("tasks with an executor", config('tasks: { build: { executor: "noop" } }')),
    neither("tasks that are not an object", config('tasks: "build"')),

    // `projectIgnore` drops directories from the project set, with the rules of the root `.gitignore`.
    both("projectIgnore of a name at any depth", config('projectIgnore: ["legacy"]')),
    both("projectIgnore of an anchored path", config('projectIgnore: ["packages/legacy"]')),
    both("projectIgnore of a directory with a trailing slash", config('projectIgnore: ["tools/"]')),
    both("projectIgnore of a directory that holds projects", config('projectIgnore: ["x"]')),
    both("projectIgnore of a project another one depends on", config('projectIgnore: ["lib"]')),
    both("projectIgnore of every project", config('projectIgnore: ["packages", "tools"]')),
    both("projectIgnore with a wildcard", config('projectIgnore: ["l*gacy", "ut?l"]')),
    both("projectIgnore of a name in another case", config('projectIgnore: ["LEGACY"]')),
    both("projectIgnore beside the root .gitignore", config('projectIgnore: ["gen"]', { ".gitignore": "legacy\n" })),
    both("an empty projectIgnore", config("projectIgnore: []")),
    both("projectIgnore that matches nothing", config('projectIgnore: ["nothing-here"]')),
    both("projectIgnore with tasks", config('projectIgnore: ["lib"], tasks: { build: { dependsOn: ["^build"] } }')),
    neither("projectIgnore that negates", config('projectIgnore: ["!lib"]')),
    neither("projectIgnore with a double star", config('projectIgnore: ["**/legacy"]')),
    neither("projectIgnore that is a string", config('projectIgnore: "legacy"')),
    neither("projectIgnore with an empty entry", config('projectIgnore: [""]')),
    neither("projectIgnore with a blank entry", config('projectIgnore: ["  "]')),
    neither("projectIgnore with a comment", config('projectIgnore: ["# legacy"]')),
    neither("projectIgnore with a number", config("projectIgnore: [1]")),
    neither("projectIgnore with a character the rules do not read", config('projectIgnore: ["a b"]')),
    neither("projectIgnore with a non-ASCII entry", config('projectIgnore: ["é"]')),
    neither("projectIgnore beside a root .gitignore the rules do not read", config('projectIgnore: ["lib"]', { ".gitignore": "!keep\n" })),

    // The `discover` flags of the non-JS ecosystems add projects that have no package.json when they are true.
    ...DISCOVER_KEYS.map((key) => both(`${key}.discover: false`, config(`${key}: { discover: false }`))),
    ...DISCOVER_KEYS.map((key) => neither(`${key}.discover: true`, config(`${key}: { discover: true }`))),
    neither("a discover flag that is not a boolean", config("python: { discover: 1 }")),
    neither("a non-JS config block with another key", config("python: { discover: false, extras: 1 }")),

    // The files Node loads, and the ones it does not.
    both("vis.config.mts", config("sponsor: { enabled: false }", {}, "vis.config.mts")),
    both("vis.config.mjs", config("sponsor: { enabled: false }", {}, "vis.config.mjs")),
    both("vis.config.js without a package type", config("sponsor: { enabled: false }", {}, "vis.config.js")),
    both("vis.config.js in a package of type module", config("sponsor: { enabled: false }", rootOfType("module"), "vis.config.js")),
    both("vis.config.ts in a package of type commonjs", config("sponsor: { enabled: false }", rootOfType("commonjs"))),
    // Node loads these as CommonJS, where `export default` is a syntax error: it prints a failure and goes on with the defaults.
    neither("vis.config.cts", config("sponsor: { enabled: false }", {}, "vis.config.cts")),
    neither("vis.config.cjs", config("sponsor: { enabled: false }", {}, "vis.config.cjs")),
    neither("vis.config.js in a package of type commonjs", config("sponsor: { enabled: false }", rootOfType("commonjs"), "vis.config.js")),
    neither("vis.config.js in a package whose type is unknown", config("sponsor: { enabled: false }", rootOfType("esnext"), "vis.config.js")),
    // Node never loads a `.json` config.
    neither("vis.config.json alone", workspace({ "vis.config.json": json({ projectIgnore: ["lib"] }) })),
    neither("vis.config.ts with a .json twin", config("sponsor: { enabled: false }", { "vis.config.json": json({}) })),

    // `defineConfig` is the identity function; the binary unwraps it once `@visulima/vis/config` resolves from the config, as it does in every
    // install. A stand-in package with that identity function resolves the same way for Node and the binary, and keeps the harness
    // (which reads the whole tree) out of the real package's own `node_modules`.
    both("defineConfig from a resolvable @visulima/vis", workspace({
        "node_modules/@visulima/vis/config.mjs": "export const defineConfig = (config) => config;\n",
        "node_modules/@visulima/vis/package.json": json({ exports: { "./config": "./config.mjs" }, name: "@visulima/vis", type: "module", version: "0.0.0" }),
        "vis.config.ts": 'import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ projectIgnore: ["legacy"], sponsor: { enabled: false } });\n',
    })),
    neither("defineConfig where @visulima/vis does not resolve", workspace({
        "vis.config.ts": 'import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ projectIgnore: ["legacy"] });\n',
    })),

    // What the binary cannot read as data.
    neither("a dynamic config", workspace({ "vis.config.ts": 'const ignored = ["le", "gacy"].join("");\nexport default { projectIgnore: [ignored] };\n' })),
    neither("a config that reads the environment", workspace({ "vis.config.ts": "export default { strictEnv: Boolean(process.env.CI) };\n" })),
    neither("a config with a spread", workspace({ "vis.config.ts": "const base = {};\nexport default { ...base, strictEnv: true };\n" })),
    neither("a config that does not parse", workspace({ "vis.config.ts": "export default { strictEnv: ;\n" })),
    neither("a config with a function export", workspace({ "vis.config.ts": "export default () => ({ strictEnv: true });\n" })),

    // `project.json` and overlays add projects, targets and edges the binary does not read.
    neither("a project.json in a project", config("sponsor: { enabled: false }", { "packages/lib/project.json": json({ name: "lib" }) })),
    neither("a project.json that names a project", config("sponsor: { enabled: false }", { "packages/lib/project.json": json({ name: "lib-renamed" }) })),
    neither("a project.json at the root", config("sponsor: { enabled: false }", { "project.json": json({ name: "root" }) })),
    neither("an overlay in a project", config("sponsor: { enabled: false }", { "packages/lib/vis.task.ts": 'export default { tasks: { build: { dependsOn: ["^build"] } } };\n' })),
    neither("a root overlay", config("sponsor: { enabled: false }", { "vis.task.ts": "export default {};\n" })),
    // With `discover` off a `Cargo.toml` in a JS project claims nothing, so the graph is unchanged; `status` counts targets, which a detector could add.
    { files: config("sponsor: { enabled: false }", { "packages/lib/Cargo.toml": '[package]\nname = "lib"\nversion = "0.1.0"\n' }), graph: true, name: "a Cargo.toml beside a package.json", status: false },

    // A workspace the membership read hands to Node whatever the config says.
    neither("a project with a name that is not ASCII", config("sponsor: { enabled: false }", { "packages/uni/package.json": json({ name: "ünï", version: "1.0.0" }) })),
    neither("two projects with one name", config("sponsor: { enabled: false }", { "packages/other/package.json": json({ name: "lib", version: "1.0.0" }) })),
    // A `packageManager` pin changes neither the projects nor the targets; `status` compares it with the running manager, which is none here.
    both("a package manager pin", config("sponsor: { enabled: false }", { "package.json": json({ name: "root", packageManager: "npm@10.0.0", private: true }) })),
    neither("a lerna file above nothing but the root", config("sponsor: { enabled: false }", { "lerna.json": json({}) })),
];

/** What only `vis graph` can answer: it prints no target, so a project that inference could give targets to is no obstacle. */
export const GRAPH_ONLY_CASES: ConfigCase[] = [
    both("a detector marker in a project", config("sponsor: { enabled: false }", { "packages/lib/vite.config.ts": "export default {};\n" })),
];

/** What `vis status` counts: targets, so a project that inference could give targets to is Node's unless inference is off. */
export const STATUS_CASES: ConfigCase[] = [
    { files: config("sponsor: { enabled: false }", { "packages/lib/vite.config.ts": "export default {};\n" }), graph: true, name: "a detector marker in a project", status: false },
    both("a detector marker in a project with inferTargets: false", config("inferTargets: false", { "packages/lib/vite.config.ts": "export default {};\n" })),
    { files: config("sponsor: { enabled: false }", { "packages/lib/package.json": json({ devDependencies: { vitest: "1.0.0" }, name: "lib", scripts: { build: "tsc" }, version: "1.0.0" }) }), graph: true, name: "a detector dependency in a project", status: false },
    both("a project without scripts", config("sponsor: { enabled: false }", { "packages/quiet/package.json": json({ name: "quiet", version: "1.0.0" }) })),
    both("a project without scripts and a default that brings a command", config('tasks: { check: { command: "echo check" } }', { "packages/quiet/package.json": json({ name: "quiet", version: "1.0.0" }) })),
    both("a script that a tasks default also names", config('tasks: { build: { command: "echo other", cache: false } }')),
    both("a tasks default for a target no project has", config('tasks: { deploy: { cache: false, dependsOn: ["build"] } }')),
    both("scripts with the same names in every project", config("sponsor: { enabled: false }", { "packages/lib/package.json": json({ name: "lib", scripts: { build: "tsc" }, version: "1.0.0" }), "packages/util/package.json": json({ name: "util", scripts: { build: "tsc" }, version: "1.0.0" }) })),
    neither("a script name that is not plain", config("sponsor: { enabled: false }", { "packages/lib/package.json": json({ name: "lib", scripts: { "100%": "echo odd" }, version: "1.0.0" }) })),
];
