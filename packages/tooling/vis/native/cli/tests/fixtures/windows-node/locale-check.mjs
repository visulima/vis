// One step of `locale-check.ps1`: under the Windows user locale this process runs in, builds the workspace `c`, `ch`,
// `d`, `h` (independent script-only projects, ids and directories in the root-collation order), fills the cache with a
// cold run of the Node CLI, runs the Node CLI again (every task hits) and then the native binary the way the JS
// launcher starts it, and prints what each did as one JSON line:
//
//     node locale-check.mjs <path to the Node CLI's dist/bin.js> <path to vis.exe> <a scratch directory>
//
// Czech and Slovak sort `ch` after `h`, so the Node CLI starts the tasks as `c, d, h, ch` there and as `c, ch, d, h`
// elsewhere, and lists the hook stages `post-commit` before `post-checkout` (`vis hook list`, which the binary answers
// only where the order is the byte order). Nothing here is typed by hand: the orders are read from what the Node CLI
// printed.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [cli, binary, scratch] = process.argv.slice(2);
const workspace = join(resolve(scratch), "ws");
const stripped = /^(CI|FORCE_COLOR|NO_COLOR|NODE_ENV|DEBUG|TERM|TERM_PROGRAM|WT_SESSION|VIS_[A-Z_]*|TURBO_[A-Z_]*|CEREBRO_.*|GITHUB_ACTIONS|GITLAB_CI|BUILDKITE|TF_BUILD)$/i;
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !stripped.test(key))), CI: "1" };
const write = (path, text) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
};
const stages = (text) => [...text.matchAll(/^([a-z-]+) \(\d+ lines?\)$/gm)].map((match) => match[1]);
const starts = (text) => [...text.matchAll(/^(?:\x1b\[2m)?>(?:\x1b\[22m)? (\S+)$/gm)].map((match) => match[1]);

rmSync(workspace, { force: true, recursive: true });
write(join(workspace, "package.json"), '{ "name": "locale-root", "private": true }\n');
write(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
write(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

for (const name of ["c", "ch", "d", "h"]) {
    write(join(workspace, "packages", name, "package.json"), `{ "name": "${name}", "version": "1.0.0", "scripts": { "build": "echo ${name}" } }\n`);
    write(join(workspace, "packages", name, "src", "index.ts"), `export const name = "${name}";\n`);
}

const marker = join(workspace, "node_modules", ".modules.yaml");

write(marker, "layoutVersion: 5\n");
utimesSync(marker, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

const run = (file, args, extra = {}) => {
    const result = spawnSync(file, args, { cwd: workspace, encoding: "utf8", env: { ...environment, ...extra } });

    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

for (const stage of ["commit-msg", "post-checkout", "post-commit", "pre-commit"]) {
    write(join(workspace, ".vis", "hooks", stage), "#!/usr/bin/env sh\necho hi\n");
}

run(process.execPath, [cli, "run", "build"]);

const node = run(process.execPath, [cli, "run", "build"]);
const native = run(binary, ["run", "build"], {
    VIS_HANDBACK_STATUS: "75",
    VIS_HANDOFF: "launcher",
    VIS_LAUNCHER: "node",
    VIS_NODE: process.execPath,
    VIS_NODE_VERSION: process.version,
    VIS_VERSION: "0.0.0-test",
});

const nodeHooks = run(process.execPath, [cli, "hook", "list"]);
const binaryHooks = run(binary, ["hook", "list"]);

console.log(
    JSON.stringify({
        hooks: {
            node: stages(nodeHooks.stdout.replaceAll("\r\n", "\n")),
            // A binary that does not answer hands the command to Node, which it cannot find here: nothing is printed.
            binary: { status: binaryHooks.status, stdoutBytes: binaryHooks.stdout.length, same: binaryHooks.stdout === nodeHooks.stdout },
        },
        locale: new Intl.Collator().resolvedOptions().locale,
        node: { status: node.status, starts: starts(node.stdout), cached: node.stdout.includes("4 read from cache") },
        binary: { status: native.status, starts: starts(native.stdout), stdoutBytes: native.stdout.length },
    }),
);
