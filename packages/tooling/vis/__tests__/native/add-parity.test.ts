import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `vis add` with `--no-marshall-check` exists twice: the Node handler (`src/commands/add/handler.ts`,
 * with the plugins that run around it) and the native path (`native/cli/src/add.rs`). For every fixture below
 * the two get the same arguments and the same environment, with stub package managers on `PATH` that write
 * their name, arguments and working directory to a log. The log, vis's own stdout and stderr (up to the clock
 * in pail's header) and the exit code must match. The native run's Node is a stub that prints a marker and
 * fails, so a run that quietly delegated is caught: the marker must be absent exactly when the native path is
 * expected to answer, and present, with no package manager run, for every shape it must leave to Node.
 *
 * The stubs print nothing unless a case asks them to. The Node handler runs the manager through the NAPI
 * binding `execPmCommandInteractive`, and on some hosts the child it starts gets `/dev/null` for stdin, stdout and
 * stderr, so what a manager prints can only be compared where the binding forwards a child's stdout (`forwards`
 * below). Everywhere else those cases are skipped, and a native-only case checks that the native path hands the
 * manager the real stdout, stderr, stdin and exit code.
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

/** Whether the binding that runs Node's package manager forwards the child's stdout, as it is meant to. */
const forwards = (): boolean => {
    const { stdout } = spawnSync(process.execPath, ["--input-type=module", "-e", `const binding = await import(${JSON.stringify(pathToFileURL(addonPath).href)}); binding.execPmCommandInteractive("echo", ["forwarded"], ".");`], {
        cwd: packageRoot,
        encoding: "utf8",
    });

    return stdout.includes("forwarded");
};

const ready = Boolean(binary) && process.platform !== "win32" && existsSync(nodeEntry) && addonLoads();

const PACKAGE = { name: "app", version: "1.0.0" };

