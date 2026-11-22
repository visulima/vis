import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `vis sync ci-workflow` exists twice: the Node generator (`src/commands/sync/handler.ts` over
 * `src/util/ci-workflow/`) and the native one (`native/cli/src/ci_workflow/`). Every fixture below is built
 * here, three times (one directory for Node, one for the binary, one for the probe, because a write run
 * changes its directory), and runs through both with the same arguments and CI context. Stdout, stderr, the
 * exit code and the files written must match. The probe run's fallback entry is a stub that prints a marker,
 * so a run that quietly delegated is caught: the marker must be absent exactly when the native path is
 * expected to answer.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const marker = "NATIVE-DELEGATED";
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

// The variables that make Node colour its output and make the binary delegate (`colour_may_be_forced` and
// `term::color_enabled`). A CI runner sets several of them (GITHUB_ACTIONS, GITHUB_WORKFLOW, TERM), which
// would send every native case to Node, so none of them may reach the child.
const COLOUR_ENVIRONMENT = [
    "APPVEYOR",
    "BUILDKITE",
    "CIRCLECI",
    "CI_NAME",
    "COLORTERM",
    "DRONE",
    "FORCE_COLOR",
    "GITEA_ACTIONS",
    "GITHUB_ACTIONS",
    "GITHUB_WORKFLOW",
    "GITLAB_CI",
    "PM2_HOME",
    "TEAMCITY_VERSION",
    "TERM",
    "TERMINAL_EMULATOR",
    "TERM_PROGRAM",
    "TF_BUILD",
    "TRAVIS",
];

// What changes Node's output apart from the arguments: the CI marker, colour, and test mode.
const DROPPED_ENVIRONMENT = new Set([
    ...COLOUR_ENVIRONMENT,
    "CI",
    "COLUMNS",
    "CONTINUOUS_INTEGRATION",
    "DEBUG",
    "NODE_ENV",
    "PAIL_LOG_LEVEL",
    "VIS_FALLBACK_ENTRY",
    "VIS_FALLBACK_ENTRY_OVERRIDE",
    "VIS_MONOREPO_ROOT",
    "VIS_VERSION",
    ...Object.keys(process.env).filter((key) => key.startsWith("CEREBRO_")),
]);

const contextEnvironment = (ci: boolean, extra: Record<string, string> = {}): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED_ENVIRONMENT.has(key)));

    env["VIS_NO_UPDATE_CHECK"] = "1";

    if (ci) {
        env["CI"] = "1";
    }

    return { ...env, ...extra };
};

interface Run {
    status: number | null;
    stderr: string;
    stdout: string;
}

/** Runs a command with stdout and stderr redirected to files, as the other parity tests do. */
const capture = (command: string, args: string[], directory: string, env: Record<string, string | undefined>): Run => {
    const name = randomUUID();
    const out = join(directory, "..", `${name}.out`);
    const err = join(directory, "..", `${name}.err`);
    const outFd = openSync(out, "w");
    const errFd = openSync(err, "w");

    try {
        const { status } = spawnSync(command, args, { cwd: directory, env, stdio: ["ignore", outFd, errFd] });

        return { status, stderr: readFileSync(err, "utf8"), stdout: readFileSync(out, "utf8") };
    } finally {
        closeSync(outFd);
        closeSync(errFd);
    }
};

const runNode = (directory: string, args: string[], env: Record<string, string | undefined>): Run => capture(process.execPath, [nodeEntry, "sync", "ci-workflow", ...args], directory, env);

const runNative = (directory: string, args: string[], env: Record<string, string | undefined>, entry: string): Run =>
    // A binary in a platform package keeps the entry and version the launcher passes; one inside the vis
    // package (a dev copy) takes the override instead. Set both.
    capture(binary as string, ["sync", "ci-workflow", ...args], directory, {
        ...env,
        VIS_FALLBACK_ENTRY: entry,
        VIS_FALLBACK_ENTRY_OVERRIDE: entry,
        VIS_NODE: process.execPath,
        VIS_VERSION: version,
    });

