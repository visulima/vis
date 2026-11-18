// Install smoke test: packs the real package and the platform packages, publishes
// them (platform packages first, then the root) to a throw-away local registry,
// installs the root with each available package manager, and runs the CLI.
//
//   node scripts/install-smoke.mjs [--pm npm,pnpm,yarn-classic,yarn-berry,bun]
//
// Needs `dist/` built and the host platform package laid out with its
// `vis-native-cli` and `.node` files (what the release job produces). A package
// manager that is not available is reported as NOT RUN, never skipped silently; when `--pm` names
// it, its absence also fails the run.
// Each package manager is installed twice: with install scripts allowed (the
// binary must be linked at `bin/vis`, `doctor` reports the native path) and with
// them disabled (the Node launcher must still work, `doctor` reports the slower
// path). pnpm gets a third row, "unapproved": pnpm 12 refuses to run a dependency's
// install script until it is listed in `allowBuilds` and ends the install with
// ERR_PNPM_IGNORED_BUILDS, yet the package is installed, so `vis` must still work
// through the Node launcher. Never publishes anywhere but the local registry.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const REGISTRY_PORT = 4873 + Math.floor(Math.random() * 500);
const REGISTRY = `http://localhost:${REGISTRY_PORT}/`;
const VERDACCIO = "verdaccio@6.11.2";
// The pnpm row runs the exact release it documents; `npx` keeps it independent of the pnpm that builds the repo.
const PNPM = "pnpm@12.21.0";

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

const pmFlag = process.argv.indexOf("--pm");
const explicitlyRequested = pmFlag !== -1;
const requested = explicitlyRequested ? process.argv[pmFlag + 1].split(",") : ["npm", "pnpm", "yarn-classic", "yarn-berry", "bun"];

const failures = [];
const report = [];
const check = (row, name, ok, detail = "") => {
    report.push({ detail, name, ok, row });

    if (!ok) {
        failures.push(`${row}: ${name}${detail ? ` (${detail})` : ""}`);
    }
};

