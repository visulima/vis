// Captures the Node CLI's output for every case file (`<group>/cases.json`) and every environment of
// `environments.json`, as the raw bytes written to a file (the same as a pipe: the two were identical for every
// case). Run it on Windows:
//
//     node capture.mjs <path to the Node CLI's dist/bin.js> <a scratch directory> [group...]
//
// Each case's workspace (a directory below tests/fixtures) is copied into the scratch directory first, outside the
// repository, so that no ancestor holds a root marker. Nothing here is typed by hand:
// `<group>/<command>__<environment>.out` is what the Node CLI printed, and `<group>/status.json` holds the exit
// status of every case that did not exit with 0. The run fails if the Node CLI wrote to stderr.
//
// The committed captures came from the published `@visulima/vis@8.0.0-next.2` (`dist/bin.js`), Node v26.13.1, Windows
// 10.0.26200 (Windows 11), stdout a file. Capture again with the Node CLI of the release being compared against.
//
// The groups `order` and `order-nested` came from this checkout built on the Windows guest instead (base `cd25db5d`,
// the `vis` package at `8.0.0-next.3`, with its native addon), same Node, Windows and stdout. Their workspaces hold
// project directories whose byte order and file system (NTFS) order differ, so what they pin is the order Node lists
// projects in.
//
// The one edit made to the bytes is the workspace's own path, which Node prints with `/` and a capital drive letter
// (a few `deps` reports hold it): it becomes `{workspace}`, which the test fills in with the directory it runs in.
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, scratch, ...selected] = process.argv.slice(2);
const { environments } = JSON.parse(readFileSync(join(here, "environments.json"), "utf8"));

const slug = (args) => args.join("_").replaceAll(/[^\w.=-]+/g, "-");

// The detection reads these; a runner's own values would change what Node prints.
const stripped = /^(ANSICON|APPVEYOR|BUILDKITE|CI|CIRCLECI|COLORTERM|CONTINUOUS_INTEGRATION|DRONE|FORCE_COLOR|GITEA_ACTIONS|GITHUB_ACTIONS|GITHUB_WORKFLOW|GITLAB_CI|JENKINS_URL|NODE_DISABLE_COLORS|NO_COLOR|NODE_ENV|DEBUG|PAIL_LOG_LEVEL|TEAMCITY_VERSION|TERM|TERM_PROGRAM|TF_BUILD|TRAVIS|WT_SESSION|VIS_MONOREPO_ROOT|COLUMNS|LINES|CEREBRO_.*)$/i;

const groups = readdirSync(here, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "workspaces" && entry.name !== "run")
    .map((entry) => entry.name)
    .filter((name) => selected.length === 0 || selected.includes(name));

for (const group of groups) {
    const cases = JSON.parse(readFileSync(join(here, group, "cases.json"), "utf8"));
    const workspace = join(resolve(scratch), group);
    const statuses = {};
    const printed = workspace.replaceAll("\\", "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase());

    rmSync(workspace, { force: true, recursive: true });
    cpSync(join(here, "..", cases.workspace), workspace, { recursive: true });

    for (const args of cases.commands) {
        for (const [name, variables] of Object.entries(environments)) {
            const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !stripped.test(key)));
            const stem = `${slug(args)}__${name}`;
            const out = openSync(join(here, group, `${stem}.out`), "w");
            const result = spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env: { ...env, ...variables }, stdio: ["ignore", out, "pipe"] });

            closeSync(out);

            const file = join(here, group, `${stem}.out`);

            writeFileSync(file, readFileSync(file, "utf8").replaceAll(printed, "{workspace}"));

            if (readFileSync(file, "utf8").includes(workspace)) {
                throw new Error(`${group}: ${args.join(" ")} in ${name} prints the workspace path with backslashes`);
            }

            if (result.stderr.length > 0) {
                throw new Error(`${group}: ${args.join(" ")} in ${name} wrote to stderr: ${result.stderr}`);
            }

            if (result.status !== 0) {
                statuses[stem] = result.status;
            }
        }
    }

    writeFileSync(join(here, group, "status.json"), `${JSON.stringify(statuses, undefined, 4)}\n`);
}