type Files = Record<string, string>;

const SCRIPTS = { build: "tsc", lint: "eslint .", test: "vitest run" };

/** A pnpm workspace the native gate accepts: two projects with scripts, the lockfile and the workspace file. */
const workspace = (extra: Files = {}): Files => {
    return {
        "package.json": JSON.stringify({ name: "fixture", private: true }),
        "packages/a/package.json": JSON.stringify({ name: "a", scripts: SCRIPTS, version: "1.0.0" }),
        "packages/b/package.json": JSON.stringify({ dependencies: { a: "workspace:*" }, name: "b", scripts: { build: "tsc", test: "vitest run" }, version: "1.0.0" }),
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
        "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
        ...extra,
    };
};

const config = (source: string): Files => {
    return { "vis.config.ts": `export default ${source};\n` };
};

/** Everything `ci.workflow` can say, in an order that is not alphabetical. */
const FULL_CONFIG = String.raw`{
    defaultBase: "trunk",
    taskRunner: { cacheDirectory: ".cache/vis" },
    toolchain: { tools: { node: "24", python: "3.13" } },
    tasks: {
        build: { dependsOn: ["^build"] },
        test: { cache: true, dependsOn: ["^build", { target: "codegen" }] },
    },
    ci: {
        workflow: {
            providers: ["gitlab", "github"],
            branches: ["main", "release/*", "v1.x/**", "it's"],
            runsOn: "ubuntu-24.04",
            nodeVersion: "20",
            timeoutMinutes: 45,
            targets: ["lint", { name: "build", env: { NODE_OPTIONS: "--max-old-space-size=4096", A_FIRST: "1" } }, "test"],
            partitions: { test: 3 },
            github: {
                env: { ZED: "z", ALPHA: "a" },
                permissions: { "id-token": "write", contents: "write" },
                services: {
                    postgres: { image: "postgres:17", env: { POSTGRES_PASSWORD: "postgres" }, ports: ["5432:5432", 6379], options: "--health-cmd pg_isready" },
                },
                steps: {
                    afterSetup: [
                        { name: "Start services", run: "docker compose up -d\nsleep 1\n", "working-directory": "infra", shell: "bash", env: { X: "1" }, "continue-on-error": true, "timeout-minutes": 7.5, if: "always()" },
                    ],
                    after: [
                        { name: "Upload", uses: "actions/upload-artifact@abc", with: { path: "coverage", "retention-days": 3, "if-no-files-found": "ignore", flag: true, ratio: 0.5, big: 1e21, negative: -2 }, comment: "line one\nline two" },
                    ],
                },
            },
            gitlab: {
                image: "node:20-slim",
                stage: "verify",
                tags: ["docker", "linux"],
                variables: { FOO: "bar", "WEIRD KEY": "x" },
                beforeScript: ["echo hi", "echo 'quoted'"],
                afterScript: ["echo done"],
                services: ["redis:7", { name: "postgres:17", alias: "db", command: ["a", "b"], variables: { P: "1" } }],
            },
        },
    },
}`;

interface Fixture {
    args: string[];
    ci?: boolean;
    /** Extra environment for the run (on top of CI). */
    env?: Record<string, string>;
    files: Files;
    /** Changes each copy after the seed run. */
    mutate?: (directory: string) => void;
    /** Whether the binary answers it itself. Everything else must delegate. */
    native: boolean;
    /** Runs before the case, with Node, in each copy (to write the files a `--check` reads). */
    seed?: string[];
}

const append = (path: string, text: string) => (directory: string) => { writeFileSync(join(directory, path), `${readFileSync(join(directory, path), "utf8")}${text}`); };

const BOTH = ["--provider=github,gitlab"];
const GITHUB_DIR = { ".github/workflows/keep.yml": "name: keep\n" };

