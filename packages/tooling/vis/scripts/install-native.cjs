"use strict";

// `preinstall` hook of @visulima/vis. Package managers create the `vis` command
// from `bin/vis`; this script replaces that file with the platform's native
// executable so the shim execs it directly and no Node process is started.
//
// It must never fail an install: every problem leaves `bin/vis` as the Node
// launcher (`bin/vis` as published), which resolves the same binary at runtime
// and still works, just with a Node start-up cost. It is CommonJS and uses the
// standard library only because it runs before anything is installed.
//
// Skipped (launcher stays) when:
//   - the package is not under a node_modules directory (a checkout of the repo),
//   - the platform has no binary, or `VIS_SKIP_NATIVE_LINK` is set,
//   - Windows: the generated `.cmd` shim cannot exec an extensionless `bin/vis`,
//   - the platform package is missing (`--omit=optional`) or its binary does not run,
//   - pnpm may already have written a shim that starts Node (see `pnpmShimMayStartNode`).

const { spawnSync } = require("node:child_process");
const { chmodSync, copyFileSync, existsSync, linkSync, readFileSync, realpathSync, renameSync, rmSync } = require("node:fs");
const { basename, dirname, join, relative, sep } = require("node:path");

const packageRoot = join(__dirname, "..");
const target = join(packageRoot, "bin", "vis");

const isMusl = () => {
    const report = typeof process.report?.getReport === "function" ? process.report.getReport() : undefined;

    if (report && Array.isArray(report.sharedObjects)) {
        return report.sharedObjects.some((object) => object.includes("libc.musl-") || object.includes("ld-musl-"));
    }

    return report ? !report.header?.glibcVersionRuntime : false;
};

