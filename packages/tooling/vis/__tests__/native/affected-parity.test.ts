import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { DELEGATED_COLOUR_ENVIRONMENTS, SHORT_COLOUR_ENVIRONMENTS, withoutColour } from "./colour-environments";

/**
 * `vis affected` exists twice: the Node handler (`src/commands/affected/handler.ts`) and the native
 * `--sparse-checkout` answer (`native/cli/src/affected.rs`). A throwaway git repository holds a small
 * monorepo with a few commits, a dirty working tree and fake remote refs. Every case runs through both
 * implementations in the same CI context, and the stdout, stderr and exit status must match. The binary's
 * fallback entry is a stub that prints a marker for the probe run, so a run that quietly delegated is
 * caught: the marker must be absent exactly when the case is expected to be answered natively.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const marker = "NATIVE-DELEGATED";
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

const PROVIDER_ENVIRONMENT = /^(?:BUILD_|BUILDKITE|CI$|CI_|CIRCLE|CONTINUOUS_INTEGRATION$|GIT_|GITHUB_|GITLAB_CI$|SYSTEM_|TF_BUILD$)/u;

const KEPT_GIT_CONFIG = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
const DROPPED = new Set(["VIS_FALLBACK_ENTRY", "VIS_FALLBACK_ENTRY_OVERRIDE", "VIS_VERSION"]);

// The runner's own colour variables are dropped (a CI runner sets several), and a case adds the one it tests.
const baseEnvironment = (): Record<string, string | undefined> =>
    Object.fromEntries(
        Object.entries({
            ...withoutColour(process.env),
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            VIS_CLI_TEST: "1",
            VIS_NO_UPDATE_CHECK: "1",
        }).filter(([key]) => !DROPPED.has(key) && (KEPT_GIT_CONFIG.has(key) || !PROVIDER_ENVIRONMENT.test(key))),
    );

// A delegated error path prints a Node stack, whose async frames differ from one run to the next. Only V8 frames
// (`at fn (file:1:2)`, `at file:1:2`, `at async fn (file:1:2)`, optionally followed by the `{` that opens the error's properties) are dropped, so any other indented line still has to match.
// With `FORCE_COLOR` (CI sets it) Node greys each frame with an SGR pair around the line, which the pattern allows for; every other colour code is still compared.
const SGR = String.raw`(?:${String.fromCodePoint(27)}\[[\d;]*m)*`;
const stackFrame = new RegExp(String.raw`^${SGR}\s+at (?:.+ \(.*:\d+:\d+\)|(?:async )?[^\s()]+:\d+:\d+)${SGR}(?: \{)?\n`, "gmu");
const withoutStackFrames = (stderr: string): string => stderr.replaceAll(stackFrame, "").replaceAll(/\(node:\d+\)/g, "(node:PID)");

/** Repositories whose `project.json` carries config the native selection does not reproduce. */
type Fixture = "external-input" | "implicit-dependency";

interface Case {
    args: string[];
    /** Working directory inside the repository; defaults to its root. */
    cwd?: string;
    /** Extra environment; values may use `{sha:&lt;tag>}`, `{payload}` and `{payload:&lt;name>}`. */
    env?: Record<string, string>;
    /** The repository the case runs in; defaults to the main one. */
    fixture?: Fixture;
    /** Whether the binary answers it natively. Everything else must delegate and still match. */
    native: boolean;
    /** Defaults to a CI context. */
    outsideCi?: boolean;
}

const sparse = ["affected", "build", "--sparse-checkout"];