// Grouped by what they show (native, `--check`, delegated), not alphabetically.
/* eslint-disable perfectionist/sort-objects */
const fixtures: Record<string, Fixture> = {
    // Native.
    "existing github workflows directory": { args: [], files: workspace(GITHUB_DIR), native: true },
    "existing gitlab file": { args: [], files: workspace({ ".gitlab-ci.yml": "stages: [test]\n" }), native: true },
    "both existing": { args: [], files: workspace({ ...GITHUB_DIR, ".gitlab/vis-ci.gitlab-ci.yml": "x: 1\n" }), native: true },
    "provider flag, both": { args: BOTH, files: workspace(), native: true },
    "provider flag, spaced and repeated": { args: ["--provider", "gitlab", "--provider=github,gitlab"], files: workspace(), native: true },
    "gitlab only": { args: ["--provider=gitlab"], files: workspace(), native: true },
    "the full config": { args: [], files: workspace(config(FULL_CONFIG)), native: true },
    "the full config, github only": { args: ["--provider=github"], files: workspace(config(FULL_CONFIG)), native: true },
    "config providers": { args: [], files: workspace(config('{ ci: { workflow: { providers: ["github", "gitlab"] } } }')), native: true },
    "affected off, no build first, no drift check": {
        args: BOTH,
        files: workspace(config("{ ci: { workflow: { affected: false, buildFirst: false, checkDrift: false } } }")),
        native: true,
    },
    "dependsOn from the task defaults": {
        args: BOTH,
        files: workspace(config("{ tasks: { test: { dependsOn: ['build'] }, build: { dependsOn: ['^build'] } }, ci: { workflow: { targets: ['test', 'lint', 'build'], partitions: { test: 2 } } } }")),
        native: true,
    },
    "a target with a colon and one that needs quoting": {
        args: BOTH,
        files: workspace({
            "packages/a/package.json": JSON.stringify({ name: "a", scripts: { "lint:types": "tsc", "weird name": "x" }, version: "1.0.0" }),
            ...config("{ ci: { workflow: { targets: ['lint:types', 'weird name'] } } }"),
        }),
        native: true,
    },
    "strings that need escaping": {
        args: BOTH,
        files: workspace(
            config(
                String.raw`{ ci: { workflow: { runsOn: "a\"b\\c\td\u0001é☃\u2028", branches: ["x\ty", "é*"], github: { env: { 'quo"te': 'va\\lue', 'sp ace': "multi\nline" }, steps: { after: [{ name: "n\u007f", run: "echo \"hi\"" }] } }, gitlab: { variables: { 'a b': "c\td" } } } } }`,
            ),
        ),
        native: true,
    },
    "a thousand shards": { args: ["--provider=github"], files: workspace(config("{ ci: { workflow: { partitions: { test: 1000 } } } }")), native: false },
    "a bun lockfile next to the pnpm one": { args: BOTH, files: workspace({ "bun.lock": "{}\n" }), native: true },
    "python, ruby and dotnet projects": {
        args: BOTH,
        files: workspace({
            ".python-version": "3.12\n",
            ".ruby-version": "3.3\n",
            Gemfile: "source 'https://rubygems.org'\n",
            "global.json": "{}\n",
            "packages/a/requirements.txt": "x\n",
            "packages/b/setup.py": "x\n",
        }),
        native: true,
    },
    "pinned python and ruby": {
        args: BOTH,
        files: workspace({
            Pipfile: "x\n",
            "packages/a/Gemfile": "x\n",
            ...config("{ toolchain: { tools: { python: '3.13', ruby: '3.4' } } }"),
        }),
        native: true,
    },
    "a dotnet solution in a project": {
        args: BOTH,
        files: workspace({ "packages/a/app.sln": "x\n", "packages/b/global.json": "{}\n" }),
        native: true,
    },
    "a script-less project": {
        args: BOTH,
        files: workspace({ "packages/c/package.json": JSON.stringify({ name: "c", version: "1.0.0" }) }),
        native: true,
    },
    "a target defaults only some projects define": {
        args: BOTH,
        files: workspace({ "packages/a/package.json": JSON.stringify({ name: "a", scripts: { typecheck: "tsc", "lint:types": "tsc" }, version: "1.0.0" }) }),
        native: true,
    },
    // `--check`, after Node wrote the files.
    "check, up to date": { args: [...BOTH, "--check"], files: workspace(config(FULL_CONFIG)), native: true, seed: [] },
    "check, up to date, found files": { args: ["--check"], files: workspace(GITHUB_DIR), native: true, seed: ["--provider=github"] },
    "check, a missing file": {
        args: ["--check", ...BOTH],
        files: workspace(),
        mutate: (directory) => { rmSync(join(directory, ".gitlab"), { force: true, recursive: true }); },
        native: true,
        seed: BOTH,
    },
    "check, every file missing": { args: ["--check", ...BOTH], files: workspace(), native: true },
    // Delegated, and compared.
    "check, a differing file": { args: [...BOTH, "--check"], files: workspace(), mutate: append(".github/workflows/vis-ci.yml", "    # hand edit\nextra: 1\n"), native: false, seed: BOTH },
    "check, a file that only differs in YAML syntax": {
        args: [...BOTH, "--check"],
        files: workspace(),
        mutate: append(".gitlab/vis-ci.gitlab-ci.yml", "# a comment\n"),
        native: false,
        seed: BOTH,
    },
    "no provider anywhere": { args: [], files: workspace(), native: false },
    "an unknown provider": { args: ["--provider=circle"], files: workspace(), native: false },
    "an empty provider flag": { args: ["--provider="], files: workspace(), native: false },
    "a dynamic config": { args: BOTH, files: workspace(config("{ ci: { workflow: { runsOn: process.env.RUNNER ?? 'x' } } }")), native: false },
    "a config key that can change the targets": { args: BOTH, files: workspace(config("{ inferTargets: false }")), native: false },
    "a task default that makes a target": { args: BOTH, files: workspace(config("{ tasks: { check: { command: 'echo' } } }")), native: false },
    "an unknown workflow key": { args: BOTH, files: workspace(config("{ ci: { workflow: { cache: true } } }")), native: false },
    "a target no project defines": { args: BOTH, files: workspace(config("{ ci: { workflow: { targets: ['nope'] } } }")), native: false },
    "a bad partition": { args: BOTH, files: workspace(config("{ ci: { workflow: { partitions: { test: 1.5 } } } }")), native: false },
    "a group of eleven shards": { args: ["--provider=github"], files: workspace(config("{ ci: { workflow: { partitions: { test: 11 } } } }")), native: false },
    "a cache directory outside the project, for gitlab": { args: ["--provider=gitlab"], files: workspace(config("{ taskRunner: { cacheDirectory: '../cache' } }")), native: false },
    "a project.json": { args: BOTH, files: workspace({ "packages/a/project.json": JSON.stringify({ name: "a" }) }), native: false },
    "an inference marker": { args: BOTH, files: workspace({ "packages/a/vite.config.ts": "export default {};\n" }), native: false },
    "a rust crate": { args: BOTH, files: workspace({ "packages/b/Cargo.toml": '[package]\nname = "b"\nversion = "0.1.0"\n' }), native: false },
    "a root project": { args: BOTH, files: workspace({ "pnpm-workspace.yaml": 'packages:\n  - "."\n  - "packages/*"\n' }), native: false },
    // Node reads the config of the workspace root only; the binary does not guess about one above it.
    "a config above the workspace root": { args: BOTH, files: workspace({ "../vis.config.ts": "export default {};\n" }), native: false },
    "outside CI": { args: BOTH, ci: false, files: workspace(), native: false },
    "with FORCE_COLOR": { args: BOTH, env: { FORCE_COLOR: "1" }, files: workspace(), native: false },
    "with NODE_ENV=test": { args: BOTH, env: { NODE_ENV: "test" }, files: workspace(), native: false },
    "with DEBUG": { args: BOTH, env: { DEBUG: "1" }, files: workspace(), native: false },
    "with a CEREBRO_ variable": { args: BOTH, env: { CEREBRO_OUTPUT_LEVEL: "16" }, files: workspace(), native: false },
    "with PAIL_LOG_LEVEL": { args: BOTH, env: { PAIL_LOG_LEVEL: "error" }, files: workspace(), native: false },
    "an extra flag": { args: [...BOTH, "--format=json"], files: workspace(), native: false },
    "--check twice": { args: [...BOTH, "--check", "--check"], files: workspace(), native: false },
};
/* eslint-enable perfectionist/sort-objects */