// Same platform -> package slug table as `bin/resolve-binary.mjs`.
const slug = () => {
    const { arch, platform } = process;

    if (platform === "linux" && (arch === "arm64" || arch === "x64")) {
        return `linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
    }

    if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
        return `darwin-${arch}`;
    }

    return undefined;
};

// Entries of the `ignoredBuilds` / `pendingBuilds` lists in `.modules.yaml`, either
// block (`- '@scope/name@1.0.0'`) or flow (`[a, b]`) style. Hand-parsed because this
// script runs before anything is installed.
const skippedBuilds = (yaml) => {
    const entries = [];
    let inList = false;

    for (const line of yaml.split(/\r?\n/u)) {
        const key = /^(\w+):\s*(.*)$/u.exec(line);

        if (key) {
            inList = key[1] === "ignoredBuilds" || key[1] === "pendingBuilds";

            if (inList) {
                entries.push(...key[2].replace(/^\[|\]$/gu, "").split(","));
            }
        } else if (inList) {
            entries.push(line.replace(/^\s*-/u, ""));
        }
    }

    return entries.map((entry) => entry.trim().replace(/^['"]|['"]$/gu, "")).filter(Boolean);
};

// `@visulima/vis@<this version>`, optionally followed by pnpm's peer suffix.
const isThisPackage = (entry, version) => {
    const prefix = `@visulima/vis@${version}`;

    return entry.startsWith(prefix) && !/^[\w.-]/u.test(entry.slice(prefix.length));
};

// The project's `node_modules`, the directory holding pnpm's `.bin` and `.modules.yaml`. Inside pnpm's
// virtual store that is the directory above `.pnpm`; otherwise the nearest `node_modules` ancestor.
const projectModulesDirectory = () => {
    let directory = packageRoot;

    while (dirname(directory) !== directory) {
        if (basename(directory) === ".pnpm") {
            return dirname(directory);
        }

        directory = dirname(directory);
    }

    directory = packageRoot;

    while (dirname(directory) !== directory) {
        if (basename(directory) === "node_modules") {
            return directory;
        }

        directory = dirname(directory);
    }

    return undefined;
};

// Directories whose `.bin` may hold the shim for this package: the one the virtual store sits in,
// and the one of the project pnpm was run from (`INIT_CWD`), which is a workspace member's own
// `node_modules` when that member depends on this package or the store is not under `node_modules`.
const shimModulesDirectories = () => {
    const directories = [projectModulesDirectory()];

    if (process.env.INIT_CWD) {
        directories.push(join(process.env.INIT_CWD, "node_modules"));
    }

    return [...new Set(directories.filter((directory) => directory !== undefined))];
};

// Whether the shim in `modules/.bin` was written for this very package directory and starts Node.
// pnpm writes `exec node "$basedir/<relative path to bin/vis>"`, so the path names the package
// directory (version included; `target` is a real path, so the shim's directory is resolved too): the shim of an earlier version, or one that execs the binary
// directly, leaves the launcher free to be replaced. A shim that cannot be read cannot be ruled out.
const shimStartsNodeForThisPackage = (modules) => {
    const shim = join(modules, ".bin", "vis");

    if (!existsSync(shim)) {
        return false;
    }

    try {
        const text = readFileSync(shim, "utf8");
        const launcher = relative(realpathSync(dirname(shim)), target).split(sep).join("/");

        return text.includes(launcher) && /\bexec\s+(?:node|"\$basedir\/node")\s/u.test(text);
    } catch {
        return true;
    }
};

// pnpm writes the `.bin` shim from the shebang of `bin/vis`, which is `node` while the
// launcher is in place. A first install writes the shim after this script ran, so a shim that
// already exists for this package directory was written by an earlier run. That covers
// `pnpm approve-builds` and `pnpm rebuild`, which run this script again, and any install on top of
// an earlier one that skipped it. Replacing `bin/vis` then would leave `node <native binary>`,
// which crashes, so keep the launcher, which works with either shim. An upgrade finds the shim of
// the previous version, which names another directory, and goes native. The `npm_command` value is
// not used: pnpm does not guarantee it for these commands.
const pnpmShimMayStartNode = () => {
    if (!(process.env.npm_config_user_agent || "").startsWith("pnpm/")) {
        return false;
    }

    const directories = shimModulesDirectories();

    if (directories.some(shimStartsNodeForThisPackage)) {
        return true;
    }

    // pnpm lists packages whose scripts it skipped (`ignoredBuilds`, `pendingBuilds`) in
    // `node_modules/.modules.yaml`, next to the `.pnpm` virtual store.
    try {
        const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

        return directories.some((modules) => {
            try {
                return skippedBuilds(readFileSync(join(modules, ".modules.yaml"), "utf8")).some((entry) => isThisPackage(entry, version));
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
};

const main = () => {
    if (process.env.VIS_SKIP_NATIVE_LINK || process.platform === "win32" || !packageRoot.includes(`${sep}node_modules${sep}`)) {
        return "skipped";
    }

    if (pnpmShimMayStartNode()) {
        return "pnpm already linked a shim that starts Node; remove node_modules and reinstall to use the native binary";
    }

    const name = slug();

    if (name === undefined) {
        return "unsupported platform";
    }

    let binary;

    try {
        binary = require.resolve(`@visulima/vis-binding-${name}/vis-native-cli`, { paths: [packageRoot] });
    } catch {
        return `@visulima/vis-binding-${name} is not installed`;
    }

    // A wrong-architecture or truncated binary must not replace the working launcher.
    const probe = spawnSync(binary, ["--version"], { stdio: "ignore", timeout: 15_000 });

    if (probe.status !== 0) {
        return "the platform binary does not run";
    }

    // Build the replacement next to the launcher and rename it over `bin/vis`: the swap is
    // atomic, and it replaces the directory entry rather than writing through it (a package
    // manager may have hard-linked `bin/vis` from its content store).
    const temporary = `${target}.${process.pid}.tmp`;

    try {
        rmSync(temporary, { force: true });

        try {
            linkSync(binary, temporary);
        } catch {
            // Cross-device or a file system without hard links.
            copyFileSync(binary, temporary);
        }

        chmodSync(temporary, 0o755);
        renameSync(temporary, target);
    } catch (error) {
        rmSync(temporary, { force: true });

        return `could not replace bin/vis (${error && error.message}); it was left unchanged`;
    }

    return "linked";
};

try {
    const outcome = main();

    if (outcome !== "linked" && outcome !== "skipped" && process.env.npm_config_loglevel !== "silent") {
        console.warn(`vis: using the Node launcher (${outcome}); commands start slower.`);
    }
} catch (error) {
    console.warn(`vis: could not link the native binary (${error && error.message}); using the Node launcher.`);
}