// On Windows the command runs through cmd.exe, which splits its line on spaces; quote each word so a
// temporary directory such as `C:\Users\Jane Doe` stays one argument. Elsewhere the argv is passed as is.
const quoteWord = (word) => (/[\s"&()^%!<>|]/u.test(word) ? `"${word.replaceAll('"', '\\"')}"` : word);
const invoke = (command, args) => (isWindows ? [[command, ...args].map(quoteWord).join(" "), []] : [command, args]);

const run = (command, args, options = {}) => {
    const [file, argv] = invoke(command, args);

    return spawnSync(file, argv, { encoding: "utf8", shell: isWindows, timeout: 300_000, ...options, env: { ...process.env, ...options.env } });
};

// Setup failures end the run; a package manager may fail with an empty stderr, so say everything the spawn knows.
const abort = (what, result) => {
    console.error(`install-smoke: ${what} failed (status ${result.status}, signal ${result.signal}${result.error ? `, ${result.error.message}` : ""})`);
    console.error(`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
    process.exit(2);
};

const have = (command) => run(command, ["--version"]).status === 0;

// The first lines of a command's output, joined for a one-line failure detail.
const excerpt = (text, lines) => text.trim().split("\n").slice(0, lines).join(" | ");

const work = mkdtempSync(join(tmpdir(), "vis-install-smoke-"));
const tarballs = join(work, "tarballs");

mkdirSync(tarballs);

const { nativeTarget } = await import("../bin/resolve-binary.mjs");
const target = nativeTarget();
const exe = isWindows ? "vis-native-cli.exe" : "vis-native-cli";

if (target === undefined || !existsSync(join(packageRoot, "npm", target, exe)) || !existsSync(join(packageRoot, "dist", "bin.js"))) {
    console.error(`install-smoke: needs dist/bin.js and npm/${target}/${exe} (run the release layout step first).`);
    process.exit(2);
}

const packOne = (cwd, command) => {
    const result = run(command, ["pack", "--pack-destination", tarballs], { cwd });

    if (result.status !== 0) {
        abort(`${command} pack in ${cwd}`, result);
    }

    // npm prints the file name, pnpm the full path.
    return basename(result.stdout.trim().split("\n").pop().trim());
};

const bindings = readdirSync(join(packageRoot, "npm")).map((slug) => packOne(join(packageRoot, "npm", slug), "npm"));
// `pnpm pack` resolves `workspace:*` / `catalog:` ranges the way a release does.
const rootTarball = packOne(packageRoot, "pnpm");

const registryDirectory = join(work, "registry");

mkdirSync(registryDirectory);
writeFileSync(
    join(registryDirectory, "config.yaml"),
    `storage: ./storage
auth:
  htpasswd:
    file: ./htpasswd
packages:
  '@visulima/vis':
    access: $all
    publish: $authenticated
  '@visulima/vis-binding-*':
    access: $all
    publish: $authenticated
  '**':
    access: $all
    proxy: npmjs
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
log: { type: stdout, format: pretty, level: http }
`,
);

const [registryFile, registryArgs] = invoke("npx", ["--yes", VERDACCIO, "--config", join(registryDirectory, "config.yaml"), "--listen", String(REGISTRY_PORT)]);
const registry = spawn(registryFile, registryArgs, {
    cwd: registryDirectory,
    shell: isWindows,
    stdio: ["ignore", "inherit", "inherit"],
});
let registryExit;

registry.on("error", (error) => {
    registryExit = `could not start (${error.message})`;
});
registry.on("exit", (code, signal) => {
    registryExit = `exited early (code ${code}, signal ${signal})`;
});

const stop = () => {
    registry.kill();
    rmSync(work, { force: true, recursive: true });
};

process.on("exit", stop);

// Polls the registry over HTTP until it answers, so a stalled `npx` cannot hang the job. Fails on a spawn
// error, an early exit, or the deadline.
const waitForRegistry = async (timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;

    while (registryExit === undefined) {
        try {
            const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(2000) });

            if (response.status < 500) {
                return;
            }
        } catch {
            // Not listening yet: retry until the deadline.
        }

        if (Date.now() >= deadline) {
            throw new Error(`registry did not answer on ${REGISTRY} within ${timeoutMs / 1000}s`);
        }

        await new Promise((resolveDelay) => {
            setTimeout(resolveDelay, 500);
        });
    }

    throw new Error(`registry ${registryExit} before it was ready`);
};

await waitForRegistry();

const user = await (
    await fetch(`${REGISTRY}-/user/org.couchdb.user:smoke`, {
        body: JSON.stringify({ name: "smoke", password: "smoke-password" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
    })
).json();
const publishConfig = join(work, "publish.npmrc");

// `@visulima:registry` from a developer's global npm config would otherwise win over `--registry`, so the
// scope is bound here and the global config is replaced by an empty file.
writeFileSync(publishConfig, `registry=${REGISTRY}\n@visulima:registry=${REGISTRY}\n//localhost:${REGISTRY_PORT}/:_authToken=${user.token}\n`);

const globalConfig = join(work, "global.npmrc");

writeFileSync(globalConfig, "");

// Platform packages first: the root's optionalDependencies must resolve the moment it is published.
const published = [];

for (const tarball of [...bindings, rootTarball]) {
    const result = run("npm", ["publish", join(tarballs, tarball), "--userconfig", publishConfig, "--globalconfig", globalConfig, "--registry", REGISTRY, "--tag", "smoke", "--provenance=false"]);

    published.push(tarball);

    if (result.status !== 0) {
        abort(`npm publish ${tarball}`, result);
    }
}

check("publish", "platform packages are published before the root", published.at(-1) === rootTarball && published.slice(0, -1).every((name) => name.includes("binding")));

const spec = `@visulima/vis@${manifest.version}`;
const registryFiles = { ".npmrc": `registry=${REGISTRY}\n` };
const berryRc = `npmRegistryServer: "${REGISTRY}"\nunsafeHttpWhitelist: ["localhost"]\nenableImmutableInstalls: false\nnodeLinker: node-modules\nenableTelemetry: false\n`;

const managers = {
    bun: {
        available: () => have("bun"),
        launch: { run: ["bun", "run", "v"] },
        install: (mode) => ({ args: ["add", "-d", spec], command: "bun", extra: { packageManager: `bun@${run("bun", ["--version"]).stdout.trim()}`, ...(mode === "enabled" ? { trustedDependencies: ["@visulima/vis"] } : {}) }, files: { ...registryFiles, "bunfig.toml": `[install]\nregistry = "${REGISTRY}"\n` } }),
    },
    npm: {
        available: () => have("npm"),
        launch: { exec: ["npm", "exec", "--", "vis", "--version"], run: ["npm", "run", "v"] },
        install: (mode) => ({ args: ["install", "-D", spec, ...(mode === "disabled" ? ["--ignore-scripts"] : [])], command: "npm", files: registryFiles }),
    },
    pnpm: {
        available: () => have("npx"),
        launch: { exec: ["npx", "--yes", PNPM, "exec", "vis", "--version"], run: ["npx", "--yes", PNPM, "run", "v"] },
        modes: ["enabled", "disabled", "unapproved"],
        install: (mode, directory) => ({
            // A store of its own per row: pnpm keeps the files an install script produced in its store (the
            // side-effects cache) and would hand them to a later row that disabled scripts.
            args: ["--yes", PNPM, "add", "-D", spec, "--store-dir", join(directory, ".pnpm-store"), ...(mode === "disabled" ? ["--ignore-scripts"] : [])],
            command: "npx",
            // pnpm installs the files and then fails the command until the build is approved.
            ...(mode === "unapproved" ? { expectInstall: "ERR_PNPM_IGNORED_BUILDS" } : {}),
            files: {
                ...registryFiles,
                "pnpm-workspace.yaml": [
                    // `pnpm run` / `pnpm exec` would otherwise re-install first and build the approved package
                    // the earlier `--ignore-scripts` install skipped.
                    "verifyDepsBeforeRun: false",
                    // pnpm reads `allowBuilds` from the workspace file. The scripts-disabled row keeps the approval so only
                    // `--ignore-scripts` turns the fast path off; the unapproved row leaves it out and nothing else.
                    ...(mode === "unapproved" ? [] : ["allowBuilds:", "  '@visulima/vis': true"]),
                    "",
                ].join("\n"),
            },
        }),
    },
    "yarn-berry": {
        available: () => have("npx"),
        launch: { exec: ["npx", "--yes", "@yarnpkg/cli-dist@4.9.2", "exec", "vis", "--version"], run: ["npx", "--yes", "@yarnpkg/cli-dist@4.9.2", "run", "v"] },
        install: (mode) => ({ args: ["--yes", "@yarnpkg/cli-dist@4.9.2", "add", "-D", spec], command: "npx", files: { ".yarnrc.yml": berryRc + (mode === "disabled" ? "enableScripts: false\n" : ""), "yarn.lock": "" } }),
    },
    "yarn-classic": {
        available: () => have("npx"),
        launch: { run: ["npx", "--yes", "yarn@1.22.22", "run", "v"] },
        install: (mode) => ({ args: ["--yes", "yarn@1.22.22", "add", "-D", "-W", spec, ...(mode === "disabled" ? ["--ignore-scripts"] : [])], command: "npx", files: { ...registryFiles, ".yarnrc": `registry "${REGISTRY}"\n` } }),
    },
};

const isNativeFile = (file) => {
    const head = readFileSync(file).subarray(0, 4).toString("hex");

    return ["cffaedfe", "cafebabe", "7f454c46"].includes(head);
};

const rows = [];

for (const name of requested) {
    const manager = managers[name];

    if (manager === undefined) {
        console.error(`install-smoke: unknown package manager ${name}`);
        process.exit(2);
    }

    // Windows: the generated .cmd shim cannot exec the extensionless bin/vis, so the launcher is the
    // supported path there; one npm row proves it installs and runs. An explicit request for another
    // manager there cannot be honoured, so it fails rather than passing with nothing run.
    if (isWindows && name !== "npm") {
        if (explicitlyRequested) {
            check(name, "requested package manager runs on Windows", false, "the Windows smoke runs npm only");
        }

        rows.push(`${name}: NOT RUN (windows runs npm only)`);
        continue;
    }

    if (!manager.available()) {
        // CI names the managers it expects; one that is missing must fail the run, not pass as NOT RUN.
        if (explicitlyRequested) {
            check(name, "requested package manager is available", false);
        }

        rows.push(`${name}: NOT RUN (not available on this machine)`);
        continue;
    }

    for (const mode of isWindows ? ["enabled"] : (manager.modes ?? ["enabled", "disabled"])) {
        const row = `${name} (scripts ${mode})`;
        const directory = join(work, `${name}-${mode}`);
        const plan = manager.install(mode, directory);

        mkdirSync(join(directory, "packages", "a"), { recursive: true });
        writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "consumer", private: true, scripts: { v: "vis --version" }, version: "1.0.0", workspaces: ["packages/*"], ...plan.extra }, null, 2));
        writeFileSync(join(directory, "packages", "a", "package.json"), JSON.stringify({ name: "a", scripts: { build: "echo a" }, version: "1.0.0" }));

        for (const [file, content] of Object.entries(plan.files)) {
            writeFileSync(join(directory, file), content);
        }

        run("git", ["init", "-q"], { cwd: directory });
        mkdirSync(join(directory, ".vis", "hooks"), { recursive: true });
        writeFileSync(join(directory, ".vis", "hooks", "config.json"), JSON.stringify({ stages: { "pre-commit": [{ entry: "true", id: "a" }] }, version: 1 }));

        const environment = { CI: "1", NO_COLOR: "1", npm_config_cache: join(work, "npm-cache"), npm_config_userconfig: publishConfig, YARN_CACHE_FOLDER: join(directory, ".yarn-cache") };
        const installed = run(plan.command, plan.args, { cwd: directory, env: environment });

        const installOutput = `${installed.stderr}${installed.stdout}`;

        if (plan.expectInstall === undefined) {
            check(row, "install succeeds", installed.status === 0, excerpt(installOutput, 14));

            if (installed.status !== 0) {
                continue;
            }
        } else {
            check(row, `install ends with ${plan.expectInstall}`, installed.status !== 0 && installOutput.includes(plan.expectInstall), excerpt(installOutput, 14));
        }

        const vis = join(directory, "node_modules", ".bin", "vis");

        if (!existsSync(vis)) {
            check(row, "install leaves a `vis` bin", false, excerpt(installOutput, 6));
            continue;
        }

        const execute = (...args) => run(vis, args, { cwd: directory, env: environment });

        const version = execute("--version");

        check(row, "`vis --version` prints the package version", version.status === 0 && version.stdout.trim() === manifest.version, `${version.stdout.trim()} ${version.stderr.trim()}`.trim());

        // The shim each package manager generates is what a user's `run` script or `exec` invocation goes through.
        for (const [how, command] of Object.entries(manager.launch)) {
            const launched = run(command[0], command.slice(1), { cwd: directory, env: environment });

            check(row, `\`${how}\` starts vis through the package manager's own path`, launched.status === 0 && launched.stdout.split("\n").some((line) => line.trim() === manifest.version), `${launched.stdout.trim().slice(-80)} ${launched.stderr.trim().slice(0, 120)}`.trim());
        }

        const help = execute("--help");

        check(row, "`vis --help` succeeds", help.status === 0, help.stderr.trim().slice(0, 120));

        const hook = execute("hook", "run", "pre-push");

        check(row, "`vis hook run pre-push` succeeds", hook.status === 0 && hook.stdout.includes('No hooks configured for stage "pre-push"'), hook.stderr.trim().slice(0, 120));

        // `--help` is answered natively on every row. Script generation is Node's, so the generated
        // script proves the hand-off (from the binary, or from the launcher) without needing a workspace.
        const completion = execute("completion", "--shell=bash");

        check(row, "delegated `vis completion` runs through Node", completion.status === 0 && completion.stdout.includes("vis complete --"), completion.stderr.trim().slice(0, 120));

        // `list` and `doctor` need a workspace root, which vis does not detect in a bun-managed
        // project (an existing limitation, unrelated to how the binary is installed): bun only gets
        // the layout check below.
        const needsWorkspace = name !== "bun";

        if (needsWorkspace) {
            const delegated = execute("list");

            check(row, "delegated `vis list` runs through Node", delegated.status === 0 && delegated.stdout.includes("project(s)"), delegated.stderr.trim().slice(0, 120));
        }

        const launcher = (() => {
            if (!needsWorkspace) {
                return undefined;
            }

            try {
                return JSON.parse(execute("doctor", "--only", "runtime", "--json", "--no-cache").stdout).runtime.find((entry) => entry.id === "launcher");
            } catch {
                return undefined;
            }
        })();

        if (!isWindows) {
            // Only "enabled" runs the install script that links the native executable.
            const native = mode === "enabled";
            const linked = isNativeFile(join(directory, "node_modules", "@visulima", "vis", "bin", "vis"));

            check(row, native ? "bin/vis is the native executable" : "bin/vis stays the Node launcher", linked === native);

            if (needsWorkspace) {
                check(row, `doctor reports the ${native ? "native" : "slower"} path`, native ? launcher?.status === "ok" : launcher?.message?.includes("slower path") === true, JSON.stringify(launcher));
            }
        }

        rows.push(`${row}: ran`);
    }
}

console.log(rows.join("\n"));
console.log(`\n${report.filter((entry) => entry.ok).length}/${report.length} checks passed`);

for (const failure of failures) {
    console.log(`FAIL ${failure}`);
}

process.exit(failures.length === 0 ? 0 : 1);
