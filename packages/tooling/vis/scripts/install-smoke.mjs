// Install smoke test: packs the real package and the platform packages, publishes
// them (platform packages first, then the root) to a throw-away local registry,
// installs the root with each available package manager, and runs the CLI.
//
//   node scripts/install-smoke.mjs [--pm npm,pnpm,yarn-classic,yarn-berry,bun]
//
// Needs `dist/` built and the host platform package laid out with its
// `vis-native-cli` and `.node` files (what the release job produces). A package
// manager that is not available is reported as NOT RUN, never skipped silently.
// Each package manager is installed twice: with install scripts allowed (the
// binary must be linked at `bin/vis`, `doctor` reports the native path) and with
// them disabled (the Node launcher must still work, `doctor` reports the slower
// path). Never publishes anywhere but the local registry.

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

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

const requested = (() => {
    const index = process.argv.indexOf("--pm");

    return index === -1 ? ["npm", "pnpm", "yarn-classic", "yarn-berry", "bun"] : process.argv[index + 1].split(",");
})();

const failures = [];
const report = [];
const check = (row, name, ok, detail = "") => {
    report.push({ detail, name, ok, row });

    if (!ok) {
        failures.push(`${row}: ${name}${detail ? ` (${detail})` : ""}`);
    }
};

const run = (command, args, options = {}) =>
    spawnSync(command, args, { encoding: "utf8", shell: isWindows, timeout: 300_000, ...options, env: { ...process.env, ...options.env } });

const have = (command) => run(command, ["--version"]).status === 0;

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
        console.error(result.stderr);
        process.exit(2);
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

const registry = spawn("npx", ["--yes", VERDACCIO, "--config", join(registryDirectory, "config.yaml"), "--listen", String(REGISTRY_PORT)], {
    cwd: registryDirectory,
    shell: isWindows,
    stdio: ["ignore", "pipe", "inherit"],
});

const stop = () => {
    registry.kill();
    rmSync(work, { force: true, recursive: true });
};

process.on("exit", stop);

await new Promise((resolveReady, reject) => {
    registry.stdout.on("data", (chunk) => {
        if (String(chunk).includes("http address")) {
            resolveReady();
        }
    });
    registry.on("exit", () => {
        reject(new Error("registry exited before it was ready"));
    });
});

const user = await (
    await fetch(`${REGISTRY}-/user/org.couchdb.user:smoke`, {
        body: JSON.stringify({ name: "smoke", password: "smoke-password" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
    })
).json();
const publishConfig = join(work, "publish.npmrc");

writeFileSync(publishConfig, `registry=${REGISTRY}\n//localhost:${REGISTRY_PORT}/:_authToken=${user.token}\n`);

// Platform packages first: the root's optionalDependencies must resolve the moment it is published.
const published = [];

for (const tarball of [...bindings, rootTarball]) {
    const result = run("npm", ["publish", join(tarballs, tarball), "--userconfig", publishConfig, "--registry", REGISTRY, "--tag", "smoke", "--provenance=false"]);

    published.push(tarball);

    if (result.status !== 0) {
        console.error(result.stderr);
        process.exit(2);
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
        available: () => have("pnpm"),
        launch: { exec: ["pnpm", "exec", "vis", "--version"], run: ["pnpm", "run", "v"] },
        install: (mode) => ({
            args: ["add", "-D", spec, ...(mode === "disabled" ? ["--ignore-scripts"] : [])],
            command: "pnpm",
            // pnpm 10 reads the package.json key, pnpm 11 the workspace file; scripts-disabled rows keep the
            // allow-list so only `--ignore-scripts` is what turns the fast path off.
            extra: { pnpm: { onlyBuiltDependencies: ["@visulima/vis"] } },
            files: { ...registryFiles, "pnpm-workspace.yaml": "allowBuilds:\n  '@visulima/vis': true\n" },
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
    // supported path there; one npm row proves it installs and runs.
    if (!manager.available() || (isWindows && name !== "npm")) {
        rows.push(`${name}: NOT RUN (${manager.available() ? "windows runs npm only" : "not available on this machine"})`);
        continue;
    }

    for (const mode of isWindows ? ["enabled"] : ["enabled", "disabled"]) {
        const row = `${name} (scripts ${mode})`;
        const directory = join(work, `${name}-${mode}`);
        const plan = manager.install(mode);

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

        check(row, "install succeeds", installed.status === 0, `${installed.stderr}${installed.stdout}`.trim().split("\n").slice(0, 14).join(" | "));

        if (installed.status !== 0) {
            continue;
        }

        const vis = join(directory, "node_modules", ".bin", "vis");
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

        // `vis --help` is answered by the Node CLI, so it proves the delegation from the binary.
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
            const linked = isNativeFile(join(directory, "node_modules", "@visulima", "vis", "bin", "vis"));

            check(row, mode === "enabled" ? "bin/vis is the native executable" : "bin/vis stays the Node launcher", linked === (mode === "enabled"));

            if (needsWorkspace) {
                check(row, `doctor reports the ${mode === "enabled" ? "native" : "slower"} path`, mode === "enabled" ? launcher?.status === "ok" : launcher?.message?.includes("slower path") === true, JSON.stringify(launcher));
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