/** Fixtures: a lockfile of one manager, and a workspace marker (a root) or not. */
const FIXTURES: Record<string, { files: Record<string, string> }> = {
    "bun-root": { files: { "bun.lock": "{}\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }) } },
    "bun-single": { files: { "bun.lock": "{}\n", "package.json": JSON.stringify(PACKAGE) } },
    "npm-root": { files: { "package-lock.json": "{}\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }) } },
    "npm-single": { files: { "package-lock.json": "{}\n", "package.json": JSON.stringify(PACKAGE) } },
    "pnpm-bare": { files: { "package.json": JSON.stringify(PACKAGE) } },
    "pnpm-root": { files: { "package.json": JSON.stringify(PACKAGE), "pnpm-lock.yaml": "lockfileVersion: 9\n", "pnpm-workspace.yaml": "packages: []\n" } },
    "pnpm-single": { files: { "package.json": JSON.stringify(PACKAGE), "pnpm-lock.yaml": "lockfileVersion: 9\n" } },
    "yarn-berry-root": {
        files: { ".yarnrc.yml": "nodeLinker: node-modules\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }), "yarn.lock": "# yarn lockfile\n" },
    },
    "yarn-root": { files: { "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }), "yarn.lock": "# yarn lockfile\n" } },
    "yarn-single": { files: { "package.json": JSON.stringify(PACKAGE), "yarn.lock": "# yarn lockfile\n" } },
};

let scratch = "";
let nativeBinary = "";
let counter = 0;

const STUBS = ["bun", "npm", "pnpm", "yarn"] as const;

// Appends `<name>:<arguments>` and the working directory to the log the case names, then, when the case asks
// for it, the environment Node's startup adds, a line on each stream and an exit code.
const stubSource = (name: string): string =>
    [
        "#!/bin/sh",
        `echo "${name}:$*" >> "$STUB_LOG"`,
        'echo "cwd:$PWD" >> "$STUB_LOG"',
        'if [ -n "$STUB_ENV" ]; then env | grep -E "^(CEREBRO_|VIS_MONOREPO_ROOT)" | sort >> "$STUB_LOG"; fi',
        'if [ -n "$STUB_STDERR" ]; then echo "$STUB_STDERR" >&2; fi',
        'if [ -n "$STUB_STDOUT" ]; then echo "$STUB_STDOUT"; fi',
        'if [ -n "$STUB_STDIN" ]; then cat >> "$STUB_LOG"; fi',
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
    /** What the stub package managers logged: one `name:arguments` line and one `cwd:` line per run. */
    log: string;
    status: number | null;
    stderr: string;
    stdout: string;
}

const capture = (command: string, args: string[], cwd: string, env: Record<string, string>, input?: string): Run => {
    const name = randomUUID();
    const out = join(scratch, `${name}.out`);
    const err = join(scratch, `${name}.err`);
    const log = join(scratch, `${name}.log`);
    const outFd = openSync(out, "w");
    const errFd = openSync(err, "w");

    try {
        const { status } = spawnSync(command, args, { cwd, env: { ...env, STUB_LOG: log }, input, stdio: [input === undefined ? "ignore" : "pipe", outFd, errFd] });

        return { log: existsSync(log) ? readFileSync(log, "utf8") : "", status, stderr: normalize(readFileSync(err, "utf8")), stdout: normalize(readFileSync(out, "utf8")) };
    } finally {
        closeSync(outFd);
        closeSync(errFd);
    }
};

const runNode = (setup: Setup, args: string[], extra: Record<string, string> = {}, ci = true): Run =>
    capture(process.execPath, [nodeEntry, ...args], setup.cwd, withoutUnset(environment(setup, extra, ci)));

const runNative = (setup: Setup, args: string[], extra: Record<string, string> = {}, ci = true, input?: string): Run =>
    capture(
        nativeBinary,
        args,
        setup.cwd,
        {
            ...withoutUnset(environment(setup, extra, ci)),
            VIS_FALLBACK_ENTRY: join(scratch, "no-such-entry.js"),
            VIS_NODE: join(setup.bindir, "node"),
            VIS_VERSION: version,
        },
        input,
    );

/** Both sides run the same call. */
const both = (setup: Setup, args: string[], extra: Record<string, string> = {}): { native: Run; node: Run } => {
    return { native: runNative(setup, args, extra), node: runNode(setup, args, extra) };
};

const FLAG = "--no-marshall-check";

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
    ["add", "react", FLAG],
    ["add", FLAG, "react", "lodash@4.17.21"],
    ["add", "-D", "react", FLAG],
    ["add", "react", "-D", "lodash", FLAG],
    ["add", "-D", "react", "-E", "lodash", "--save-optional", "@scope/pkg", FLAG],
    ["add", "react", "-E", "-O", FLAG],
    ["add", "react", "-P", FLAG],
    ["add", "react", "--save-dev", "--exact", "--save-optional", FLAG],
    ["add", "react", "--save-peer", "--save-optional", FLAG],
    ["add", "react", "-g", FLAG],
    ["add", "react", "-w", FLAG],
    ["add", "react", "--workspace-root", "-D", FLAG],
    ["add", "react", "--workspace", FLAG],
    ["add", "react", "--run-scripts", FLAG],
    ["add", "react", FLAG, "-F", "app"],
    ["add", "react", "lodash", "--filter=a", "--filter=b", FLAG],
    ["add", "react", "-F", "a", "-w", FLAG],
    ["add", "react", "-F", "a", "-D", "-E", FLAG],
    ["add", "react", "-g", "-F", "a", "-D", "-E", FLAG],
    ["add", "@scope/pkg@^1.2.0", "alias@npm:real@1", "tag@latest", "range@>=1.0.0", FLAG],
    ["add", "react@~18.2.0", "@scope/other@1.x", "pkg@git+https://example.test/a.git#semver:^1", FLAG],
    ["add", "react", FLAG, "--no-socket-check", "--no-typosquat-check"],
    ["add", "react", "-D", "-E", "-O", "-P", "-g", "-w", "--workspace", "--run-scripts", FLAG],
];

const DEFINE_CONFIG = 'import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ update: { target: "minor" } });\n';

/** An installed `@visulima/vis` that exports `./config`, as the package does. */
const INSTALLED_VIS: Record<string, string> = {
    "node_modules/@visulima/vis/dist/config.js": "export const defineConfig = (config) => config;\n",
    "node_modules/@visulima/vis/package.json": JSON.stringify({ exports: { "./config": "./dist/config.js" }, name: "@visulima/vis", type: "module" }),
};

const PARITY_CASES: ParityCase[] = [
    ...Object.keys(FIXTURES).flatMap((fixture) => SHAPES.map((args) => { return { args, fixture }; })),
    // The security notice is printed for each manager's default setup in a root; there is no alias to skip it.
    { args: ["add", "react", FLAG], files: { ".npmrc": "registry=https://registry.example.test/\n" }, fixture: "npm-root", label: "an .npmrc without ignore-scripts" },
    // A config literal in the root that holds no key Node evaluates.
    { args: ["add", "react", FLAG], files: { "vis.config.ts": 'export default { update: { target: "minor" } };\n' }, fixture: "pnpm-root", label: "a config literal" },
    { args: ["add", "react", FLAG], files: { "vis.config.json": "{}\n" }, fixture: "pnpm-root", label: "a json config, which Node never loads" },
    { args: ["add", "react", FLAG], files: { "vis.config.ts": "export default {};\n" }, fixture: "pnpm-single", label: "a config outside a root, which Node ignores" },
    { args: ["add", "react", FLAG], files: { ...INSTALLED_VIS, "vis.config.ts": DEFINE_CONFIG }, fixture: "pnpm-root", label: "a defineConfig config with @visulima/vis installed" },
    // What Node's startup adds to the environment the package manager runs in.
    ...["pnpm-root", "pnpm-single"].map((fixture) => { return { args: ["add", "react", FLAG], env: { STUB_ENV: "1" }, fixture, label: "the environment the manager runs in" }; }),
    // A user agent in the environment names a manager without a version; neither side lets it pick the manager.
    { args: ["add", "react", "-D", "-F", "a", "-F", "b", FLAG], env: { npm_config_user_agent: "yarn/1.22.19 npm/? node/v22.23.4 darwin arm64" }, fixture: "yarn-single", label: "a yarn user agent" },
    { args: ["add", "react", FLAG], env: { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22.23.4 darwin arm64" }, fixture: "pnpm-single", label: "a pnpm user agent" },
    // The exit code is the package manager's.
    ...["1", "2", "130"].map((code) => { return { args: ["add", "react", FLAG], env: { STUB_EXIT: code }, fixture: "pnpm-single", label: `exit code ${code}` }; }),
    // `--no-typosquat-check` lets a typosquat through, in the native path as in Node.
    { args: ["add", "lodas", FLAG, "--no-typosquat-check"], fixture: "pnpm-single", label: "a typosquat with --no-typosquat-check" },
    // Names that match no typosquat, scoped, versioned and aliased.
    { args: ["add", "@scope/pkg@1.0.0", "react@18.0.0", "zzz-not-a-package-name", FLAG], fixture: "pnpm-single", label: "names that match no typosquat" },
    // A package.json the add does not read: vis never edits it, and an unparsable one is the manager's business.
    { args: ["add", "react", FLAG], files: { "package.json": "{ not json" }, fixture: "pnpm-single", label: "an unparsable package.json" },
    { args: ["add", "react", FLAG], files: { "package.json": JSON.stringify({ ...PACKAGE, dependencies: { lodas: "1.0.0" } }) }, fixture: "pnpm-single", label: "a typosquat already in package.json" },
];

const DELEGATED_CASES: DelegatedCase[] = [
    // Typosquat hits by bare, scoped and versioned name, in each position.
    ...[
        ["add", "lodas", FLAG],
        ["add", "@scope/lodas", FLAG],
        ["add", "lodas@1.0.0", FLAG],
        ["add", "react", "lodas", FLAG],
        ["add", "react", FLAG, "-D", "lodas"],
        ["add", "reaact@^18", FLAG],
        ["add", "lodas", FLAG, "--no-socket-check"],
    ].map((args) => { return { args, fixture: "pnpm-single", label: `vis ${args.join(" ")}` }; }),
    // Shapes of the command line.
    ...[
        ["add", "react"],
        ["add", "react", "--no-socket-check"],
        ["add", "react", "--no-typosquat-check"],
        ["add", FLAG],
        ["add"],
        ["add", "-D", FLAG],
        ["add", "-F", "app", "react", FLAG],
        ["add", "--filter=app", "react", FLAG],
        ["add", "react", FLAG, "-F", "app", "lodash"],
        ["add", "react", FLAG, "-F"],
        ["add", "react", FLAG, "-F", "-D"],
        ["add", "react", FLAG, "--filter="],
        ["add", "react", FLAG, "-r"],
        ["add", "react", FLAG, "--recursive"],
        ["add", "react", FLAG, "--to", "web"],
        ["add", "react", FLAG, "--auto-install-peers"],
        ["add", "react", FLAG, "--dev"],
        ["add", "react", FLAG, "--cwd", "."],
        ["add", "react", FLAG, "--config", "x.ts"],
        ["add", "react", FLAG, "--runtime", "node"],
        ["add", "react", FLAG, "-D", "-D"],
        ["add", "react", FLAG, "--exact", "-E"],
        ["add", "react", FLAG, FLAG],
        ["add", "react", FLAG, "-Dg"],
        ["add", "react", FLAG, "--exact=true"],
        ["add", "react", FLAG, "--"],
        ["add", "react", FLAG, "--", "x"],
        ["add", "./local", FLAG],
        ["add", "react@", FLAG],
        ["add", "@scope", FLAG],
        ["add", "@scope/", FLAG],
        ["add", "git+https://example.test/a.git", FLAG],
        ["add", "file:../x", FLAG],
        ["add", "react ", FLAG],
        ["add", "réact", FLAG],
        ["add", "react", "", FLAG],
        ["i", "react", FLAG],
    ].map((args) => { return { args, fixture: "pnpm-single", label: `vis ${args.join(" ")}` }; }),
    // Contexts: outside CI, colour, Node's output settings, the environment that picks the installer.
    { args: ["add", "react", FLAG], ci: false, fixture: "pnpm-single", label: "outside CI" },
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
        { MARSHALL_DISABLE_SOCKET: "1" },
        { VIS_SECURITY_WARNINGS: "1" },
        { VIS_INSTALLER: "npm" },
        { VIS_RUNTIME: "node" },
        { VIS_MONOREPO_ROOT: "/elsewhere" },
        { COLUMNS: "20" },
    ].map((env) => { return { args: ["add", "react", FLAG], env, fixture: "pnpm-single", label: `environment ${JSON.stringify(env)}` }; }),
    // Configs, pins and markers Node reads: the keys that hold the typosquat allow list, the marshall and Socket settings.
    ...[
        "export default { security: {} };\n",
        'export default { security: { typosquatAllowlist: ["lodas"] } };\n',
        "export default { security: { socket: { enabled: true } } };\n",
        'export default { install: { backend: "npm" } };\n',
        'export default { runtime: "node" };\n',
        'export default { update: { target: ["m", "inor"].join("") } };\n',
    ].map((config) => { return { args: ["add", "react", FLAG], files: { "vis.config.ts": config }, fixture: "pnpm-root", label: `the config ${config.trim()}` }; }),
    { args: ["add", "react", FLAG], files: { "vis.config.ts": DEFINE_CONFIG }, fixture: "pnpm-root", label: "a defineConfig config before @visulima/vis is installed" },
    { args: ["add", "react", FLAG], files: { ".npmrc": "ignore-scripts=true\n" }, fixture: "npm-root", label: "an .npmrc that mentions ignore-scripts" },
    { args: ["add", "react", FLAG], files: { ".yarnrc.yml": "enableScripts: false\n" }, fixture: "yarn-berry-root", label: "a .yarnrc.yml that mentions enableScripts" },
    { args: ["add", "react", FLAG], files: { "package.json": JSON.stringify({ ...PACKAGE, packageManager: "pnpm@9.0.0" }) }, fixture: "pnpm-single", label: "a packageManager pin" },
    { args: ["add", "react", FLAG], files: { "bun.lock": "{}\n" }, fixture: "pnpm-single", label: "a bun lockfile beside another manager" },
    { args: ["add", "react", FLAG], files: { "pnpm-lock.yaml": "lockfileVersion: 9\n" }, fixture: "npm-single", label: "two lockfile managers" },
    { args: ["add", "react", FLAG], bin: ["aube"], fixture: "pnpm-single", label: "aube on PATH" },
    { args: ["add", "react", FLAG], directory: "packages/app", fixture: "pnpm-root", label: "a directory below the monorepo root" },
    { args: ["add", "react", FLAG], files: { "lerna.json": '{ "packages": [] }\n' }, fixture: "pnpm-single", label: "lerna.json" },
    { args: ["add", "react", FLAG], files: { "turbo.json": "{}\n" }, fixture: "pnpm-single", label: "turbo.json" },
    { args: ["add", "react", FLAG], files: { "deno.json": "{}\n" }, fixture: "pnpm-single", label: "a deno file" },
];

describe.skipIf(!ready)("vis add: native vs Node", () => {
    beforeAll(() => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-add-parity-")));
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
        expect(node.log).toMatch(/^(bun|npm|pnpm|yarn):/m);
    });

    it.each(DELEGATED_CASES.map((delegated) => [`${delegated.fixture}: ${delegated.label}`, delegated] as const))("hands %s to Node", (_label: string, delegated: DelegatedCase) => {
        expect.assertions(2);

        const setup = project(delegated.fixture, delegated.files, delegated.directory);

        for (const name of delegated.bin ?? []) {
            writeFileSync(join(setup.bindir, name), "#!/bin/sh\nexit 0\n");
            chmodSync(join(setup.bindir, name), 0o755);
        }

        const native = runNative(setup, delegated.args, delegated.env, delegated.ci ?? true);

        // Delegated before the manager runs: a delegation after it ran would add twice.
        expect(native.stdout).toContain(marker);
        expect(native.log).toBe("");
    });

    it("prints the security line of each manager's enforcement in a monorepo root, and none outside one", () => {
        expect.assertions(5);

        const add = ["add", "react", FLAG];

        expect(runNative(project("pnpm-root"), add).stderr).toContain("security: pnpm blocks build scripts by default.");
        expect(runNative(project("npm-root"), add).stderr).toContain("security: npm does not block lifecycle scripts.");
        expect(runNative(project("yarn-root"), add).stderr).toContain("security: yarn classic does not support blocking lifecycle scripts.");
        expect(runNative(project("yarn-berry-root"), add).stderr).toContain("security: yarn berry supports enableScripts.");
        expect(runNative(project("pnpm-single"), add).stderr).toBe("");
    });

    it("blocks lifecycle scripts unless --run-scripts, for every manager, and the global form runs npm", () => {
        expect.assertions(5);

        const logs = (fixture: string, args: string[]): string => runNative(project(fixture), ["add", ...args, FLAG]).log;

        expect(logs("pnpm-single", ["react"])).toMatch(/^pnpm:add react --ignore-scripts$/m);
        expect(logs("npm-single", ["react", "-D"])).toMatch(/^npm:install --save-dev react --ignore-scripts$/m);
        expect(logs("bun-single", ["react", "--run-scripts"])).toMatch(/^bun:add react$/m);
        expect(logs("yarn-single", ["react", "-E"])).toMatch(/^yarn:add --exact react --ignore-scripts$/m);
        expect(logs("pnpm-single", ["react", "-g"])).toMatch(/^npm:install --global react --ignore-scripts$/m);
    });

    it.skipIf(!forwards())("prints what the manager prints, and no peer-dependency hint, as Node does", () => {
        expect.assertions(4);

        const setup = project("pnpm-single");

        for (const env of [{ STUB_STDERR: "WARN  unmet peer react@18.0.0" }, { STUB_STDOUT: "Issues with peer dependencies found" }, { STUB_EXIT: "3", STUB_STDERR: "to-stderr", STUB_STDOUT: "to-stdout" }]) {
            const { native, node } = both(setup, ["add", "react", FLAG], env);

            expect(native).toStrictEqual(node);
        }

        expect(runNative(setup, ["add", "react", FLAG], { STUB_STDERR: "WARN  unmet peer react@18.0.0" }).stdout).not.toContain("Peer dependency");
    });

    it("hands the manager the real stdout, stderr, stdin and exit code", () => {
        expect.assertions(5);

        const setup = project("pnpm-single");
        const run = runNative(setup, ["add", "react", FLAG], { STUB_EXIT: "7", STUB_STDERR: "to-stderr", STUB_STDIN: "1", STUB_STDOUT: "to-stdout" }, true, "from-stdin\n");

        expect(run.stdout).toBe("to-stdout\n");
        expect(run.stderr).toBe("to-stderr\n");
        expect(run.status).toBe(7);
        expect(run.log).toContain("from-stdin");
        expect(run.stdout).not.toContain("Peer dependency");
    });

    it.each(["npm-root", "pnpm-root", "pnpm-single"])("%s: leaves the same files behind as Node, in the project and in HOME", (fixture: string) => {
        expect.assertions(2);

        // Each side in a project and a home of its own, so one cannot see what the other wrote.
        const tree = (setup: Setup): string[] => [...readdirSync(dirname(setup.cwd), { recursive: true }).map(String)].filter((path) => !path.startsWith("bin")).toSorted();
        const nodeSide = project(fixture);
        const nativeSide = project(fixture);
        const before = tree(nodeSide);

        runNode(nodeSide, ["add", "react", FLAG]);
        runNative(nativeSide, ["add", "react", FLAG]);

        expect(tree(nativeSide)).toStrictEqual(tree(nodeSide));
        expect(tree(nodeSide)).toStrictEqual(before);
    });

    it("hands the call to Node when the package manager is not on PATH, where Node reports the failure", () => {
        expect.assertions(1);

        const setup = project("pnpm-single");

        rmSync(join(setup.bindir, "pnpm"));

        expect(runNative(setup, ["add", "react", FLAG]).stdout).toContain(marker);
    });

    it("does not depend on the environment it runs in", () => {
        expect.assertions(2);

        const setup = project("pnpm-single");
        const clean = runNative(setup, ["add", "react", FLAG]);
        const parent = { ...process.env };

        // Variables of the parent that would change the answer must not reach either side: the runs are built from scratch.
        process.env["FORCE_COLOR"] = "1";
        process.env["MARSHALL_DISABLE_ALL"] = "1";
        process.env["VIS_INSTALLER"] = "npm";

        try {
            expect(runNative(setup, ["add", "react", FLAG])).toStrictEqual(clean);
            expect(runNode(setup, ["add", "react", FLAG])).toStrictEqual(clean);
        } finally {
            for (const key of ["FORCE_COLOR", "MARSHALL_DISABLE_ALL", "VIS_INSTALLER"]) {
                if (parent[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = parent[key];
                }
            }
        }
    });
});
