import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    const install = (environment: Record<string, string> = {}, script = join(installed, "scripts", "install-native.cjs")) =>
        spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ...environment } });

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

    it("honours VIS_SKIP_NATIVE_LINK", () => {
        expect.assertions(1);

        writeBinary("#!/bin/sh\necho native\n");
        install({ VIS_SKIP_NATIVE_LINK: "1" });

        expect(readFileSync(join(installed, "bin", "vis"), "utf8")).toBe(PLACEHOLDER);
    });
});
