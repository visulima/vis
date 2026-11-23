import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `vis info` (alias `view`) and `vis dlx` exist twice: the Node handlers (`src/commands/info/handler.ts`,
 * `src/commands/dlx/handler.ts`) and the native paths (`native/cli/src/info.rs`, `dlx.rs`). For every fixture
 * below the two get the same arguments and the same environment, with stub package managers on `PATH` that
 * write their name, arguments, working directory and complete environment to a log. The log, vis's own stdout
 * and stderr and the exit code must match. The native run's Node is a stub that prints a marker and fails, so a
 * run that quietly delegated is caught: the marker must be absent exactly when the native path is expected to
 * answer, and present, with no package manager run, for every shape it must leave to Node.
 *
 * What a stub prints is compared too (`STUB_STDOUT`, `STUB_STDERR`, `STUB_EXIT`): Node runs the manager with
 * `spawnSync` and the terminal's own stdio, as the native side does.
 *
 * The environment is built from scratch, not filtered from the parent's: the runner's colour, CI and
 * package-manager variables change which path answers and what Node prints, so none of them may reach either
 * side. The environment the manager sees is compared in full, except for the variables the native launcher
 * contract adds on its own (`LAUNCHER_VARIABLES`): they are named, not hidden.
 *
 * The first-run gate of `dlx` (package metadata over the network, a prompt) is never exercised: every native
 * case switches it off, and every case that would run it only has to be handed to Node.
 *
 * Needs the native `vis` binary, the built CLI (`dist/bin.js`) and the NAPI addon; skipped otherwise.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const addonPath = join(packageRoot, "index.js");
const marker = "NATIVE-DELEGATED";
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

/**
 * The variables the native side carries from the launcher into the manager's environment, and the one macOS adds
 * to a process that loads CoreFoundation (Node does, the Rust binary does not).
 */
const LAUNCHER_VARIABLES = ["VIS_FALLBACK_ENTRY", "VIS_LAUNCHER", "VIS_NODE"];
const PLATFORM_VARIABLES = ["__CF_USER_TEXT_ENCODING"];

