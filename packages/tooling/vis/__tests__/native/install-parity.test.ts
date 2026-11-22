import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `vis install` (no packages) exists twice: the Node handler (`src/commands/install/handler.ts`, with the
 * plugins that run around it) and the native path (`native/cli/src/install.rs`). For every fixture below the
 * two get the same arguments and the same environment, with stub package managers on `PATH` that print their
 * name and arguments. The package manager's arguments, stdout, stderr (up to the clock in pail's header) and the
 * exit code must match. The native run's Node is a stub that prints a marker and fails, so a run that quietly
 * delegated is caught: the marker must be absent exactly when the native path is expected to answer, and
 * present for every shape it must leave to Node.
 *
 * The environment is built from scratch, not filtered from the parent's: the runner's colour, CI and
 * package-manager variables (`GITHUB_ACTIONS`, `FORCE_COLOR`, `TERM`, `npm_config_user_agent`, ...) change
 * which path answers and what Node prints, so none of them may reach either side.
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

type Kind = "bun" | "npm" | "pnpm" | "yarn";

const PACKAGE = { name: "app", version: "1.0.0" };

/** Fixtures: a lockfile of one manager, and a workspace marker (a root) or not. */
const FIXTURES: Record<string, { files: Record<string, string>; kind: Kind }> = {
    "bun-root": { files: { "bun.lock": "{}\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }) }, kind: "bun" },
    "bun-single": { files: { "bun.lock": "{}\n", "package.json": JSON.stringify(PACKAGE) }, kind: "bun" },
    "npm-root": { files: { "package-lock.json": "{}\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }) }, kind: "npm" },
    "npm-single": { files: { "package-lock.json": "{}\n", "package.json": JSON.stringify(PACKAGE) }, kind: "npm" },
    "pnpm-bare": { files: { "package.json": JSON.stringify(PACKAGE) }, kind: "pnpm" },
    "pnpm-root": { files: { "package.json": JSON.stringify(PACKAGE), "pnpm-lock.yaml": "lockfileVersion: 9\n", "pnpm-workspace.yaml": "packages: []\n" }, kind: "pnpm" },
    "pnpm-single": { files: { "package.json": JSON.stringify(PACKAGE), "pnpm-lock.yaml": "lockfileVersion: 9\n" }, kind: "pnpm" },
    "yarn-berry-root": {
        files: { ".yarnrc.yml": "nodeLinker: node-modules\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }), "yarn.lock": "# yarn lockfile\n" },
        kind: "yarn",
    },
    "yarn-root": { files: { "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }), "yarn.lock": "# yarn lockfile\n" }, kind: "yarn" },
    "yarn-single": { files: { "package.json": JSON.stringify(PACKAGE), "yarn.lock": "# yarn lockfile\n" }, kind: "yarn" },
};

let scratch = "";
let nativeBinary = "";
let counter = 0;

const STUBS = ["bun", "npm", "pnpm", "yarn"] as const;

// Prints `<name>:<arguments>` on stdout, then whatever the case asks for: a line on stderr, a line on stdout,
// an exit code. The knobs come from the environment the case passes to both sides.
const stubSource = (name: string): string =>
    [
        "#!/bin/sh",
        `echo "${name}:$*"`,
        'if [ -n "$STUB_STDERR" ]; then echo "$STUB_STDERR" >&2; fi',
        'if [ -n "$STUB_STDOUT" ]; then echo "$STUB_STDOUT"; fi',
        'if [ -n "$STUB_ENV" ]; then env | grep -E "^(CEREBRO_|VIS_MONOREPO_ROOT)" | sort; fi',
        'exit "${STUB_EXIT:-0}"',
        "",
    ].join("\n");

interface Setup {
    bindir: string;
    cwd: string;
    home: string;
}

/** A fresh project from a fixture, plus a bin directory with a stub for each manager. */
const project = (fixture: string, extra: Record<string, string> = {}, directory?: string): Setup => {
    const root = join(scratch, `${fixture}-${String(counter++)}`);
    const base = join(root, "project");
    const bindir = join(root, "bin");
    const home = join(root, "home");
    const cwd = directory === undefined ? base : join(base, directory);

    for (const folder of [base, bindir, home, cwd]) {
        mkdirSync(folder, { recursive: true });
    }

    for (const [name, content] of Object.entries({ ...(FIXTURES[fixture] as (typeof FIXTURES)[string]).files, ...extra })) {
        mkdirSync(dirname(join(base, name)), { recursive: true });
        writeFileSync(join(base, name), content);
    }

    for (const name of STUBS) {
        writeFileSync(join(bindir, name), stubSource(name));
        chmodSync(join(bindir, name), 0o755);
    }

    // The native side hands what it declines to this one.
    writeFileSync(join(bindir, "node"), `#!/bin/sh\necho ${marker}\nexit 99\n`);
    chmodSync(join(bindir, "node"), 0o755);

    return { bindir, cwd, home };
};

/** The whole environment of a run: nothing is inherited. */
const environment = (setup: Setup, extra: Record<string, string> = {}, ci = true): Record<string, string> => {
    return {
        COLUMNS: "80",
        HOME: setup.home,
        PATH: `${setup.bindir}:/usr/bin:/bin`,
        VIS_NO_UPDATE_CHECK: "1",
        ...(ci ? { CI: "1" } : {}),
        ...extra,
    };
};

/** A value that takes the variable out of the environment altogether. */
const UNSET = "\0unset";

/** Environment without the variables a case unsets. */
const withoutUnset = (env: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(env).filter(([, value]) => value !== UNSET));

/** The clock in pail's header differs between runs. */
const normalize = (text: string): string => text.replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS");

interface Run {
    status: number | null;
    stderr: string;
    stdout: string;
}

const capture = (command: string, args: string[], cwd: string, env: Record<string, string>): Run => {
    const name = randomUUID();
    const out = join(scratch, `${name}.out`);
    const err = join(scratch, `${name}.err`);
    const outFd = openSync(out, "w");
    const errFd = openSync(err, "w");

    try {
        const { status } = spawnSync(command, args, { cwd, env, stdio: ["ignore", outFd, errFd] });

        return { status, stderr: normalize(readFileSync(err, "utf8")), stdout: normalize(readFileSync(out, "utf8")) };
    } finally {
        closeSync(outFd);
        closeSync(errFd);
    }
};

const runNode = (setup: Setup, args: string[], extra: Record<string, string> = {}, ci = true): Run =>
    capture(process.execPath, [nodeEntry, ...args], setup.cwd, withoutUnset(environment(setup, extra, ci)));

const runNative = (setup: Setup, args: string[], extra: Record<string, string> = {}, ci = true): Run =>
    capture(nativeBinary, args, setup.cwd, {
        ...withoutUnset(environment(setup, extra, ci)),
        VIS_FALLBACK_ENTRY: join(scratch, "no-such-entry.js"),
        VIS_NODE: join(setup.bindir, "node"),
        VIS_VERSION: version,
    });

/** Both sides run the same call. */
const both = (setup: Setup, args: string[], extra: Record<string, string> = {}): { native: Run; node: Run } => {
    return { native: runNative(setup, args, extra), node: runNode(setup, args, extra) };
};

const PEER_WARNING = "WARN  unmet peer react@18.0.0";
const PACKAGE_MANAGER_LINE = /^(bun|npm|pnpm|yarn):/m;

/** A case the native side must answer with exactly what Node prints. */
interface ParityCase {
    args: string[];
    /** Environment added to both sides. */
    env?: Record<string, string>;
    /** Files written over the fixture's. */
    files?: Record<string, string>;
    fixture: string;
    label?: string;
}

/** A case the native side must hand to Node. */
interface DelegatedCase {
    args: string[];
    /** Executables added to the bin directory, which is first on PATH. */
    bin?: string[];
    ci?: boolean;
    directory?: string;
    env?: Record<string, string>;
    files?: Record<string, string>;
    fixture: string;
    label: string;
}

const SHAPES: string[][] = [
    ["install"],
    ["i"],
    ["install", "--no-frozen-lockfile"],
    ["install", "--frozen-lockfile", "-D"],
    ["install", "--prod", "--offline"],
    ["install", "-P", "-f", "--lockfile-only"],
    ["install", "--no-optional", "--silent"],
    ["install", "-s", "-r"],
    ["install", "-r", "-w", "-F", "app"],
    ["install", "--filter=a", "--filter=b", "--dev"],
    ["install", "--run-scripts"],
    ["install", "--no-frozen-lockfile", "--lockfile-only"],
    ["install", "--force", "--no-frozen-lockfile", "--offline"],
];

const DEFINE_CONFIG = 'import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ update: { target: "minor" } });\n';

/** An installed `@visulima/vis` that exports `./config`, as the package does. */
const INSTALLED_VIS: Record<string, string> = {
    "node_modules/@visulima/vis/dist/config.js": "export const defineConfig = (config) => config;\n",
    "node_modules/@visulima/vis/package.json": JSON.stringify({ exports: { "./config": "./dist/config.js" }, name: "@visulima/vis", type: "module" }),
};

const manifest = (dependencies: Record<string, unknown>, field = "dependencies"): Record<string, string> => {
    return { "package.json": JSON.stringify({ ...PACKAGE, [field]: dependencies }) };
};

const PARITY_CASES: ParityCase[] = [
    ...Object.keys(FIXTURES).flatMap((fixture) => SHAPES.map((args) => { return { args, fixture }; })),
    // The security notice is printed for each manager's default setup in a root, and not for the alias.
    { args: ["install"], files: { ".npmrc": "registry=https://registry.example.test/\n" }, fixture: "npm-root", label: "an .npmrc without ignore-scripts" },
    // A config literal in the root that holds no key Node evaluates.
    { args: ["install"], files: { "vis.config.ts": 'export default { update: { target: "minor" } };\n' }, fixture: "pnpm-root", label: "a config literal" },
    { args: ["install"], files: { "vis.config.json": "{}\n" }, fixture: "pnpm-root", label: "a json config, which Node never loads" },
    { args: ["install"], files: { "vis.config.ts": "export default {};\n" }, fixture: "pnpm-single", label: "a config outside a root, which Node ignores" },
    { args: ["install"], files: { ...INSTALLED_VIS, "vis.config.ts": DEFINE_CONFIG }, fixture: "pnpm-root", label: "a defineConfig config with @visulima/vis installed" },
    // The peer-dependency hint, wrapped to COLUMNS.
    ...["pnpm-single", "pnpm-root", "npm-single", "yarn-single"].flatMap((fixture) =>
        ["80", "50", "100"].map((columns) => { return { args: ["install"], env: { COLUMNS: columns, STUB_STDERR: PEER_WARNING }, fixture, label: `peer warning at ${columns} columns` }; }),
    ),
    { args: ["install"], env: { COLUMNS: UNSET, STUB_STDERR: PEER_WARNING }, fixture: "pnpm-single", label: "peer warning with COLUMNS unset, as in CI" },
    { args: ["install"], env: { STUB_STDOUT: "Issues with peer dependencies found" }, fixture: "pnpm-single", label: "peer warning on stdout" },
    ...["npm ERR! code ERESOLVE", "warning pkg has unmet peer dependency x", "YN0060: incompatible peer", "bun: incorrect peer dependency"].map((text) => {
        return {
            args: ["install"],
            env: { STUB_STDERR: text },
            fixture: "pnpm-single",
            label: `peer pattern ${text}`,
        };
    }),
    { args: ["install", "--silent"], env: { STUB_STDERR: PEER_WARNING }, fixture: "pnpm-single", label: "peer warning, --silent" },
    { args: ["install"], env: { STUB_EXIT: "3", STUB_STDERR: PEER_WARNING }, fixture: "pnpm-single", label: "peer warning, failing manager" },
    { args: ["install"], env: { STUB_STDERR: "unmet_peer is no warning" }, fixture: "pnpm-single", label: "text that is no peer warning" },
    // What Node's startup adds to the environment the package manager runs in.
    ...["pnpm-root", "pnpm-single"].map((fixture) => { return { args: ["install"], env: { STUB_ENV: "1" }, fixture, label: "the environment the manager runs in" }; }),
    // The exit code is the package manager's.
    ...["1", "2", "130"].map((code) => { return { args: ["install"], env: { STUB_EXIT: code }, fixture: "pnpm-single", label: `exit code ${code}` }; }),
    // A scan that finds nothing, for scoped and aliased names too.
    { args: ["install"], files: manifest({ "@scope/pkg": "1.0.0", alias: "npm:real-package@^1", react: "18.0.0" }), fixture: "pnpm-single", label: "names that match no typosquat" },
    { args: ["install"], files: manifest({ "zzz-not-a-package-name": "1.0.0" }, "peerDependencies"), fixture: "pnpm-single", label: "a clean peer dependency" },
];

const DELEGATED_CASES: DelegatedCase[] = [
    // Typosquat hits in each of the four maps, by name, by scoped name and by alias.
    ...["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((field) => [
        { args: ["install"], files: manifest({ lodas: "1.0.0" }, field), fixture: "pnpm-single", label: `a typosquat in ${field}` },
        { args: ["install"], files: manifest({ ok: "npm:lodas@1.0.0" }, field), fixture: "pnpm-single", label: `an alias to a typosquat in ${field}` },
        { args: ["install"], files: manifest({ "@scope/lodas": "1.0.0" }, field), fixture: "pnpm-single", label: `a scoped typosquat in ${field}` },
    ]),
    { args: ["install"], files: { "package.json": "{ not json" }, fixture: "pnpm-single", label: "an unparsable package.json" },
    { args: ["install"], files: manifest({ a: 1 }), fixture: "pnpm-single", label: "a dependency that is no string" },
    { args: ["install"], files: { "package.json": JSON.stringify({ ...PACKAGE, dependencies: "lodash" }) }, fixture: "pnpm-single", label: "dependencies that are no map" },
    // Shapes of the command line.
    ...[
        ["install", "react"],
        ["install", "--ci"],
        ["install", "--prefer-offline"],
        ["install", "--installer", "npm"],
        ["install", "--no-aube"],
        ["install", "--no-typosquat-check"],
        ["install", "--no-marshall-check"],
        ["install", "--cwd", "."],
        ["install", "--config", "x.ts"],
        ["install", "--runtime", "node"],
        ["install", "--force", "--force"],
        ["install", "-D", "--dev"],
        ["install", "-D", "--prod"],
        ["install", "--frozen-lockfile", "--no-frozen-lockfile"],
        ["install", "-F"],
        ["install", "--filter", "-D"],
        ["install", "-Df"],
        ["install", "--force=true"],
        ["install", "--", "x"],
    ].map((args) => { return { args, fixture: "pnpm-single", label: `vis ${args.join(" ")}` }; }),
    // Contexts: outside CI, colour, Node's output settings, the environment that picks the installer.
    { args: ["install"], ci: false, fixture: "pnpm-single", label: "outside CI" },
    ...[
        { FORCE_COLOR: "1" },
        { GITHUB_ACTIONS: "true" },
        { TERM: "xterm-256color" },
        { NODE_ENV: "test" },
        { DEBUG: "*" },
        { PAIL_LOG_LEVEL: "error" },
        { CEREBRO_OUTPUT_LEVEL: "1" },
        { MARSHALL_DISABLE_ALL: "1" },
        { MARSHALL_DISABLE_TYPOSQUATS: "1" },
        { VIS_SECURITY_WARNINGS: "1" },
        { VIS_INSTALLER: "npm" },
        { VIS_RUNTIME: "node" },
        { VIS_MONOREPO_ROOT: "/elsewhere" },
        { COLUMNS: "20" },
    ].map((env) => { return { args: ["install"], env, fixture: "pnpm-single", label: `environment ${JSON.stringify(env)}` }; }),
    // Configs, pins and markers Node reads.
    ...[
        "export default { security: {} };\n",
        'export default { install: { backend: "npm" } };\n',
        'export default { runtime: "node" };\n',
        'export default { update: { target: ["m", "inor"].join("") } };\n',
    ].map((config) => { return { args: ["install"], files: { "vis.config.ts": config }, fixture: "pnpm-root", label: `the config ${config.trim()}` }; }),
    { args: ["install"], files: { "vis.config.ts": DEFINE_CONFIG }, fixture: "pnpm-root", label: "a defineConfig config before @visulima/vis is installed" },
    { args: ["install"], files: { ".npmrc": "ignore-scripts=true\n" }, fixture: "npm-root", label: "an .npmrc that mentions ignore-scripts" },
    { args: ["install"], files: { ".yarnrc.yml": "enableScripts: false\n" }, fixture: "yarn-berry-root", label: "a .yarnrc.yml that mentions enableScripts" },
    { args: ["install"], files: { "package.json": JSON.stringify({ ...PACKAGE, packageManager: "pnpm@9.0.0" }) }, fixture: "pnpm-single", label: "a packageManager pin" },
    { args: ["install"], files: { "bun.lock": "{}\n" }, fixture: "pnpm-single", label: "a bun lockfile beside another manager" },
    { args: ["install"], files: { "pnpm-lock.yaml": "lockfileVersion: 9\n" }, fixture: "npm-single", label: "two lockfile managers" },
    { args: ["install"], bin: ["aube"], fixture: "pnpm-single", label: "aube on PATH" },
    { args: ["install"], directory: "packages/app", fixture: "pnpm-root", label: "a directory below the monorepo root" },
    { args: ["install"], files: { "lerna.json": '{ "packages": [] }\n' }, fixture: "pnpm-single", label: "lerna.json" },
    { args: ["install"], files: { "turbo.json": "{}\n" }, fixture: "pnpm-single", label: "turbo.json" },
    { args: ["install"], files: { "deno.json": "{}\n" }, fixture: "pnpm-single", label: "a deno file" },
];

describe.skipIf(!ready)("vis install: native vs Node", () => {
    beforeAll(() => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-install-parity-")));
        nativeBinary = join(scratch, "vis");

        // A binary inside the package reads its own location and delegates to `dist/bin.js` itself, which
        // would make a delegation look like a native answer; a copy outside it keeps the stub in charge.
        writeFileSync(nativeBinary, readFileSync(binary as string), { mode: 0o755 });
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it.each(PARITY_CASES.map((parity) => [`${parity.fixture}: ${parity.label ?? `vis ${parity.args.join(" ")}`}`, parity] as const))("%s", (_label: string, parity: ParityCase) => {
        expect.assertions(3);

        const { native, node } = both(project(parity.fixture, parity.files), parity.args, parity.env);

        // The native side answered, with what Node prints, and the comparison is about a manager that ran.
        expect(native.stdout).not.toContain(marker);
        expect(native).toStrictEqual(node);
        expect(node.stdout).toMatch(PACKAGE_MANAGER_LINE);
    });

    it.each(DELEGATED_CASES.map((delegated) => [`${delegated.fixture}: ${delegated.label}`, delegated] as const))("hands %s to Node", (_label: string, delegated: DelegatedCase) => {
        expect.assertions(2);

        const setup = project(delegated.fixture, delegated.files, delegated.directory);

        for (const name of delegated.bin ?? []) {
            writeFileSync(join(setup.bindir, name), "#!/bin/sh\nexit 0\n");
            chmodSync(join(setup.bindir, name), 0o755);
        }

        const native = runNative(setup, delegated.args, delegated.env, delegated.ci ?? true);

        expect(native.stdout).toContain(marker);
        expect(native.stdout).not.toMatch(PACKAGE_MANAGER_LINE);
    });

    it("prints the security line of each manager's enforcement in a monorepo root, and none outside one", () => {
        expect.assertions(6);

        expect(runNative(project("pnpm-root"), ["install"]).stderr).toContain("security: pnpm blocks build scripts by default.");
        expect(runNative(project("npm-root"), ["install"]).stderr).toContain("security: npm does not block lifecycle scripts.");
        expect(runNative(project("yarn-root"), ["install"]).stderr).toContain("security: yarn classic does not support blocking lifecycle scripts.");
        expect(runNative(project("yarn-berry-root"), ["install"]).stderr).toContain("security: yarn berry supports enableScripts.");
        expect(runNative(project("pnpm-single"), ["install"]).stderr).toBe("");
        expect(runNative(project("pnpm-root"), ["i"]).stderr).toBe("");
    });

    it("prints the peer-dependency hint after the package manager's own output, and not with --silent or a failure", () => {
        expect.assertions(4);

        const setup = project("pnpm-single");
        const hint = runNative(setup, ["install"], { STUB_STDERR: PEER_WARNING });

        expect(hint.stdout).toMatch(/^pnpm:install[^\n]*\n(\d\d:\d\d:\d\d|HH:MM:SS) INFO \.+\n\nPeer dependency issues detected\./);
        expect(runNative(setup, ["install", "--silent"], { STUB_STDERR: PEER_WARNING }).stdout).not.toContain("Peer dependency");
        expect(runNative(setup, ["install"], { STUB_EXIT: "3", STUB_STDERR: PEER_WARNING }).stdout).not.toContain("Peer dependency");
        expect(runNative(setup, ["install"], { STUB_EXIT: "3" }).status).toBe(3);
    });

    it.each(["npm-root", "pnpm-root", "pnpm-single"])("%s: leaves the same files behind as Node, in the project and in HOME", (fixture: string) => {
        expect.assertions(2);

        // Each side in a project and a home of its own, so one cannot see what the other wrote.
        const tree = (setup: Setup): string[] => [...readdirSync(dirname(setup.cwd), { recursive: true }).map(String)].filter((path) => !path.startsWith("bin")).toSorted();
        const nodeSide = project(fixture);
        const nativeSide = project(fixture);
        const before = tree(nodeSide);

        runNode(nodeSide, ["install"]);
        runNative(nativeSide, ["install"]);

        expect(tree(nativeSide)).toStrictEqual(tree(nodeSide));
        expect(tree(nodeSide)).toStrictEqual(before);
    });

    it("hands the call to Node when the package manager is not on PATH, where Node reports the failure", () => {
        expect.assertions(1);

        const setup = project("pnpm-single");

        rmSync(join(setup.bindir, "pnpm"));

        expect(runNative(setup, ["install"]).stdout).toContain(marker);
    });
});
