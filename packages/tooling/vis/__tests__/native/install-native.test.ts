import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nativeTarget } from "../../bin/resolve-binary.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installScript = join(packageRoot, "scripts", "install-native.cjs");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
};
const PLACEHOLDER = "#!/usr/bin/env node\nimport './vis.mjs';\n";

describe("npm package layout", () => {
    it("points the vis command at bin/vis, which the install script replaces", () => {
        expect.assertions(4);

        expect(manifest.bin["vis"]).toBe("./bin/vis");
        expect(manifest.bin["v"]).toBe("./bin/vis");
        expect(manifest.scripts["preinstall"]).toBe("node scripts/install-native.cjs");
        expect(manifest.files).toContain("scripts/install-native.cjs");
    });

    it("ships a Node launcher as the published bin/vis", () => {
        expect.assertions(2);

        const placeholder = readFileSync(join(packageRoot, "bin", "vis"), "utf8");

        expect(placeholder.startsWith("#!/usr/bin/env node\n")).toBe(true);
        expect(placeholder).toContain("./vis.mjs");
    });
});

// The script links a POSIX binary; Windows keeps the launcher by design.
describe.skipIf(process.platform === "win32" || nativeTarget() === undefined)("scripts/install-native.cjs", () => {
    let root: string;
    let installed: string;
    let platformPackage: string;

    // `NODE_PATH` is dropped: pnpm sets it to the workspace's hoisted `node_modules`, which holds the real
    // platform package, so a copy under a temp dir would resolve it even when the test installs none.
    const install = (environment: Record<string, string> = {}, script = join(installed, "scripts", "install-native.cjs")) => {
        // Ambient pnpm/npm state and the skip switch would change what the installer does in these fixtures.
        const inherited = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("npm_") && !["INIT_CWD", "NODE_PATH", "VIS_SKIP_NATIVE_LINK"].includes(key)),
        );

        return spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...inherited, ...environment } });
    };

    const writeBinary = (body: string) => {
        writeFileSync(join(platformPackage, "vis-native-cli"), body, { mode: 0o755 });
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "vis-install-"));
        installed = join(root, "node_modules", "@visulima", "vis");
        platformPackage = join(root, "node_modules", "@visulima", `vis-binding-${nativeTarget()}`);

        mkdirSync(join(installed, "bin"), { recursive: true });
        mkdirSync(join(installed, "scripts"), { recursive: true });
        mkdirSync(platformPackage, { recursive: true });
        copyFileSync(installScript, join(installed, "scripts", "install-native.cjs"));
        writeFileSync(join(installed, "bin", "vis"), PLACEHOLDER, { mode: 0o755 });
        writeFileSync(join(platformPackage, "package.json"), "{}");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("replaces bin/vis with the platform binary and keeps it executable", () => {
        expect.assertions(4);

        writeBinary("#!/bin/sh\necho native\n");

        const result = install();
        const linked = join(installed, "bin", "vis");

        expect(result.status).toBe(0);
        expect(readFileSync(linked, "utf8")).toBe("#!/bin/sh\necho native\n");
        expect(() => {
            accessSync(linked, constants.X_OK);
        }).not.toThrow();
        expect(spawnSync(linked, { encoding: "utf8" }).stdout).toBe("native\n");
    });

    it("never writes through a bin/vis that a package manager hard-linked from its store", () => {
        expect.assertions(2);

        const storeCopy = join(root, "store-copy");

        writeFileSync(storeCopy, PLACEHOLDER);
        rmSync(join(installed, "bin", "vis"));
        linkSync(storeCopy, join(installed, "bin", "vis"));
        chmodSync(storeCopy, 0o755);
        writeBinary("#!/bin/sh\necho native\n");

        install();

        expect(readFileSync(storeCopy, "utf8")).toBe(PLACEHOLDER);
        expect(readFileSync(join(installed, "bin", "vis"), "utf8")).toContain("native");
    });

    it("keeps the Node launcher when the platform binary does not run", () => {
        expect.assertions(3);

        writeBinary("not an executable");
        chmodSync(join(platformPackage, "vis-native-cli"), 0o755);

        const result = install();

        expect(result.status).toBe(0);
        expect(result.stderr).toContain("Node launcher");
        expect(readFileSync(join(installed, "bin", "vis"), "utf8")).toBe(PLACEHOLDER);
    });

    it.skipIf(process.getuid?.() === 0)("leaves bin/vis untouched and removes its temporary file when the swap fails", () => {
        expect.assertions(3);

        writeBinary("#!/bin/sh\necho native\n");
        chmodSync(join(installed, "bin"), 0o555);

        try {
            const result = install();

            expect(result.stderr).toContain("it was left unchanged");
            expect(readFileSync(join(installed, "bin", "vis"), "utf8")).toBe(PLACEHOLDER);
            expect(readdirSync(join(installed, "bin"))).toStrictEqual(["vis"]);
        } finally {
            chmodSync(join(installed, "bin"), 0o755);
        }
    });

    it("keeps the Node launcher when the platform package is not installed", () => {
        expect.assertions(2);

        rmSync(platformPackage, { force: true, recursive: true });

        const result = install();

        expect(result.status).toBe(0);
        expect(readFileSync(join(installed, "bin", "vis"), "utf8")).toBe(PLACEHOLDER);
    });

    it("does nothing outside a node_modules install (a repository checkout)", () => {
        expect.assertions(2);

        writeBinary("#!/bin/sh\necho native\n");

        const checkout = join(root, "checkout");

        mkdirSync(join(checkout, "bin"), { recursive: true });
        mkdirSync(join(checkout, "scripts"), { recursive: true });
        copyFileSync(installScript, join(checkout, "scripts", "install-native.cjs"));
        writeFileSync(join(checkout, "bin", "vis"), PLACEHOLDER);

        const result = install({}, join(checkout, "scripts", "install-native.cjs"));

        expect(result.status).toBe(0);
        expect(readFileSync(join(checkout, "bin", "vis"), "utf8")).toBe(PLACEHOLDER);
    });

    describe("pnpm shims that would start Node", () => {
        const pnpm = { npm_config_user_agent: "pnpm/11.0.0 npm/? node/v24" };

        beforeEach(() => {
            writeBinary("#!/bin/sh\necho native\n");
        });

        const launcherKept = () => readFileSync(join(installed, "bin", "vis"), "utf8") === PLACEHOLDER;

        it("links on a first pnpm install", () => {
            expect.assertions(1);

            install({ ...pnpm, INIT_CWD: root, npm_command: "add" });

            expect(launcherKept()).toBe(false);
        });

        // The `.bin/vis` shim pnpm wrote on the first install, before this script ran again.
        const writeStaleShim = () => {
            mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
            writeFileSync(join(root, "node_modules", ".bin", "vis"), "#!/bin/sh\nexec node \"$basedir/../@visulima/vis/bin/vis\" \"$@\"\n");
        };

        it("keeps the launcher on `pnpm rebuild`, where the shim was written before the script ran", () => {
            expect.assertions(1);

            writeStaleShim();
            install({ ...pnpm, INIT_CWD: root, npm_command: "rebuild" });

            expect(launcherKept()).toBe(true);
        });

        it("keeps the launcher on `pnpm approve-builds`, which leaves the stale shim in place", () => {
            expect.assertions(2);

            writeStaleShim();
            const approved = install({ ...pnpm, INIT_CWD: root, npm_command: "approve-builds" });

            expect(approved.status).toBe(0);
            expect(launcherKept()).toBe(true);
        });

        it("keeps the launcher when a stale shim exists, whatever `npm_command` pnpm reports", () => {
            expect.assertions(1);

            writeStaleShim();
            install({ ...pnpm, INIT_CWD: root });

            expect(launcherKept()).toBe(true);
        });

        // Lays the package out inside pnpm's virtual store and returns its installed `bin/vis`.
        const installInPnpmStore = (modulesYaml: string, packageVersion = "1.0.0") => {
            // A project of its own per call: a link left by an earlier call would otherwise be written through.
            const project = mkdtempSync(join(root, "pnpm-project-"));
            const store = join(project, "node_modules", ".pnpm", `@visulima+vis@${packageVersion}`, "node_modules", "@visulima");
            const storedPackage = join(store, "vis");

            mkdirSync(join(storedPackage, "bin"), { recursive: true });
            mkdirSync(join(storedPackage, "scripts"), { recursive: true });
            copyFileSync(installScript, join(storedPackage, "scripts", "install-native.cjs"));
            writeFileSync(join(storedPackage, "bin", "vis"), PLACEHOLDER);
            writeFileSync(join(storedPackage, "package.json"), JSON.stringify({ name: "@visulima/vis", version: packageVersion }));
            mkdirSync(join(store, `vis-binding-${nativeTarget()}`), { recursive: true });
            copyFileSync(join(platformPackage, "vis-native-cli"), join(store, `vis-binding-${nativeTarget()}`, "vis-native-cli"));
            writeFileSync(join(project, "node_modules", ".modules.yaml"), modulesYaml);

            install({ ...pnpm, INIT_CWD: join(root, "other"), npm_command: "install" }, join(storedPackage, "scripts", "install-native.cjs"));

            return readFileSync(join(storedPackage, "bin", "vis"), "utf8");
        };

        it("keeps the launcher when pnpm recorded this package's scripts as skipped or pending", () => {
            expect.assertions(3);

            expect(installInPnpmStore("ignoredBuilds:\n  - '@visulima/vis@1.0.0'\nlayoutVersion: 5\n")).toBe(PLACEHOLDER);
            expect(installInPnpmStore("pendingBuilds:\n  - '@visulima/vis@1.0.0'\nlayoutVersion: 5\n")).toBe(PLACEHOLDER);
            expect(installInPnpmStore("ignoredBuilds: ['esbuild@0.1.0', '@visulima/vis@1.0.0']\n")).toBe(PLACEHOLDER);
        });

        it("links when only another version or another list mentions this package", () => {
            expect.assertions(2);

            expect(installInPnpmStore("ignoredBuilds:\n  - '@visulima/vis@0.9.0'\n  - '@visulima/vis-binding-x@1.0.0'\n")).not.toBe(PLACEHOLDER);
            expect(installInPnpmStore("included:\n  dependencies: true\nskipped:\n  - '@visulima/vis@1.0.0'\nignoredBuilds:\n  - esbuild@0.1.0\n")).not.toBe(
                PLACEHOLDER,
            );
        });

        it("does not affect other package managers", () => {
            expect.assertions(1);

            install({ npm_command: "rebuild", npm_config_user_agent: "npm/11.0.0 node/v24" });

            expect(launcherKept()).toBe(false);
        });
    });

    it("honours VIS_SKIP_NATIVE_LINK", () => {
        expect.assertions(1);

        writeBinary("#!/bin/sh\necho native\n");
        install({ VIS_SKIP_NATIVE_LINK: "1" });

        expect(readFileSync(join(installed, "bin", "vis"), "utf8")).toBe(PLACEHOLDER);
    });
});