const addonLoads = (): boolean =>
    existsSync(addonPath) && spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(addonPath).href)});`], { cwd: packageRoot }).status === 0;

const ready = Boolean(binary) && process.platform !== "win32" && existsSync(nodeEntry) && addonLoads();

const PACKAGE = { name: "app", version: "1.0.0" };

/** Fixtures: a lockfile of one manager, and a workspace marker (a root) or not. */
const FIXTURES: Record<string, { files: Record<string, string>; manager: string }> = {
    "bun-root": { files: { "bun.lock": "{}\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }) }, manager: "bun" },
    "bun-single": { files: { "bun.lock": "{}\n", "package.json": JSON.stringify(PACKAGE) }, manager: "bun" },
    "npm-root": { files: { "package-lock.json": "{}\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }) }, manager: "npm" },
    "npm-single": { files: { "package-lock.json": "{}\n", "package.json": JSON.stringify(PACKAGE) }, manager: "npm" },
    "pnpm-bare": { files: { "package.json": JSON.stringify(PACKAGE) }, manager: "pnpm" },
    "pnpm-root": { files: { "package.json": JSON.stringify(PACKAGE), "pnpm-lock.yaml": "lockfileVersion: 9\n", "pnpm-workspace.yaml": "packages: []\n" }, manager: "pnpm" },
    "pnpm-single": { files: { "package.json": JSON.stringify(PACKAGE), "pnpm-lock.yaml": "lockfileVersion: 9\n" }, manager: "pnpm" },
    "yarn-berry-root": {
        files: { ".yarnrc.yml": "nodeLinker: node-modules\n", "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }), "yarn.lock": "# yarn lockfile\n" },
        manager: "yarn",
    },
    "yarn-root": { files: { "package.json": JSON.stringify({ ...PACKAGE, workspaces: ["packages/*"] }), "yarn.lock": "# yarn lockfile\n" }, manager: "yarn" },
    "yarn-single": { files: { "package.json": JSON.stringify(PACKAGE), "yarn.lock": "# yarn lockfile\n" }, manager: "yarn" },
};

let scratch = "";
let nativeBinary = "";
let counter = 0;

const STUBS = ["bun", "npm", "pnpm", "yarn"] as const;

// Appends `<name>:<arguments>` and the working directory to the log the case names, then the manager's whole
// environment (minus the shell's own bookkeeping and the case's controls), a line on each stream when the case
// asks for it, and an exit code.
const stubSource = (name: string): string =>
    [
        "#!/bin/sh",
        `echo "${name}:$*" >> "$STUB_LOG"`,
        'echo "cwd:$PWD" >> "$STUB_LOG"',
        'env | grep -vE "^(PWD|OLDPWD|_|SHLVL|STUB_[A-Z]+)=" | sort | sed "s/^/env:/" >> "$STUB_LOG"',
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

interface Run {
    /** What the stub package managers logged: a `name:arguments` line, a `cwd:` line and their environment, per run. */
    log: string;
    status: number | null;
    stderr: string;
    stdout: string;
}

/** The manager's environment with the variables of the launcher contract named away, so the rest is compared as it is. */
const withoutLauncherVariables = (log: string): string =>
    log
        .split("\n")
        .filter((line) => ![...LAUNCHER_VARIABLES, ...PLATFORM_VARIABLES].some((name) => line.startsWith(`env:${name}=`)))
        .join("\n");

const capture = (command: string, args: string[], cwd: string, env: Record<string, string>, input?: string): Run => {
    const name = randomUUID();
    const out = join(scratch, `${name}.out`);
    const err = join(scratch, `${name}.err`);
    const log = join(scratch, `${name}.log`);
    const outFd = openSync(out, "w");
    const errFd = openSync(err, "w");

    try {
        const { status } = spawnSync(command, args, { cwd, env: { ...env, STUB_LOG: log }, input, stdio: [input === undefined ? "ignore" : "pipe", outFd, errFd] });

        return { log: existsSync(log) ? withoutLauncherVariables(readFileSync(log, "utf8")) : "", status, stderr: readFileSync(err, "utf8"), stdout: readFileSync(out, "utf8") };
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

/** A case the native side must answer with exactly what Node prints. */
interface ParityCase {
    args: string[];
    ci?: boolean;
    directory?: string;
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

const labelOf = (parity: { args: string[]; fixture: string; label?: string }): string => `${parity.fixture}: ${parity.label ?? `vis ${parity.args.join(" ")}`}`;

/** Every file under a side's project and home, so that what one side writes the other must write too. */
const tree = (setup: Setup): string[] => [...readdirSync(dirname(setup.cwd), { recursive: true }).map(String)].filter((path) => !path.startsWith("bin")).toSorted();

const sameFilesAsNode = (fixture: string, args: string[], ci: boolean): [string[], string[], string[]] => {
    // Each side in a project and a home of its own, so one cannot see what the other wrote.
    const nodeSide = project(fixture);
    const nativeSide = project(fixture);
    const before = tree(nodeSide);

    runNode(nodeSide, args, { VIS_NO_UPDATE_CHECK: UNSET }, ci);
    runNative(nativeSide, args, { VIS_NO_UPDATE_CHECK: UNSET }, ci);

    return [tree(nativeSide), tree(nodeSide), before];
};

/** Both sides run the same call in a project of their own. */
const compare = (parity: ParityCase): { native: Run; node: Run } => {
    const setup = project(parity.fixture, parity.files, parity.directory);

    return { native: runNative(setup, parity.args, parity.env, parity.ci ?? true), node: runNode(setup, parity.args, parity.env, parity.ci ?? true) };
};

const runDelegated = (delegated: DelegatedCase): Run => {
    const setup = project(delegated.fixture, delegated.files, delegated.directory);

    for (const name of delegated.bin ?? []) {
        writeFileSync(join(setup.bindir, name), "#!/bin/sh\nexit 0\n");
        chmodSync(join(setup.bindir, name), 0o755);
    }

    return runNative(setup, delegated.args, delegated.env, delegated.ci ?? true);
};

describe.skipIf(!ready)("vis info and vis dlx: native vs Node", () => {
    beforeAll(() => {
        if (!ready) {
            return;
        }

        scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-info-dlx-parity-")));
        nativeBinary = join(scratch, "vis");

        // A binary inside the package reads its own location and delegates to `dist/bin.js` itself, which
        // would make a delegation look like a native answer; a copy outside it keeps the stub in charge.
        writeFileSync(nativeBinary, readFileSync(binary as string), { mode: 0o755 });
    });

    afterAll(() => {
        if (scratch !== "") {
            rmSync(scratch, { force: true, recursive: true });
        }
    });

    /* ------------------------------------------------------------------------------------------------ info */

    const DEFINE_CONFIG = 'import { defineConfig } from "@visulima/vis/config";\n\nexport default defineConfig({ update: { target: "minor" } });\n';

    /** An installed `@visulima/vis` that exports `./config`, as the package does. */
    const INSTALLED_VIS: Record<string, string> = {
        "node_modules/@visulima/vis/dist/config.js": "export const defineConfig = (config) => config;\n",
        "node_modules/@visulima/vis/package.json": JSON.stringify({ exports: { "./config": "./dist/config.js" }, name: "@visulima/vis", type: "module" }),
    };

    /** Shapes without a field, which every manager answers with its view command. */
    const INFO_PLAIN_SHAPES: string[][] = [
        ["info", "react"],
        ["view", "react"],
        ["info", "react", "--json"],
        ["info", "--json", "react"],
        ["info", "@scope/pkg@^1.2.0"],
        ["info", "react@18", "--json"],
        ["view", "@scope/pkg", "--json"],
    ];

    /** Shapes with a field: yarn berry takes none and says so, which is left to Node. */
    const INFO_FIELD_SHAPES: string[][] = [
        ["info", "react", "version"],
        ["info", "react", "version", "dependencies"],
        ["info", "react", "version", "--json"],
        ["info", "react", "--json", "version"],
        ["info", "--json", "react", "dist-tags.latest", "dist.tarball"],
        ["view", "react@18", "dependencies", "peerDependencies"],
        ["info", "react", "versions", "--json"],
    ];

    const isYarn = (fixture: string): boolean => (FIXTURES[fixture] as (typeof FIXTURES)[string]).manager === "yarn";

    const INFO_PARITY_CASES: ParityCase[] = [
        ...Object.keys(FIXTURES).flatMap((fixture) => [...INFO_PLAIN_SHAPES, ...(isYarn(fixture) ? [] : INFO_FIELD_SHAPES)].map((args) => { return { args, fixture }; })),
        // A config literal in the root that holds no key Node evaluates.
        { args: ["info", "react"], files: { "vis.config.ts": 'export default { update: { target: "minor" } };\n' }, fixture: "pnpm-root", label: "a config literal" },
        { args: ["info", "react"], files: { "vis.config.json": "{}\n" }, fixture: "pnpm-root", label: "a json config, which Node never loads" },
        { args: ["info", "react"], files: { "vis.config.ts": "export default {};\n" }, fixture: "pnpm-single", label: "a config outside a root, which Node ignores" },
        { args: ["info", "react"], files: { ...INSTALLED_VIS, "vis.config.ts": DEFINE_CONFIG }, fixture: "pnpm-root", label: "a defineConfig config with @visulima/vis installed" },
        // A user agent in the environment names a manager without a version; neither side lets it pick the manager.
        { args: ["info", "react", "--json"], env: { npm_config_user_agent: "yarn/1.22.19 npm/? node/v22.23.4 darwin arm64" }, fixture: "yarn-single", label: "a yarn user agent" },
        { args: ["info", "react"], env: { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22.23.4 darwin arm64" }, fixture: "pnpm-single", label: "a pnpm user agent" },
        // The exit code is the manager's, except for 1, which Node treats as an ordinary "not found".
        ...["1", "2", "3", "130"].map((code) => { return { args: ["info", "react", "version"], env: { STUB_EXIT: code }, fixture: "pnpm-single", label: `exit code ${code}` }; }),
        { args: ["info", "react"], env: { STUB_EXIT: "1", STUB_STDERR: "npm ERR! code E404", STUB_STDOUT: "" }, fixture: "npm-single", label: "a not-found report on stderr" },
        { args: ["info", "react", "version"], env: { STUB_STDOUT: "18.2.0" }, fixture: "pnpm-single", label: "the version on stdout" },
        // Colours and terminal settings change nothing the native path prints: it prints nothing of its own.
        ...[{ FORCE_COLOR: "1" }, { GITHUB_ACTIONS: "true" }, { TERM: "xterm-256color" }, { NO_COLOR: "1" }].map((env) => {
            return { args: ["info", "react", "--json"], env, fixture: "pnpm-single", label: `environment ${JSON.stringify(env)}` };
        }),
    ];

    const INFO_DELEGATED_CASES: DelegatedCase[] = [
        ...[
            ["info"],
            ["info", "--json"],
            ["info", "react", "--json", "--json"],
            ["info", "react", "--registry=https://x.test"],
            ["info", "react", "--", "x"],
            ["info", "react", "--"],
            ["info", "-rf"],
            ["info", "react", "-x"],
            ["info", "react", "--json=false"],
            ["info", "react", "18"],
            ["info", "react", "true"],
            ["info", "react", ""],
            ["info", "react", "a b"],
            ["info", "./local"],
            ["info", "réact"],
            ["info", "react", "--cwd", "."],
            ["info", "react", "--config", "x.ts"],
            ["info", "react", "--runtime", "node"],
            ["view"],
        ].map((args) => { return { args, fixture: "pnpm-single", label: `vis ${args.join(" ")}` }; }),
        // yarn berry takes no field; Node says so on stderr.
        ...["yarn-single", "yarn-root", "yarn-berry-root"].map((fixture) => { return { args: ["info", "react", "version"], fixture, label: "a field on yarn berry" }; }),
        // Contexts: outside CI, Node's output settings, the environment that picks the installer.
        { args: ["info", "react"], ci: false, fixture: "pnpm-single", label: "outside CI" },
        ...[
            { COLUMNS: "20" },
            { NODE_ENV: "test" },
            { DEBUG: "*" },
            { PAIL_LOG_LEVEL: "error" },
            { CEREBRO_OUTPUT_LEVEL: "1" },
            { MARSHALL_DISABLE_ALL: "1" },
            { VIS_SECURITY_WARNINGS: "1" },
            { VIS_INSTALLER: "npm" },
            { VIS_RUNTIME: "node" },
            { VIS_MONOREPO_ROOT: "/elsewhere" },
        ].map((env) => { return { args: ["info", "react"], env, fixture: "pnpm-single", label: `environment ${JSON.stringify(env)}` }; }),
        // Configs, pins and markers Node reads.
        ...[
            'export default { install: { backend: "npm" } };\n',
            "export default { install: { corepack: true } };\n",
            'export default { runtime: "node" };\n',
            'export default { update: { target: ["m", "inor"].join("") } };\n',
        ].map((config) => { return { args: ["info", "react"], files: { "vis.config.ts": config }, fixture: "pnpm-root", label: `the config ${config.trim()}` }; }),
        { args: ["info", "react"], files: { "vis.config.ts": DEFINE_CONFIG }, fixture: "pnpm-root", label: "a defineConfig config before @visulima/vis is installed" },
        { args: ["info", "react"], files: { "package.json": JSON.stringify({ ...PACKAGE, packageManager: "pnpm@9.0.0" }) }, fixture: "pnpm-single", label: "a packageManager pin" },
        { args: ["info", "react"], files: { "bun.lock": "{}\n" }, fixture: "pnpm-single", label: "a bun lockfile beside another manager" },
        { args: ["info", "react"], files: { "pnpm-lock.yaml": "lockfileVersion: 9\n" }, fixture: "npm-single", label: "two lockfile managers" },
        { args: ["info", "react"], bin: ["aube"], fixture: "pnpm-single", label: "aube on PATH" },
        { args: ["info", "react"], directory: "packages/app", fixture: "pnpm-root", label: "a directory below the monorepo root" },
        { args: ["info", "react"], files: { "lerna.json": '{ "packages": [] }\n' }, fixture: "pnpm-single", label: "lerna.json" },
        { args: ["info", "react"], files: { "turbo.json": "{}\n" }, fixture: "pnpm-single", label: "turbo.json" },
        { args: ["info", "react"], files: { "deno.json": "{}\n" }, fixture: "pnpm-single", label: "a deno file" },
    ];

    describe("vis info: native vs Node", () => {
        it.each(INFO_PARITY_CASES.map((parity) => [labelOf(parity), parity] as const))("%s", (_label: string, parity: ParityCase) => {
            expect.assertions(3);

            const { native, node } = compare(parity);

            // The native side answered, with what Node prints, and the comparison is about a manager that ran.
            expect(native.stdout).not.toContain(marker);
            expect(native).toStrictEqual(node);
            expect(node.log).toMatch(/^(bun|npm|pnpm|yarn):/m);
        });

        it.each(INFO_DELEGATED_CASES.map((delegated) => [labelOf(delegated), delegated] as const))("hands %s to Node", (_label: string, delegated: DelegatedCase) => {
            expect.assertions(2);

            const native = runDelegated(delegated);

            // Delegated before the manager runs: a delegation after it ran would run it twice.
            expect(native.stdout).toContain(marker);
            expect(native.log).toBe("");
        });

        it("hands the call to Node when the package manager is not on PATH, where Node reports the failure", () => {
            expect.assertions(1);

            const setup = project("pnpm-single");

            rmSync(join(setup.bindir, "pnpm"));

            expect(runNative(setup, ["info", "react"]).stdout).toContain(marker);
        });

        it.each(["npm-root", "pnpm-root", "pnpm-single"])("%s: leaves the same files behind as Node, in the project and in HOME", (fixture: string) => {
            expect.assertions(2);

            const [native, node, before] = sameFilesAsNode(fixture, ["info", "react", "version"], true);

            expect(native).toStrictEqual(node);
            expect(node).toStrictEqual(before);
        });

        it("hands the manager the real stdout, stderr and exit code", () => {
            expect.assertions(3);

            const run = runNative(project("pnpm-single"), ["info", "react", "version"], { STUB_EXIT: "7", STUB_STDERR: "to-stderr", STUB_STDOUT: "to-stdout" });

            expect(run.stdout).toBe("to-stdout\n");
            expect(run.stderr).toBe("to-stderr\n");
            expect(run.status).toBe(7);
        });
    });

    /* ------------------------------------------------------------------------------------------------- dlx */

    /** The shapes where the first-run gate stays out, with what each manager needs to answer without a warning. */
    interface DlxShape {
        args: string[];
        /** Yarn berry has no shell mode and no offline mode, and bun has no offline mode: Node warns, the native side leaves it. */
        needs?: "offline" | "shell";
    }

    const DLX_SHAPES: DlxShape[] = [
        { args: ["dlx", "--no-info", "cowsay"] },
        { args: ["dlx", "cowsay", "--no-info"] },
        { args: ["dlx", "--no-info", "cowsay", "hi", "there"] },
        { args: ["dlx", "--no-info", "cowsay@1.5.0", "hi"] },
        { args: ["dlx", "--no-info", "@scope/pkg@^1.2.0", "a", "b"] },
        { args: ["dlx", "--no-info", "create-vite", "my-app", "007", "true", "1e3", "a=b", "x y"] },
        { args: ["dlx", "--no-info", "cowsay", "hi", "--silent"] },
        { args: ["dlx", "--no-info", "-s", "cowsay"] },
        { args: ["dlx", "--no-info", "--yes", "cowsay"] },
        { args: ["dlx", "--no-info", "cowsay", "-y", "hi"] },
        { args: ["dlx", "--no-info", "--silent", "--yes", "cowsay", "hi"] },
        { args: ["dlx", "--no-info", "-p", "lolcatjs", "-s", "cowsay"] },
        { args: ["dlx", "--no-info", "cowsay", "-p", "lolcatjs", "-s"] },
        { args: ["dlx", "--no-info", "-p", "a", "-p", "b", "-y", "cowsay", "hi"] },
        { args: ["dlx", "--no-info", "--package", "a", "--silent", "cowsay"] },
        { args: ["dlx", "--no-info", "--offline", "cowsay"], needs: "offline" },
        { args: ["dlx", "--no-info", "cowsay", "hi", "--offline", "--silent"], needs: "offline" },
        { args: ["dlx", "--no-info", "-c", "echo hi"], needs: "shell" },
        { args: ["dlx", "--no-info", "--shell-mode", "echo hi | cowsay"], needs: "shell" },
        { args: ["dlx", "--no-info", "-p", "cowsay", "-p", "lolcatjs", "-c", "echo hi | cowsay | lolcatjs"], needs: "shell" },
        { args: ["dlx", "--no-info", "-p", "cowsay", "-c", "echo hi", "--silent"], needs: "shell" },
        // Shell mode vets only the `-p` packages, so with none the gate is out without `--no-info`.
        { args: ["dlx", "-c", "echo hi"], needs: "shell" },
        { args: ["dlx", "--shell-mode", "echo hi && echo there", "--silent"], needs: "shell" },
        // Paths, URLs and aliases are no registry specs.
        { args: ["dlx", "./local.js"] },
        { args: ["dlx", "../tools/run.js", "a", "b"] },
        { args: ["dlx", "/abs/run.js"] },
        { args: ["dlx", "~/run.js"] },
        { args: ["dlx", "git+https://example.test/a.git", "x"] },
        { args: ["dlx", "https://example.test/a.tgz"] },
        { args: ["dlx", "npm:cowsay@1", "hi"] },
        { args: ["dlx", "github:user/repo", "--silent"] },
        { args: ["dlx", "file:../x"] },
        { args: ["dlx", "@scope/x:y"] },
    ];

    const unavailable = (fixture: string, needs?: DlxShape["needs"]): boolean => {
        const { manager } = (FIXTURES[fixture] as (typeof FIXTURES)[string]);

        return (manager === "yarn" && needs !== undefined) || (manager === "bun" && needs === "offline");
    };

    const DLX_PARITY_CASES: ParityCase[] = [
        ...Object.keys(FIXTURES).flatMap((fixture) => DLX_SHAPES.filter((shape) => !unavailable(fixture, shape.needs)).map((shape) => { return { args: shape.args, fixture }; })),
        // `VIS_DLX_NO_INFO` is the other way to switch the gate off, with the values `isTruthyEnv` reads as on.
        ...["1", "true", "TRUE", "yes", "on", "anything", " 1 ", "2"].map((value) => { return { args: ["dlx", "cowsay", "hi"], env: { VIS_DLX_NO_INFO: value }, fixture: "pnpm-single", label: `VIS_DLX_NO_INFO=${JSON.stringify(value)}` }; }),
        // With the gate out the other variable changes nothing.
        { args: ["dlx", "--no-info", "cowsay"], env: { VIS_DLX_YES: "1" }, fixture: "pnpm-single", label: "VIS_DLX_YES beside --no-info" },
        // A falsy value leaves the gate on, which only a non-registry spec makes irrelevant.
        ...["", "0", "false", "no", " NO "].map((value) => { return { args: ["dlx", "./local.js"], env: { VIS_DLX_NO_INFO: value }, fixture: "pnpm-single", label: `a path with VIS_DLX_NO_INFO=${JSON.stringify(value)}` }; }),
        // The lean entry runs the manager in the working directory, with no workspace root and no config.
        { args: ["dlx", "--no-info", "cowsay"], directory: "packages/app", fixture: "pnpm-root", label: "a directory below the monorepo root" },
        { args: ["dlx", "--no-info", "cowsay"], directory: "packages/app", fixture: "bun-root", label: "a directory below a bun root" },
        { args: ["dlx", "--no-info", "cowsay"], directory: "packages/app", fixture: "npm-root", label: "a directory below an npm root" },
        { args: ["dlx", "--no-info", "cowsay"], files: { "vis.config.ts": 'export default { install: { backend: "npm" } };\n' }, fixture: "pnpm-single", label: "a config, which the lean entry never reads" },
        { args: ["dlx", "--no-info", "cowsay"], files: { "vis.config.ts": "export default {{{ not valid\n" }, fixture: "pnpm-root", label: "a config that does not parse" },
        // The nearest lockfile decides whether the runtime is bun, not any lockfile above.
        { args: ["dlx", "--no-info", "cowsay"], directory: "packages/app", files: { "packages/app/pnpm-lock.yaml": "lockfileVersion: 9\n" }, fixture: "bun-single", label: "a pnpm lockfile below a bun lockfile" },
        { args: ["dlx", "--no-info", "cowsay"], directory: "packages/app", files: { "packages/app/bun.lock": "{}\n" }, fixture: "pnpm-single", label: "a bun lockfile below a pnpm lockfile" },
        { args: ["dlx", "--no-info", "cowsay"], files: { "bun.lockb": "" }, fixture: "pnpm-single", label: "a bun.lockb beside a pnpm lockfile" },
        { args: ["dlx", "--no-info", "cowsay"], files: { "bun.lock": "{}\n", "pnpm-lock.yaml": "lockfileVersion: 9\n" }, fixture: "npm-single", label: "three lockfiles in one directory" },
        { args: ["dlx", "--no-info", "cowsay"], files: { ".yarnrc.yml": "nodeLinker: node-modules\n" }, fixture: "pnpm-bare", label: "a yarn config file and no lockfile" },
        { args: ["dlx", "--no-info", "cowsay"], files: { "bunfig.toml": "" }, fixture: "pnpm-bare", label: "a bunfig.toml and no lockfile" },
        // A terminal-less run outside CI is the same run.
        ...["pnpm-single", "npm-single", "bun-single"].map((fixture) => { return { args: ["dlx", "--no-info", "cowsay", "hi"], ci: false, env: { VIS_NO_UPDATE_CHECK: UNSET }, fixture, label: "outside CI, with the update check on" }; }),
        { args: ["dlx", "./local.js"], ci: false, env: { VIS_NO_UPDATE_CHECK: UNSET }, fixture: "pnpm-single", label: "a path outside CI, with the update check on" },
        // A user agent in the environment names a manager without a version; neither side lets it pick the manager.
        { args: ["dlx", "--no-info", "cowsay"], env: { npm_config_user_agent: "yarn/1.22.19 npm/? node/v22.23.4 darwin arm64" }, fixture: "yarn-single", label: "a yarn user agent" },
        { args: ["dlx", "--no-info", "cowsay"], env: { npm_config_user_agent: "npm/10.0.0 node/v22.23.4 darwin arm64" }, fixture: "pnpm-single", label: "an npm user agent" },
        // Colours and terminal settings change nothing the native path prints: it prints nothing of its own.
        ...[{ FORCE_COLOR: "1" }, { GITHUB_ACTIONS: "true" }, { TERM: "xterm-256color" }, { NO_COLOR: "1" }, { COLUMNS: "20" }, { NODE_ENV: "test" }, { NODE_ENV: "debug" }, { PAIL_LOG_LEVEL: "error" }, { VERBOSE: "1" }, { LOG_LEVEL: "debug" }, { DEBUG_COLORS: "1" }, { NODE_DEBUG: "x" }, { VIS_MONOREPO_ROOT: "/elsewhere" }].map((env) => {
            return { args: ["dlx", "--no-info", "cowsay", "hi"], env, fixture: "pnpm-single", label: `environment ${JSON.stringify(env)}` };
        }),
        // The exit code is the manager's, whatever it is.
        ...["1", "2", "130"].map((code) => { return { args: ["dlx", "--no-info", "cowsay"], env: { STUB_EXIT: code }, fixture: "pnpm-single", label: `exit code ${code}` }; }),
        { args: ["dlx", "--no-info", "cowsay"], env: { STUB_STDERR: "to-stderr", STUB_STDOUT: "to-stdout" }, fixture: "pnpm-single", label: "what the manager prints" },
    ];

    const DLX_DELEGATED_CASES: DelegatedCase[] = [
    // The first-run gate runs: it fetches package metadata and may prompt, which is Node's before any output.
        ...[
            ["dlx", "cowsay"],
            ["dlx", "cowsay", "hi"],
            ["dlx", "--yes", "cowsay"],
            ["dlx", "-y", "cowsay"],
            ["dlx", "--info", "cowsay"],
            ["dlx", "--offline", "cowsay"],
            ["dlx", "--silent", "cowsay"],
            ["dlx", "@scope/pkg@1", "a"],
            ["dlx", "-p", "lolcatjs", "-c", "echo hi"],
            ["dlx", "-c", "echo hi", "-p", "lolcatjs", "-s"],
            ["dlx", "-p", "lolcatjs", "-c", "./local.js"],
            ["dlx", "./local.js", "-p", "cowsay", "-s"],
        ].map((args) => { return { args, fixture: "pnpm-single", label: `vis ${args.join(" ")}` }; }),
        ...[{ VIS_DLX_YES: "1" }, { VIS_DLX_NO_INFO: "0" }, { VIS_DLX_NO_INFO: "false" }, { VIS_DLX_NO_INFO: "" }, { VIS_DLX_NO_INFO: "no" }, { VIS_DLX_NO_INFO: " 1" }, { VIS_DLX_NO_INFO: "　" }].map((env) => {
            return { args: ["dlx", "cowsay"], env, fixture: "pnpm-single", label: `environment ${JSON.stringify(env)}` };
        }),
        { args: ["dlx", "cowsay"], ci: false, fixture: "pnpm-single", label: "outside CI" },
        // Shapes of the command line.
        ...[
            ["dlx"],
            ["dlx", "--no-info"],
            ["dlx", "--no-info", "-c"],
            ["dlx", "--no-info", "-p", "a", "b", "c"],
            ["dlx", "--no-info", "-p", "a", "-p", "b", "cowsay"],
            ["dlx", "--no-info", "-p", "a", "--package=b", "cowsay"],
            ["dlx", "--no-info", "--package", "a", "cowsay", "x"],
            ["dlx", "--no-info", "cowsay", "-p", "a"],
            ["dlx", "--no-info", "-p", "-c", "x"],
            ["dlx", "--no-info", "-p", "", "-c", "x"],
            ["dlx", "--no-info", "-p", "-a", "-c", "x"],
            ["dlx", "--no-info", "--package=a", "-c", "x"],
            ["dlx", "--no-info", "cowsay", "--version"],
            ["dlx", "--no-info", "cowsay", "-x"],
            ["dlx", "--no-info", "cowsay", "--template", "react"],
            ["dlx", "--no-info", "cowsay", "--"],
            ["dlx", "--no-info", "cowsay", "--", "--x"],
            ["dlx", "--no-info", "--", "cowsay"],
            ["dlx", "--no-info", "-sc", "echo"],
            ["dlx", "--no-info", "cowsay", "--yes=false"],
            ["dlx", "--no-info", "cowsay", "--silent=true"],
            ["dlx", "--no-info", "cowsay", "-s", "-s"],
            ["dlx", "--no-info", "cowsay", "--silent", "-s"],
            ["dlx", "--no-info", "cowsay", "--offline", "--offline"],
            ["dlx", "--no-info", "--no-info", "cowsay"],
            ["dlx", "--no-info", "--info", "cowsay"],
            ["dlx", "--no-info", "cowsay", "--cwd", "."],
            ["dlx", "--no-info", "cowsay", "--config", "x.ts"],
            ["dlx", "--no-info", "cowsay", "--runtime", "bun"],
            ["dlx", "--no-info", "cowsay", "--no-color"],
            ["dlx", "--no-info", "cowsay", "-v"],
            ["dlx", "--no-info", "cowsay", "-"],
        ].map((args) => { return { args, fixture: "pnpm-single", label: `vis ${args.join(" ")}` }; }),
        // Node warns for these and words it itself.
        { args: ["dlx", "--no-info", "-c", "echo hi"], fixture: "yarn-single", label: "shell mode on yarn berry" },
        { args: ["dlx", "--no-info", "--offline", "cowsay"], fixture: "yarn-single", label: "offline on yarn berry" },
        { args: ["dlx", "--no-info", "--offline", "cowsay"], fixture: "bun-single", label: "offline on bun" },
        // The environment that picks the installer or changes Node's output.
        ...[{ VIS_INSTALLER: "npm" }, { VIS_RUNTIME: "node" }, { VIS_RUNTIME: "bun" }, { DEBUG: "*" }, { DEBUG: "vis" }, { CEREBRO_OUTPUT_LEVEL: "1" }, { CEREBRO_LOG: "x" }, { FORCE_COLOR: "1", NO_COLOR: "1" }, { FORCE_COLOR: "1", NODE_DISABLE_COLORS: "1" }].map((env) => {
            return { args: ["dlx", "--no-info", "cowsay"], env, fixture: "pnpm-single", label: `environment ${JSON.stringify(env)}` };
        }),
        // Pins and markers Node reads.
        { args: ["dlx", "--no-info", "cowsay"], files: { "package.json": JSON.stringify({ ...PACKAGE, packageManager: "pnpm@9.0.0" }) }, fixture: "pnpm-single", label: "a packageManager pin" },
        { args: ["dlx", "--no-info", "cowsay"], directory: "packages/app", files: { "package.json": JSON.stringify({ ...PACKAGE, packageManager: "npm@10.0.0" }), "packages/app/package.json": JSON.stringify(PACKAGE) }, fixture: "pnpm-single", label: "a packageManager pin in an ancestor" },
        { args: ["dlx", "--no-info", "cowsay"], bin: ["aube"], fixture: "pnpm-single", label: "aube on PATH" },
    ];

    describe("vis dlx: native vs Node", () => {
        it.each(DLX_PARITY_CASES.map((parity) => [labelOf(parity), parity] as const))("%s", (_label: string, parity: ParityCase) => {
            expect.assertions(3);

            const { native, node } = compare(parity);

            // The native side answered, with what Node prints, and the comparison is about a manager that ran.
            expect(native.stdout).not.toContain(marker);
            expect(native).toStrictEqual(node);
            expect(node.log).toMatch(/^(bun|npm|pnpm|yarn):/m);
        });

        it.each(DLX_DELEGATED_CASES.map((delegated) => [labelOf(delegated), delegated] as const))("hands %s to Node", (_label: string, delegated: DelegatedCase) => {
            expect.assertions(2);

            const native = runDelegated(delegated);

            // Delegated before the manager runs: a delegation after it ran would run it twice.
            expect(native.stdout).toContain(marker);
            expect(native.log).toBe("");
        });

        it("hands the call to Node when the package manager is not on PATH, where Node reports the failure", () => {
            expect.assertions(1);

            const setup = project("pnpm-single");

            rmSync(join(setup.bindir, "pnpm"));

            expect(runNative(setup, ["dlx", "--no-info", "cowsay"]).stdout).toContain(marker);
        });

        it.each([true, false])("leaves the same files behind as Node, in the project and in HOME (CI: %s)", (ci: boolean) => {
            expect.assertions(2);

            const [native, node, before] = sameFilesAsNode("pnpm-single", ["dlx", "--no-info", "cowsay", "hi"], ci);

            expect(native).toStrictEqual(node);
            expect(node).toStrictEqual(before);
        });

        it("hands the manager the real stdin, stdout, stderr and exit code", () => {
            expect.assertions(5);

            const run = runNative(project("pnpm-single"), ["dlx", "--no-info", "cowsay"], { STUB_EXIT: "7", STUB_STDERR: "to-stderr", STUB_STDIN: "1", STUB_STDOUT: "to-stdout" }, true, "from-stdin\n");

            expect(run.stdout).toBe("to-stdout\n");
            expect(run.stderr).toBe("to-stderr\n");
            expect(run.status).toBe(7);
            expect(run.log).toContain("from-stdin");
            expect(run.log).toContain("pnpm:dlx cowsay");
        });
    });
});