const cases: Case[] = [
    // Ref ranges. `v1`..`v5` tag the commits, `origin/main` sits on `v1` and `origin/dev` on `v2`.
    { args: [...sparse, "--base=v1", "--head=v2"], native: true },
    { args: [...sparse, "--base=v2", "--head=v3"], native: true },
    { args: [...sparse, "--base=v3", "--head=v4"], native: true },
    { args: [...sparse, "--base=v4", "--head=v5"], native: true },
    { args: [...sparse, "--base=v1", "--head=v5"], native: true },
    { args: [...sparse, "--base", "v1", "--head", "v5"], native: true },
    { args: [...sparse, "--base=v5", "--head=v5"], native: true },
    { args: [...sparse, "--base=v1", "--head=HEAD~2"], native: true },
    { args: [...sparse, "--base=origin/dev", "--head=v3"], native: true },
    { args: [...sparse, "--base=v1"], native: true },
    { args: [...sparse], native: true },
    // Scopes.
    { args: [...sparse, "--base=v1", "--head=v2", "--downstream=none"], native: true },
    { args: [...sparse, "--base=v1", "--head=v2", "--downstream=direct"], native: true },
    { args: [...sparse, "--base=v1", "--head=v2", "--downstream=deep"], native: true },
    { args: [...sparse, "--base=v1", "--head=v2", "--downstream", "none", "--upstream", "none"], native: true },
    { args: [...sparse, "--base=v2", "--head=v3", "--upstream=direct"], native: true },
    { args: [...sparse, "--base=v2", "--head=v3", "--upstream=deep", "--downstream=none"], native: true },
    { args: [...sparse, "--base=v2", "--head=v3", "--upstream=deep"], native: true },
    // The working tree.
    { args: [...sparse, "--base=v5", "--uncommitted"], native: true },
    { args: [...sparse, "--base=v5", "--no-uncommitted"], native: true },
    { args: [...sparse, "--base=v1", "--uncommitted"], native: true },
    { args: [...sparse, "--base=v1", "--head=HEAD", "--uncommitted", "--downstream=none"], native: true },
    { args: [...sparse, "--base=v5", "--uncommitted", "--downstream=none"], native: true },
    { args: [...sparse, "--base=v1", "--head=v2", "--uncommitted"], native: true },
    { args: [...sparse, "--uncommitted"], native: true },
    // CI providers.
    { args: [...sparse], env: { GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "dev", GITHUB_SHA: "{sha:v5}" }, native: true },
    { args: [...sparse], env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: "{payload}" }, native: true },
    // A merge queue payload names its base in `merge_group.base_sha`, which wins over `before`.
    { args: [...sparse], env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: "{payload:merge-group}", GITHUB_SHA: "{sha:v5}" }, native: true },
    { args: [...sparse], env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: "{payload:merge-group-only}" }, native: true },
    { args: [...sparse], env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: "{payload:merge-group-zero}" }, native: true },
    { args: [...sparse], env: { GITHUB_ACTIONS: "true" }, native: true },
    { args: [...sparse], env: { CI_COMMIT_BEFORE_SHA: "{sha:v3}", CI_COMMIT_SHA: "{sha:v5}", GITLAB_CI: "true" }, native: true },
    { args: [...sparse], env: { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev", CI_PIPELINE_SOURCE: "merge_request_event", GITLAB_CI: "true" }, native: true },
    { args: [...sparse], env: { CI_COMMIT_BEFORE_SHA: "0000000000000000000000000000000000000000", GITLAB_CI: "true" }, native: true },
    { args: [...sparse], env: { BUILDKITE: "true", BUILDKITE_COMMIT: "{sha:v4}", BUILDKITE_PULL_REQUEST_BASE_BRANCH: "dev" }, native: true },
    { args: [...sparse], env: { CIRCLE_PR_BASE_BRANCH: "dev", CIRCLECI: "true" }, native: true },
    { args: [...sparse], env: { SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/dev", TF_BUILD: "True" }, native: true },
    // The selection prints no colour of its own: where Node's colour detection turns colour on, the output is the same. The Node
    // runtime warns on stderr, with its process id, when `FORCE_COLOR` and `NO_COLOR` are both set, which stays Node's.
    ...SHORT_COLOUR_ENVIRONMENTS.map((env): Case => { return { args: [...sparse, "--base=v1", "--head=v2"], env, native: true }; }),
    ...DELEGATED_COLOUR_ENVIRONMENTS.map((env): Case => { return { args: [...sparse, "--base=v1", "--head=v2"], env, native: false }; }),
    // The root is found from a subdirectory too.
    { args: [...sparse, "--base=v1", "--head=v2"], cwd: "packages/core", native: true },
    { args: [...sparse, "--base=v5", "--uncommitted"], cwd: "apps/web", native: true },
    // Shapes and inputs Node owns.
    { args: [...sparse, "--base=nope", "--head=v2"], native: false },
    { args: [...sparse, "--base=v1", "--head=nope"], native: false },
    { args: [...sparse, "--base=v1", "--head=v2", "--downstream=sideways"], native: false },
    { args: [...sparse, "--base=v1", "--head=v2", "--upstream=up"], native: false },
    { args: [...sparse, "--base=has space", "--head=v2"], native: false },
    { args: [...sparse, "--base=v1", "--head=v2", "--query=language=typescript"], native: false },
    { args: [...sparse, "--base=v1", "--head=v2", "--tag=lib"], native: false },
    { args: [...sparse, "--base=v1", "--head=v2", "--base=v2"], native: false },
    { args: [...sparse, "--base=", "--head=v2"], native: false },
    { args: ["affected", "--sparse-checkout"], native: false },
    { args: ["affected"], native: false },
    { args: [...sparse, "--base=v1", "--head=v2", "--parallel=2"], native: false },
    { args: [...sparse, "--base=v1", "--head=v2"], native: false, outsideCi: true },
    // `project.json` config the native selection cannot reproduce. Node selects `lib` from an external input with no stored
    // hash snapshot (nothing changed in git), and `app` from an implicit dependency (`lib` changed in git).
    { args: [...sparse, "--base=v1", "--head=v1"], fixture: "external-input", native: false },
    { args: [...sparse, "--base=v1", "--head=v2"], fixture: "external-input", native: false },
    { args: [...sparse, "--base=v1", "--head=v2"], fixture: "implicit-dependency", native: false },
    { args: [...sparse, "--base=v1", "--head=v2", "--downstream=direct"], fixture: "implicit-dependency", native: false },
];

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis affected: native vs Node", () => {
    const paths = { fixtures: {} as Record<Fixture, string>, payload: "", payloads: {} as Record<string, string>, repository: "", scratch: "", shared: "", stub: "" };
    const shas: Record<string, string> = {};

    const git = (args: string[], cwd = paths.repository): string => {
        const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...baseEnvironment() } });

        if (result.status !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
        }

        return result.stdout.trim();
    };

    const write = (file: string, content: string, repository = paths.repository): void => {
        const path = join(repository, file);

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    };

    const commit = (message: string, tag: string, repository = paths.repository): void => {
        git(["add", "--all"], repository);
        git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message], repository);
        git(["tag", tag], repository);

        if (repository === paths.repository) {
            shas[tag] = git(["rev-parse", "HEAD"], repository);
        }
    };

    // A small workspace with `lib` and `app` (no package.json edge between them) whose `project.json` files come from
    // `projectJson`. `v1` is the initial commit and `v2` changes `lib`.
    const createFixture = (name: Fixture, projectJson: Record<string, Record<string, unknown>>): string => {
        const repository = join(paths.scratch, name);

        mkdirSync(repository);
        git(["init", "--quiet", "-b", "main"], repository);

        write("package.json", '{"name":"fixture-root","private":true}\n', repository);
        write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n', repository);
        write("pnpm-lock.yaml", "lockfileVersion: 9\n", repository);
        write("packages/lib/package.json", manifest("lib"), repository);
        write("packages/lib/index.ts", "export const lib = 1;\n", repository);
        write("packages/app/package.json", manifest("app"), repository);
        write("packages/app/index.ts", "export const app = 1;\n", repository);

        for (const [project, config] of Object.entries(projectJson)) {
            write(`packages/${project}/project.json`, `${JSON.stringify(config)}\n`, repository);
        }

        commit("initial", "v1", repository);
        git(["update-ref", "refs/remotes/origin/main", "HEAD"], repository);

        write("packages/lib/index.ts", "export const lib = 2;\n", repository);
        commit("lib", "v2", repository);

        return repository;
    };

    const manifest = (name: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ name, scripts: { build: "echo build" }, ...extra })}\n`;

    beforeAll(() => {
        paths.scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-affected-parity-")));
        paths.stub = join(paths.scratch, "stub.mjs");
        paths.repository = join(paths.scratch, "repo");
        paths.payload = join(paths.scratch, "event.json");

        writeFileSync(paths.stub, `console.log("${marker}");\nprocess.exit(99);\n`);
        mkdirSync(paths.repository);

        git(["init", "--quiet", "-b", "main"]);

        write("package.json", '{"name":"affected-root","private":true}\n');
        write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "apps/*"\n');
        write("pnpm-lock.yaml", "lockfileVersion: 9\n");
        write("README.md", "# root\n");
        // core <- utils <- ui(dev) <- web ; core <- peer(peer) ; utils <- cli(bin) ; solo stands alone.
        write("packages/core/package.json", manifest("core"));
        write("packages/core/src/index.ts", "export const core = 1;\n");
        write("packages/core/x.ts", "export const x = 1;\n");
        write("packages/utils/package.json", manifest("utils", { dependencies: { core: "workspace:*" } }));
        write("packages/utils/a.ts", "export const a = 1;\n");
        write("packages/ui/package.json", manifest("ui", { devDependencies: { utils: "workspace:*" } }));
        write("packages/ui/ui.ts", "export const ui = 1;\n");
        write("packages/peer/package.json", manifest("peer", { peerDependencies: { core: "workspace:*" } }));
        write("packages/solo/package.json", manifest("solo"));
        write("packages/solo/index.ts", "export const solo = 1;\n");
        write("apps/web/package.json", manifest("web", { dependencies: { ui: "workspace:*" } }));
        write("apps/cli/package.json", manifest("cli", { bin: "./cli.js", dependencies: { utils: "workspace:*" } }));
        commit("initial", "v1");

        git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

        write("packages/core/src/index.ts", "export const core = 2;\n");
        commit("core", "v2");
        git(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

        write("packages/solo/index.ts", "export const solo = 2;\n");
        write("apps/cli/cli.js", "#!/usr/bin/env node\n");
        commit("solo and cli", "v3");

        write("README.md", "# root, changed\n");
        commit("root file", "v4");

        git(["mv", "packages/utils/a.ts", "packages/solo/a.ts"]);
        commit("rename across packages", "v5");

        // A dirty working tree: a tracked edit, a staged rename across packages, untracked files inside
        // and outside every project.
        write("packages/ui/ui.ts", "export const ui = 2;\n");
        git(["mv", "packages/core/x.ts", "packages/peer/x.ts"]);
        write("packages/peer/new.ts", "export const n = 1;\n");
        write("notes.md", "scratch\n");

        writeFileSync(paths.payload, JSON.stringify({ before: shas["v3"] }));

        const zero = "0".repeat(40);

        for (const [name, payload] of Object.entries({
            "merge-group": { before: shas["v3"], merge_group: { base_sha: shas["v2"] } },
            "merge-group-only": { merge_group: { base_sha: shas["v2"] } },
            "merge-group-zero": { before: shas["v3"], merge_group: { base_sha: zero } },
        })) {
            paths.payloads[name] = join(paths.scratch, `event-${name}.json`);
            writeFileSync(paths.payloads[name] as string, JSON.stringify(payload));
        }

        paths.shared = join(paths.scratch, "shared");
        mkdirSync(paths.shared);
        writeFileSync(join(paths.shared, "data.txt"), "shared input\n");

        paths.fixtures["external-input"] = createFixture("external-input", {
            lib: { name: "lib", targets: { build: { inputs: ["{workspaceRoot}/../shared/**"] } } },
        });
        paths.fixtures["implicit-dependency"] = createFixture("implicit-dependency", { app: { implicitDependencies: ["lib"], name: "app" } });
    });

    afterAll(() => {
        rmSync(paths.scratch, { force: true, recursive: true });
    });

    const environmentFor = (testCase: Case): Record<string, string | undefined> => {
        const env = baseEnvironment();

        if (!testCase.outsideCi) {
            env["CI"] = "1";
        }

        for (const [key, value] of Object.entries(testCase.env ?? {})) {
            env[key] = value.replace(/\{sha:(\w+)\}/u, (_, tag: string) => shas[tag] as string).replace(/\{payload:([\w-]+)\}/u, (_, name: string) => paths.payloads[name] as string).replace("{payload}", paths.payload);
        }

        return env;
    };

    const repositoryOf = (testCase: Case): string => (testCase.fixture ? paths.fixtures[testCase.fixture] : paths.repository);

    // Node stores the external-input hashes of a run under `node_modules/.cache/vis` and reads them on the next one. Every run
    // starts without that snapshot, so the Node reference and the Node fallback see the same state.
    const forgetExternalInputs = (testCase: Case): void => {
        rmSync(join(repositoryOf(testCase), "node_modules"), { force: true, recursive: true });
    };

    // `vis affected` computes its root from the working directory and ignores an inherited
    // `VIS_MONOREPO_ROOT`; the native runs get a stale one on purpose, so trusting it would show.
    const runNode = (testCase: Case) => {
        forgetExternalInputs(testCase);

        return spawnSync(process.execPath, [nodeEntry, ...testCase.args], {
            cwd: join(repositoryOf(testCase), testCase.cwd ?? "."),
            encoding: "utf8",
            env: { ...environmentFor(testCase), VIS_MONOREPO_ROOT: repositoryOf(testCase) },
        });
    };

    const runNative = (testCase: Case, entry: string) => {
        forgetExternalInputs(testCase);

        return spawnSync(binary as string, testCase.args, {
            cwd: join(repositoryOf(testCase), testCase.cwd ?? "."),
            encoding: "utf8",
            env: {
                ...environmentFor(testCase),
                VIS_FALLBACK_ENTRY: entry,
                VIS_FALLBACK_ENTRY_OVERRIDE: entry,
                VIS_MONOREPO_ROOT: dirname(repositoryOf(testCase)),
                VIS_NODE: process.execPath,
                VIS_VERSION: version,
            },
        });
    };

    it.each(cases.map((testCase) => [`${testCase.fixture ? `<${testCase.fixture}> ` : ""}${testCase.cwd ? `[${testCase.cwd}] ` : ""}${testCase.outsideCi ? "(no CI) " : ""}${JSON.stringify(testCase.env ?? {})} ${testCase.args.join(" ")}`, testCase] as const))(
        "%s matches Node",
        (_name, testCase) => {
            expect.assertions(4);

            const node = runNode(testCase);
            // The marker shows which path answers: it appears only on delegation.
            const probe = runNative(testCase, paths.stub);

            expect(probe.stdout.includes(marker)).toBe(!testCase.native);

            const native = runNative(testCase, nodeEntry);

            expect(native.stdout).toBe(node.stdout);
            expect(withoutStackFrames(native.stderr)).toBe(withoutStackFrames(node.stderr));
            expect(native.status).toBe(node.status);
        },
    );

    // The matrix above compares the two implementations; these pin what the answers are, so a pair of
    // empty or global answers cannot pass for a match.
    it.each([
        [[...sparse, "--base=v1", "--head=v2"], "apps/cli\napps/web\npackages/core\npackages/peer\npackages/ui\npackages/utils\n"],
        [[...sparse, "--base=v1", "--head=v2", "--downstream=none"], "packages/core\n"],
        [[...sparse, "--base=v1", "--head=v2", "--downstream=direct"], "packages/core\npackages/peer\npackages/utils\n"],
        [[...sparse, "--base=v2", "--head=v3", "--downstream=none", "--upstream=deep"], "apps/cli\npackages/core\npackages/solo\npackages/utils\n"],
        [[...sparse, "--base=v3", "--head=v4"], "apps/cli\napps/web\npackages/core\npackages/peer\npackages/solo\npackages/ui\npackages/utils\n"],
        [[...sparse, "--base=v5", "--head=v5"], ""],
        [[...sparse, "--base=v5", "--no-uncommitted"], ""],
        // The staged rename moves `core/x.ts` to `peer/x.ts`: both sides count, and `notes.md` outside any project does not.
        [[...sparse, "--base=v5", "--uncommitted", "--downstream=none"], "packages/core\npackages/peer\npackages/ui\n"],
    ])("answers `%j` with the expected roots", (args: string[], expected: string) => {
        expect.assertions(3);

        const node = runNode({ args, native: true });

        expect(node.status).toBe(0);
        expect(node.stdout).toBe(expected);
        expect(node.stderr).toBe("");
    });
});