const write = (root: string, files: Files): void => {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
};

/** Every file under the generated-workflow directories, by path. */
const written = (root: string): Record<string, string> => {
    const found: Record<string, string> = {};
    const walk = (directory: string): void => {
        if (!existsSync(directory)) {
            return;
        }

        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(path);
            } else {
                found[relative(root, path)] = readFileSync(path, "utf8");
            }
        }
    };

    walk(join(root, ".github"));
    walk(join(root, ".gitlab"));

    return found;
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis sync ci-workflow: native vs Node", () => {
    const paths = { scratch: "", stub: "" };

    beforeAll(() => {
        paths.scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-ci-workflow-parity-")));
        paths.stub = join(paths.scratch, "stub.mjs");

        writeFileSync(paths.stub, `console.log("${marker}");\nprocess.exit(99);\n`);
    });

    afterAll(() => {
        rmSync(paths.scratch, { force: true, recursive: true });
    });

    /** Three identical copies of a fixture, each with the Node-written files a `--check` case reads. */
    const prepare = (name: string, fixture: Fixture): { native: string; node: string; probe: string } => {
        const base = join(paths.scratch, name.replaceAll(/\W+/gu, "-"));
        const directories = { native: join(base, "native"), node: join(base, "node"), probe: join(base, "probe") };

        for (const directory of Object.values(directories)) {
            mkdirSync(directory, { recursive: true });
            write(directory, fixture.files);

            if (fixture.seed !== undefined) {
                // The full-config check case seeds with no arguments: its providers come from the config.
                const seeded = runNode(directory, fixture.seed, contextEnvironment(true));

                if (seeded.status !== 0) {
                    throw new Error(`seeding ${name} failed: ${seeded.stderr}`);
                }
            }

            fixture.mutate?.(directory);
        }

        return directories;
    };

    it.each(Object.entries(fixtures))("%s matches Node", (name, fixture) => {
        expect.assertions(7);

        const directories = prepare(name, fixture);
        const env = contextEnvironment(fixture.ci ?? true, fixture.env);
        const node = runNode(directories.node, fixture.args, env);
        const probe = runNative(directories.probe, fixture.args, env, paths.stub);

        // The stub probe shows which path answers: the marker appears only on delegation.
        expect(probe.stdout.includes(marker)).toBe(!fixture.native);

        const native = runNative(directories.native, fixture.args, env, nodeEntry);

        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe(node.stderr);
        expect(native.status).toBe(node.status);
        expect(written(directories.native)).toStrictEqual(written(directories.node));
        // A guard against a vacuous pass: Node answered the case, not an unrelated failure.
        expect(node.stdout + node.stderr).not.toBe("");
        expect(node.stderr).not.toContain("    at ");
    });

    it("answers the full config natively with the files Node writes for it", () => {
        expect.assertions(4);

        const directories = prepare("full-config-files", { args: [], files: workspace(config(FULL_CONFIG)), native: true });
        const env = contextEnvironment(true);

        runNode(directories.node, [], env);
        runNative(directories.native, [], env, nodeEntry);

        const files = written(directories.native);

        expect(Object.keys(files).toSorted()).toStrictEqual([".github/workflows/vis-ci.yml", ".gitlab/vis-ci.gitlab-ci.yml"]);
        expect(files).toStrictEqual(written(directories.node));
        expect(files[".github/workflows/vis-ci.yml"]).toContain("# line one\n            # line two\n");
        expect(files[".gitlab/vis-ci.gitlab-ci.yml"]).toContain("parallel: 3");
    });
});
