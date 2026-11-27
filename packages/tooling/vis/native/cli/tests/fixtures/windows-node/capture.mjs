// Captures the Node CLI's output for every command and environment in cases.json, as the raw bytes written to a
// file (the same as a pipe: the two were identical for every case). Run it on Windows:
//
//     node capture.mjs <path to the Node CLI's dist/bin.js> <copy of tests/fixtures/list/basic> <this directory>
//
// The workspace must be a copy outside the repository, so that no ancestor holds a root marker. Nothing here is
// typed by hand: `<command>__<environment>.out` is what the Node CLI printed, and the run fails if it wrote to
// stderr or did not exit with status 0.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [cli, workspace, outputDirectory = dirname(fileURLToPath(import.meta.url))] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "cases.json"), "utf8"));

const slug = (args) => args.join("_").replaceAll(/[^\w.=-]+/g, "-");

// The detection reads these; a runner's own values would change what Node prints.
const stripped = /^(ANSICON|APPVEYOR|BUILDKITE|CI|CIRCLECI|COLORTERM|CONTINUOUS_INTEGRATION|DRONE|FORCE_COLOR|GITEA_ACTIONS|GITHUB_ACTIONS|GITHUB_WORKFLOW|GITLAB_CI|JENKINS_URL|NODE_DISABLE_COLORS|NO_COLOR|NODE_ENV|DEBUG|PAIL_LOG_LEVEL|TEAMCITY_VERSION|TERM|TERM_PROGRAM|TF_BUILD|TRAVIS|WT_SESSION|VIS_MONOREPO_ROOT|COLUMNS|LINES|CEREBRO_.*)$/i;

for (const args of cases.commands) {
    for (const [name, variables] of Object.entries(cases.environments)) {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !stripped.test(key)));
        const path = join(outputDirectory, `${slug(args)}__${name}.out`);
        const out = openSync(path, "w");
        const result = spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env: { ...env, ...variables }, stdio: ["ignore", out, "pipe"] });

        closeSync(out);

        if (result.status !== 0 || result.stderr.length > 0) {
            throw new Error(`${args.join(" ")} in ${name}: status ${result.status}, stderr ${result.stderr}`);
        }
    }
}
