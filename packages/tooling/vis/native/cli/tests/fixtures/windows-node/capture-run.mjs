// Captures what the Node CLI does for `vis run <target>` on Windows, for the cases of `run/cases.json`: a cold run (it
// executes the tasks and writes the cache), then a run in which every task is a cache hit in each environment of
// `environments.json`. Run it on Windows:
//
//     node capture-run.mjs <path to the Node CLI's dist/bin.js> <a scratch directory> [case...]
//
// Each case's workspace (a directory below tests/fixtures) is copied into the scratch directory first, outside the
// repository, so that no ancestor holds a root marker, and gets the `node_modules/.modules.yaml` an install leaves
// (the lockfile preflight reads it). Nothing here is typed by hand. What lands in `run/<case>/`:
//
//   cache/<key>/...         the cache the cold run wrote (`.commit`, `code`, `terminalOutput`), byte for byte
//   cold.out, cold.err      stdout and stderr of the cold run
//   <environment>.out       stdout of the all-hit run in that environment
//   <environment>.summary.json   `.vis/last-summary.json` after that run
//   status.json             the exit status of every run that did not exit with 0
//
// The committed captures came from this checkout built on the Windows guest (base `3b5c0c66`, the `vis` package at
// `8.0.0-next.3`), Node v26.13.1, Windows 10.0.26200 (Windows 11), stdout a pipe. Capture again with the Node CLI of the
// release being compared against. The case `fsorder` was captured the same way from base `cd25db5d`.
//
// The run fails if the Node CLI wrote to stderr, if a hit run changed the cache directory, or if a file holds the
// workspace's path with backslashes. The one edit made to the bytes is the workspace's own path, which Node prints
// with `/` and a capital drive letter: it becomes `{workspace}`.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, scratch, ...selected] = process.argv.slice(2);
const { environments: shared } = JSON.parse(readFileSync(join(here, "environments.json"), "utf8"));
const { environments: extra } = JSON.parse(readFileSync(join(here, "run", "environments.json"), "utf8"));
const environments = { ...shared, ...extra };
const { cases } = JSON.parse(readFileSync(join(here, "run", "cases.json"), "utf8"));

// The detection reads these; a runner's own values would change what Node prints.
const stripped = /^(ANSICON|APPVEYOR|BUILDKITE|CI|CIRCLECI|COLORTERM|CONTINUOUS_INTEGRATION|DRONE|FORCE_COLOR|GITEA_ACTIONS|GITHUB_ACTIONS|GITHUB_WORKFLOW|GITLAB_CI|JENKINS_URL|NODE_DISABLE_COLORS|NO_COLOR|NODE_ENV|DEBUG|PAIL_LOG_LEVEL|TEAMCITY_VERSION|TERM|TERM_PROGRAM|TF_BUILD|TRAVIS|WT_SESSION|VIS_MONOREPO_ROOT|VIS_[A-Z_]*|TURBO_[A-Z_]*|COLUMNS|LINES|CEREBRO_.*)$/i;

/** Every file below `directory` with its bytes, sorted, as `relative path -> hex`. */
const snapshot = (directory) => {
    const files = {};
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);

            if (entry.isDirectory()) {
                walk(path);
            } else {
                files[path.slice(directory.length + 1).replaceAll("\\", "/")] = readFileSync(path).toString("hex");
            }
        }
    };

    walk(directory);

    return JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
};

for (const { name, target, workspace: source } of cases.filter((entry) => selected.length === 0 || selected.includes(entry.name))) {
    const workspace = join(resolve(scratch), name);
    const out = join(here, "run", name);
    const printed = workspace.replaceAll("\\", "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase());
    const statuses = {};
    const environment = (variables) => ({
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !stripped.test(key))),
        ...variables,
    });
    const run = (variables, mayWriteToStderr = false) => {
        const result = spawnSync(process.execPath, [cli, "run", target], { cwd: workspace, env: environment(variables), stdio: ["ignore", "pipe", "pipe"] });

        if (result.stderr.length > 0 && !mayWriteToStderr) {
            throw new Error(`${name}: wrote to stderr: ${result.stderr}`);
        }

        return result;
    };
    const keep = (file, bytes) => {
        const text = bytes.toString("utf8").replaceAll(printed, "{workspace}");

        if (text.includes(workspace) || text.includes(workspace.replaceAll("\\", "\\\\"))) {
            throw new Error(`${name}: ${file} holds the workspace path with backslashes`);
        }

        writeFileSync(join(out, file), text);
    };

    rmSync(workspace, { force: true, recursive: true });
    rmSync(out, { force: true, recursive: true });
    cpSync(join(here, "..", source), workspace, { recursive: true });
    mkdirSync(join(workspace, "node_modules"), { recursive: true });
    mkdirSync(out, { recursive: true });

    // What an install leaves: a marker newer than the lockfile.
    const marker = join(workspace, "node_modules", ".modules.yaml");
    const later = new Date(Date.now() + 5000);

    writeFileSync(marker, "layoutVersion: 5\n");
    utimesSync(marker, later, later);

    // The cold run executes the tasks, and Node warns on stderr about how it spawns them on Windows; the native binary
    // never runs a task, so only what it writes is compared. The warning is kept for the record.
    const cold = run(environments.ci, true);

    if (cold.status !== 0) {
        statuses.cold = cold.status;
    }

    keep("cold.out", cold.stdout);
    keep("cold.err", cold.stderr);

    const cache = join(workspace, "node_modules", ".cache", "vis");

    if (!existsSync(cache) || statSync(cache).isFile()) {
        throw new Error(`${name}: the cold run wrote no cache at ${cache}`);
    }

    cpSync(cache, join(out, "cache"), { recursive: true });

    const before = snapshot(cache);

    for (const [environmentName, variables] of Object.entries(environments)) {
        const result = run(variables);

        if (result.status !== 0) {
            statuses[environmentName] = result.status;
        }

        if (snapshot(cache) !== before) {
            throw new Error(`${name}: the run in ${environmentName} changed the cache`);
        }

        keep(`${environmentName}.out`, result.stdout);
        keep(`${environmentName}.summary.json`, readFileSync(join(workspace, ".vis", "last-summary.json")));
    }

    writeFileSync(join(out, "status.json"), `${JSON.stringify(statuses, undefined, 4)}\n`);
}
